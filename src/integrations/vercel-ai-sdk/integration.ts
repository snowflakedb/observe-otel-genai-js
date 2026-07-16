/**
 * AI SDK v7 `Telemetry` integration for genai-otel.
 *
 * Register once via `registerTelemetry(genaiTelemetryIntegration(client))` and
 * every `generateText` / `streamText` / `ToolLoopAgent` / `generateObject` call
 * in the process emits genai-otel spans — no per-call-site wiring.
 *
 * Span tree (GenAI semconv): `invoke_agent` (operation) → `chat` (per step) →
 * `execute_tool` (per tool). Parenting is achieved without AsyncLocalStorage:
 * the operation span is opened in `onStart`, and every child span's *creation*
 * is wrapped in the parent recorder's `withActiveContext`, which installs the
 * parent as the active OTel span for the synchronous `startSpan` call.
 *
 * Correlation: every lifecycle event carries a `callId`; per-operation state is
 * keyed on it, so concurrent operations stay isolated.
 *
 * Runtime decoupling: only the `Telemetry` *type* is imported from `ai` (erased
 * at compile time). Event payloads are read through the loose duck-typed
 * interfaces in `_map.ts`, so this module has no runtime dependency on `ai`.
 */

import type { Telemetry } from 'ai';
import type { Client } from '../../client.js';
import { type Message, assistantTextMessage } from '../../models/message.js';
import type { AgentInvocationRecorder } from '../../recorders/agent.js';
import { OP_CHAT, OP_GENERATE_CONTENT, type OperationName } from '../../semconv.js';
import {
  type AiAbortEvent,
  type AiObjectStepEndEvent,
  type AiObjectStepStartEvent,
  type AiOperationEndEvent,
  type AiOperationStartEvent,
  type AiStepFinishEvent,
  type AiStepStartEvent,
  type AiToolExecutionEndEvent,
  type AiToolExecutionStartEvent,
  mapModelMessages,
  mapProviderPrompt,
  mapStepContent,
} from './_map.js';
import { type VercelAdapterOptions, identityFields, mapAiUsage, modelRefFromAi } from './_model.js';

type GenerationRec = ReturnType<Client['startStreamingGeneration']>;
type ToolRec = ReturnType<Client['startToolExecution']>;

/** Event fields the {@link DeriveOptions} mapper reads to build per-turn identity. */
export interface DeriveOptionsEvent {
  /** `telemetry.functionId` for the call, if set. */
  readonly functionId?: string;
  /** The user-defined runtime context (already telemetry-filtered by the SDK). */
  readonly runtimeContext?: unknown;
  /** AI SDK operation id, e.g. `ai.streamText`. */
  readonly operationId?: string;
  readonly provider?: string;
  readonly modelId?: string;
}

/** Maps an operation-start event to genai-otel identity/tags for that turn. */
export type DeriveOptions = (event: DeriveOptionsEvent) => VercelAdapterOptions;

export interface GenaiTelemetryOptions {
  /**
   * Derives per-turn identity/tags from each operation's `functionId` +
   * `runtimeContext`. Defaults to {@link defaultDeriveOptions}, which reads
   * `functionId`/`runtimeContext.agent` → `agentName` and
   * `runtimeContext.{conversationId,userId}`.
   */
  deriveOptions?: DeriveOptions;
  /**
   * Whether to open an `invoke_agent` operation span wrapping the steps. `true`
   * (default) matches the GenAI semantic conventions (and `@ai-sdk/otel`). Pass
   * a predicate to emit it only for some calls (e.g. real agents but not
   * one-shot `generateObject` sites). When suppressed, `chat`/`execute_tool`
   * spans are emitted without an operation parent.
   */
  emitOperationSpan?: boolean | ((event: DeriveOptionsEvent) => boolean);
}

/** Default identity mapper: functionId → agentName, plus runtimeContext fields. */
export function defaultDeriveOptions(event: DeriveOptionsEvent): VercelAdapterOptions {
  const rc = (event.runtimeContext ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    agentName: event.functionId ?? str(rc.agent),
    conversationId: str(rc.conversationId),
    userId: str(rc.userId),
  };
}

interface StepState {
  rec: GenerationRec;
  closedToolCallIds: Set<string>;
}

