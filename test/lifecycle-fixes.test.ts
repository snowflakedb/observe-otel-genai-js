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
 * Targeted regression tests for the lifecycle-related fixes.
 */

import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '../src/client.js';
import { FlushTimeoutError, GenAIOtelError } from '../src/errors.js';
import { type Harness, createHarness } from './_harness.js';

describe('Client.flush timeout', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    if (h) await h.shutdown();
    h = undefined;
  });

  it('rejects with FlushTimeoutError when forceFlush exceeds the deadline', async () => {
    h = createHarness();

    // Stub trace.getTracerProvider to return a provider whose forceFlush
    // never resolves. The Client duck-types forceFlush on the result of
    // trace.getTracerProvider().
    const origGetter = trace.getTracerProvider.bind(trace);
    const stub = {
      forceFlush: () => new Promise<void>(() => {}),
      getTracer: () => h!.tracerProvider.getTracer('stub'),
    };
    (trace as unknown as { getTracerProvider: () => unknown }).getTracerProvider = () => stub;

    try {
      const client = new Client();
      await expect(client.flush(50)).rejects.toBeInstanceOf(FlushTimeoutError);
    } finally {
      (trace as unknown as { getTracerProvider: typeof origGetter }).getTracerProvider = origGetter;
    }
  });
});

describe('FlushTimeoutError', () => {
  it('is exported and is a GenAIOtelError subclass', () => {
    const err = new FlushTimeoutError('boom');
    expect(err).toBeInstanceOf(GenAIOtelError);
    expect(err.name).toBe('FlushTimeoutError');
  });
});
