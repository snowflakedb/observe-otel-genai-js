/**
 * `GenAIOtelTracingProcessor`: an `@openai/agents` `TracingProcessor` that turns
 * the SDK's spans into OpenTelemetry GenAI spans.
 *
 * Applications normally install `OpenAIAgentsInstrumentation`, which registers this
 * processor and adds the context handling a processor cannot do by itself.
 *
 * SDK span to OTel span:
 *  - trace: a run container span named after the trace, with operation `invoke_agent`
 *  - `agent`: `invoke_agent`
 *  - `function`: `execute_tool`
 *  - `generation` from the AI SDK bridge: `chat`. The OpenAI model paths are left
 *    to `OpenAIInstrumentation`, so a model call is never reported twice.
 *  - everything else: no span. `turn` and `task` errors are routed to the
 *    enclosing span.
 *
 * The SDK does not await these callbacks, so durations come from the SDK's own
 * timestamps, and every callback body is guarded so it cannot throw into the run.
 */

import {
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  createContextKey,
  context as otelContext,
  trace as otelTrace,
} from '@opentelemetry/api';

import { Client } from '../../client.js';
import { AllowListSpan, allowListSpanOptions } from '../../content/allow-list.js';
import { type ContentCaptureMode, resolveContentCaptureMode } from '../../content/capture.js';
import { contentCaptureModeFromContext } from '../../context.js';
import type { GenerationStart } from '../../models/generation.js';
import type { Message } from '../../models/message.js';
import type { AgentInvocationRecorder } from '../../recorders/agent.js';
import type { GenerationRecorder } from '../../recorders/generation.js';
import type { ToolExecutionRecorder } from '../../recorders/tool.js';
import {
  ATTR_CONVERSATION_ID,
  ATTR_ERROR_TYPE,
  ATTR_OPERATION_NAME,
  ATTR_SDK_NAME,
  INSTRUMENTATION_NAME,
  OP_CHAT,
  OP_INVOKE_AGENT,
  SDK_NAME,
} from '../../semconv.js';
import { VERSION } from '../../version.js';
import { type OAMessage, mapOpenAIInput, mapOpenAIOutputMessage } from '../openai/_chat.js';
import { mapResponsesOutput } from '../openai/_responses.js';
import { type AiProviderMessage, mapProviderPrompt } from '../vercel-ai-sdk/_map.js';
import {
  aiSdkModelRef,
  finishReasonFor,
  isAiSdkGeneration,
  mapAgentsItems,
  mapGenerationUsage,
  mapResponseInput,
} from './_map.js';
import {
  type SdkAgentSpanData,
  type SdkFunctionSpanData,
  type SdkGenerationSpanData,
  type SdkResponseSpanData,
  type SdkSpan,
  type SdkSpanError,
  type SdkTrace,
  type SdkTracingProcessor,
  parseSdkTimestamp,
} from './_sdk-types.js';

export interface GenAIOtelTracingProcessorOptions {
  /** Reuse an existing `Client`. Otherwise the processor creates one from the global providers. */
  client?: Client;
  /** Content-capture override; falls through to the client config when unset. */
  contentCapture?: ContentCaptureMode;
  /**
   * Cap on open traces. Past it, the least recently active trace is ended with the
   * data it has. Default 1000.
   */
  maxTracesInFlight?: number;
  /**
   * The SDK's `getCurrentTrace`. With it, a run resumed in the same process after a
   * tool approval is traced: the SDK sends no trace start for it.
   */
  getCurrentTrace?: () => SdkTrace | null;
}

/** Context key marking which `Runner.run()` call the current code runs under. */
export const RUN_TOKEN_KEY = createContextKey('@genai-otel/openai-agents-run-token');

export interface AgentsIdentity {
  conversationId?: string;
  agentName?: string;
}

type Recorder = AgentInvocationRecorder | ToolExecutionRecorder | GenerationRecorder;

