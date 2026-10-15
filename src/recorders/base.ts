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
 * Shared recorder lifecycle infrastructure.
 *
 * Each concrete recorder (generation, embedding, tool, agent) extends
 * `RecorderBase` and supplies:
 *  - the seed values used to populate span attributes on start,
 *  - a `setResult` method matching its result-payload shape,
 *  - a `finalize()` implementation that emits events, attributes, status,
 *    and metrics, then ends the span.
 *
 * `end()` is idempotent and reentrancy-guarded. `Symbol.asyncDispose` lets
 * callers use `await using rec = ...` to guarantee cleanup on scope exit.
 */

import type { Attributes, Span } from '@opentelemetry/api';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { ResolvedClientConfig } from '../config.js';
import {
  type ContentCapture,
  type ContentCaptureMode,
  resolveContentCaptureMode,
} from '../content/capture.js';
import { contentCaptureModeFromContext } from '../context.js';
import type { ErrorClassifier } from '../errors/classify.js';
import { classifyError } from '../errors/classify.js';
import type { GenAIMetrics } from '../metrics/histograms.js';
import {
  ATTR_ERROR_CATEGORY,
  ATTR_ERROR_TYPE,
  ERR_CATEGORY_SDK,
  type ErrorCategory,
} from '../semconv.js';
import type { SpanLinkMap } from '../spans/links.js';

/**
 * Everything a recorder needs from its host client. Designed so the recorder
 * does not import `Client` directly (breaks the circular dep).
 */
export interface RecorderHostContext {
  readonly config: ResolvedClientConfig;
  readonly metrics: GenAIMetrics;
  readonly spanLinks: SpanLinkMap;
  readonly now: () => number;
  /** Optional override that takes precedence over the built-in classifier. */
  readonly errorClassifier?: ErrorClassifier;
}

export interface ClassifiedError {
  errorType: string;
  errorCategory: ErrorCategory;
  statusMessage: string;
}

export abstract class RecorderBase {
  protected readonly host: RecorderHostContext;
  protected readonly span: Span;
  protected readonly startedAtMs: number;
  protected readonly perCallContentCapture: ContentCaptureMode;

  // Mutable state
  protected callError: unknown | undefined;
  protected localError: Error | undefined;
  protected ended = false;
  /** Set after end() finishes successfully so we can compute duration etc. */
  protected completedAtMs?: number;
  /** Caller-supplied end timestamp; see {@link setEndedAt}. */
  private endedAtMsOverride?: number;
  /** Caller-supplied `error.type`; see {@link setErrorType}. */
  private errorTypeOverride?: string;

  constructor(
    host: RecorderHostContext,
    span: Span,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
  ) {
    this.host = host;
    this.span = span;
    this.startedAtMs = startedAtMs;
    this.perCallContentCapture = perCallContentCapture;
  }

