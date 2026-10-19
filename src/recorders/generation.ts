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
 * `GenerationRecorder` — wraps an LLM call (streaming or non-streaming).
 *
 * Lifecycle:
 *   1. `Client.startGeneration(seed)` / `startStreamingGeneration(seed)` returns
 *      a recorder; the span is created and seed-attributes applied.
 *   2. User code calls the provider, then calls `setResult({ usage, output, ... })`.
 *      Streaming users also report TTFT — `setFirstTokenAt(t)` when they can see
 *      the first chunk arrive, or `setTimeToFirstToken(s)` when the provider
 *      hands them the duration instead.
 *   3. User calls `end()` (or `await using` cleanup does it). Finalize emits
 *      content as structured span attributes, refreshes attributes, records
 *      exceptions/status, records 1-6 histograms, and ends the span.
 */

import type { Span } from '@opentelemetry/api';
import type { ContentCaptureMode } from '../content/capture.js';
import { emitGenerationContent } from '../content/sink.js';
import { ValidationError } from '../errors.js';
import type { Generation, GenerationStart, ModelRef } from '../models/generation.js';
import type { IdentityFields } from '../models/identity.js';
import type { Message } from '../models/message.js';
import { normalizeUsage } from '../models/usage.js';
import {
  ATTR_CONVERSATION_TITLE,
  ATTR_RESPONSE_TIME_TO_FIRST_CHUNK,
  ERR_TYPE_MAPPING,
  ERR_TYPE_PROVIDER_CALL,
  ERR_TYPE_VALIDATION,
  OP_CHAT,
  TOKEN_TYPE_CACHE_CREATION,
  TOKEN_TYPE_CACHE_READ,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
  TOKEN_TYPE_REASONING,
} from '../semconv.js';
import { applyGenerationAttributes } from '../spans/attributes.js';
import { generationSpanName } from '../spans/names.js';
import { generateId } from '../util/id.js';
import { RecorderBase, type RecorderHostContext } from './base.js';

export class GenerationRecorder extends RecorderBase {
  private readonly seed: GenerationStart;
  private result: Partial<Generation> | undefined;
  private mappingError: unknown | undefined;
  private firstTokenAtMs: number | undefined;
  private timeToFirstTokenSeconds: number | undefined;
  private lastGeneration: Generation | undefined;

  constructor(
    host: RecorderHostContext,
    span: Span,
    seed: GenerationStart,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
    handedDown?: IdentityFields,
  ) {
    super(host, span, startedAtMs, perCallContentCapture, handedDown);
    this.seed = seed;
  }

  /**
   * Stores the (partial) generation result. Multiple calls overwrite previous
   * values; the recorder always emits the most-recent state on end().
   */
  setResult(result: Partial<Generation>): void {
    this.result = { ...(this.result ?? {}), ...result };
  }

  /** Optional: records when the first streaming token arrived for TTFT. */
  setFirstTokenAt(t: Date | number): void {
    const ms = t instanceof Date ? t.getTime() : t;
    if (Number.isFinite(ms)) this.firstTokenAtMs = ms;
  }

