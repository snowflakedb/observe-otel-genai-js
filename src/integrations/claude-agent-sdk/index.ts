/**
 * Claude Agent SDK adapter.
 *
 * The Claude Agent SDK does not run the agent in your process — it spawns the
 * Claude Code CLI and streams JSON messages back. There is no model call to
 * wrap, so this adapter reconstructs the span tree entirely from the message
 * stream: `message.id` delimits API calls, `parent_tool_use_id` identifies
 * subagents, and a `tool_result` block ends the tool span it names.
 *
 * The caller's options are passed through untouched — nothing is injected.
 *
 * One `query()` call is one agent invocation, so it gets one `invoke_agent` span
 * that is the common ancestor of everything else this adapter emits. That span sits
 * under whatever context the caller is in, so it is the trace root only when the
 * caller has no span of their own.
 *
 * `result` messages are internal checkpoints, not boundaries: the CLI emits one per
 * *its* notion of a turn (a main-loop model call), and a single `query()` can emit
 * several — a delegated background task keeps the run going past the first one. Each
 * result supersedes the last; its totals are cumulative over the whole call.
 *
 * Emits:
 *
 *     invoke_agent <agentName>
 *       chat <model>                one per API call, cut on message.id
 *       execute_tool <name>
 *       execute_tool Task
 *         invoke_agent <subagent>   nested, keyed by parent_tool_use_id
 *           chat <model>
 *
 * Attribute names follow the current GenAI semantic conventions, taken from
 * `src/semconv.ts`. Where core's recorders still emit an older spelling for one,
 * both names are written so a consumer sees the current one either way.
 */

import { type Attributes, trace } from '@opentelemetry/api';

import type { Client } from '../../client.js';
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
  ATTR_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS,
  ATTR_USAGE_COST_USD,
  ATTR_USAGE_IS_PARTIAL,
  OP_CHAT,
} from '../../semconv.js';
import { blockToParts } from '../_common/anthropic-blocks.js';
import type { AdapterCallOptions } from '../_common/metadata.js';
import type {
  AgentContentBlock,
  AgentMessage,
  AgentModelUsage,
  AgentQueryFn,
  AgentQueryOptions,
  AgentUsage,
} from './types.js';

const DEFAULT_AGENT_NAME = 'claude-agent-sdk';

/**
 * Routing env vars the CLI reads to pick a hosting platform, mapped to the
 * semconv `gen_ai.provider.name` value. A hosting platform wins over the vendor
 * it hosts, so a Bedrock-served Claude model reports `aws.bedrock`.
 */
