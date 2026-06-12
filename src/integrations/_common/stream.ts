/**
 * Shared utilities for wrapping provider streams (OpenAI Stream, Anthropic
 * MessageStream, etc.) so the recorder ends correctly even if the consumer
 * never iterates, and provider-specific methods (`tee`, `toReadableStream`,
 * `controller`, ...) survive the wrapping.
 *
 * The returned Proxy forwards every property/method to the underlying stream
 * EXCEPT `[Symbol.asyncIterator]`, which is replaced with a wrapping iterator
 * that observes chunks and ends the recorder in `finally`.
 *
 * A watchdog timer (default 10 minutes, .unref()'d so it doesn't keep the
 * event loop alive) ends the recorder with an error if the iterator is never
 * consumed.
 */

const DEFAULT_WATCHDOG_MS = 10 * 60 * 1000; // 10 minutes

export interface StreamWrapOptions<TChunk> {
  /** Called for every chunk; first chunk should record TTFT. */
  onChunk?: (chunk: TChunk) => void;
  /** Called once the iterator finishes successfully. */
  onComplete?: () => Promise<void> | void;
  /** Called when the iterator throws. */
  onError?: (err: unknown) => Promise<void> | void;
  /** Called from the watchdog when the iterator was never consumed. */
  onAbandoned?: () => Promise<void> | void;
  /** Watchdog timeout in ms. Defaults to 10 minutes. */
  watchdogMs?: number;
}

/**
 * Wraps a stream-like object that exposes `[Symbol.asyncIterator]`. Returns a
 * Proxy that:
 *   - intercepts iteration to record chunks + end the recorder,
 *   - forwards every other property/method to the underlying stream,
 *   - schedules a watchdog that ends the recorder if iteration never starts.
 *
 * The returned value has the same TypeScript type as the underlying stream so
 * callers keep `tee()`, `toReadableStream()`, etc.
 */
export function wrapProviderStream<S extends AsyncIterable<TChunk>, TChunk>(
  stream: S,
  options: StreamWrapOptions<TChunk>,
): S {
  let iteratorStarted = false;
  let recorderEnded = false;

  const finishOnce = async (fn: (() => Promise<void> | void) | undefined): Promise<void> => {
    if (recorderEnded) return;
    recorderEnded = true;
    if (fn) await fn();
  };

  const watchdog =
    options.watchdogMs === 0
      ? undefined
      : setTimeout(() => {
          if (iteratorStarted || recorderEnded) return;
          void finishOnce(options.onAbandoned ?? options.onComplete);
        }, options.watchdogMs ?? DEFAULT_WATCHDOG_MS);
  if (watchdog && typeof (watchdog as { unref?: () => void }).unref === 'function') {
    (watchdog as { unref: () => void }).unref();
  }

  const cancelWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
  };

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return function (this: unknown): AsyncIterator<TChunk> {
          iteratorStarted = true;
          cancelWatchdog();
          const inner = (target as AsyncIterable<TChunk>)[Symbol.asyncIterator]();
          return {
            async next(...args: [] | [undefined]) {
              try {
                const r = await inner.next(...args);
                if (!r.done) {
                  try {
                    options.onChunk?.(r.value);
                  } catch {
                    /* ignore observer errors */
                  }
                  return r;
                }
                await finishOnce(options.onComplete);
                return r;
              } catch (err) {
                await finishOnce(() => options.onError?.(err));
                throw err;
              }
            },
            async return(value) {
              try {
                if (typeof inner.return === 'function') {
                  await inner.return(value);
                }
              } finally {
                await finishOnce(options.onComplete);
              }
              return { done: true, value: value as TChunk };
            },
            async throw(err) {
              try {
                if (typeof inner.throw === 'function') {
                  await inner.throw(err);
                }
              } finally {
                await finishOnce(() => options.onError?.(err));
              }
              throw err;
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          } as AsyncIterator<TChunk>;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
