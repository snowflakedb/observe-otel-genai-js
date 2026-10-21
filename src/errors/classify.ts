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
 * Provider-error classification.
 *
 * Walks duck-typed status-code fields on the thrown value (matches OpenAI,
 * Anthropic, Google, generic `fetch` Response error shapes) and maps to one of
 * the stable `error.category` values from semconv.ts. Pluggable via
 * `ClientConfig.errorClassifier`.
 */

import {
  ERR_CATEGORY_AUTH,
  ERR_CATEGORY_CLIENT,
  ERR_CATEGORY_RATE_LIMIT,
  ERR_CATEGORY_SDK,
  ERR_CATEGORY_SERVER,
  ERR_CATEGORY_TIMEOUT,
  type ErrorCategory,
} from '../semconv.js';

const STATUS_CODE_FIELDS = ['status', 'statusCode', 'status_code', 'Status', 'StatusCode'] as const;
const STATUS_REGEX = /\b([1-5][0-9][0-9])\b/g;

/**
 * `error.type` must stay low-cardinality, but error records can carry free text, so
 * only class-like names pass. `TripwireTriggered` keeps OpenAI Agents guardrail trips
 * visible.
 */
export const ERROR_CLASS_NAME =
  /^(?:[A-Za-z_$][A-Za-z0-9_$.]{0,127})?(?:Error|Exception|TripwireTriggered)$/;

/** The class name of a thrown `Error`, such as `AuthenticationError`, when it looks like one. */
export function errorClassName(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  // The openai package's error classes leave `name` as 'Error'.
  const className = err.constructor.name;
  const name = err.name === 'Error' && ERROR_CLASS_NAME.test(className) ? className : err.name;
  return ERROR_CLASS_NAME.test(name) ? name : undefined;
}

/**
 * Returns one of the canonical `error.category` values for `err`. Returns
 * `'sdk_error'` when `fallbackSdk` is true and no other category matches.
 */
export function classifyError(err: unknown, fallbackSdk = true): ErrorCategory {
  if (err == null) return fallbackSdk ? ERR_CATEGORY_SDK : '';
  if (isTimeout(err)) return ERR_CATEGORY_TIMEOUT;

  const status = extractStatusCode(err);
  const message = stringify(err).toLowerCase();
  if (message.includes('timeout') || message.includes('deadline exceeded')) {
    return ERR_CATEGORY_TIMEOUT;
  }
  if (status === 429) return ERR_CATEGORY_RATE_LIMIT;
  if (status === 401 || status === 403) return ERR_CATEGORY_AUTH;
  if (status === 408) return ERR_CATEGORY_TIMEOUT;
  if (status != null && status >= 500 && status <= 599) return ERR_CATEGORY_SERVER;
  if (status != null && status >= 400 && status <= 499) return ERR_CATEGORY_CLIENT;
  return fallbackSdk ? ERR_CATEGORY_SDK : '';
}

function isTimeout(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return true;
    if (err.name === 'AbortError') return true;
  }
  return false;
}

function extractStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err == null) {
    return extractStatusFromMessage(stringify(err));
  }

  const e = err as Record<string, unknown>;
  for (const field of STATUS_CODE_FIELDS) {
    const parsed = asStatusCode(e[field]);
    if (parsed != null) return parsed;
  }

  const response = e.response;
  if (response && typeof response === 'object') {
    for (const field of STATUS_CODE_FIELDS) {
      const parsed = asStatusCode((response as Record<string, unknown>)[field]);
      if (parsed != null) return parsed;
    }
  }

  const inner = e.error;
  if (inner && typeof inner === 'object') {
    for (const field of STATUS_CODE_FIELDS) {
      const parsed = asStatusCode((inner as Record<string, unknown>)[field]);
      if (parsed != null) return parsed;
    }
  }

  return extractStatusFromMessage(stringify(err));
}

function extractStatusFromMessage(message: string): number | undefined {
  STATUS_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
  while ((match = STATUS_REGEX.exec(message)) != null) {
    const code = asStatusCode(match[1]);
    if (code != null) return code;
  }
  return undefined;
}

function asStatusCode(value: unknown): number | undefined {
  if (typeof value === 'boolean') return undefined;
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    if (Number.isFinite(n)) parsed = n;
  }
  if (parsed == null) return undefined;
  if (parsed >= 100 && parsed <= 599) return parsed;
  return undefined;
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    return '';
  }
}

/**
 * Pluggable hook signature consumed by `ClientConfig.errorClassifier`.
 */
export type ErrorClassifier = (err: unknown) => ErrorCategory;
