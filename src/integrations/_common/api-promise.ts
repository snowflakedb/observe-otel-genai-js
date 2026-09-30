/**
 * Shared helpers for preserving the Stainless-generated `APIPromise` shape used
 * by the OpenAI and Anthropic SDKs.
 *
 * `create(...)` returns an `APIPromise` — a `Promise` subclass that also exposes
 * helper methods (`.withResponse()`, `.asResponse()`, `_thenUnwrap`). If our
 * instrumentation replaced it with a plain `Promise`, those helpers would break,
 * and so would the SDKs' `.stream()` helpers (which call
 * `create(...).withResponse()` internally). Instrumenting on this shape keeps
 * all of that working.
 */

/**
 * Minimal shape of the SDK's `APIPromise` we depend on:
 *  - `_thenUnwrap(transform)` derives a new `APIPromise` that transforms the
 *    parsed value while preserving `.withResponse()` / `.asResponse()`.
 *  - `asResponse()` resolves the raw `Response` without reading the body (so it
 *    is safe to observe for error handling without disturbing the caller).
 */
export interface ApiPromiseLike<T> extends Promise<T> {
  _thenUnwrap<U>(transform: (value: T) => U): ApiPromiseLike<U>;
  asResponse(): Promise<unknown>;
}

/** Structural type guard for {@link ApiPromiseLike}. */
export function isApiPromiseLike(value: unknown): value is ApiPromiseLike<unknown> {
  return (
    value != null &&
    typeof (value as { _thenUnwrap?: unknown })._thenUnwrap === 'function' &&
    typeof (value as { asResponse?: unknown }).asResponse === 'function'
  );
}

/** Minimal recorder surface needed to finalize a span. */
interface FinalizableRecorder {
  setCallError: (err: unknown) => void;
  end: () => Promise<void>;
}

/**
 * Finalize the span when the request fails. `_thenUnwrap`'s transform only runs
 * on success, so failures (transport errors, non-2xx) are observed here through
 * `asResponse()` — which resolves with the raw `Response` (no body read) on
 * success and rejects on failure, leaving the caller's own body consumption
 * untouched. `end()` is idempotent, so this never double-finalizes.
 */
export function finalizeSpanOnRequestError(
  apiPromise: ApiPromiseLike<unknown>,
  rec: FinalizableRecorder,
): void {
  void Promise.resolve(apiPromise.asResponse()).then(undefined, (err: unknown) => {
    rec.setCallError(err);
    void rec.end();
  });
}
