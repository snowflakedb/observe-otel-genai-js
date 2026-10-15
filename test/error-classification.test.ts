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

import { describe, expect, it } from 'vitest';
import { classifyError } from '../src/errors/classify.js';
import {
  ERR_CATEGORY_AUTH,
  ERR_CATEGORY_CLIENT,
  ERR_CATEGORY_RATE_LIMIT,
  ERR_CATEGORY_SDK,
  ERR_CATEGORY_SERVER,
  ERR_CATEGORY_TIMEOUT,
} from '../src/semconv.js';

describe('classifyError', () => {
  it('returns rate_limit on 429 status', () => {
    expect(classifyError({ status: 429 })).toBe(ERR_CATEGORY_RATE_LIMIT);
    expect(classifyError({ statusCode: 429 })).toBe(ERR_CATEGORY_RATE_LIMIT);
  });

  it('returns auth_error on 401 / 403', () => {
    expect(classifyError({ status: 401 })).toBe(ERR_CATEGORY_AUTH);
    expect(classifyError({ status: 403 })).toBe(ERR_CATEGORY_AUTH);
  });

  it('returns timeout on 408 and on AbortError/TimeoutError', () => {
    expect(classifyError({ status: 408 })).toBe(ERR_CATEGORY_TIMEOUT);
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(classifyError(e)).toBe(ERR_CATEGORY_TIMEOUT);
    const t = new Error('timed out');
    t.name = 'TimeoutError';
    expect(classifyError(t)).toBe(ERR_CATEGORY_TIMEOUT);
  });

  it('returns server_error on 5xx', () => {
    expect(classifyError({ status: 500 })).toBe(ERR_CATEGORY_SERVER);
    expect(classifyError({ status: 503 })).toBe(ERR_CATEGORY_SERVER);
  });

  it('returns client_error on 4xx (not 401/403/408/429)', () => {
    expect(classifyError({ status: 400 })).toBe(ERR_CATEGORY_CLIENT);
    expect(classifyError({ status: 404 })).toBe(ERR_CATEGORY_CLIENT);
  });

  it('reads nested response.status when top-level missing', () => {
    expect(classifyError({ response: { status: 500 } })).toBe(ERR_CATEGORY_SERVER);
  });

  it('falls back to sdk_error when nothing classifies', () => {
    expect(classifyError(new Error('weird'))).toBe(ERR_CATEGORY_SDK);
  });

  it('returns sdk_error on null when fallbackSdk=true (default)', () => {
    expect(classifyError(null)).toBe(ERR_CATEGORY_SDK);
  });

  it('infers status code from string message', () => {
    expect(classifyError(new Error('HTTP 502 Bad Gateway'))).toBe(ERR_CATEGORY_SERVER);
  });

  it('detects "timeout" in error messages', () => {
    expect(classifyError(new Error('deadline exceeded'))).toBe(ERR_CATEGORY_TIMEOUT);
    expect(classifyError(new Error('socket timeout'))).toBe(ERR_CATEGORY_TIMEOUT);
  });
});