interface AgentState {
  readonly name: string;
  readonly recorder: AgentInvocationRecorder;
  /** Input of the agent's first model call and output of its last one. */
  input?: Message[];
  output?: Message[];
}

interface SpanRecord {
  readonly sdkSpan: SdkSpan;
  readonly trace: TraceRecord;
  /** Context children of this SDK span start under: its own span's, or its nearest ancestor's. */
  otelContext: Context;
  recorder?: Recorder;
  /** Nearest span at or above this one with a recorder. `turn` and `task` errors land there. */
  owner?: SpanRecord;
  /** Nearest agent at or above this span. */
  agent?: AgentState;
  /** The latest `generation` span directly beneath this span, for time-to-first-token. */
  latestGeneration?: SpanRecord;
  /** On a `generation` span: whether its run streams, and when the first token arrived. */
  streaming?: boolean;
  firstTokenAt?: number;
}

interface TraceRecord {
  readonly sdkTrace: SdkTrace;
  readonly conversationId?: string;
  /**
   * Opened again for a run resumed in the same process. The SDK sends no trace start
   * or end for those, so the trace closes when the run's top-level task ends.
   */
  readonly resumed: boolean;
  /** Opened inside a `Runner.run()` call, so a failure of the run is a failure of the trace. */
  readonly ownedByRun: boolean;
  readonly span: Span;
  /** Content-capture mode resolved when the trace opened. */
  readonly mode: ContentCaptureMode;
  readonly context: Context;
  readonly spanIds: Set<string>;
  /** Spans already ended, so a start delivered after its end does not open the span again. */
  readonly endedSpanIds: Set<string>;
  readonly runTokens: Set<object>;
  /** Error of a top-level span in a run-owned trace. A streamed run reports failures only there. */
  error?: unknown;
}

interface ClosedTrace {
  readonly at: number;
  /** Tokens of the `Runner.run()` calls that produced the trace's spans. */
  readonly runTokens: ReadonlySet<object>;
}

interface RunState {
  readonly streaming: boolean;
  readonly traceIds: Set<string>;
}

const DEFAULT_MAX_TRACES = 1000;

/**
 * `error.type` must stay low-cardinality, but SDK error records carry free text, so
 * only class-like names pass. `TripwireTriggered` keeps guardrail trips visible.
 */
const ERROR_NAME = /^(?:[A-Za-z_$][A-Za-z0-9_$.]{0,127})?(?:Error|Exception|TripwireTriggered)$/;

export class GenAIOtelTracingProcessor implements SdkTracingProcessor {
  readonly client: Client;
  private readonly tracer: Tracer;
  private readonly contentCapture?: ContentCaptureMode;
  private readonly maxTraces: number;
  /** Ordered from least to most recently active. */
  private readonly traces = new Map<string, TraceRecord>();
  private readonly spans = new Map<string, SpanRecord>();
  /** Recently closed traces and when they closed, so a late span start is not taken for a resumed run. */
  private readonly closed = new Map<string, ClosedTrace>();
  private readonly getCurrentTrace?: () => SdkTrace | null;
  private readonly runs = new WeakMap<object, RunState>();
  private stopped = false;

  constructor(options: GenAIOtelTracingProcessorOptions = {}) {
    this.client = options.client ?? new Client();
    this.tracer = this.client.config.tracer ?? otelTrace.getTracer(INSTRUMENTATION_NAME, VERSION);
    this.contentCapture = options.contentCapture;
    this.maxTraces = options.maxTracesInFlight ?? DEFAULT_MAX_TRACES;
    this.getCurrentTrace = options.getCurrentTrace;
  }

  // ---------------------------------------------------------------------------
  // TracingProcessor
  // ---------------------------------------------------------------------------

  async onTraceStart(trace: SdkTrace): Promise<void> {
    this.safely('onTraceStart', () => this.openTrace(trace, false));
  }