  /** Idempotent: subsequent calls are no-ops. */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      await this.finalize();
    } catch (err) {
      this.localError = err instanceof Error ? err : new Error(String(err));
      // Best-effort: end the span even if finalize threw.
      try {
        this.span.end();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Overrides the timestamp `finalize()` treats as the end of the operation.
   *
   * A recorder stamps itself with `host.now()` when `end()` runs, which measures
   * the right thing when `end()` runs at the moment the work finishes. Use this
   * when the framework reports the completion later: the OpenAI Agents SDK
   * delivers `onSpanEnd` as a detached, un-awaited callback, so `host.now()`
   * would add our callback lag to the real duration and inflate both the span
   * and `gen_ai.client.operation.duration`.
   *
   * Ignores non-finite values and timestamps before the recorded start, so a bad
   * clock cannot produce a negative duration.
   */
  setEndedAt(t: Date | number): void {
    const ms = toMs(t);
    if (ms == null || !Number.isFinite(ms) || ms < this.startedAtMs) return;
    this.endedAtMsOverride = ms;
  }

  /** The end timestamp `finalize()` should use: the override, else now. */
  protected resolveCompletedAtMs(): number {
    return this.endedAtMsOverride ?? this.host.now();
  }

  /**
   * Overrides the `error.type` this recorder reports, on both the span attribute
   * and the metric label.
   *
   * Each recorder reports a coarse category for its own kind of work
   * (`provider_call_error`, `tool_execution_error`, …), which fits when the
   * recorder made the failing call itself. Use this when an upstream framework
   * named the failure better: an OpenAI Agents guardrail trip surfaces as
   * `InputGuardrailTripwireTriggered`, and there is no guardrail span to carry
   * it, so collapsing it to `provider_call_error` destroys the one signal
   * available.
   *
   * Keep the value bounded. It becomes a metric label, so free-form text here is
   * a cardinality problem.
   */
  setErrorType(errorType: string | undefined): void {
    if (!errorType) return;
    this.errorTypeOverride = errorType;
  }

  /** Stores a provider/runtime call error to surface on the span at end(). */
  setCallError(err: unknown): void {
    if (err == null) return;
    this.callError = err;
  }

  /** Sets extra span attributes, for values the recorder has no field for. */
  setAttributes(attrs: Attributes): void {
    this.span.setAttributes(attrs);
  }

  /** Returns the local validation/enqueue error after end(), if any. */
  err(): Error | undefined {
    return this.localError;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.end();
  }

  /**
   * Runs `fn` with this recorder's span installed as the active OTel span,
   * then restores the previous context. Spans created inside `fn` (including
   * across `await` boundaries in the returned promise chain) parent under this
   * span via OTel context propagation.
   *
   * This does NOT end the recorder. It is the building block for "open the
   * span now, keep it as the active parent while async work is kicked off, end
   * it later" — e.g. wrap a streaming call so its per-step generation spans
   * nest under an agent span, then call `end()` from the stream's onFinish.
   * The span only needs to be active at the synchronous call site that starts
   * the work (the AI SDK captures its parent there), not for the whole stream.
   */
  withActiveContext<T>(fn: () => T): T {
    return context.with(trace.setSpan(context.active(), this.span), fn);
  }

  // ---------------------------------------------------------------------------
  // Subclass extension points
  // ---------------------------------------------------------------------------

  protected abstract finalize(): Promise<void>;

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  protected resolveContentCapture(): { mode: ContentCaptureMode; config: ContentCapture } {
    const mode = resolveContentCaptureMode(
      this.perCallContentCapture,
      contentCaptureModeFromContext(),
      this.host.config.contentCaptureMode,
    );
    return { mode, config: this.host.config.contentCapture };
  }

  /**
   * Classifies an error into the canonical `(errorType, errorCategory)` pair
   * used for `error.type` / `error.category` attributes and metric labels.
   * Returns empty strings on success.
   */
  protected classify(err: unknown, defaultType: string, isMetadataOnly = false): ClassifiedError {
    if (err == null) {
      return { errorType: '', errorCategory: '', statusMessage: '' };
    }
    const classifier = this.host.errorClassifier ?? classifyError;
    const category = (classifier(err) || ERR_CATEGORY_SDK) as ErrorCategory;
    const statusMessage = isMetadataOnly ? category : stringifyError(err);
    return {
      errorType: this.errorTypeOverride ?? defaultType,
      errorCategory: category,
      statusMessage,
    };
  }

  /**
   * Records exception + sets ERROR status. Privacy-gated: when
   * `isMetadataOnly` is true and the error originated from user content,
   * `recordExceptionForUser` is suppressed and the description is replaced
   * with the bare category.
   */
  protected recordExceptionIfAny(err: unknown, isMetadataOnly: boolean): void {
    if (err == null) return;
    if (isMetadataOnly) return;
    try {
      this.span.recordException(err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* never let exception-recording crash the recorder */
    }
  }

  /** Always records — used for SDK-internal errors that carry no user content. */
  protected recordSdkException(err: unknown): void {
    if (err == null) return;
    try {
      this.span.recordException(err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* ignore */
    }
  }

  /** Leaves the status unset on success, as the OTel conventions recommend for instrumentation. */
  protected setSpanStatus(classified: ClassifiedError): void {
    if (classified.errorType === '') return;
    this.span.setAttribute(ATTR_ERROR_TYPE, classified.errorType);
    if (classified.errorCategory) {
      this.span.setAttribute(ATTR_ERROR_CATEGORY, classified.errorCategory);
    }
    this.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: classified.statusMessage || classified.errorType,
    });
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return '';
  }
}

/** Converts a Date | number (ms epoch) into a Date for OTel's span.end. */
export function toDate(value: Date | number | undefined): Date | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value;
  return new Date(value);
}

/** Converts a Date | number to ms epoch. */
export function toMs(value: Date | number | undefined): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.getTime();
  return value;
}
