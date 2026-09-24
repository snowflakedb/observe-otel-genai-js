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
import { contentCaptureModeFromContext } from '../../context.js';
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
  AgentUsage,
} from './types.js';

const DEFAULT_AGENT_NAME = 'claude-agent-sdk';

/** The model the CLI puts on the assistant message it makes up for a failed API call. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Env vars the CLI reads to pick a hosting platform, and the `gen_ai.provider.name`
 * each maps to. When `options.env` is set, it is the CLI's whole environment.
 */
const PROVIDER_ENV: readonly (readonly [string, string])[] = [
  ['CLAUDE_CODE_USE_BEDROCK', 'aws.bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'gcp.vertex_ai'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'azure.ai.inference'],
];

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
    const run = new AgentRun(client, options, params as AgentQueryParams);
    let stream: AsyncIterable<unknown>;
    try {
      stream = query(params);
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
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The members of the SDK's `Query` the proxy intercepts. */
type SdkQuery = Partial<
  AsyncGenerator<unknown> & AsyncDisposable & { close(): void; interrupt(): Promise<unknown> }
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
  agentName: string;
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
  subagent?: AgentThread;
}

class AgentRun {
  private readonly client: Client;
  private readonly config: ClaudeAgentSdkOptions;
  private readonly queryOptions: AgentQueryOptions;
  private readonly prompt: unknown;
  private readonly provider: string;
  private readonly agentName: string;
  private readonly startedAt = Date.now();
  /** Where `query()` was called. The root opens later, on the first message. */
  private readonly callerContext: Context = context.active();

  private root: AgentInvocationRecorder | undefined;
  private main: AgentThread | undefined;
  private readonly tools = new Map<string, OpenTool>();

  private sessionId: string | undefined;
  private model: string | undefined;
  private compacted = false;
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
    this.prompt = params.prompt;
    this.provider = resolveProvider(this.queryOptions);
    this.agentName = config.agentName ?? DEFAULT_AGENT_NAME;
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
          this.onMessage(msg);
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
      await this.end(error ?? (completed ? this.missingResultError() : undefined)).catch(
        logRecordingFailure,
      );
    }
  }

  /** A stream that ended with no result is a failure, unless the caller stopped it. */
  private missingResultError(): Error | undefined {
    if (this.sawResult || this.stoppedByCaller) return undefined;
    return new Error('agent stream ended before any result message');
  }

  private onMessage(msg: AgentMessage): void {
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
      thread.history.push(call.historyMessage);
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
      if (tool?.isTask) tool.receipt = block.content;
      else this.closeTool(id, block.content, block.is_error ? new Error('tool error') : undefined);
    }
    const message = blocksToMessage(blocks, toolResults.length > 0 ? 'tool' : 'user');
    if (message) thread.history.push(message);
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
        return;
      }
      case 'task_notification':
        // The real end of a task; `summary` is its output.
        if (msg.tool_use_id) {
          const error = msg.status === 'failed' ? new Error('task failed') : undefined;
          this.closeTool(msg.tool_use_id, msg.summary, error);
        }
        return;
      case 'compact_boundary':
        this.compacted = true;
        this.openRoot().setAttributes({ [ATTR_CONVERSATION_COMPACTED]: true });
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

    root.setAttributes({
      ...usageAttributes(sumModelUsage(msg.modelUsage)),
      ...(msg.total_cost_usd ? { [ATTR_USAGE_COST_USD]: msg.total_cost_usd } : {}),
    });
    root.setOutput(
      !msg.is_error && typeof msg.result === 'string' && msg.result
        ? [{ role: 'assistant', parts: [textPart(msg.result)] }]
        : [],
    );
    if (msg.stop_reason) root.setStopReason(msg.stop_reason);
  }

  // --- threads --------------------------------------------------------------

  /** Opened on the first message, so the span can carry the session id from `init`. */
  private openRoot(): AgentInvocationRecorder {
    if (this.root) return this.root;
    this.root = context.with(this.callerContext, () =>
      this.client.invokeAgent({
        ...this.sharedSeed(this.agentName),
        requestProvider: this.provider,
        requestModel: this.queryOptions.model ?? this.model,
        input: promptMessages(this.prompt),
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
      agentName: this.agentName,
      isMain: true,
      history: promptMessages(this.prompt),
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
      agentName: name,
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
      ...this.sharedSeed(thread.agentName),
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
    const endedAt = call.finalUsage ? Date.now() : call.lastBlockAt;
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
        conversationId: this.conversationId,
        agentName: thread.agentName,
        agentVersion: this.config.agentVersion,
        contentCapture: this.config.contentCapture,
        startedAt,
      }),
    );
    rec.setResult({ arguments: block.input });
    const input = (block.input ?? {}) as Record<string, unknown>;
    this.tools.set(id, { rec, name, input, owner: thread, startedAt, isTask: false });
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

  /** Closes the tools a thread still has open; a background task keeps its receipt. */
  private closeToolsOf(thread: AgentThread, error: Error | undefined): void {
    for (const [id, tool] of this.tools) {
      if (tool.owner === thread) this.closeTool(id, tool.receipt, error);
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

  private get conversationId(): string | undefined {
    return this.config.conversationId ?? this.sessionId;
  }

  /** Seed fields every agent and chat span in the run carries. */
  private sharedSeed(agentName: string) {
    return {
      agentName,
      agentVersion: this.config.agentVersion,
      userId: this.config.userId,
      conversationId: this.conversationId,
      contentCapture: this.config.contentCapture,
      tags: this.config.tags,
      metadata: this.config.metadata,
    };
  }

  /** Request settings from the caller's options, which only the main thread uses. */
  private mainRequestSettings(): Partial<GenerationStart> {
    const { systemPrompt, thinking } = this.queryOptions;
    return {
      systemPrompt: typeof systemPrompt === 'string' && systemPrompt ? systemPrompt : undefined,
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

function resolveProvider(options: AgentQueryOptions): string {
  const env = options.env ?? process.env;
  for (const [key, provider] of PROVIDER_ENV) {
    const value = env[key];
    if (value && value !== '0' && value !== 'false') return provider;
  }
  return 'anthropic';
}

function hasToolUse(blocks: AgentContentBlock[]): boolean {
  return blocks.some((b) => b.type === 'tool_use');
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

/** A string prompt; a streamed prompt is not replayed onto spans. */
function promptMessages(prompt: unknown): Message[] {
  return typeof prompt === 'string' && prompt ? [{ role: 'user', parts: [textPart(prompt)] }] : [];
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
    cacheCreationInputTokens: write,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens || undefined,
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
    }),
  );
  const sum = (key: keyof TokenUsage) => perModel.reduce((n, u) => n + (u[key] ?? 0), 0);
  return {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadInputTokens: sum('cacheReadInputTokens'),
    cacheCreationInputTokens: sum('cacheCreationInputTokens'),
  };
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

export type { AgentMessage, AgentQueryFn, AgentQueryOptions } from './types.js';