  async onTraceEnd(trace: SdkTrace): Promise<void> {
    await this.safely('onTraceEnd', () => this.closeTrace(trace.traceId));
  }

  async onSpanStart(span: SdkSpan): Promise<void> {
    this.safely('onSpanStart', () => this.startSpan(span));
  }

  private openTrace(trace: SdkTrace, resumed: boolean): TraceRecord | undefined {
    if (this.stopped) return undefined;
    // Runs given the same `traceId` share one; end the earlier one rather than lose it.
    if (this.traces.has(trace.traceId))
      void this.safely('closeTrace', () => this.closeTrace(trace.traceId));
    // Started under the caller's context, so a run inside a request handler nests
    // under the handler's span.
    const options = { kind: SpanKind.INTERNAL, startTime: new Date(this.client.now()) };
    const mode = resolveContentCaptureMode(
      this.contentCapture,
      contentCaptureModeFromContext(),
      this.client.config.contentCaptureMode,
    );
    // Opened without a recorder, so it is filtered here rather than by the `Client`.
    const span =
      mode === 'allow_list'
        ? new AllowListSpan(this.tracer.startSpan(trace.name, allowListSpanOptions(options)))
        : this.tracer.startSpan(trace.name, options);
    span.setAttribute(ATTR_OPERATION_NAME, OP_INVOKE_AGENT);
    span.setAttribute(ATTR_SDK_NAME, SDK_NAME);
    if (trace.groupId) span.setAttribute(ATTR_CONVERSATION_ID, trace.groupId);
    applyMetadataAttributes(span, trace.metadata);

    const record: TraceRecord = {
      sdkTrace: trace,
      conversationId: trace.groupId ?? undefined,
      resumed,
      ownedByRun: this.activeRun() !== undefined,
      span,
      mode,
      context: otelTrace.setSpan(otelContext.active(), span),
      spanIds: new Set(),
      endedSpanIds: new Set(),
      runTokens: new Set(),
    };
    this.traces.set(trace.traceId, record);
    const token = this.activeRunToken();
    if (token) {
      record.runTokens.add(token);
      this.runs.get(token)?.traceIds.add(trace.traceId);
    }
    this.evictIdleTraces();
    return record;
  }

  /**
   * Also called from {@link callScope}: the SDK notifies processors one after
   * another without waiting, so a model or tool call can begin before this
   * processor has heard its span, or that span's parents, started.
   */
  private startSpan(span: SdkSpan): void {
    if (this.stopped || this.spans.has(span.spanId)) return;
    const trace = this.traces.get(span.traceId) ?? this.reopenTrace(span);
    if (!trace || trace.endedSpanIds.has(span.spanId)) return;
    this.markActive(span.traceId, trace);
    const token = this.activeRunToken();
    if (token) trace.runTokens.add(token);
    if (span.previousSpan && span.previousSpan.spanId === span.parentId) {
      this.startSpan(span.previousSpan);
    }

    const parent = span.parentId ? this.spans.get(span.parentId) : undefined;
    const record: SpanRecord = {
      sdkSpan: span,
      trace,
      otelContext: parent?.otelContext ?? trace.context,
      owner: parent?.owner,
      agent: parent?.agent,
    };
    const startedAt = parseSdkTimestamp(span.startedAt) ?? this.client.now();

    switch (span.spanData.type) {
      case 'agent':
        this.startAgent(record, span.spanData as SdkAgentSpanData, trace, startedAt);
        break;
      case 'function':
        this.startTool(record, span.spanData as SdkFunctionSpanData, trace, startedAt);
        break;
      case 'generation':
        record.streaming = this.activeRun()?.streaming === true;
        if (parent) parent.latestGeneration = record;
        break;
    }

    this.spans.set(span.spanId, record);
    trace.spanIds.add(span.spanId);
  }

