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
 * AI SDK v7 `Telemetry` integration for genai-otel.
 *
 * Register once via `registerTelemetry(genaiTelemetryIntegration(client))` and
 * every `generateText` / `streamText` / `ToolLoopAgent` / `generateObject` call
 * in the process emits genai-otel spans — no per-call-site wiring.
 *
 * Span tree (GenAI semconv): `invoke_agent` (operation) → `chat` (per step) and
 * `execute_tool` (per tool), side by side. A `chat` span ends with its model call,
 * before the step's tools run. The operation span is opened in `onStart`, and every
 * child span's *creation* is wrapped in the parent recorder's `withActiveContext`,
 * which installs the parent as the active OTel span, and its identity as the
 * enclosing scope, for the synchronous `startSpan` call. Separately,
 * `executeTool` re-activates the `execute_tool` span for the duration of
 * `tool.execute` so auto-instrumented work inside the tool (HTTP/undici, nested
 * `generateText`, …) parents under that span rather than an ambient ancestor.
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
  type AiErrorEvent,
  type AiLanguageModelCallEndEvent,
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
import {
  type VercelAdapterOptions,
  identityFields,
  mapAiUsage,
  modelRefFromAi,
  normalizeAiSdkProviderName,
} from './_model.js';

type GenerationRec = ReturnType<Client['startGeneration']>;
type ToolRec = ReturnType<Client['startToolExecution']>;

/** AI SDK operations that get an `invoke_agent` span; `embed`, `embedMany` and `rerank` do not. */
const TRACED_OPERATIONS = new Set([
  'ai.generateText',
  'ai.streamText',
  'ai.generateObject',
  'ai.streamObject',
]);

/** Operations whose steps are recorded as streamed (`gen_ai.request.stream: true`). */
const STREAMED_OPERATIONS = new Set(['ai.streamText', 'ai.streamObject']);