/** Per-operation state, keyed by the AI SDK `callId`. */
interface OpState {
  agent?: AgentInvocationRecorder;
  options: VercelAdapterOptions;
  steps: Map<number, StepState>;
  latestStep?: StepState;
  tools: Map<string, ToolRec>;
  closed: boolean;
}

/**
 * Owns the per-operation registry and translates AI SDK lifecycle events into
 * genai-otel recorder calls. One instance backs one registered integration.
 */
class GenaiTelemetry {
  private readonly ops = new Map<string, OpState>();

  constructor(
    private readonly client: Client,
    private readonly deriveOptions: DeriveOptions,
    private readonly emitOperationSpan: boolean | ((event: DeriveOptionsEvent) => boolean),
  ) {}

  onStart(event: AiOperationStartEvent): void {
    const deriveEvent: DeriveOptionsEvent = {
      functionId: (event as { functionId?: string }).functionId,
      runtimeContext: event.runtimeContext,
      operationId: event.operationId,
      provider: event.provider,
      modelId: event.modelId,
    };
    const options = this.deriveOptions(deriveEvent);
    const wantAgent =
      typeof this.emitOperationSpan === 'function'
        ? this.emitOperationSpan(deriveEvent)
        : this.emitOperationSpan;

    let agent: AgentInvocationRecorder | undefined;
    if (wantAgent) {
      const input = this.recordInputs(event) ? mapModelMessages(event.messages ?? []) : undefined;
      agent = this.client.invokeAgent({
        agentName: options.agentName ?? 'agent',
        agentVersion: options.agentVersion,
        conversationId: options.conversationId,
        userId: options.userId,
        requestProvider: event.provider,
        requestModel: event.modelId,
        tags: options.tags,
        metadata: options.metadata,
        parentGenerationIds: options.parentGenerationIds,
        startedAt: this.client.now(),
        ...(input && input.length > 0 ? { input } : {}),
      });
    }

    this.ops.set(event.callId, {
      agent,
      options,
      steps: new Map(),
      tools: new Map(),
      closed: false,
    });
  }

  onStepStart(event: AiStepStartEvent): void {
    const op = this.get(event.callId);
    if (!op) return;
    const systemPrompt = typeof event.instructions === 'string' ? event.instructions : undefined;
    const input = this.recordInputs(event) ? mapModelMessages(event.messages ?? []) : [];
    this.openStep(
      op,
      event.stepNumber,
      { provider: event.provider, modelId: event.modelId },
      {
        operationName: OP_CHAT,
        systemPrompt,
        input,
      },
    );
  }

  onObjectStepStart(event: AiObjectStepStartEvent): void {
    const op = this.get(event.callId);
    if (!op) return;
    const { messages, systemPrompt } = mapProviderPrompt(event.promptMessages ?? []);
    this.openStep(
      op,
      event.stepNumber ?? 0,
      { provider: event.provider, modelId: event.modelId },
      {
        operationName: OP_GENERATE_CONTENT,
        systemPrompt,
        input: this.recordInputs(event) ? messages : [],
      },
    );
  }

  onToolExecutionStart(event: AiToolExecutionStartEvent): void {
    const op = this.get(event.callId);
    if (!op || !op.latestStep) return;
    // Create the tool span under the latest open step (v7 tool events carry no
    // stepNumber; within an op the tool-loop runs steps sequentially, so the
    // latest open step is the correct parent).
    const rec = op.latestStep.rec.withActiveContext(() =>
      this.client.startToolExecution({
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        agentName: op.options.agentName,
        agentVersion: op.options.agentVersion,
        conversationId: op.options.conversationId,
      }),
    );
    rec.setResult({ arguments: event.toolCall.input });
    op.tools.set(event.toolCall.toolCallId, rec);
  }

  async onToolExecutionEnd(event: AiToolExecutionEndEvent): Promise<void> {
    const op = this.get(event.callId);
    const rec = op?.tools.get(event.toolCall.toolCallId);
    if (!op || !rec) return;
    op.tools.delete(event.toolCall.toolCallId);
    // Mark handled across all open steps so the onStepEnd fallback doesn't
    // double-record this tool.
    for (const [, step] of op.steps) step.closedToolCallIds.add(event.toolCall.toolCallId);

    const out = event.toolOutput;
    if (out?.type === 'tool-error') {
      rec.setExecError(out.error);
    } else if (out?.type === 'tool-result') {
      rec.setResult({ result: out.output });
    }
    await end(rec);
  }