  async onSpanEnd(span: SdkSpan): Promise<void> {
    await this.safely('onSpanEnd', async () => {
      // With slow processors ahead of this one, the end can be all we hear.
      this.startSpan(span);
      const record = this.spans.get(span.spanId);
      if (record) await this.finishSpan(record);
    });
  }

  async forceFlush(): Promise<void> {
    await this.safely('forceFlush', () => this.client.flush());
  }

  /**
   * Only flushes. The SDK calls this whenever it replaces its processor list and on
   * process signals, and neither means tracing is over. {@link stop} ends it.
   */
  async shutdown(timeout?: number): Promise<void> {
    await this.safely('shutdown', () => this.client.flush(timeout));
  }

  /** Ends every open span with the data it has, flushes, and ignores new work until {@link resume}. */
  async stop(timeout?: number): Promise<void> {
    this.stopped = true;
    await this.safely('stop', async () => {
      for (const traceId of [...this.traces.keys()]) await this.closeTrace(traceId);
      await this.client.flush(timeout);
    });
  }

  resume(): void {
    this.stopped = false;
  }

  // ---------------------------------------------------------------------------
  // Hooks for OpenAIAgentsInstrumentation
  // ---------------------------------------------------------------------------

  /**
   * Starts tracking one `Runner.run()` call. The returned token goes into the OTel
   * context under {@link RUN_TOKEN_KEY}, so traces the run opens can be closed if it
   * rejects, and chat spans know whether the run streams.
   */
  beginRun(streaming: boolean): object {
    const token = {};
    this.runs.set(token, { streaming, traceIds: new Set() });
    return token;
  }

  /**
   * Closes the traces a rejected run opened, since the SDK skips `trace.end()` on
   * rejection. A run inside someone else's trace (a `withTrace` block, or an agent
   * used as a tool) closes nothing: the caller may recover.
   */
  async onRunError(token: object, error: unknown): Promise<void> {
    await this.safely('onRunError', async () => {
      for (const traceId of this.runs.get(token)?.traceIds ?? []) {
        await this.closeTrace(traceId, error);
      }
    });
  }

  /** Closes a `withTrace` trace whose callback threw, which the SDK leaves open. */
  async failTrace(traceId: string, error: unknown): Promise<void> {
    await this.safely('failTrace', () => this.closeTrace(traceId, error));
  }

  /**
   * The OTel context and ambient identity for a model or tool call under
   * `sdkSpan`: its nearest emitted span is active, and the conversation id and
   * agent name are set. The run marker from the calling context is kept, so a
   * nested run is not mistaken for its outer run.
   */
  callScope(sdkSpan: SdkSpan | null): { context: Context; identity: AgentsIdentity } {
    const active = otelContext.active();
    if (sdkSpan) this.safely('callScope', () => this.startSpan(sdkSpan));
    const record = sdkSpan ? this.spans.get(sdkSpan.spanId) : undefined;
    if (!record) return { context: active, identity: {} };

    const run = active.getValue(RUN_TOKEN_KEY);
    const identity: AgentsIdentity = {};
    if (record.trace.conversationId) identity.conversationId = record.trace.conversationId;
    if (record.agent?.name) identity.agentName = record.agent.name;
    return {
      context: run ? record.otelContext.setValue(RUN_TOKEN_KEY, run) : record.otelContext,
      identity,
    };
  }

  /** Records time-to-first-token for the model call under `parentSdkSpanId`. */
  markFirstToken(parentSdkSpanId: string | undefined, atMs: number): void {
    const generation = parentSdkSpanId && this.spans.get(parentSdkSpanId)?.latestGeneration;
    if (generation) generation.firstTokenAt ??= atMs;
  }

  // ---------------------------------------------------------------------------
  // Span starts
  // ---------------------------------------------------------------------------

