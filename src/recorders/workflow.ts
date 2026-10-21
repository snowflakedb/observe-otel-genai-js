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
 * `WorkflowInvocationRecorder` — wraps an `invoke_workflow` span.
 *
 * A workflow chains steps together without deciding anything on its own, such
 * as a LangGraph graph with no agent in it. Use the callback variant
 * (`client.invokeWorkflow(seed, async (rec) => { ... })`) so the steps' spans
 * nest under it. Spans inside take its conversation id and user id; it has no
 * agent name to hand down, so they keep the enclosing agent's name, if any.
 */

import type { Span } from '@opentelemetry/api';
import { type ContentCaptureMode, omitsContent } from '../content/capture.js';
import { emitAgentContent } from '../content/sink.js';
import type { HandedDown } from '../context.js';
import { errorClassName } from '../errors/classify.js';
import type { Message } from '../models/message.js';
import type { WorkflowInvocationStart } from '../models/workflow.js';
import { applyWorkflowAttributes } from '../spans/attributes.js';
import { workflowSpanName } from '../spans/names.js';
import { RecorderBase, type RecorderHostContext } from './base.js';

export class WorkflowInvocationRecorder extends RecorderBase {
  private readonly seed: WorkflowInvocationStart;
  private inputMessages: Message[] | undefined;
  private outputMessages: Message[] | undefined;

  constructor(
    host: RecorderHostContext,
    span: Span,
    seed: WorkflowInvocationStart,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
    handedDown?: HandedDown,
  ) {
    super(host, span, startedAtMs, perCallContentCapture, handedDown);
    this.seed = seed;
  }

  /** Records the workflow's input when it is only known after the span started. Replaces `seed.input`. */
  setInput(messages: Message[]): void {
    this.inputMessages = messages;
  }

  /** Records the workflow's final output, emitted as `gen_ai.output.messages`. */
  setOutput(messages: Message[]): void {
    this.outputMessages = messages;
  }

  setError(err: unknown): void {
    this.setCallError(err);
  }

  protected async finalize(): Promise<void> {
    const completedAtMs = this.resolveCompletedAtMs();
    this.completedAtMs = completedAtMs;
    const { mode, config: captureConfig } = this.resolveContentCapture();
    const stripped = omitsContent(mode);

    this.span.updateName(workflowSpanName(this.seed.workflowName ?? ''));
    applyWorkflowAttributes(this.span, this.seed);

    if (!stripped && captureConfig.enabled) {
      emitAgentContent(
        this.span,
        this.inputMessages ?? this.seed.input,
        this.outputMessages,
        captureConfig,
        undefined,
        this.callError != null,
        mode,
      );
    }

    this.recordExceptionIfAny(this.callError, mode);
    // Named by its class, as the OpenAI Agents workflow span is: a workflow makes no call of its own.
    const classified =
      this.callError != null
        ? this.classify(this.callError, errorClassName(this.callError) ?? '_OTHER', stripped)
        : { errorType: '', errorCategory: '' as const, statusMessage: '' };
    this.setSpanStatus(classified);

    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    this.host.metrics.recordWorkflowDuration(durationSeconds, {
      workflowName: this.seed.workflowName,
      conversationId: this.seed.conversationId,
      userId: this.seed.userId,
      errorType: classified.errorType,
      errorCategory: classified.errorCategory,
    });

    this.span.end(new Date(completedAtMs));
  }
}
