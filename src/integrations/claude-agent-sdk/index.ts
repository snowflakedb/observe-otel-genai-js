/*
 * Copyright 2026 Snowflake Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Claude Agent SDK adapter.
 *
 * The SDK does not run the agent in your process: it spawns the Claude Code CLI and
 * streams JSON messages back. There is no model call to wrap, so this adapter
 * rebuilds the span tree from the message stream alone.
 *
 * Emits, per `query()` call:
 *
 *     invoke_agent <agentName>
 *       chat <model>                one per API call, keyed by message.id
 *       execute_tool <name>
 *       execute_tool Agent          the delegation tool (named Task on older CLIs)
 *         invoke_agent <subagent>   keyed by parent_tool_use_id
 *           chat <model>
 *
 * A `result` message is a checkpoint, not the end of the run: a background task can
 * keep the run going past it, and each result's totals cover the whole call so far.
 * The run ends when the stream does.
 */

import { type Context, context, diag } from '@opentelemetry/api';

import type { Client } from '../../client.js';
import { resolveContentCaptureMode } from '../../content/capture.js';
import { contentCaptureModeFromContext, conversationIdFromContext } from '../../context.js';
import type { GenerationStart } from '../../models/generation.js';
import type { Message, Part } from '../../models/message.js';
import { textPart } from '../../models/message.js';
import type { TokenUsage } from '../../models/usage.js';
import type { AgentInvocationRecorder } from '../../recorders/agent.js';
import type { GenerationRecorder } from '../../recorders/generation.js';
import type { ToolExecutionRecorder } from '../../recorders/tool.js';
import {
  ATTR_CONVERSATION_COMPACTED,
  ATTR_REQUEST_REASONING_LEVEL,
  ATTR_USAGE_COST_USD,
  ATTR_USAGE_IS_PARTIAL,
} from '../../semconv.js';
import { usageAttributes } from '../../spans/attributes.js';
import { blockToParts } from '../_common/anthropic-blocks.js';
import type { AdapterCallOptions } from '../_common/metadata.js';
import { isTracedQuery, markTraced } from './traced-queries.js';
import type {
  AgentContentBlock,
  AgentMessage,
  AgentModelUsage,
  AgentQueryFn,
  AgentQueryOptions,
  AgentQueryParams,
  AgentStartupFn,
  AgentUsage,
  AgentWarmQuery,
} from './types.js';

/** The model the CLI puts on the assistant message it makes up for a failed API call. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * How many messages each chat span replays as its input. Every span re-sends the
 * whole conversation, so without a bound a long tool loop outgrows what an exporter
 * accepts, and the span is dropped.
 */
const MAX_HISTORY_MESSAGES = 40;

/** The tools that launch a subagent. The CLI accepts either name. */
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);

/**
 * Env vars the CLI reads to pick a hosting platform, and the `gen_ai.provider.name`
 * each maps to, in the order the CLI checks them (CLI 2.1.220): when two are set, the
 * first wins. Mantle is a second Bedrock endpoint; the two "Claude Platform on
 * <cloud>" flags reach Anthropic's own API. When `options.env` is set, it is the
 * CLI's whole environment.
 */
const PROVIDER_ENV: readonly (readonly [string, string])[] = [
  ['CLAUDE_CODE_USE_BEDROCK', 'aws.bedrock'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'azure.ai.inference'],
  ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'anthropic'],
  ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'anthropic'],
  ['CLAUDE_CODE_USE_MANTLE', 'aws.bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'gcp.vertex_ai'],
];

/** The values the CLI reads as on. Anything else, `no` and `off` included, is off. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Metadata for the run, applied wherever each span type has a field for it. */
export type ClaudeAgentSdkOptions = AdapterCallOptions;

/**
 * Wraps the SDK's `query` function. The returned function has the same signature and
 * returns the SDK's own `Query` object, so `interrupt()`, `setModel()` and the other
 * control methods keep working; only iteration is observed.
 *
 * ```ts
 * const traced = wrapQuery(client, query, { agentName: 'support-bot' });
 * for await (const msg of traced({ prompt: 'hi', options })) { ... }
 * ```
 */
