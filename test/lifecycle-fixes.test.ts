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