const PROVIDER_ENV: readonly (readonly [string, string])[] = [
  ['CLAUDE_CODE_USE_BEDROCK', 'aws.bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'gcp.vertex_ai'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'azure.ai.foundry'],
];

/**
 * Resolves the provider before the run starts, so `gen_ai.provider.name` is
 * correct from the moment the span opens.
 *
 * The platform is decided by the environment, not by the response, so there is no
 * need to wait for `result.modelUsage[*].provider` — which would be too late
 * anyway, since the recorder re-applies its seed when the span ends.
 *
 * `options.env` replaces rather than merges, so it is exactly what the CLI
 * subprocess will see; fall back to our own environment when it is absent.
 */
function resolveProvider(sdkOptions: AgentQueryOptions | undefined): string {
  const env = (sdkOptions?.env as Record<string, string | undefined> | undefined) ?? process.env;
  for (const [key, provider] of PROVIDER_ENV) {
    const value = env[key];
    if (value && value !== '0' && value !== 'false') return provider;
  }
  return 'anthropic';
}
/** Map key for the main thread's chat context; a space cannot collide with a tool_use_id. */
const MAIN = ' main';

/**
 * Per-run metadata for the Claude Agent SDK adapter.
 *
 * Deliberately just the shared adapter options — no structural toggles. What the
 * adapter emits is fixed; how much of it carries content is the client's
 * `contentCaptureMode` (per-call `contentCapture`, or ambient
 * `withContentCaptureMode`), and span volume is a sampler's job.
 */
export type ClaudeAgentSdkOptions = AdapterCallOptions;

/**
 * Wraps the SDK's `query` function. The returned function has the same
 * signature and yields the same messages; each one is observed on the way past.
 *
 * ```ts
 * const traced = wrapQuery(client, query, { agentName: 'support-bot' });
 * for await (const msg of traced({ prompt: 'hi', options })) { ... }
 * ```
 */
export function wrapQuery(
  client: Client,
  query: AgentQueryFn,
  options: ClaudeAgentSdkOptions = {},
): AgentQueryFn {
  return function tracedQuery(params: { prompt: unknown; options?: AgentQueryOptions }) {
    const run = new AgentRun(client, options, params.options);
    return run.iterate(() => query(params), params.prompt);
  };
}

// -----------------------------------------------------------------------------
// Per-run state
// -----------------------------------------------------------------------------

/** Chat-span state for one agent context: the main thread, or one subagent. */
interface ChatContext {
  /** Map key: `MAIN`, or the `parent_tool_use_id` of the owning subagent. */
  key: string;
  /** Owning agent span: the root agent, or a subagent's invoke_agent span. */
  owner: AgentInvocationRecorder;
  rec: GenerationRecorder | undefined;
  messageId: string | undefined;
  blocks: AgentContentBlock[];
  /** Mid-stream snapshot from `message.usage`; superseded by `finalUsage`. */
  usage: AgentUsage | undefined;
  /** Final per-call usage from the `message_delta` stream event, when available. */
  finalUsage: AgentUsage | undefined;
  /** Reasoning tokens from `message_delta`. */
  reasoningTokens: number | undefined;
  /** Real per-call stop reason; `message.stop_reason` is null while streaming. */
  stopReason: string | undefined;
  model: string | undefined;
  ttftSeconds: number | undefined;
  /** Running conversation, replayed as each chat span's input messages. */
  history: Message[];
}

interface OpenTool {
  rec: ToolExecutionRecorder;
  name: string;
}

interface OpenSubagent {
  rec: AgentInvocationRecorder;
  output: Message[];
}

// -----------------------------------------------------------------------------

class AgentRun {
  private readonly client: Client;
  private readonly opts: ClaudeAgentSdkOptions;
  private readonly sdkOptions: AgentQueryOptions | undefined;

  private rootAgent: AgentInvocationRecorder | undefined;
  private rootAgentStartedAt = Date.now();
  /**
   * The run's error, as last known. Everything else a `result` reports is written to
   * the span as it arrives, but an error cannot be: a recorder's error has no way to
   * be cleared, so a later result that succeeds could not undo an earlier failure.
   * Held here instead and applied once, at teardown.
   */
  private finalError: unknown;
  private sawResult = false;
  private disposed = false;

  private readonly chats = new Map<string, ChatContext>();
  private readonly tools = new Map<string, OpenTool>();
  private readonly subagents = new Map<string, OpenSubagent>();
  /** tool_use_id -> the Task/Agent tool_use block that launched a subagent. */
  private readonly launches = new Map<string, AgentContentBlock>();
  /**
   * tool_use_ids of calls the CLI runs as a task, keyed off `system/task_started`.
   *
   * Their `tool_result` cannot be trusted to mean the work finished. Run in the
   * background it arrives in milliseconds carrying only a receipt — "async agent
   * launched", or "command running in background with ID" — while the real work goes
   * on for another half a minute. Closing on it would report a near-instant tool call
   * and, for a delegation, leave the subagent with no open parent to nest under.
   *
   * `system/task_notification` is the signal that holds throughout: it carries the
   * `tool_use_id`, the real status, and the output. So these close on that and ignore
   * their `tool_result`. Run inline the notification simply arrives first, and the
   * `tool_result` behind it is a no-op.
   *
   * Covers both task types the CLI registers — `local_agent` (a Task delegation) and
   * `local_bash` (a backgrounded command). Nothing here reads the type: being a task
   * at all is what decides where completion comes from.
   */
  private readonly taskTools = new Set<string>();
  /**
   * TTFT seen on a `message_start` stream event, keyed by context.
   *
   * `message_start` carries `ttft_ms` and arrives *before* the first assistant
   * message of that call, so there is no chat span to put it on yet. Held here
   * and consumed when the span opens.
   */
  private readonly pendingTtft = new Map<string, number>();

  private readonly provider: string;
  private sessionId: string | undefined;
  private model: string | undefined;
  private compacted = false;
  private prompt: unknown;

  constructor(client: Client, opts: ClaudeAgentSdkOptions, sdkOptions?: AgentQueryOptions) {
    this.client = client;
    this.opts = opts;
    this.sdkOptions = sdkOptions;
    this.provider = resolveProvider(sdkOptions);
  }

  // --- main loop ------------------------------------------------------------

  async *iterate(
    start: () => AsyncIterable<AgentMessage>,
    prompt: unknown,
  ): AsyncGenerator<AgentMessage, void> {
    this.prompt = prompt;
    let stream: AsyncIterable<AgentMessage>;
    try {
      stream = start();
    } catch (err) {
      this.openRootAgent();
      await this.failRootAgent(err);
      throw err;
    }

    try {
      for await (const msg of stream) {
        try {
          this.onMessage(msg);
        } catch {
          // A mapping slip must not interrupt the caller's stream.
        }
        yield msg;
      }
    } catch (err) {
      await this.failRootAgent(err);
      throw err;
    } finally {
      await this.dispose();
    }
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
      default:
        break;
    }
  }

  // --- root agent lifecycle -------------------------------------------------------

  private openRootAgent(): AgentInvocationRecorder {
    if (this.rootAgent) return this.rootAgent;
    this.rootAgentStartedAt = Date.now();
    this.rootAgent = this.client.invokeAgent({
      agentName: this.opts.agentName ?? DEFAULT_AGENT_NAME,
      agentVersion: this.opts.agentVersion,
      requestProvider: this.provider,
      requestModel: this.sdkOptions?.model ?? this.model,
      conversationId: this.opts.conversationId ?? this.sessionId,
      userId: this.opts.userId,
      input: promptToMessages(this.prompt),
      contentCapture: this.opts.contentCapture,
      metadata: this.opts.metadata,
      startedAt: this.rootAgentStartedAt,
    });

    const effort = this.sdkOptions?.effort;
    if (typeof effort === 'string') {
      setAttrs(this.rootAgent, { [ATTR_REQUEST_REASONING_LEVEL]: effort });
    }
    return this.rootAgent;
  }

  private chatContext(parentToolUseId: string | null | undefined): ChatContext {
    const key = parentToolUseId ?? MAIN;
    const existing = this.chats.get(key);
    if (existing) return existing;

    const owner = parentToolUseId ? this.subagent(parentToolUseId).rec : this.openRootAgent();
    const ctx: ChatContext = {
      key,
      owner,
      rec: undefined,
      messageId: undefined,
      blocks: [],
      usage: undefined,
      finalUsage: undefined,
      reasoningTokens: undefined,
      stopReason: undefined,
      model: undefined,
      ttftSeconds: undefined,
      history: key === MAIN ? promptToMessages(this.prompt) : [],
    };
    this.chats.set(key, ctx);
    return ctx;
  }

  /**
   * Lazily opens a subagent span, reading its identity from the Task tool call
   * that launched it. Started but never made "current" — parallel delegations
   * finish out of launch order, so children are parented explicitly.
   */
  private subagent(parentToolUseId: string): OpenSubagent {
    const existing = this.subagents.get(parentToolUseId);
    if (existing) return existing;

    const launch = this.launches.get(parentToolUseId);
    const input = (launch?.input ?? {}) as Record<string, unknown>;
    const name =
      pickString(input.subagent_type) ?? pickString(input.agent_type) ?? launch?.name ?? 'subagent';
    // Still open: a Task tool's `tool_result` *is* the subagent's report, so it
    // cannot arrive before the subagent's own messages have opened this span.
    const parentTool = this.tools.get(parentToolUseId);
    const turn = this.openRootAgent();
    const promptText = pickString(input.prompt);

    const open = (): AgentInvocationRecorder =>
      this.client.invokeAgent({
        agentName: name,
        agentDescription: pickString(input.description),
        requestProvider: this.provider,
        requestModel: pickString(input.model) ?? this.model,
        conversationId: this.opts.conversationId ?? this.sessionId,
        input: promptText ? [{ role: 'user', parts: [textPart(promptText)] }] : [],
        contentCapture: this.opts.contentCapture,
        startedAt: Date.now(),
      });

    const rec = parentTool ? parentTool.rec.withActiveContext(open) : turn.withActiveContext(open);
    const entry: OpenSubagent = { rec, output: [] };
    this.subagents.set(parentToolUseId, entry);
    return entry;
  }

  // --- assistant / user -----------------------------------------------------

  private onAssistant(msg: AgentMessage): void {
    const inner = msg.message ?? {};
    const parent = msg.parent_tool_use_id ?? null;
    const blocks = blocksOf(inner);
    if (inner.model) this.model = inner.model;

    // Tool spans open from the stream, not from a tool result: only the stream
    // carries `parent_tool_use_id`, which is what puts the span in the right place.
    // block.id is the tool call id.
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id) this.launches.set(block.id, block);
    }

    const ctx = this.chatContext(parent);

    // A new message.id means a new API call. The same id means another content
    // block of the call already in flight.
    if (!ctx.rec || (inner.id && inner.id !== ctx.messageId)) {
      this.closeChat(ctx);
      this.openChat(ctx, inner.id, inner.model);
    }
    ctx.blocks.push(...blocks);
    if (inner.usage) ctx.usage = inner.usage;
    if (inner.stop_reason) ctx.rec?.setResult({ stopReason: inner.stop_reason });
    if (msg.aborted) ctx.rec?.setCallError(new Error('assistant message aborted'));

    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id) this.openTool(block, parent);
    }

    const asMessage = blocksToMessage(blocks, 'assistant');
    if (asMessage) {
      ctx.history.push(asMessage);
      if (parent) this.subagents.get(parent)?.output.push(asMessage);
    }
  }

  private onUser(msg: AgentMessage): void {
    const parent = msg.parent_tool_use_id ?? null;
    const ctx = this.chatContext(parent);
    const blocks = blocksOf(msg.message ?? {});

    // A user message closes the API call in flight — the next assistant message
    // belongs to a fresh request.
    this.closeChat(ctx);

    let sawToolResult = false;
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        sawToolResult = true;
        // A task waits for its notification; this may only be a launch receipt.
        if (this.taskTools.has(block.tool_use_id)) continue;
        this.closeTool(block.tool_use_id, block.content, block.is_error ? 'tool error' : undefined);
      }
    }

    const asMessage = blocksToMessage(blocks, sawToolResult ? 'tool' : 'user');
    if (asMessage) ctx.history.push(asMessage);
  }

  private onStreamEvent(msg: AgentMessage): void {
    const key = msg.parent_tool_use_id ?? MAIN;

    // `message_delta` closes a call on the wire: it is the one event carrying the
    // call's final usage and stop reason. Without it we would be left with the
    // `message_start` snapshot, which understates output tokens by ~98%.
    //
    // Measured on CLI 2.1.220: these events always arrive with
    // `parent_tool_use_id` null, immediately after their own call's assistant
    // messages, and never interleaved with another call's — the main loop is
    // blocked while a subagent runs, and subagent calls emit no stream events at
    // all. So routing by `key` lands on the right span. The set-once guard is
    // there in case a future CLI interleaves them.
    if (msg.event?.type === 'message_delta') {
      const ctx = this.chats.get(key);
      if (!ctx?.rec || ctx.finalUsage !== undefined) return;
      const usage = msg.event.usage;
      if (usage) {
        ctx.finalUsage = usage;
        const thinking = usage.output_tokens_details?.thinking_tokens;
        if (typeof thinking === 'number' && thinking > 0) ctx.reasoningTokens = thinking;
      }
      const stop = msg.event.delta?.stop_reason;
      if (stop) ctx.stopReason = stop;
      return;
    }

    if (typeof msg.ttft_ms !== 'number') return;
    const ctx = this.chats.get(key);
    if (ctx?.rec) {
      if (ctx.ttftSeconds === undefined) this.applyTtft(ctx, msg.ttft_ms);
      return;
    }
    this.pendingTtft.set(key, msg.ttft_ms);
  }

  private applyTtft(ctx: ChatContext, ttftMs: number): void {
    if (!ctx.rec) return;
    ctx.ttftSeconds = ttftMs / 1000;
    ctx.rec.setTimeToFirstToken(ctx.ttftSeconds);
    setAttrs(ctx.rec, { [ATTR_RESPONSE_TIME_TO_FIRST_CHUNK]: ctx.ttftSeconds });
  }

  private onSystem(msg: AgentMessage): void {
    if (msg.subtype === 'init') {
      this.sessionId = msg.session_id ?? this.sessionId;
      if (msg.model) this.model = msg.model;
      this.openRootAgent();
      return;
    }

    // The CLI has registered this call as a task. Always ahead of that call's
    // `tool_result`, whether it then runs in the background or inline.
    if (msg.subtype === 'task_started') {
      if (msg.tool_use_id) this.taskTools.add(msg.tool_use_id);
      return;
    }

    // The task really finished. `summary` is its output — the same text an inline
    // `tool_result` carries, and what a backgrounded one lacks.
    if (msg.subtype === 'task_notification') {
      const id = msg.tool_use_id;
      if (!id) return;
      this.taskTools.delete(id);
      const failed = msg.status !== undefined && msg.status !== 'completed';
      this.closeTool(id, msg.summary, failed ? `task ${msg.status}` : undefined);
      return;
    }

    // Compaction is reported with the semconv boolean only. The pre/post token
    // counts would need a bespoke event, and nothing consumes one yet.
    if (msg.subtype === 'compact_boundary') {
      this.compacted = true;
      setAttrs(this.openRootAgent(), { [ATTR_CONVERSATION_COMPACTED]: true });
    }
  }

  // --- chat spans -----------------------------------------------------------

  private openChat(
    ctx: ChatContext,
    messageId: string | undefined,
    model: string | undefined,
  ): void {
    const resolvedModel = model ?? this.model ?? this.sdkOptions?.model ?? 'unknown';
    const streaming = this.sdkOptions?.includePartialMessages === true;
    const seed: GenerationStart = {
      model: { provider: this.provider, name: resolvedModel },
      operationName: OP_CHAT,
      conversationId: this.opts.conversationId ?? this.sessionId,
      userId: this.opts.userId,
      agentName: this.opts.agentName ?? DEFAULT_AGENT_NAME,
      systemPrompt: systemPromptText(this.sdkOptions?.systemPrompt),
      thinkingEnabled: this.sdkOptions?.thinking?.type === 'enabled' ? true : undefined,
      thinkingBudgetTokens: this.sdkOptions?.thinking?.budgetTokens,
      contentCapture: this.opts.contentCapture,
      startedAt: Date.now(),
    };
    ctx.rec = ctx.owner.withActiveContext(() =>
      streaming ? this.client.startStreamingGeneration(seed) : this.client.startGeneration(seed),
    );
    ctx.messageId = messageId;
    ctx.blocks = [];
    ctx.usage = undefined;
    ctx.finalUsage = undefined;
    ctx.reasoningTokens = undefined;
    ctx.stopReason = undefined;
    ctx.model = resolvedModel;
    ctx.ttftSeconds = undefined;

    ctx.rec.setResult({ input: [...ctx.history] });
    const attrs: Attributes = {};
    if (messageId) attrs['gen_ai.response.id'] = messageId;
    if (this.compacted) attrs[ATTR_CONVERSATION_COMPACTED] = true;
    const effort = this.sdkOptions?.effort;
    if (typeof effort === 'string') attrs[ATTR_REQUEST_REASONING_LEVEL] = effort;
    setAttrs(ctx.rec, attrs);

    const pending = this.pendingTtft.get(ctx.key);
    if (pending !== undefined) {
      this.pendingTtft.delete(ctx.key);
      this.applyTtft(ctx, pending);
    }
  }

  private closeChat(ctx: ChatContext): void {
    const rec = ctx.rec;
    if (!rec) return;
    ctx.rec = undefined;

    // `message_delta` carries the call's real totals; `message.usage` is only a
    // mid-stream snapshot. Prefer the former and flag the span when we had to
    // settle for the latter (no `includePartialMessages`, or an aborted call).
    const usage = ctx.finalUsage ?? ctx.usage;
    const isFinal = ctx.finalUsage !== undefined;

    const output = blocksToMessage(ctx.blocks, 'assistant');
    rec.setResult({
      output: output ? [output] : [],
      usage: foldUsage(usage, ctx.reasoningTokens),
      responseModel: ctx.model,
      stopReason: ctx.stopReason,
    });

    const attrs: Attributes = {};
    if (usage?.cache_creation_input_tokens) {
      attrs[ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS] = usage.cache_creation_input_tokens;
    }
    if (!isFinal) attrs[ATTR_USAGE_IS_PARTIAL] = true;
    setAttrs(rec, attrs);
    void rec.end();
  }

  // --- tool spans -----------------------------------------------------------

  private openTool(block: AgentContentBlock, parentToolUseId: string | null): void {
    const id = block.id;
    if (!id || this.tools.has(id)) return;
    const name = block.name ?? 'unknown_tool';

    const owner = parentToolUseId
      ? (this.subagents.get(parentToolUseId)?.rec ?? this.openRootAgent())
      : this.openRootAgent();

    const rec = owner.withActiveContext(() =>
      this.client.startToolExecution({
        toolName: name,
        toolCallId: id,
        toolType: name.startsWith('mcp__') ? 'extension' : 'function',
        requestProvider: this.provider,
        requestModel: this.model,
        conversationId: this.opts.conversationId ?? this.sessionId,
        agentName: this.opts.agentName ?? DEFAULT_AGENT_NAME,
        contentCapture: this.opts.contentCapture,
        startedAt: Date.now(),
      }),
    );
    rec.setResult({ arguments: block.input });
    this.tools.set(id, { rec, name });
  }

  private closeTool(id: string | undefined, response: unknown, error: unknown): void {
    if (!id) return;
    // A Task tool owns a nested subagent span. End the child first: OTel does not
    // enforce it, but a child outliving its parent renders as a bar sticking out
    // past its parent and some backends flag it.
    this.finishSubagent(id);
    const open = this.tools.get(id);
    if (!open) return;
    this.tools.delete(id);
    if (response !== undefined) open.rec.setResult({ result: response });
    if (error !== undefined) open.rec.setExecError(error);
    void open.rec.end();
  }

  /** Ends a subagent span once the Task tool that spawned it has returned. */
  private finishSubagent(toolUseId: string): void {
    const entry = this.subagents.get(toolUseId);
    if (!entry) return;
    this.subagents.delete(toolUseId);
    const ctx = this.chats.get(toolUseId);
    if (ctx) {
      this.closeChat(ctx);
      this.chats.delete(toolUseId);
    }
    if (entry.output.length > 0) entry.rec.setOutput(entry.output);
    void entry.rec.end();
  }

  // --- result / teardown ----------------------------------------------------

  /**
   * A `result` is a checkpoint, not the end of the run: it closes the model call in
   * flight and supersedes the previous result, but the span stays open until the
   * stream does. Tools are deliberately left alone — a backgrounded delegation
   * legitimately outlives the result that announced it.
   */
  private onResult(msg: AgentMessage): void {
    const rec = this.openRootAgent();
    this.sessionId = msg.session_id ?? this.sessionId;
    this.sawResult = true;

    // An API failure is the one result error that belongs on the model call: the
    // CLI relays it as a synthetic assistant message, so that call's span is open
    // and would otherwise close as a success. The early-stop subtypes are the
    // opposite — the loop hit a limit and the call before it went fine.
    const err = resultError(msg);
    const apiError = msg.subtype === 'success' ? err : undefined;
    for (const [, ctx] of this.chats) {
      if (apiError && ctx.key === MAIN) ctx.rec?.setCallError(apiError);
      this.closeChat(ctx);
    }
    this.chats.clear();
    this.finalError = err;

    // Written straight to the span: `modelUsage` and the cost are cumulative over the
    // whole `query()` call, so a later result only ever raises them and the last one
    // to arrive leaves the right value behind.
    const totals = foldModelUsage(msg.modelUsage);
    const attrs: Attributes = {};
    if (totals.cacheWrite > 0) attrs[ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS] = totals.cacheWrite;
    if (totals.costUsd > 0) attrs[ATTR_USAGE_COST_USD] = totals.costUsd;
    else if (typeof msg.total_cost_usd === 'number' && msg.total_cost_usd > 0) {
      attrs[ATTR_USAGE_COST_USD] = msg.total_cost_usd;
    }
    if (this.compacted) attrs[ATTR_CONVERSATION_COMPACTED] = true;
    // `AgentInvocationRecorder` has no usage channel and records no token metric, so
    // the authoritative totals ride on the span as attributes. The per-call token
    // metric comes from the chat spans.
    setAttrs(rec, { ...attrs, ...usageAttributes(totals.usage) });

    rec.setOutput(
      typeof msg.result === 'string' && msg.result && !msg.is_error
        ? [{ role: 'assistant', parts: [textPart(msg.result)] }]
        : [],
    );
    if (msg.stop_reason) rec.setStopReason(msg.stop_reason);
  }

  /**
   * Ends the run: the stream is over, so everything still open closes here and the
   * last result is written onto the span.
   */
  private async endRootAgent(): Promise<void> {
    for (const [id] of [...this.subagents]) this.finishSubagent(id);
    for (const [id] of [...this.tools]) this.closeTool(id, undefined, 'tool never returned');
    for (const [, ctx] of this.chats) this.closeChat(ctx);
    this.chats.clear();

    const rec = this.rootAgent;
    this.rootAgent = undefined;
    this.compacted = false;
    if (!rec) return;

    if (this.finalError) rec.setError(this.finalError);
    await rec.end();
  }

  private async failRootAgent(err: unknown): Promise<void> {
    for (const [, ctx] of this.chats) ctx.rec?.setCallError(err);
    this.finalError = err;
    await this.endRootAgent();
  }

  /** Closes anything the stream left open — abandoned generators, early breaks. */
  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.sawResult) {
      const err = new Error('agent stream ended before any result message');
      for (const [, ctx] of this.chats) ctx.rec?.setCallError(err);
      this.finalError = err;
    }
    await this.endRootAgent();
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Sets attributes on a recorder's span through the public recorder API.
 *
 * Recorders own their span and do not expose it. `withActiveContext` installs it
 * as the active span for the synchronous duration of the callback, which is all
 * a `setAttributes` call needs — and it works identically from the stream loop
 * and from a hook running in one of the SDK's own async contexts.
 */
