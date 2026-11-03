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
 * A marker for "this SDK method already has observe-otel-genai instrumentation on it".
 *
 * A provider adapter can be applied two ways at once: the `wrapX(client, sdk)`
 * proxy (per-client) and the OTel `XInstrumentation` (prototype-level). A user
 * who installs both would get two spans per call, because the proxy would
 * instrument the result of a `create` that the prototype patch already
 * instrumented.
 *
 * The instrumentation marks each method it patches, and the proxies check the
 * marker and pass the call straight through when it is set. One span per call
 * whether one layer or both are installed.
 *
 * `Symbol.for` keeps the marker visible across two co-loaded copies of this
 * package, which is the case that needs to dedup when both copies patch the same
 * prototype. `metadata.ts` uses a module-local `Symbol` for the opposite reason.
 *
 * The marker covers observe-otel-genai instrumentation only. A third-party OTel
 * instrumentation on the same method is no reason to skip: its span carries its
 * own conventions, so suppressing ours would drop attributes the user installed
 * this package to get.
 */
const MARKER = Symbol.for('@snowflake/observe-otel-genai/instrumented-method');

/** Flags `fn` as carrying observe-otel-genai instrumentation. */
export function markInstrumented<T extends object>(fn: T): T {
  try {
    Object.defineProperty(fn, MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen function. Dedup degrades to "may double-instrument"; a throw here
    // would break the caller's patch.
  }
  return fn;
}

/** True when `fn` was marked by {@link markInstrumented}. */
export function isInstrumented(fn: unknown): boolean {
  if (typeof fn !== 'function' && (typeof fn !== 'object' || fn === null)) return false;
  return (fn as Record<symbol, unknown>)[MARKER] === true;
}