  /**
   * Optional: records time to first token directly, in seconds.
   *
   * For providers that report the duration themselves rather than letting you
   * observe the first chunk arrive — the Claude Agent SDK's `ttft_ms`, for one.
   * Takes precedence over {@link setFirstTokenAt}, which can only derive TTFT by
   * subtracting the span's start and so needs a real instant to work from.
   */
  setTimeToFirstToken(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) this.timeToFirstTokenSeconds = seconds;
  }

  /**
   * Stores a mapping error — used by provider adapters when normalization
   * from the provider's response shape into the SDK `Generation` shape fails.
   */
  setMappingError(err: unknown): void {
    if (err == null) return;
    this.mappingError = err;
  }

  /** Returns the merged generation that was emitted (for tests/debug). */
  get last(): Generation | undefined {
    return this.lastGeneration ? { ...this.lastGeneration } : undefined;
  }

  protected async finalize(): Promise<void> {
    const completedAtMs = this.resolveCompletedAtMs();
    this.completedAtMs = completedAtMs;
    const { mode, config: captureConfig } = this.resolveContentCapture();
    const isMetadataOnly = mode === 'metadata_only';

    // 1. Merge seed + result into the final generation payload.
    const generation = this.mergeSeedAndResult(completedAtMs);

    const stripped = isMetadataOnly;

    // 2. Update span name to reflect final operation + model.
    this.span.updateName(
      generationSpanName(
        generation.operationName ?? OP_CHAT,
        generation.model?.name ?? this.seed.model.name ?? '',
      ),
    );

    // 3. Emit content as structured span attributes.
    if (!stripped && captureConfig.enabled) {
      emitGenerationContent(this.span, generation, captureConfig, mode);
    } else if (stripped) {
      // Strip user-facing content from the merged payload so the attribute
      // application below does not leak the conversation title onto the span.
      generation.conversationTitle = '';
      generation.systemPrompt = '';
      generation.input = [];
      generation.output = [];
    }

    // 4. Apply the full attribute set (overwrites seed values).
    applyGenerationAttributes(this.span, {
      ...generation,
      // model may be a partial; rebuild a complete ref so attribute helpers
      // see provider + name.
      model: this.mergedModel(generation.model),
    });
    if (stripped) {
      // The "skip empty string" rule in setStr means an empty conversationTitle
      // would simply not set the attribute. We DO want a deliberate empty
      // value here so callers can tell the difference between "never set" and
      // "intentionally stripped".
      this.span.setAttribute(ATTR_CONVERSATION_TITLE, '');
    }
    const ttft = this.timeToFirstToken(generation);
    if (ttft !== undefined) this.span.setAttribute(ATTR_RESPONSE_TIME_TO_FIRST_CHUNK, ttft);

    // 5. Privacy-gated exception recording.
    this.recordExceptionIfAny(this.callError, stripped);
    this.recordExceptionIfAny(this.mappingError, stripped);

    // 6. Status + error metric labels.
    let classified: import('./base.js').ClassifiedError;
    if (this.callError != null) {
      classified = this.classify(this.callError, ERR_TYPE_PROVIDER_CALL, stripped);
    } else if (this.mappingError != null) {
      classified = this.classify(this.mappingError, ERR_TYPE_MAPPING, stripped);
    } else if (this.localError instanceof ValidationError) {
      classified = this.classify(this.localError, ERR_TYPE_VALIDATION, false);
      this.recordSdkException(this.localError);
    } else {
      classified = { errorType: '', errorCategory: '' as const, statusMessage: '' };
    }
    this.setSpanStatus(classified);

    // 7. Record histograms.
    this.recordMetrics(generation, completedAtMs, classified);

    // 8. Capture trace/span ids onto the result for downstream correlation.
    const spanCtx = this.span.spanContext();
    generation.traceId = spanCtx.traceId;
    generation.spanId = spanCtx.spanId;

    // 9. End the span with the explicit completion time.
    this.span.end(new Date(completedAtMs));
    this.lastGeneration = generation;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private mergeSeedAndResult(completedAtMs: number): Generation {
    const seed = this.seed;
    const result = this.result ?? {};
    const usage = normalizeUsage(result.usage);
    const tags = { ...(this.host.config.tags ?? {}), ...(seed.tags ?? {}), ...(result.tags ?? {}) };
    const metadata = { ...(seed.metadata ?? {}), ...(result.metadata ?? {}) };

    return {
      id: result.id ?? seed.id ?? generateId('gen'),
      conversationId: result.conversationId ?? seed.conversationId ?? '',
      conversationTitle: result.conversationTitle ?? seed.conversationTitle ?? '',
      userId: result.userId ?? seed.userId ?? '',
      agentName: result.agentName ?? seed.agentName ?? '',
      agentVersion: result.agentVersion ?? seed.agentVersion ?? '',
      mode: result.mode ?? seed.mode,
      operationName: result.operationName ?? seed.operationName ?? OP_CHAT,
      model: this.mergedModel(result.model),
      responseId: result.responseId ?? '',
      responseModel: result.responseModel ?? '',
      systemPrompt: result.systemPrompt ?? seed.systemPrompt ?? '',
      maxTokens: result.maxTokens ?? seed.maxTokens,
      temperature: result.temperature ?? seed.temperature,
      topP: result.topP ?? seed.topP,
      frequencyPenalty: result.frequencyPenalty ?? seed.frequencyPenalty,
      presencePenalty: result.presencePenalty ?? seed.presencePenalty,
      stopSequences: result.stopSequences ?? seed.stopSequences,
      seed: result.seed ?? seed.seed,
      choiceCount: result.choiceCount ?? seed.choiceCount,
      toolChoice: result.toolChoice ?? seed.toolChoice,
      thinkingEnabled: result.thinkingEnabled ?? seed.thinkingEnabled,
      thinkingBudgetTokens: result.thinkingBudgetTokens ?? seed.thinkingBudgetTokens,
      input: result.input ?? [],
      output: result.output ?? [],
      tools: result.tools ?? seed.tools ?? [],
      usage,
      stopReason: result.stopReason ?? '',
      startedAt: this.startedAtMs,
      completedAt: completedAtMs,
      tags,
      metadata,
      callError: this.callError != null ? stringifyForCallError(this.callError) : '',
      parentGenerationIds: this.normalizeParentIds(seed.parentGenerationIds),
      effectiveVersion: result.effectiveVersion ?? seed.effectiveVersion ?? '',
    };
  }

  private mergedModel(resultModel: Partial<ModelRef> | undefined): ModelRef {
    const seed = this.seed.model;
    return {
      provider: resultModel?.provider ?? seed.provider ?? '',
      name: resultModel?.name ?? seed.name ?? '',
    };
  }

  private normalizeParentIds(
    parents: GenerationStart['parentGenerationIds'],
  ): string[] | undefined {
    if (!parents || parents.length === 0) return undefined;
    return parents.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object' && p.traceId && p.spanId) {
        return `${p.traceId}:${p.spanId}`;
      }
      return '';
    });
  }

  private recordMetrics(
    generation: Generation,
    completedAtMs: number,
    classified: { errorType: string; errorCategory: string },
  ) {
    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    const labels = {
      operationName: generation.operationName ?? OP_CHAT,
      providerName: generation.model?.provider ?? '',
      requestModel: generation.model?.name ?? '',
      agentName: generation.agentName ?? '',
      conversationId: generation.conversationId,
    };

    this.host.metrics.recordOperationDuration(durationSeconds, {
      ...labels,
      errorType: classified.errorType,
      errorCategory: classified.errorCategory,
    });

    const usage = generation.usage ?? {};
    this.host.metrics.recordTokenUsage(usage.inputTokens ?? 0, TOKEN_TYPE_INPUT, labels);
    this.host.metrics.recordTokenUsage(usage.outputTokens ?? 0, TOKEN_TYPE_OUTPUT, labels);
    this.host.metrics.recordTokenUsage(
      usage.cacheReadInputTokens ?? 0,
      TOKEN_TYPE_CACHE_READ,
      labels,
    );
    this.host.metrics.recordTokenUsage(
      usage.cacheCreationInputTokens ?? 0,
      TOKEN_TYPE_CACHE_CREATION,
      labels,
    );
    this.host.metrics.recordTokenUsage(usage.reasoningTokens ?? 0, TOKEN_TYPE_REASONING, labels);

    this.host.metrics.recordToolCalls(countToolCalls(generation.output ?? []), labels);

    const ttft = this.timeToFirstToken(generation);
    if (ttft !== undefined) this.host.metrics.recordTimeToFirstToken(ttft, labels);
  }

  private timeToFirstToken(generation: Generation): number | undefined {
    if (generation.mode !== 'STREAM') return undefined;
    const ttft =
      this.timeToFirstTokenSeconds ??
      (this.firstTokenAtMs != null ? (this.firstTokenAtMs - this.startedAtMs) / 1000 : undefined);
    return ttft != null && ttft >= 0 ? ttft : undefined;
  }
}

function countToolCalls(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'tool_call') n++;
    }
  }
  return n;
}

function stringifyForCallError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return '';
  }
}