export function wrapQuery<F extends AgentQueryFn>(
  client: Client,
  query: F,
  options: ClaudeAgentSdkOptions = {},
): F {
  if (isTracedQuery(query)) return query;
  const traced = (params: Parameters<F>[0]) => {
    const queryParams = params as AgentQueryParams;
    const run = new AgentRun(client, options, queryParams);
    const { prompt } = queryParams;
    let stream: AsyncIterable<unknown>;
    try {
      stream = query(
        (isAsyncIterable(prompt)
          ? { ...queryParams, prompt: run.recordPrompt(prompt) }
          : params) as Parameters<F>[0],
      );
    } catch (err) {
      void run.end(err).catch(logRecordingFailure);
      throw err;
    }
    return observeIteration(stream, run);
  };
  markTraced(traced);
  return traced as F;
}

/**
 * Wraps the SDK's `startup`, which spawns the CLI ahead of time and hands back a
 * `WarmQuery`. Its `query(prompt)` does not go through the module's `query`, so it
 * is traced here, with the options `startup` was given.
 */
export function wrapStartup<F extends AgentStartupFn>(
  client: Client,
  startup: F,
  options: ClaudeAgentSdkOptions = {},
): F {
  if (isTracedQuery(startup)) return startup;
  const traced = async (params?: { options?: AgentQueryOptions }) => {
    const warm: AgentWarmQuery = await startup(params as never);
    const warmQuery = warm.query.bind(warm);
    const query = wrapQuery(client, (p: AgentQueryParams) => warmQuery(p.prompt as never), options);
    warm.query = (prompt: unknown) => query({ prompt, options: params?.options });
    return warm;
  };
  markTraced(traced);
  return traced as unknown as F;
}

/**
 * Returns the SDK's `Query` with iteration routed through the run. Everything else is
 * passed to the SDK object unchanged.
 */