/** An agent's name when nothing names it, such as a call with no `functionId`. */
const DEFAULT_AGENT_NAME = 'ai-sdk';

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
   * one-shot `generateObject` sites). When suppressed, `chat` spans have no
   * operation parent, and `execute_tool` spans sit under the `chat` span that
   * asked for them.
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
  streamed: boolean;
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
    if (!event.operationId || !TRACED_OPERATIONS.has(event.operationId)) return;
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
        agentName: options.agentName,
        fallbackAgentName: DEFAULT_AGENT_NAME,
        agentVersion: options.agentVersion,
        conversationId: options.conversationId,
        userId: options.userId,
        requestProvider: event.provider ? normalizeAiSdkProviderName(event.provider) : undefined,
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
      streamed: STREAMED_OPERATIONS.has(event.operationId),
      steps: new Map(),
      tools: new Map(),
      closed: false,
    });
  }

  onStepStart(event: AiStepStartEvent): void {
    const op = this.get(event.callId);
    if (!op) return;
    const recordInputs = this.recordInputs(event);
    const systemPrompt =
      recordInputs && typeof event.instructions === 'string' ? event.instructions : undefined;
    const input = recordInputs ? mapModelMessages(event.messages ?? []) : [];
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
    const recordInputs = this.recordInputs(event);
    const { messages, systemPrompt } = mapProviderPrompt(event.promptMessages ?? []);
    this.openStep(
      op,
      event.stepNumber ?? 0,
      { provider: event.provider, modelId: event.modelId },
      {
        operationName: OP_GENERATE_CONTENT,
        systemPrompt: recordInputs ? systemPrompt : undefined,
        input: recordInputs ? messages : [],
      },
    );
  }

  /**
   * Stamps the step's `chat` span with the model call's end time, so it leaves out
   * tool time. The span ends later, in onStepEnd, which carries the output and usage.
   * The event has no step number; steps run one at a time, so it is the latest step.
   */
  onLanguageModelCallEnd(event: AiLanguageModelCallEndEvent): void {
    this.get(event.callId)?.latestStep?.rec.setEndedAt(this.client.now());
  }

  onToolExecutionStart(event: AiToolExecutionStartEvent): void {
    const op = this.get(event.callId);
    if (!op) return;
    const rec = this.underToolParent(op, op.latestStep, () =>
      this.client.startToolExecution({
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
      }),
    );
    if (this.recordInputs(event)) rec.setResult({ arguments: event.toolCall.input });
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
    } else if (out?.type === 'tool-result' && this.recordOutputs(event)) {
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
    if (op.agent && event.finishReason) op.agent.setStopReason(event.finishReason);
    await this.closeOp(event.callId, op);
  }

  async onAbort(event: AiAbortEvent): Promise<void> {
    const op = this.get(event.callId);
    if (!op) return;
    op.agent?.setError(event.reason ?? new Error('operation aborted'));
    await this.closeOp(event.callId, op, event.reason ?? new Error('operation aborted'));
  }

  /**
   * Runs `tool.execute` with the matching `execute_tool` span installed as the
   * active OTel span. The AI SDK calls this between `onToolExecutionStart` and
   * `onToolExecutionEnd`, so the recorder is already in `op.tools`. Without this,
   * auto-instrumented work inside the tool (HTTP clients, nested generations)
   * would parent under whatever ambient context was active when the operation
   * started — typically a request/agent ancestor, not the tool span.
   *
   * Falls through to bare `execute()` when the recorder is missing (unknown
   * callId/toolCallId, or a tool path that skipped `onToolExecutionStart`).
   */
  async executeTool<T>(
    callId: string,
    toolCallId: string,
    execute: () => PromiseLike<T>,
  ): Promise<T> {
    const rec = this.ops.get(callId)?.tools.get(toolCallId);
    if (!rec) return await execute();
    return await rec.withActiveContext(() => execute());
  }

  async onError(event: AiErrorEvent): Promise<void> {
    const op = this.get(event.callId);
    if (!op) return;
    await this.closeOp(event.callId, op, event.error);
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
    const seed = {
      model: modelRefFromAi(model),
      operationName: extra.operationName,
      ...identityFields(op.options),
      startedAt: this.client.now(),
      systemPrompt: extra.systemPrompt,
      tags: op.options.tags,
      metadata: op.options.metadata,
      parentGenerationIds: op.options.parentGenerationIds,
    };
    const rec = this.underAgent(op, () =>
      op.streamed ? this.client.startStreamingGeneration(seed) : this.client.startGeneration(seed),
    );
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
        rec = this.underToolParent(op, step, () =>
          this.client.startToolExecution({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            requestModel: event.model?.modelId,
            requestProvider: event.model?.provider
              ? normalizeAiSdkProviderName(event.model.provider)
              : undefined,
          }),
        );
        if (this.recordInputs(event)) rec.setResult({ arguments: tc.input });
      }
      if (toolErrors.has(tc.toolCallId)) {
        rec.setExecError(toolErrors.get(tc.toolCallId));
      } else if (toolResults.has(tc.toolCallId) && this.recordOutputs(event)) {
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

  /** Starts a span under the operation's `invoke_agent` span, if it has one. */
  private underAgent<T>(op: OpState, start: () => T): T {
    return op.agent ? op.agent.withActiveContext(start) : start();
  }

  /**
   * Starts a tool span under `invoke_agent`, next to the step's `chat` span. With
   * no `invoke_agent` span it goes under the `chat` span, so the run stays one trace.
   */
  private underToolParent<T>(op: OpState, step: StepState | undefined, start: () => T): T {
    const parent = op.agent ?? step?.rec;
    return parent ? parent.withActiveContext(start) : start();
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
    onLanguageModelCallEnd: (e) => {
      impl.onLanguageModelCallEnd(e as unknown as AiLanguageModelCallEndEvent);
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
    onError: (e) => impl.onError(e as AiErrorEvent),
    executeTool: ({ callId, toolCallId, execute }) => impl.executeTool(callId, toolCallId, execute),
  };
}