  private startAgent(
    record: SpanRecord,
    data: SdkAgentSpanData,
    trace: TraceRecord,
    startedAt: number,
  ): void {
    const recorder = this.startRecorder(record, () =>
      this.client.invokeAgent({
        agentName: data.name,
        conversationId: trace.conversationId,
        startedAt,
        contentCapture: this.contentCapture,
      }),
    );
    record.agent = { name: data.name, recorder };
  }

  private startTool(
    record: SpanRecord,
    data: SdkFunctionSpanData,
    trace: TraceRecord,
    startedAt: number,
  ): void {
    this.startRecorder(record, () =>
      this.client.startToolExecution({
        toolName: data.name,
        toolType: 'function',
        agentName: record.agent?.name,
        conversationId: trace.conversationId,
        startedAt,
        contentCapture: this.contentCapture,
      }),
    );
  }

  /**
   * Opens the `chat` span for an AI SDK `generation` once the SDK span is over. The
   * bridge fills in the model, which is what marks the AI SDK path, only after the
   * span has started. Other model paths get no span here.
   */
  private startChat(record: SpanRecord): GenerationRecorder | undefined {
    const data = record.sdkSpan.spanData as SdkGenerationSpanData;
    if (!isAiSdkGeneration(data)) return undefined;
    const seed: GenerationStart = {
      model: aiSdkModelRef(data.model),
      operationName: OP_CHAT,
      agentName: record.agent?.name,
      conversationId: record.trace.conversationId,
      startedAt: parseSdkTimestamp(record.sdkSpan.startedAt),
      contentCapture: this.contentCapture,
    };
    const recorder = otelContext.with(record.otelContext, () =>
      record.streaming
        ? this.client.startStreamingGeneration(seed)
        : this.client.startGeneration(seed),
    );
    if (record.firstTokenAt !== undefined) recorder.setFirstTokenAt(record.firstTokenAt);
    record.recorder = recorder;
    return recorder;
  }

  /** Starts a recorder under the record's parent context and makes it the parent for children. */
  private startRecorder<R extends Recorder>(record: SpanRecord, start: () => R): R {
    return otelContext.with(record.otelContext, () => {
      const recorder = start();
      record.recorder = recorder;
      record.owner = record;
      record.otelContext = recorder.withActiveContext(() => otelContext.active());
      return recorder;
    });
  }

  // ---------------------------------------------------------------------------
  // Span ends
  // ---------------------------------------------------------------------------

  private async finishSpan(record: SpanRecord): Promise<void> {
    const span = record.sdkSpan;
    this.spans.delete(span.spanId);
    record.trace.spanIds.delete(span.spanId);
    record.trace.endedSpanIds.add(span.spanId);

    switch (span.spanData.type) {
      case 'agent':
        if (record.agent) setAgentResult(record.agent);
        break;
      case 'function':
        if (record.recorder) {
          setToolResult(record.recorder as ToolExecutionRecorder, span);
        }
        break;
      case 'generation': {
        const data = span.spanData as SdkGenerationSpanData;
        const chat = this.startChat(record);
        if (chat) this.setChatResult(record, chat, data);
        else noteChatCompletionsCall(record.agent, data);
        break;
      }
      case 'response': {
        const data = span.spanData as SdkResponseSpanData;
        noteModelCall(
          record.agent,
          mapResponseInput(data._input),
          mapResponsesOutput(data._response?.output),
        );
        break;
      }
      case 'task':
      case 'turn':
        // A model call that failed may have been retried, so only these two say a
        // run or turn really failed.
        if (span.error && record.owner?.recorder) applyError(record.owner.recorder, span.error);
        break;
    }
    if (span.error && !span.parentId && record.trace.ownedByRun) record.trace.error ??= span.error;

    if (record.recorder) {
      applyError(record.recorder, span.error);
      const endedAt = parseSdkTimestamp(span.endedAt);
      if (endedAt !== undefined) record.recorder.setEndedAt(endedAt);
      await record.recorder.end();
    }
    if (record.trace.resumed && span.spanData.type === 'task' && !span.parentId) {
      await this.closeTrace(span.traceId);
    }
  }