  async onStepEnd(event: AiStepFinishEvent): Promise<void> {
    const op = this.get(event.callId);
    if (!op) return;
    const step = op.steps.get(event.stepNumber);
    op.steps.delete(event.stepNumber);
    if (op.latestStep === step) op.latestStep = undefined;
    if (!step) return;
    step.rec.setResult({
      output: this.recordOutputs(event) ? mapStepContent(event.content) : undefined,
      usage: mapAiUsage(event.usage),
      stopReason: event.finishReason,
      responseId: event.response?.id,
      responseModel: event.response?.modelId,
    });
    await end(step.rec);
    await this.emitUnhandledTools(op, step, event);
  }

  async onObjectStepEnd(event: AiObjectStepEndEvent): Promise<void> {
    const op = this.get(event.callId);
    if (!op) return;
    const step = op.steps.get(0);
    op.steps.delete(0);
    if (op.latestStep === step) op.latestStep = undefined;
    if (!step) return;
    const output =
      this.recordOutputs(event) &&
      typeof event.objectText === 'string' &&
      event.objectText.length > 0
        ? [assistantTextMessage(event.objectText)]
        : undefined;
    step.rec.setResult({
      output,
      usage: mapAiUsage(event.usage),
      stopReason: event.finishReason,
      responseId: event.response?.id,
      responseModel: event.response?.modelId,
    });
    await end(step.rec);
  }

  async onEnd(event: AiOperationEndEvent): Promise<void> {
    const op = this.get(event.callId);
    if (!op) return;
    if (op.agent && this.recordOutputs(event) && Array.isArray(event.content)) {
      const output = mapStepContent(event.content);
      if (output.length > 0) op.agent.setOutput(output);
    }
    await this.closeOp(event.callId, op);
  }

  async onAbort(event: AiAbortEvent): Promise<void> {
    const op = this.get(event.callId);
    if (!op) return;
    op.agent?.setError(event.reason ?? new Error('operation aborted'));
    await this.closeOp(event.callId, op, event.reason ?? new Error('operation aborted'));
  }

  /**
   * Runs the provider model call, attributing failures to the op that owns
   * `callId` (the only error signal that carries a callId — `onError` does
   * not). Rethrows so the SDK's own error flow is unaffected.
   */
  async executeLanguageModelCall<T>(callId: string, execute: () => PromiseLike<T>): Promise<T> {
    try {
      return await execute();
    } catch (err) {
      const op = this.ops.get(callId);
      if (op) await this.closeOp(callId, op, err);
      throw err;
    }
  }

  /**
   * Best-effort fallback for the untyped `onError` (no callId): if exactly one
   * operation is open, attribute the error to it. With zero or multiple open
   * operations the error cannot be safely attributed and is skipped (the
   * per-call `executeLanguageModelCall` path already covers model failures).
   */
  async onError(error: unknown): Promise<void> {
    if (this.ops.size !== 1) return;
    const entry = [...this.ops][0];
    if (!entry) return;
    await this.closeOp(entry[0], entry[1], error);
  }

  // --- internals ---

  private get(callId: string | undefined): OpState | undefined {
    if (callId === undefined) return undefined;
    const op = this.ops.get(callId);
    return op && !op.closed ? op : undefined;
  }

  private openStep(
    op: OpState,
    stepNumber: number,
    model: { provider: string; modelId: string },
    extra: { operationName: OperationName; systemPrompt?: string; input: Message[] },
  ): void {
    const create = () =>
      this.client.startStreamingGeneration({
        model: modelRefFromAi(model),
        operationName: extra.operationName,
        ...identityFields(op.options),
        startedAt: this.client.now(),
        systemPrompt: extra.systemPrompt,
        tags: op.options.tags,
        metadata: op.options.metadata,
        parentGenerationIds: op.options.parentGenerationIds,
      });
    const rec = op.agent ? op.agent.withActiveContext(create) : create();
    if (extra.input.length > 0) rec.setResult({ input: extra.input });
    const step: StepState = { rec, closedToolCallIds: new Set() };
    op.steps.set(stepNumber, step);
    op.latestStep = step;
  }

