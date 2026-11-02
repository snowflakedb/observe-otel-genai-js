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
 * Text for span status, exception messages, and recorded call errors.
 *
 * `String(plainObject)` is the literal `"[object Object]"`, and that is what
 * gets exported. {@link serializeError} is the human-facing form. Scans for
 * "timeout" or an HTTP status use {@link readErrorMessage} and stop there:
 * running that regex over a JSON dump would treat an incidental number in the
 * payload as a status code.
 */

/**
 * The string a value already carries, without JSON-encoding the rest.
 *
 * A string is returned as itself, and an `Error` as `error.message` (not
 * `error.toString()`, which prefixes the name). On an object, the first
 * non-empty string of `message`, then `error`, wins. An object-valued field
 * is skipped — it is never passed to `String()`. Returns `undefined` when
 * there is no string to read.
 */
export function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return typeof value.message === 'string' ? value.message : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    return nonEmptyStringField(value, 'message') ?? nonEmptyStringField(value, 'error');
  }
  return undefined;
}

/**
 * Human-facing error text.
 *
 * - `null` / `undefined` → `""`
 * - string → that string
 * - `Error` → `error.message`
 * - object → {@link readErrorMessage}, otherwise `JSON.stringify`
 * - number / boolean / bigint → `String()`
 *
 * A circular structure, or anything else `JSON.stringify` rejects, falls back
 * to `String()`.
 */
export function serializeError(value: unknown): string {
  if (value == null) return '';
  const message = readErrorMessage(value);
  if (message != null) return message;
  if (typeof value !== 'object') {
    try {
      return String(value);
    } catch {
      return '';
    }
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    // Circular structure, or a value JSON.stringify cannot encode.
  }
  try {
    return String(value);
  } catch {
    return '';
  }
}

function nonEmptyStringField(value: object, key: string): string | undefined {
  let field: unknown;
  try {
    field = (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
  if (typeof field !== 'string' || field === '') return undefined;
  return field;
}