function observeIteration<T extends object>(stream: T, run: AgentRun): T {
  const observed = run.observe(stream as AsyncIterable<AgentMessage>);
  // A loop that started ends the run in its own `finally`; one that never started cannot.
  const finish = () => (run.started ? observed.return() : run.end());
  const stop = async (stopSdk: () => unknown) => {
    run.markStoppedByCaller();
    try {
      return await stopSdk();
    } finally {
      await finish();
    }
  };
  return new Proxy(stream as T & SdkQuery, {
    get(target, prop) {
      switch (prop) {
        case Symbol.asyncIterator:
          return () => observed;
        case 'next':
        case 'throw':
          return observed[prop].bind(observed);
        // The SDK's own stop methods end the CLI, which also releases a read in progress.
        case 'return':
          return (value?: unknown) => stop(() => target.return?.(value));
        case Symbol.asyncDispose:
          return async () => {
            await stop(() => target[Symbol.asyncDispose]?.());
          };
        case 'close':
          return () => {
            run.markStoppedByCaller();
            try {
              target.close?.();
            } finally {
              finish().catch(logRecordingFailure);
            }
          };
        case 'interrupt':
          return () => {
            run.markInterrupted();
            return target.interrupt?.();
          };
        case 'streamInput':
          return (input: AsyncIterable<unknown>) => target.streamInput?.(run.recordPrompt(input));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The members of the SDK's `Query` the proxy intercepts. */
type SdkQuery = Partial<
  AsyncGenerator<unknown> &
    AsyncDisposable & {
      close(): void;
      interrupt(): Promise<unknown>;
      streamInput(input: AsyncIterable<unknown>): Promise<void>;
    }
>;

function logRecordingFailure(err: unknown): void {
  diag.debug('genai-otel: failed to record Claude Agent SDK telemetry', err);
}

// -----------------------------------------------------------------------------
// Per-run state
// -----------------------------------------------------------------------------

/** One agent's conversation: the main thread, or a subagent. */
interface AgentThread {
  agent: AgentInvocationRecorder;
  /** Unset on the main thread, whose name comes from the caller. */
  subagentName?: string;
  isMain: boolean;
  /** Replayed as each chat span's input messages. */
  history: Message[];
  /** When the thread last handed control back to the model; the next call starts here. */
  readyAt: number;
  call?: ModelCall;
  lastModel?: string;
}

/** The API call in flight on a thread. */
interface ModelCall {
  rec: GenerationRecorder;
  messageId: string | undefined;
  model: string;
  blocks: AgentContentBlock[];
  lastBlockAt: number;
  historyMessage?: Message;
  /** Mid-stream snapshot; undercounts output tokens. */
  usage?: AgentUsage;
  /** The call's real totals, from `message_delta`. */
  finalUsage?: AgentUsage;
  stopReason?: string;
}

interface OpenTool {
  rec: ToolExecutionRecorder;
  name: string;
  input: Record<string, unknown>;
  owner: AgentThread;
  startedAt: number;
  /** The CLI runs this call as a task, so its `tool_result` may be only a launch receipt. */
  isTask: boolean;
  receipt?: unknown;
  /** The task reported finishing before its `tool_result`, which then closes the span. */
  finished?: { error?: Error };
  subagent?: AgentThread;
}

class AgentRun {
  private readonly client: Client;
  private readonly config: ClaudeAgentSdkOptions;
  private readonly queryOptions: AgentQueryOptions;
  /** The caller's prompt as messages; a streamed prompt adds them as the SDK reads it. */
  private readonly promptInput: Message[];
  private readonly provider: string;
  private readonly startedAt = Date.now();
  /** Where `query()` was called. The root opens later, on the first message. */
  private readonly callerContext: Context = context.active();

  private root: AgentInvocationRecorder | undefined;
  private main: AgentThread | undefined;
  private readonly tools = new Map<string, OpenTool>();
  /** task_id -> tool_use_id, for task messages that carry only the task id. */
  private readonly taskTools = new Map<string, string>();

  private sessionId: string | undefined;
  private model: string | undefined;
  private compacted = false;
  /** The latest result's cumulative totals, and what earlier resets zeroed. */
  private latestTotals: RunTotals | undefined;
  private totalsBeforeReset: RunTotals = { usage: {}, costUsd: 0 };
  private sawResult = false;
  /** The caller ended the run with `close()` or `return()`, which is not a failure. */
  private stoppedByCaller = false;
  /** The caller interrupted the turn; the error result that follows is expected. */
  private interrupted = false;
  /** The caller has started reading the stream. */
  started = false;
  /**
   * Held until teardown rather than set on the span: a recorder's error cannot be
   * cleared, and a later result that succeeds should leave the run green.
   */
  private lastResultError: Error | undefined;

  constructor(client: Client, config: ClaudeAgentSdkOptions, params: AgentQueryParams) {
    this.client = client;
    this.config = config;
    this.queryOptions = params.options ?? {};
    this.promptInput = promptMessages(params.prompt);
    this.provider = resolveProvider(this.queryOptions);
  }

  /** Passes a streamed prompt through unchanged, recording each user message as it is read. */
  async *recordPrompt(prompt: AsyncIterable<unknown>): AsyncGenerator<unknown, void> {
    for await (const msg of prompt) {
      try {
        this.onPromptMessage(msg as AgentMessage);
      } catch (err) {
        logRecordingFailure(err);
      }
      yield msg;
    }
  }

  private onPromptMessage(msg: AgentMessage): void {
    if (msg.type !== 'user' || msg.parent_tool_use_id) return;
    const message = blocksToMessage(blocksOf(msg.message?.content), 'user');
    if (!message) return;
    this.promptInput.push(message);
    // The root opens on the CLI's first message; until then the input waits here.
    this.root?.setInput([...this.promptInput]);
    if (this.main) remember(this.main, message);
  }

  markStoppedByCaller(): void {
    this.stoppedByCaller = true;
  }

  markInterrupted(): void {
    this.interrupted = true;
  }

  async *observe(stream: AsyncIterable<AgentMessage>): AsyncGenerator<AgentMessage, void> {
    this.started = true;
    let error: unknown;
    let completed = false;
    try {
      for await (const msg of stream) {
        try {
          // Spans open as the caller reads, so record in the context `query()` was called in.
          context.with(this.callerContext, () => this.onMessage(msg));
        } catch (err) {
          logRecordingFailure(err);
        }
        yield msg;
      }
      completed = true;
    } catch (err) {
      error = err;
      throw err;
    } finally {
      await context
        .with(this.callerContext, () =>
          this.end(error ?? (completed ? this.missingResultError() : undefined)),
        )
        .catch(logRecordingFailure);
    }
  }

  /** A stream that ended with no result is a failure, unless the caller stopped it. */
  private missingResultError(): Error | undefined {
    // An interrupt can end the stream before the turn's result is sent.
    if (this.sawResult || this.stoppedByCaller || this.interrupted) return undefined;
    return new Error('agent stream ended before any result message');
  }

  private onMessage(msg: AgentMessage): void {
    if (msg.subtype !== 'task_notification') this.closeFinishedTasks();
    switch (msg.type) {
      case 'assistant':
        this.onAssistant(msg);
        break;
      case 'user':
        this.onUser(msg);
        break;
      case 'stream_event':
        this.onStreamEvent(msg);
        break;
      case 'system':
        this.onSystem(msg);
        break;
      case 'result':
        this.onResult(msg);
        break;
      case 'conversation_reset':
        // A /clear zeroes the running totals; what came before still counts for this run.
        this.totalsBeforeReset = addTotals(this.totalsBeforeReset, this.latestTotals);
        this.latestTotals = undefined;
        // The next call starts from an empty conversation, not a compacted one.
        this.mainThread().history = [];
        this.compacted = false;
        break;
    }
  }

  // --- messages -------------------------------------------------------------

  private onAssistant(msg: AgentMessage): void {
    const thread = this.threadFor(msg.parent_tool_use_id);
    if (!thread) return;
    const inner = msg.message ?? {};

    // A failed API call: the message stands for the call, and its text is the error.
    if (inner.model === SYNTHETIC_MODEL) {
      const text = blocksOf(inner.content)
        .map((b) => b.text ?? '')
        .join('');
      this.openCall(thread).rec.setCallError(new Error(text || 'API call failed'));
      return;
    }

    let call = thread.call;
    if (!call || (inner.id && inner.id !== call.messageId)) {
      call = this.openCall(thread, inner.id, inner.model);
    }
    const blocks = blocksOf(inner.content);
    call.blocks.push(...blocks);
    call.lastBlockAt = Date.now();
    if (inner.usage) call.usage = { ...call.usage, ...inner.usage };
    if (inner.stop_reason) call.stopReason = inner.stop_reason;
    if (msg.aborted) call.rec.setCallError(new Error('assistant message aborted'));

    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id) this.openTool(block, thread);
    }
    // One history message per call, even when tool results arrive between its blocks.
    const parts = blocks.flatMap((b) => blockToParts(b));
    if (call.historyMessage) call.historyMessage.parts.push(...parts);
    else if (parts.length > 0) {
      call.historyMessage = { role: 'assistant', parts };
      remember(thread, call.historyMessage);
    }
  }

  private onUser(msg: AgentMessage): void {
    const thread = this.threadFor(msg.parent_tool_use_id);
    if (!thread) return;
    // No call closes here: the CLI runs a tool as soon as its block arrives, so
    // results can come back while the same call is still sending blocks.

    const blocks = blocksOf(msg.message?.content);
    const toolResults = blocks.filter((b) => b.type === 'tool_result' && b.tool_use_id);
    // A subagent's only plain user message is its prompt echoed back, which its
    // history already starts with.
    if (!thread.isMain && toolResults.length === 0) return;

    for (const block of toolResults) {
      const id = block.tool_use_id as string;
      const tool = this.tools.get(id);
      if (tool?.isTask && !tool.finished) {
        tool.receipt = block.content ?? '';
        continue;
      }
      // A subagent gets no stream events; this is the only final usage its last call gets.
      const call = tool?.subagent?.call;
      const usage = usageOf(msg.tool_use_result);
      if (call && usage) call.finalUsage = usage;
      const error = block.is_error ? new Error('tool error') : tool?.finished?.error;
      this.closeTool(id, block.content, error);
    }
    const message = blocksToMessage(blocks, toolResults.length > 0 ? 'tool' : 'user');
    if (message) remember(thread, message);
    thread.readyAt = Date.now();
  }

  /** Sent only with `includePartialMessages`. */
  private onStreamEvent(msg: AgentMessage): void {
    const thread = this.threadFor(msg.parent_tool_use_id);
    const event = msg.event;
    if (!thread || !event) return;

    if (event.type === 'message_start') {
      const call = this.openCall(thread, event.message?.id, event.message?.model, msg.ttft_ms);
      call.usage = event.message?.usage;
    } else if (event.type === 'message_delta' && thread.call) {
      thread.call.finalUsage = event.usage;
      if (event.delta?.stop_reason) thread.call.stopReason = event.delta.stop_reason;
      this.closeCall(thread);
    }
  }

  private onSystem(msg: AgentMessage): void {
    switch (msg.subtype) {
      case 'init':
        this.sessionId = msg.session_id;
        this.model = msg.model;
        // A new turn: an interrupt sent while idle has no result to excuse.
        this.interrupted = false;
        // The CLI is up; the first request goes out now.
        this.mainThread().readyAt = Date.now();
        return;
      case 'task_started': {
        const tool = msg.tool_use_id ? this.tools.get(msg.tool_use_id) : undefined;
        if (tool) tool.isTask = true;
        if (msg.task_id && msg.tool_use_id) this.taskTools.set(msg.task_id, msg.tool_use_id);
        return;
      }
      case 'task_notification': {
        // The real end of a task; `summary` is its output.
        const id = msg.tool_use_id ?? (msg.task_id ? this.taskTools.get(msg.task_id) : undefined);
        if (msg.task_id) this.taskTools.delete(msg.task_id);
        const tool = id ? this.tools.get(id) : undefined;
        if (!id || !tool) return;
        const error = msg.status === 'failed' ? new Error('task failed') : undefined;
        // Run in the foreground, the task's tool_result follows with the full output.
        if (tool.receipt === undefined) tool.finished = { error };
        else this.closeTool(id, msg.summary, error);
        return;
      }
      case 'task_updated': {
        // The SDK can leave out a task's notification; this update is then its only end.
        const status = msg.patch?.status;
        if (status !== 'completed' && status !== 'failed' && status !== 'killed') return;
        const id = msg.task_id ? this.taskTools.get(msg.task_id) : undefined;
        const tool = id ? this.tools.get(id) : undefined;
        if (tool)
          tool.finished = { error: status === 'failed' ? new Error('task failed') : undefined };
        return;
      }
      case 'compact_boundary':
        this.compacted = true;
        this.openRoot().setAttributes({ [ATTR_CONVERSATION_COMPACTED]: true });
        // The next call sees a summary of what came before, which never reaches this
        // process. Leaving it out understates the input; keeping it would overstate it.
        this.mainThread().history = [];
        return;
    }
  }

  private onResult(msg: AgentMessage): void {
    const root = this.openRoot();
    this.sawResult = true;
    this.lastResultError = this.interrupted ? undefined : resultError(msg);
    this.interrupted = false;

    // An API failure keeps subtype `success`; it belongs on the call that failed.
    // The other error subtypes are early stops, where the last call went fine.
    const main = this.mainThread();
    if (this.lastResultError && msg.subtype === 'success') {
      main.call?.rec.setCallError(this.lastResultError);
    }
    this.closeCall(main);

    this.recordTotals(root, msg);
    root.setOutput(
      !msg.is_error && typeof msg.result === 'string' && msg.result
        ? [{ role: 'assistant', parts: [textPart(msg.result)] }]
        : [],
    );
    if (msg.stop_reason) root.setStopReason(msg.stop_reason);
  }

  /**
   * The results' totals cover more than this call when the session was resumed or
   * continued: its first result already includes the earlier runs, by an amount the
   * stream never states. Those runs get no totals rather than wrong ones.
   */
  private recordTotals(root: AgentInvocationRecorder, msg: AgentMessage): void {
    if (this.queryOptions.resume || this.queryOptions.continue) return;
    this.latestTotals = { usage: sumModelUsage(msg.modelUsage), costUsd: msg.total_cost_usd ?? 0 };
    const run = addTotals(this.totalsBeforeReset, this.latestTotals);
    root.setAttributes({
      ...usageAttributes(run.usage),
      ...(run.costUsd ? { [ATTR_USAGE_COST_USD]: run.costUsd } : {}),
    });
  }

  // --- threads --------------------------------------------------------------

  /** Opened on the first message, so the span can carry the session id from `init`. */
  private openRoot(): AgentInvocationRecorder {
    if (this.root) return this.root;
    // Also opened by end() when the caller closes the stream before reading it.
    this.root = context.with(this.callerContext, () =>
      this.client.invokeAgent({
        ...this.sharedSeed(),
        requestProvider: this.provider,
        requestModel: this.queryOptions.model ?? this.model,
        input: [...this.promptInput],
        parentGenerationIds: this.config.parentGenerationIds,
        startedAt: this.startedAt,
      }),
    );
    this.setReasoningLevel(this.root);
    return this.root;
  }

  private mainThread(): AgentThread {
    this.main ??= {
      agent: this.openRoot(),
      isMain: true,
      history: [...this.promptInput],
      readyAt: this.startedAt,
    };
    return this.main;
  }

  /**
   * The thread a message belongs to. A subagent's messages only count while the tool
   * that launched it is open: that is what its span nests under.
   */
  private threadFor(parentToolUseId: string | null | undefined): AgentThread | undefined {
    if (!parentToolUseId) return this.mainThread();
    const tool = this.tools.get(parentToolUseId);
    if (!tool) return undefined;
    tool.subagent ??= this.openSubagent(tool);
    return tool.subagent;
  }

  /** Dated from the delegation's start: the subagent's first message comes much later. */
  private openSubagent(tool: OpenTool): AgentThread {
    const name = pickString(tool.input.subagent_type) ?? tool.name;
    // The subagent's prompt is the delegation tool's argument, so it follows the
    // tool-content rule rather than the prompt rule.
    const showToolContent = this.capturesToolContent();
    const prompt = pickString(tool.input.prompt);
    const input: Message[] =
      prompt && showToolContent ? [{ role: 'user', parts: [textPart(prompt)] }] : [];

    const agent = tool.rec.withActiveContext(() =>
      this.client.invokeAgent({
        ...this.sharedSeed(name),
        requestProvider: this.provider,
        input,
        startedAt: tool.startedAt,
      }),
    );
    return {
      agent,
      subagentName: name,
      isMain: false,
      history: [...input],
      readyAt: tool.startedAt,
    };
  }

  private finishSubagent(thread: AgentThread, report: unknown, error: Error | undefined): void {
    this.closeToolsOf(thread, error);
    this.closeCall(thread);
    const output = this.capturesToolContent()
      ? blocksToMessage(blocksOf(report), 'assistant')
      : undefined;
    if (output) thread.agent.setOutput([output]);
    if (error) thread.agent.setError(error);
    void thread.agent.end();
  }

  // --- chat spans -----------------------------------------------------------

  /** Ends the thread's call in flight, if any, and starts the next one. */
  private openCall(
    thread: AgentThread,
    messageId?: string,
    model?: string,
    ttftMs?: number,
  ): ModelCall {
    this.closeCall(thread);
    const now = Date.now();
    const resolvedModel = model ?? thread.lastModel ?? this.model ?? 'unknown';
    const seed: GenerationStart = {
      ...this.sharedSeed(thread.subagentName),
      ...(thread.isMain ? this.mainRequestSettings() : {}),
      model: { provider: this.provider, name: resolvedModel },
      conversationTitle: this.config.conversationTitle,
      turnIndex: this.config.turnIndex,
      turnRole: this.config.turnRole,
      startedAt: ttftMs === undefined ? thread.readyAt : now - ttftMs,
    };
    const rec = thread.agent.withActiveContext(() =>
      this.expectsStreamEvents(thread)
        ? this.client.startStreamingGeneration(seed)
        : this.client.startGeneration(seed),
    );
    rec.setResult({ input: [...thread.history], responseId: messageId });
    if (ttftMs !== undefined) rec.setTimeToFirstToken(ttftMs / 1000);
    if (this.compacted) rec.setAttributes({ [ATTR_CONVERSATION_COMPACTED]: true });
    if (thread.isMain) this.setReasoningLevel(rec);

    thread.call = { rec, messageId, model: resolvedModel, blocks: [], lastBlockAt: now };
    thread.lastModel = resolvedModel;
    return thread.call;
  }

  /**
   * Ends the call in flight. Without `message_delta` the real end is unknown by the
   * time a later message closes the call, so it is dated to the call's last block.
   */
  private closeCall(thread: AgentThread): void {
    const call = thread.call;
    if (!call) return;
    thread.call = undefined;

    const output = blocksToMessage(call.blocks, 'assistant');
    // A snapshot's input figures are final, but its output count is taken as the reply
    // starts, so it is left out rather than reported low.
    const usage = call.finalUsage
      ? { ...call.usage, ...call.finalUsage }
      : { ...call.usage, output_tokens: undefined };
    call.rec.setResult({
      output: output ? [output] : [],
      usage: toTokenUsage(usage),
      responseModel: call.model,
      stopReason: call.stopReason ?? (hasToolUse(call.blocks) ? 'tool_use' : undefined),
    });
    // Only a message_delta arrives as the call ends; other final usage comes later.
    const endedAt =
      call.finalUsage && this.expectsStreamEvents(thread) ? Date.now() : call.lastBlockAt;
    if (!call.finalUsage) call.rec.setAttributes({ [ATTR_USAGE_IS_PARTIAL]: true });
    call.rec.setEndedAt(endedAt);
    void call.rec.end();
    thread.readyAt = Math.max(thread.readyAt, endedAt);
  }

  // --- tool spans -----------------------------------------------------------

  private openTool(block: AgentContentBlock, thread: AgentThread): void {
    const id = block.id as string;
    const name = block.name ?? 'unknown_tool';
    const startedAt = Date.now();
    const rec = thread.agent.withActiveContext(() =>
      this.client.startToolExecution({
        toolName: name,
        toolCallId: id,
        toolType: name.startsWith('mcp__') ? 'extension' : 'function',
        requestProvider: this.provider,
        requestModel: thread.call?.model,
        ...this.identity(thread.subagentName),
        contentCapture: this.config.contentCapture,
        startedAt,
      }),
    );
    rec.setResult({ arguments: block.input });
    const input = (block.input ?? {}) as Record<string, unknown>;
    // Known from the call itself, so it holds even if task_started comes after the receipt.
    const isTask = DELEGATION_TOOLS.has(name) || input.run_in_background === true;
    this.tools.set(id, { rec, name, input, owner: thread, startedAt, isTask });
  }

  private closeTool(id: string, response: unknown, error: Error | undefined): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    this.tools.delete(id);
    // End the child first, so it does not outlive its parent.
    if (tool.subagent) this.finishSubagent(tool.subagent, response, error);
    if (response !== undefined) tool.rec.setResult({ result: response });
    if (error) tool.rec.setExecError(error);
    void tool.rec.end();
  }

  /**
   * Closes background tasks that reported finishing only through `task_updated`. Held
   * for one message, since the notification that usually follows carries the output.
   */
  private closeFinishedTasks(): void {
    for (const [id, tool] of this.tools) {
      if (tool.finished && tool.receipt !== undefined) {
        this.closeTool(id, tool.receipt, tool.finished.error);
      }
    }
  }

  /** Closes the tools a thread still has open; a background task keeps its receipt. */
  private closeToolsOf(thread: AgentThread, error: Error | undefined): void {
    for (const [id, tool] of this.tools) {
      if (tool.owner === thread) this.closeTool(id, tool.receipt, error ?? tool.finished?.error);
    }
  }

  // --- teardown -------------------------------------------------------------

  /**
   * Closes everything still open. `error` is set when the run broke (the stream threw,
   * or ended with no result); the caller stopping early is not an error.
   */
  async end(error?: unknown): Promise<void> {
    const failure = error === undefined ? undefined : asError(error);
    if (this.main) {
      this.closeToolsOf(this.main, failure);
      // Without stream events an open call has already delivered its reply, so only a
      // call cut off mid-stream shares the failure.
      if (failure && this.expectsStreamEvents(this.main)) this.main.call?.rec.setCallError(failure);
      this.closeCall(this.main);
    }

    // A run that ends before its first message still gets a span: the CLI did start.
    const root = this.openRoot();
    const runError = failure ?? this.lastResultError;
    if (runError) root.setError(runError);
    await root.end();
  }

  // --- helpers --------------------------------------------------------------

  /**
   * Identity for a thread's spans. A subagent is its own agent, so it takes only
   * its name. The CLI session id is the conversation id only when neither the
   * options nor the enclosing scope give one.
   */
  private identity(subagentName?: string) {
    const { agentName, agentVersion, userId, conversationId } = this.config;
    return {
      ...(subagentName === undefined ? { agentName, agentVersion } : { agentName: subagentName }),
      userId,
      conversationId: conversationId || conversationIdFromContext() || this.sessionId,
    };
  }

  /** Seed fields every agent and chat span in a thread carries. */
  private sharedSeed(subagentName?: string) {
    return {
      ...this.identity(subagentName),
      contentCapture: this.config.contentCapture,
      tags: this.config.tags,
      metadata: this.config.metadata,
    };
  }

  /** Request settings from the caller's options, which only the main thread uses. */
  private mainRequestSettings(): Partial<GenerationStart> {
    const { systemPrompt, thinking } = this.queryOptions;
    return {
      systemPrompt: callerSystemPrompt(systemPrompt),
      thinkingEnabled: thinking?.type === 'enabled' ? true : undefined,
      thinkingBudgetTokens: thinking?.budgetTokens,
    };
  }

  private setReasoningLevel(rec: AgentInvocationRecorder | GenerationRecorder): void {
    const { effort } = this.queryOptions;
    if (effort) rec.setAttributes({ [ATTR_REQUEST_REASONING_LEVEL]: effort });
  }

  /** The SDK sends stream events only for the main thread, and only when asked to. */
  private expectsStreamEvents(thread: AgentThread): boolean {
    return thread.isMain && this.queryOptions.includePartialMessages === true;
  }

  private capturesToolContent(): boolean {
    const mode = resolveContentCaptureMode(
      this.config.contentCapture,
      contentCaptureModeFromContext(),
      this.client.config.contentCaptureMode,
    );
    return mode === 'full';
  }
}

// -----------------------------------------------------------------------------
// Mapping
// -----------------------------------------------------------------------------

/**
 * The system prompt the caller wrote in full: a string, or the custom form. A preset
 * is rendered by the CLI and never seen here, and its `append` is only a fragment.
 */
function callerSystemPrompt(prompt: unknown): string | undefined {
  if (typeof prompt === 'string') return prompt || undefined;
  const custom = prompt as { type?: unknown; prompt?: unknown } | undefined;
  return custom?.type === 'custom' ? pickString(custom.prompt) : undefined;
}

function resolveProvider(options: AgentQueryOptions): string {
  const env = options.env ?? process.env;
  for (const [key, provider] of PROVIDER_ENV) {
    if (TRUTHY.has(env[key]?.trim().toLowerCase() ?? '')) return provider;
  }
  return 'anthropic';
}

/** Adds to the replayed conversation, dropping the oldest messages past the bound. */
function remember(thread: AgentThread, message: Message): void {
  thread.history.push(message);
  if (thread.history.length > MAX_HISTORY_MESSAGES) {
    thread.history.splice(0, thread.history.length - MAX_HISTORY_MESSAGES);
  }
}

function hasToolUse(blocks: AgentContentBlock[]): boolean {
  return blocks.some((b) => b.type === 'tool_use');
}

function usageOf(toolUseResult: unknown): AgentUsage | undefined {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return undefined;
  const { usage } = toolUseResult as { usage?: unknown };
  return typeof usage === 'object' && usage !== null ? (usage as AgentUsage) : undefined;
}

function blocksOf(content: unknown): AgentContentBlock[] {
  if (Array.isArray(content)) return content as AgentContentBlock[];
  if (typeof content === 'string' && content) return [{ type: 'text', text: content }];
  return [];
}

function blocksToMessage(blocks: AgentContentBlock[], role: Message['role']): Message | undefined {
  const parts: Part[] = blocks.flatMap((b) => blockToParts(b));
  return parts.length > 0 ? { role, parts } : undefined;
}

/** A string prompt. A streamed prompt's messages are added by `recordPrompt` as the SDK reads them. */
function promptMessages(prompt: unknown): Message[] {
  const message =
    typeof prompt === 'string' ? blocksToMessage(blocksOf(prompt), 'user') : undefined;
  return message ? [message] : [];
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof (value as AsyncIterable<unknown> | undefined)?.[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Anthropic's `input_tokens` excludes cache reads and writes. The GenAI conventions
 * count them in, with the cache figures as subsets.
 */
function toTokenUsage(usage: AgentUsage): TokenUsage {
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (usage.input_tokens ?? 0) + read + write,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens || undefined,
  };
}

interface RunTotals {
  usage: TokenUsage;
  costUsd: number;
}

function addTotals(a: RunTotals, b: RunTotals | undefined): RunTotals {
  return b ? { usage: addUsage(a.usage, b.usage), costUsd: a.costUsd + b.costUsd } : a;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum = (key: keyof TokenUsage) => (a[key] ?? 0) + (b[key] ?? 0);
  return {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadInputTokens: sum('cacheReadInputTokens'),
    cacheWriteInputTokens: sum('cacheWriteInputTokens'),
    reasoningTokens: sum('reasoningTokens') || undefined,
  };
}

/** `modelUsage` covers subagents too, and is cumulative over the whole call. */
function sumModelUsage(modelUsage: Record<string, AgentModelUsage> | undefined): TokenUsage {
  const perModel = Object.values(modelUsage ?? {}).map((m) =>
    toTokenUsage({
      input_tokens: m.inputTokens,
      output_tokens: m.outputTokens,
      cache_read_input_tokens: m.cacheReadInputTokens,
      cache_creation_input_tokens: m.cacheCreationInputTokens,
      output_tokens_details: { thinking_tokens: m.thinkingTokens },
    }),
  );
  return perModel.reduce(addUsage, {});
}

/**
 * The error a result reports. On an API failure the subtype stays `success` and the
 * text is in `result`; the early-stop subtypes put it in `errors`.
 */
function resultError(msg: AgentMessage): Error | undefined {
  if (!msg.is_error) return undefined;
  const text =
    msg.subtype === 'success'
      ? (pickString(msg.result) ?? '')
      : (msg.errors ?? []).filter((e) => e.trim() !== '').join('; ');
  const status = typeof msg.api_error_status === 'number' ? ` (HTTP ${msg.api_error_status})` : '';
  return new Error(
    text ? `${text}${status}` : `claude agent run failed: ${msg.terminal_reason ?? msg.subtype}`,
  );
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export type { AgentMessage, AgentQueryFn, AgentQueryOptions, AgentStartupFn } from './types.js';