  private setChatResult(
    record: SpanRecord,
    chat: GenerationRecorder,
    data: SdkGenerationSpanData,
  ): void {
    const { messages: input, systemPrompt } = mapProviderPrompt(
      (data.input ?? []) as unknown as AiProviderMessage[],
    );
    const output = mapAgentsItems(data.output);
    chat.setResult({
      input,
      output,
      systemPrompt,
      usage: mapGenerationUsage(data.usage),
      stopReason: finishReasonFor(output),
    });
    noteModelCall(record.agent, input, output);
  }

  /** Ends a span the SDK never ended, with the data it has. */
  private async abandonSpan(record: SpanRecord, error: unknown): Promise<void> {
    this.spans.delete(record.sdkSpan.spanId);
    record.trace.endedSpanIds.add(record.sdkSpan.spanId);
    if (record.sdkSpan.spanData.type === 'generation') this.startChat(record);
    if (record.sdkSpan.spanData.type === 'agent' && record.agent) setAgentResult(record.agent);
    if (!record.recorder) return;
    if (error != null) applyError(record.recorder, error);
    await record.recorder.end();
  }

  // ---------------------------------------------------------------------------
  // Traces
  // ---------------------------------------------------------------------------

  private async closeTrace(traceId: string, error?: unknown): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    this.traces.delete(traceId);
    this.rememberClosed(traceId, trace);

    // Children first, so a turn error still reaches its agent before the agent ends.
    // A span can already be over with its end callback still queued behind another
    // processor; that one gets its normal ending.
    for (const spanId of [...trace.spanIds].reverse()) {
      const record = this.spans.get(spanId);
      if (!record) continue;
      if (record.sdkSpan.endedAt) await this.finishSpan(record);
      else await this.abandonSpan(record, error);
    }

