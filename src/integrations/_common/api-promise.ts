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
 *  - `asResponse()` resolves the raw `Response` without reading the body.
 *  - `then` / `catch` / `finally` / `withResponse()` parse the body.
 */
export interface ApiPromiseLike<T> extends Promise<T> {
  _thenUnwrap<U>(transform: (value: T) => U): ApiPromiseLike<U>;
  asResponse(): Promise<unknown>;
  withResponse(): Promise<unknown>;
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
 * Returns `apiPromise._thenUnwrap(transform)`, making sure the span ends no
 * matter how the caller consumes it:
 *  - Parsed (`await`, `then` / `catch` / `finally`, `withResponse()`, or a
 *    further `_thenUnwrap`): `transform` records the result on success, and a
 *    request or parse failure is recorded here.
 *  - Raw only (`asResponse()`): the body is never parsed, so `transform` never
 *    runs. The span ends once the response arrives.
 *
 * Nothing parses the body up front, since that would consume it before an
 * `asResponse()` caller can read it.
 */
export function instrumentApiPromise<U>(
  apiPromise: ApiPromiseLike<unknown>,
  rec: FinalizableRecorder,
  transform: (value: unknown) => U,
): ApiPromiseLike<U> {
  const fail = (err: unknown) => {
    rec.setCallError(err);
    void rec.end();
  };
  // Request failures (transport errors, non-2xx) reject here without the body being read.
  void apiPromise.asResponse().then(undefined, fail);

  let parsed = false;
  const track = <V>(promise: ApiPromiseLike<V>): ApiPromiseLike<V> => {
    const methods = promise as unknown as Record<string, (...args: unknown[]) => unknown>;
    const { then, asResponse, _thenUnwrap } = promise;
    let watching = false;
    for (const name of ['then', 'catch', 'finally', 'withResponse']) {
      const original = methods[name]!;
      methods[name] = (...args) => {
        parsed = true;
        if (!watching) {
          watching = true;
          // The SDK caches the parse, so this shares the caller's read of the body.
          then.call(promise, undefined, fail);
        }
        return original.apply(promise, args);
      };
    }
    promise.asResponse = () =>
      asResponse.call(promise).then((response) => {
        if (!parsed) void rec.end();
        return response;
      });
    promise._thenUnwrap = <W>(next: (value: V) => W) =>
      track(_thenUnwrap.call(promise, next) as ApiPromiseLike<W>);
    return promise;
  };
  return track(apiPromise._thenUnwrap(transform));
}
