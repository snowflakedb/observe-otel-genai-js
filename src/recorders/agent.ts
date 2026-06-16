/**
 * `AgentInvocationRecorder` — wraps an `invoke_agent` span.
 *
 * Designed to host nested generations / tool calls. Use the callback variant
 * (`client.invokeAgent(seed, async (rec) => { ... })`) to get automatic
 * parent/child trace structure via OTel's active-span context.
 *
 * The fluent variant (`const rec = client.invokeAgent(seed)`) does NOT auto-
 * parent children. The trace structure still works via timestamp ordering
 * and `gen_ai.conversation.id` joins, but you lose the explicit tree.
 *
 * For streaming agents — where the turn's work completes asynchronously after
 * the call returns, so the callback variant would end the span too early — use
 * the fluent variant together with `rec.withActiveContext(fn)` to parent the
 * stream's spans, then call `rec.end()` from the stream's onFinish/onError.
 */

import type { Span } from '@opentelemetry/api';
import type { ContentCaptureMode } from '../content/capture.js';
import type { AgentCreationStart, AgentInvocationStart } from '../models/agent.js';
import {
  ERR_TYPE_PROVIDER_CALL,
  ERR_TYPE_VALIDATION,
  OP_CREATE_AGENT,
  OP_INVOKE_AGENT,
} from '../semconv.js';
import { applyAgentAttributes, applyAgentCreationAttributes } from '../spans/attributes.js';
import { agentCreateSpanName, agentSpanName } from '../spans/names.js';
import { RecorderBase, type RecorderHostContext } from './base.js';

export class AgentInvocationRecorder extends RecorderBase {
  private readonly seed: AgentInvocationStart;
  private output: unknown | undefined;
  private outputSet = false;

  constructor(
    host: RecorderHostContext,
    span: Span,
    seed: AgentInvocationStart,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
  ) {
    super(host, span, startedAtMs, perCallContentCapture);
    this.seed = seed;
  }

  /**
   * Records the agent's final output / task result. Stored as
   * `genai.agent.output` on the span (serialized to JSON if not a string).
   */
  setOutput(output: unknown): void {
    this.output = output;
    this.outputSet = true;
  }

  /** Alias for setCallError matching the AgentInvocationRecorder docs. */
  setError(err: unknown): void {
    this.setCallError(err);
  }

  protected async finalize(): Promise<void> {
    const completedAtMs = this.host.now();
    this.completedAtMs = completedAtMs;
    const { mode } = this.resolveContentCapture();
    const stripped = mode === 'metadata_only';

    this.span.updateName(agentSpanName(this.seed.agentName));
    applyAgentAttributes(this.span, this.seed);

    if (this.outputSet && !stripped) {
      const text = typeof this.output === 'string' ? this.output : safeStringify(this.output);
      if (text) this.span.setAttribute('genai.agent.output', text);
    }

    this.recordExceptionIfAny(this.callError, stripped);
    const classified =
      this.callError != null
        ? this.classify(this.callError, ERR_TYPE_PROVIDER_CALL, stripped)
        : { errorType: '', errorCategory: '' as const, statusMessage: '' };
    this.setSpanStatus(classified);

    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    this.host.metrics.recordOperationDuration(durationSeconds, {
      operationName: OP_INVOKE_AGENT,
      providerName: '',
      requestModel: '',
      agentName: this.seed.agentName,
      errorType: classified.errorType,
      errorCategory: classified.errorCategory,
    });

    this.span.end(new Date(completedAtMs));
  }

  static applyStartAttributes(span: Span, seed: AgentInvocationStart): void {
    applyAgentAttributes(span, seed);
  }
}

function safeStringify(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '';
    }
  }
}

// -----------------------------------------------------------------------------
// AgentCreationRecorder
// -----------------------------------------------------------------------------

/**
 * `AgentCreationRecorder` — wraps an `create_agent` span.
 *
 * Captures the one-time setup work that happens when an agent is
 * initialized: loading config, registering tools, building the system
 * prompt, etc.
 *
 * Lifecycle is minimal: optional `setError(err)` if setup fails, then
 * `end()`. Use the callback variant on `Client.createAgent(seed, fn)` to
 * auto-end on body completion and auto-parent any nested spans.
 */
export class AgentCreationRecorder extends RecorderBase {
  private readonly seed: AgentCreationStart;

  constructor(
    host: RecorderHostContext,
    span: Span,
    seed: AgentCreationStart,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
  ) {
    super(host, span, startedAtMs, perCallContentCapture);
    this.seed = seed;
  }

  /** Records a setup-time error (e.g. tool registration threw). */
  setError(err: unknown): void {
    this.setCallError(err);
  }

  protected async finalize(): Promise<void> {
    const completedAtMs = this.host.now();
    this.completedAtMs = completedAtMs;
    const { mode } = this.resolveContentCapture();
    const stripped = mode === 'metadata_only';

    this.span.updateName(agentCreateSpanName(this.seed.agentName));
    applyAgentCreationAttributes(this.span, this.seed);

    this.recordExceptionIfAny(this.callError, stripped);
    const classified =
      this.callError != null
        ? this.classify(this.callError, ERR_TYPE_VALIDATION, stripped)
        : { errorType: '', errorCategory: '' as const, statusMessage: '' };
    this.setSpanStatus(classified);

    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    this.host.metrics.recordOperationDuration(durationSeconds, {
      operationName: OP_CREATE_AGENT,
      providerName: '',
      requestModel: '',
      agentName: this.seed.agentName,
      errorType: classified.errorType,
      errorCategory: classified.errorCategory,
    });

    this.span.end(new Date(completedAtMs));
  }

  static applyStartAttributes(span: Span, seed: AgentCreationStart): void {
    applyAgentCreationAttributes(span, seed);
  }
}