    this.endContainerSpan(trace, error ?? trace.error);
  }

  private endContainerSpan(trace: TraceRecord, error: unknown): void {
    const span = trace.span;
    const errorType = error == null ? '' : (errorName(error) ?? '_OTHER');
    if (errorType) {
      span.setAttribute(ATTR_ERROR_TYPE, errorType);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: trace.mode === 'metadata_only' ? errorType : errorMessage(error),
      });
    }

    span.end(new Date(this.client.now()));
  }

  /**
   * Reopens a trace for a run resumed from a saved state, which reuses the trace of
   * the run it continues. A span delivered late by that earlier run is not a resume.
   */
  private reopenTrace(span: SdkSpan): TraceRecord | undefined {
    const closed = this.closed.get(span.traceId);
    if (closed && this.isLateDelivery(span, closed)) return undefined;
    const sdkTrace = this.getCurrentTrace?.();
    if (sdkTrace?.traceId !== span.traceId) return undefined;
    this.closed.delete(span.traceId);
    return this.openTrace(sdkTrace, true);
  }

  /**
   * A late delivery started before the trace closed, or runs inside one of the runs
   * that produced it; a resume is a new run that starts afterwards. Spans can start
   * in the same millisecond the trace closes, so a tie is decided by the run token
   * when there is one.
   */
  private isLateDelivery(span: SdkSpan, closed: ClosedTrace): boolean {
    const startedAt = parseSdkTimestamp(span.startedAt);
    if (startedAt === undefined || startedAt < closed.at) return true;
    const token = this.activeRunToken();
    return token ? closed.runTokens.has(token) : startedAt === closed.at;
  }

  private rememberClosed(traceId: string, trace: TraceRecord): void {
    // Compared with SDK timestamps, which use the wall clock, not `client.now()`.
    this.closed.set(traceId, { at: Date.now(), runTokens: trace.runTokens });
    for (const oldest of this.closed.keys()) {
      if (this.closed.size <= this.maxTraces) return;
      this.closed.delete(oldest);
    }
  }

  private markActive(traceId: string, trace: TraceRecord): void {
    this.traces.delete(traceId);
    this.traces.set(traceId, trace);
  }

  private evictIdleTraces(): void {
    for (const traceId of this.traces.keys()) {
      if (this.traces.size <= this.maxTraces) return;
      void this.safely('evict', () => this.closeTrace(traceId));
    }
  }

  private activeRunToken(): object | undefined {
    return otelContext.active().getValue(RUN_TOKEN_KEY) as object | undefined;
  }

  private activeRun(): RunState | undefined {
    const token = this.activeRunToken();
    return token ? this.runs.get(token) : undefined;
  }

  private safely<T>(where: string, fn: () => T): T | undefined {
    const warn = (err: unknown) =>
      this.client.config.logger.warn(`genai-otel: openai-agents ${where} failed`, err);
    try {
      const result = fn();
      if (result instanceof Promise) return result.catch(warn) as T;
      return result;
    } catch (err) {
      warn(err);
      return undefined;
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function setAgentResult(agent: AgentState): void {
  if (agent.input) agent.recorder.setInput(agent.input);
  if (agent.output) {
    agent.recorder.setOutput(agent.output);
    agent.recorder.setStopReason(finishReasonFor(agent.output));
  }
}

function setToolResult(recorder: ToolExecutionRecorder, span: SdkSpan): void {
  const data = span.spanData as SdkFunctionSpanData;
  // The SDK marks MCP tools only once they run.
  if (data.mcp_data) recorder.setToolType('mcp');
  // A failed tool's `output` is the SDK's fallback message, not a real result.
  recorder.setResult({
    arguments: data.input || undefined,
    result: span.error ? undefined : data.output || undefined,
  });
}

/** A `generation` span from `OpenAIChatCompletionsModel`: the request messages and the raw completion. */
function noteChatCompletionsCall(agent: AgentState | undefined, data: SdkGenerationSpanData): void {
  const completion = data.output?.[0] as { choices?: Array<{ message?: OAMessage }> } | undefined;
  noteModelCall(
    agent,
    mapOpenAIInput(data.input).filter((m) => m.role !== 'system'),
    mapOpenAIOutputMessage(completion?.choices?.[0]?.message),
  );
}

/** Keeps the first model input and the last model output seen under an agent. */
function noteModelCall(agent: AgentState | undefined, input: Message[], output: Message[]): void {
  if (!agent) return;
  if (!agent.input && input.length > 0) agent.input = input;
  if (output.length > 0) agent.output = output;
}

/**
 * Hands an error to a recorder. The recorder writes `error.type` itself when it
 * ends, so the bounded name goes in as an override, or not at all, which keeps the
 * recorder's own category (`tool_execution_error`, …).
 */
function applyError(recorder: Recorder, error: unknown): void {
  if (error == null) return;
  recorder.setCallError(error instanceof Error ? error : new Error(errorMessage(error)));
  recorder.setErrorType(errorName(error));
}

/**
 * A bounded error class name, or undefined. SDK error records put the useful part
 * in `data.error`, either as `"BoomError: message"` or as `{ name, … }`, and a
 * fixed text such as `'Error in agent run'` in `message`.
 */
function errorName(error: unknown): string | undefined {
  let candidate: unknown;
  if (error instanceof Error) {
    candidate = error.name;
  } else {
    const record = error as SdkSpanError;
    const detail = record?.data?.error as string | { name?: string } | undefined;
    candidate = typeof detail === 'string' ? detail : (detail?.name ?? record?.message);
  }
  if (typeof candidate !== 'string') return undefined;
  const name = candidate.split(':')[0]?.trim() ?? '';
  return ERROR_NAME.test(name) ? name : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

function applyMetadataAttributes(span: Span, metadata: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      span.setAttribute(`genai.metadata.${key}`, value);
    }
  }
}
