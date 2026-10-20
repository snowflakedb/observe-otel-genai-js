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
 * The Vercel adapter's `genaiTelemetryIntegration` drives this automatically
 * from the AI SDK telemetry lifecycle — prefer it when instrumenting AI SDK
 * agents.
 */

import type { Span } from '@opentelemetry/api';
import { type ContentCaptureMode, omitsContent } from '../content/capture.js';
import { emitAgentContent } from '../content/sink.js';
import type { AgentCreationStart, AgentInvocationStart } from '../models/agent.js';
import type { IdentityFields } from '../models/identity.js';
import type { Message } from '../models/message.js';
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
  private inputMessages: Message[] | undefined;
  private outputMessages: Message[] | undefined;
  private stopReason: string | undefined;

  constructor(
    host: RecorderHostContext,
    span: Span,
    seed: AgentInvocationStart,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
    handedDown?: IdentityFields,
  ) {
    super(host, span, startedAtMs, perCallContentCapture, handedDown);
    this.seed = seed;
  }

  /** Records the agent's input when it is only known after the span started. Replaces `seed.input`. */
  setInput(messages: Message[]): void {
    this.inputMessages = messages;
  }

  /**
   * Records the agent's final output as structured chat messages. Emitted as
   * the standard `gen_ai.output.messages` attribute (subject to content-capture
   * config). Callers with a raw string should wrap it via
   * `assistantTextMessage(text)`.
   */
  setOutput(messages: Message[]): void {
    this.outputMessages = messages;
  }

  /**
   * Records the finish reason for the agent's final turn (e.g. the AI SDK's
   * `finishReason`). Used to populate the semconv-required `finish_reason` on
   * `gen_ai.output.messages`; when unset it is derived from error state.
   */
  setStopReason(reason: string | undefined): void {
    this.stopReason = reason;
  }

  /** Alias for setCallError matching the AgentInvocationRecorder docs. */
  setError(err: unknown): void {
    this.setCallError(err);
  }

  protected async finalize(): Promise<void> {
    const completedAtMs = this.resolveCompletedAtMs();
    this.completedAtMs = completedAtMs;
    const { mode, config: captureConfig } = this.resolveContentCapture();
    const stripped = omitsContent(mode);

    this.span.updateName(agentSpanName(this.seed.agentName));
    applyAgentAttributes(this.span, this.seed);

    if (!stripped && captureConfig.enabled) {
      emitAgentContent(
        this.span,
        this.inputMessages ?? this.seed.input,
        this.outputMessages,
        captureConfig,
        this.stopReason,
        this.callError != null,
        mode,
      );
    }

    this.recordExceptionIfAny(this.callError, mode);
    const classified =
      this.callError != null
        ? this.classify(this.callError, ERR_TYPE_PROVIDER_CALL, stripped)
        : { errorType: '', errorCategory: '' as const, statusMessage: '' };
    this.setSpanStatus(classified);

    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    this.host.metrics.recordOperationDuration(durationSeconds, {
      operationName: OP_INVOKE_AGENT,
      providerName: this.seed.requestProvider ?? '',
      requestModel: this.seed.requestModel ?? '',
      agentName: this.seed.agentName ?? '',
      conversationId: this.seed.conversationId,
      userId: this.seed.userId,
      errorType: classified.errorType,
      errorCategory: classified.errorCategory,
    });

    this.span.end(new Date(completedAtMs));
  }

  static applyStartAttributes(span: Span, seed: AgentInvocationStart): void {
    applyAgentAttributes(span, seed);
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
    const completedAtMs = this.resolveCompletedAtMs();
    this.completedAtMs = completedAtMs;
    const { mode } = this.resolveContentCapture();
    const stripped = omitsContent(mode);

    this.span.updateName(agentCreateSpanName(this.seed.agentName));
    applyAgentCreationAttributes(this.span, this.seed);

    this.recordExceptionIfAny(this.callError, mode);
    const classified =
      this.callError != null
        ? this.classify(this.callError, ERR_TYPE_VALIDATION, stripped)
        : { errorType: '', errorCategory: '' as const, statusMessage: '' };
    this.setSpanStatus(classified);

    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    this.host.metrics.recordOperationDuration(durationSeconds, {
      operationName: OP_CREATE_AGENT,
      providerName: this.seed.requestProvider ?? '',
      requestModel: this.seed.requestModel ?? '',
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
