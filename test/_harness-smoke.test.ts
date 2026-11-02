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
 * Smoke test for the harness itself: verifies that the in-memory exporters
 * actually capture what the OTel SDK records. If these tests fail, the test
 * environment is broken; if they pass and other tests fail, the bug is in
 * the library, not the harness.
 */

import { metrics, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, createHarness } from './_harness.js';

describe('test harness smoke', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('captures a span emitted directly through the OTel API', () => {
    const tracer = trace.getTracer('smoke');
    const span = tracer.startSpan('hello');
    span.setAttribute('test.kind', 'smoke');
    span.end();

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0]?.name).toBe('hello');
    expect(spans[0]?.attributes['test.kind']).toBe('smoke');
  });

  it('captures a histogram value emitted directly through the OTel API', async () => {
    const meter = metrics.getMeter('smoke');
    const h1 = meter.createHistogram('smoke.hist', { unit: 'count' });
    h1.record(7, { foo: 'bar' });

    const rmList = await h.collectMetrics();
    // rmList is an array of ResourceMetrics
    expect(rmList.length).toBeGreaterThan(0);
    let found = false;
    for (const rm of rmList) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          if (m.descriptor.name === 'smoke.hist') found = true;
        }
      }
    }
    expect(found, 'smoke.hist histogram recorded').toBe(true);
  });
});
