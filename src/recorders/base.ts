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

import type { Span } from '@opentelemetry/api';
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

  /** Stores a provider/runtime call error to surface on the span at end(). */
  setCallError(err: unknown): void {
    if (err == null) return;
    this.callError = err;
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
    return { errorType: defaultType, errorCategory: category, statusMessage };
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

  protected setSpanStatus(classified: ClassifiedError): void {
    if (classified.errorType === '') {
      this.span.setStatus({ code: SpanStatusCode.OK });
      return;
    }
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
