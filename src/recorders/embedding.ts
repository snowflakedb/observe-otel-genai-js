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
 * `EmbeddingRecorder` — wraps an embeddings API call.
 *
 * Mirrors the GenerationRecorder shape but with a smaller payload: an
 * `EmbeddingResult` carries input/output counts and dimensions. Input texts
 * are optionally captured (truncated + sampled) per `EmbeddingCaptureConfig`.
 */

import type { Span } from '@opentelemetry/api';
import type { ContentCaptureMode } from '../content/capture.js';
import { ValidationError } from '../errors.js';
import type { EmbeddingResult, EmbeddingStart } from '../models/embedding.js';
import type { IdentityFields } from '../models/identity.js';
import {
  ERR_TYPE_PROVIDER_CALL,
  ERR_TYPE_VALIDATION,
  OP_EMBEDDINGS,
  TOKEN_TYPE_INPUT,
} from '../semconv.js';
import { applyEmbeddingEndAttributes, applyEmbeddingStartAttributes } from '../spans/attributes.js';
import { embeddingSpanName } from '../spans/names.js';
import { type ClassifiedError, RecorderBase, type RecorderHostContext } from './base.js';

export class EmbeddingRecorder extends RecorderBase {
  private readonly seed: EmbeddingStart;
  private result: EmbeddingResult | undefined;

  constructor(
    host: RecorderHostContext,
    span: Span,
    seed: EmbeddingStart,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
    handedDown?: IdentityFields,
  ) {
    super(host, span, startedAtMs, perCallContentCapture, handedDown);
    this.seed = seed;
  }

  setResult(result: EmbeddingResult): void {
    this.result = { ...(this.result ?? {}), ...result };
  }

  protected async finalize(): Promise<void> {
    const completedAtMs = this.resolveCompletedAtMs();
    this.completedAtMs = completedAtMs;

    const { mode } = this.resolveContentCapture();
    const stripped = mode === 'metadata_only';

    this.span.updateName(embeddingSpanName(this.seed.model.name));

    const result = this.result ?? {};
    const captureCfg = this.host.config.embeddingCapture;
    const capturedTexts =
      !stripped && captureCfg.captureInput
        ? sampleTexts(result.inputTexts ?? [], captureCfg.maxInputItems, captureCfg.maxTextLength)
        : undefined;

    applyEmbeddingEndAttributes(this.span, result, capturedTexts);

    // Privacy-gated exception recording.
    this.recordExceptionIfAny(this.callError, stripped);

    let classified: ClassifiedError;
    if (this.callError != null) {
      classified = this.classify(this.callError, ERR_TYPE_PROVIDER_CALL, stripped);
    } else if (this.localError instanceof ValidationError) {
      classified = this.classify(this.localError, ERR_TYPE_VALIDATION, false);
      this.recordSdkException(this.localError);
    } else {
      classified = { errorType: '', errorCategory: '', statusMessage: '' };
    }
    this.setSpanStatus(classified);

    const labels = {
      operationName: OP_EMBEDDINGS,
      providerName: this.seed.model.provider,
      requestModel: this.seed.model.name,
      agentName: this.seed.agentName ?? '',
      conversationId: this.seed.conversationId,
      userId: this.seed.userId,
    };
    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    this.host.metrics.recordOperationDuration(durationSeconds, {
      ...labels,
      errorType: classified.errorType,
      errorCategory: classified.errorCategory,
    });
    this.host.metrics.recordTokenUsage(result.inputTokens ?? 0, TOKEN_TYPE_INPUT, labels);

    this.span.end(new Date(completedAtMs));
  }

  // Re-apply start attributes (used by Client when starting the span; kept
  // here so it lives near the rest of the embedding emission logic).
  static applyStartAttributes(span: Span, seed: EmbeddingStart): void {
    applyEmbeddingStartAttributes(span, seed);
  }
}

function sampleTexts(texts: readonly string[], maxItems: number, maxLen: number): string[] {
  if (texts.length === 0) return [];
  const limit = maxItems > 0 ? maxItems : 20;
  const len = maxLen > 0 ? maxLen : 1024;
  const out: string[] = [];
  for (let i = 0; i < Math.min(texts.length, limit); i++) {
    const t = texts[i] ?? '';
    if (t.length <= len) out.push(t);
    else if (len <= 3) out.push(t.slice(0, len));
    else out.push(`${t.slice(0, len - 3)}...`);
  }
  return out;
}
