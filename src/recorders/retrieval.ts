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
 * `RetrievalRecorder` — wraps a `retrieval` span (kind CLIENT): a RAG context
 * fetch from a vector DB / search system. `setDocuments` records the results;
 * `end()` emits the opt-in query/documents through the sink and the duration
 * metric.
 */

import type { Span } from '@opentelemetry/api';
import { type ContentCaptureMode, omitsContent } from '../content/capture.js';
import { emitRetrievalContent } from '../content/sink.js';
import type { HandedDown } from '../context.js';
import type { RetrievalDocument, RetrievalResult, RetrievalStart } from '../models/retrieval.js';
import { ERR_TYPE_PROVIDER_CALL, OP_RETRIEVAL } from '../semconv.js';
import { applyRetrievalAttributes } from '../spans/attributes.js';
import { retrievalSpanName } from '../spans/names.js';
import { RecorderBase, type RecorderHostContext } from './base.js';

export class RetrievalRecorder extends RecorderBase {
  private readonly seed: RetrievalStart;
  private result: RetrievalResult | undefined;

  constructor(
    host: RecorderHostContext,
    span: Span,
    seed: RetrievalStart,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
    handedDown?: HandedDown,
  ) {
    super(host, span, startedAtMs, perCallContentCapture, handedDown);
    this.seed = seed;
  }

  setResult(result: RetrievalResult): void {
    this.result = { ...(this.result ?? {}), ...result };
  }

  setDocuments(documents: RetrievalDocument[]): void {
    this.setResult({ documents });
  }

  protected async finalize(): Promise<void> {
    const completedAtMs = this.resolveCompletedAtMs();
    this.completedAtMs = completedAtMs;

    const { mode, config: captureConfig } = this.resolveContentCapture();
    const stripped = omitsContent(mode);
    // retrieval carries external content with similar sensitivity to tool payloads,
    // so users who opt out of tool content are opted out of retrieval content too.
    const allowRetrievalContent = !stripped && mode !== 'no_tool_content';

    const result = this.result ?? {};

    this.span.updateName(retrievalSpanName(this.seed.dataSourceId ?? ''));
    applyRetrievalAttributes(this.span, this.seed);

    if (allowRetrievalContent && captureConfig.enabled) {
      emitRetrievalContent(this.span, this.seed.queryText, result.documents, captureConfig);
    }

    this.recordExceptionIfAny(this.callError, mode);
    const classified =
      this.callError != null
        ? this.classify(this.callError, ERR_TYPE_PROVIDER_CALL, stripped)
        : { errorType: '', errorCategory: '' as const, statusMessage: '' };
    this.setSpanStatus(classified);

    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    this.host.metrics.recordOperationDuration(durationSeconds, {
      operationName: OP_RETRIEVAL,
      providerName: this.seed.provider ?? '',
      requestModel: this.seed.requestModel ?? '',
      agentName: this.seed.agentName ?? '',
      conversationId: this.seed.conversationId,
      userId: this.seed.userId,
      errorType: classified.errorType,
      errorCategory: classified.errorCategory,
    });

    this.span.end(new Date(completedAtMs));
  }

  static applyStartAttributes(span: Span, seed: RetrievalStart): void {
    applyRetrievalAttributes(span, seed);
  }
}