function setAttrs(rec: { withActiveContext<T>(fn: () => T): T }, attrs: Attributes): void {
  if (Object.keys(attrs).length === 0) return;
  rec.withActiveContext(() => {
    trace.getActiveSpan()?.setAttributes(attrs);
  });
}

function blocksOf(inner: { content?: AgentContentBlock[] | string }): AgentContentBlock[] {
  const content = inner.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content) return [{ type: 'text', text: content }];
  return [];
}

function blocksToMessage(blocks: AgentContentBlock[], role: Message['role']): Message | undefined {
  const parts: Part[] = [];
  for (const b of blocks) parts.push(...blockToParts(b));
  if (parts.length === 0) return undefined;
  return { role, parts };
}

function promptToMessages(prompt: unknown): Message[] {
  if (typeof prompt === 'string' && prompt) return [{ role: 'user', parts: [textPart(prompt)] }];
  if (prompt && typeof prompt === 'object' && 'message' in prompt) {
    const inner = (prompt as { message: { content?: AgentContentBlock[] | string } }).message;
    const msg = blocksToMessage(blocksOf(inner ?? {}), 'user');
    return msg ? [msg] : [];
  }
  return [];
}

function systemPromptText(sp: AgentQueryOptions['systemPrompt']): string | undefined {
  if (typeof sp === 'string') return sp || undefined;
  if (sp && typeof sp === 'object') {
    const parts = [sp.preset ? `preset: ${sp.preset}` : undefined, sp.append].filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

/**
 * Folds Anthropic's cache counters into `inputTokens`.
 *
 * Anthropic reports `input_tokens` excluding cache reads and writes; current
 * GenAI semconv requires `gen_ai.usage.input_tokens` to include them, with the
 * cache attributes as subsets. This differs from the `/anthropic` adapter, which
 * still reports the raw uncached count.
 */
function foldUsage(
  usage: AgentUsage | undefined,
  reasoningTokens?: number,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (usage.input_tokens ?? 0) + read + write,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: write,
    reasoningTokens,
  };
}

interface RunTotals {
  usage: TokenUsage;
  cacheWrite: number;
  costUsd: number;
}

/**
 * Sums `modelUsage` across models.
 *
 * No subtraction: `modelUsage` is cumulative over the whole `query()` call, which is
 * exactly the span it lands on. It also covers subagents and compaction, which
 * `result.usage` does not.
 */
function foldModelUsage(current: Record<string, AgentModelUsage> | undefined): RunTotals {
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  let cost = 0;

  for (const mu of Object.values(current ?? {})) {
    input += mu.inputTokens ?? 0;
    output += mu.outputTokens ?? 0;
    read += mu.cacheReadInputTokens ?? 0;
    write += mu.cacheCreationInputTokens ?? 0;
    cost += mu.costUSD ?? 0;
  }

  return {
    usage: {
      inputTokens: input + read + write,
      outputTokens: output,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: write,
    },
    cacheWrite: write,
    costUsd: cost,
  };
}

/**
 * The error a result reports, if any.
 *
 * Which field holds the text depends on the subtype, and this follows the rule the
 * SDK applies to its own thrown error: on an API failure the subtype is still
 * `success` and the text sits in `result`; the early-stop subtypes put it in
 * `errors`.
 */
function resultError(msg: AgentMessage | undefined): Error | undefined {
  if (!msg?.is_error) return undefined;
  const text =
    msg.subtype === 'success'
      ? (pickString(msg.result) ?? '')
      : (Array.isArray(msg.errors) ? msg.errors : [])
          .filter((e): e is string => typeof e === 'string' && e.trim() !== '')
          .join('; ');
  const status = msg.api_error_status;
  const suffix = typeof status === 'number' ? ` (HTTP ${status})` : '';
  return new Error(
    text ? `${text}${suffix}` : `claude agent run failed: ${msg.terminal_reason ?? msg.subtype}`,
  );
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Renders a `TokenUsage` as span attributes, skipping zeros. */
function usageAttributes(usage: TokenUsage): Attributes {
  const attrs: Attributes = {};
  if (usage.inputTokens) attrs['gen_ai.usage.input_tokens'] = usage.inputTokens;
  if (usage.outputTokens) attrs['gen_ai.usage.output_tokens'] = usage.outputTokens;
  if (usage.cacheReadInputTokens) {
    attrs['gen_ai.usage.cache_read.input_tokens'] = usage.cacheReadInputTokens;
  }
  return attrs;
}

export type { AgentMessage, AgentQueryFn, AgentQueryOptions } from './types.js';