  /** Emits execute_tool spans for tool calls in the step not seen via onToolExecutionEnd. */
  private async emitUnhandledTools(
    op: OpState,
    step: StepState,
    event: AiStepFinishEvent,
  ): Promise<void> {
    const toolErrors = new Map<string, unknown>();
    for (const part of event.content) {
      if (part.type === 'tool-error' && part.toolCallId)
        toolErrors.set(part.toolCallId, part.error);
    }
    const toolResults = new Map<string, unknown>();
    for (const tr of event.toolResults) toolResults.set(tr.toolCallId, tr.output);

    for (const tc of event.toolCalls) {
      if (step.closedToolCallIds.has(tc.toolCallId)) continue;
      let rec = op.tools.get(tc.toolCallId);
      if (rec) {
        op.tools.delete(tc.toolCallId);
      } else {
        rec = step.rec.withActiveContext(() =>
          this.client.startToolExecution({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            requestModel: event.model?.modelId,
            requestProvider: event.model?.provider,
            agentName: op.options.agentName,
            agentVersion: op.options.agentVersion,
            conversationId: op.options.conversationId,
          }),
        );
        rec.setResult({ arguments: tc.input });
      }
      if (toolErrors.has(tc.toolCallId)) {
        rec.setExecError(toolErrors.get(tc.toolCallId));
      } else if (toolResults.has(tc.toolCallId)) {
        rec.setResult({ result: toolResults.get(tc.toolCallId) });
      }
      step.closedToolCallIds.add(tc.toolCallId);
      await end(rec);
    }
  }

  private async closeOp(callId: string, op: OpState, error?: unknown): Promise<void> {
    if (op.closed) return;
    op.closed = true;
    this.ops.delete(callId);
    // Close any still-open step/tool recorders (error path or abandoned turn).
    for (const [, step] of op.steps) {
      if (error !== undefined) step.rec.setCallError(error);
      await end(step.rec);
    }
    for (const [, rec] of op.tools) {
      if (error !== undefined) rec.setExecError(error);
      await end(rec);
    }
    if (op.agent) {
      if (error !== undefined) op.agent.setError(error);
      await end(op.agent);
    }
  }

  private recordInputs(event: unknown): boolean {
    return (event as { recordInputs?: boolean }).recordInputs !== false;
  }

  private recordOutputs(event: unknown): boolean {
    return (event as { recordOutputs?: boolean }).recordOutputs !== false;
  }
}

/** Ends a recorder, swallowing flush errors (mirrors the hook-bag behavior). */
async function end(rec: { end(): Promise<void> }): Promise<void> {
  try {
    await rec.end();
  } catch {
    /* ignore recorder flush errors */
  }
}

/**
 * Builds a genai-otel `Telemetry` integration. Register once at startup:
 *
 *   import { registerTelemetry } from 'ai';
 *   registerTelemetry(genaiTelemetryIntegration(client, { deriveOptions }));
 *
 * The handlers cast each event to a loose duck-typed shape (we read only a safe
 * subset of fields); this is contravariantly sound because we accept the SDK's
 * richer event and narrow inside.
 */
export function genaiTelemetryIntegration(
  client: Client,
  options: GenaiTelemetryOptions = {},
): Telemetry {
  const impl = new GenaiTelemetry(
    client,
    options.deriveOptions ?? defaultDeriveOptions,
    options.emitOperationSpan ?? true,
  );
  return {
    onStart: (e) => {
      impl.onStart(e as unknown as AiOperationStartEvent);
    },
    onStepStart: (e) => {
      impl.onStepStart(e as unknown as AiStepStartEvent);
    },
    onToolExecutionStart: (e) => {
      impl.onToolExecutionStart(e as unknown as AiToolExecutionStartEvent);
    },
    onToolExecutionEnd: (e) => impl.onToolExecutionEnd(e as unknown as AiToolExecutionEndEvent),
    onStepEnd: (e) => impl.onStepEnd(e as unknown as AiStepFinishEvent),
    onObjectStepStart: (e) => {
      impl.onObjectStepStart(e as unknown as AiObjectStepStartEvent);
    },
    onObjectStepEnd: (e) => impl.onObjectStepEnd(e as unknown as AiObjectStepEndEvent),
    onEnd: (e) => impl.onEnd(e as unknown as AiOperationEndEvent),
    onAbort: (e) => impl.onAbort(e as unknown as AiAbortEvent),
    onError: (e) => impl.onError(e),
    executeLanguageModelCall: ({ callId, execute }) =>
      impl.executeLanguageModelCall(callId, execute),
  };
}
