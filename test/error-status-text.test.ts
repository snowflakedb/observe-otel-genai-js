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
 * Span status and exception text for values that are not Errors.
 *
 * `String(plainObject)` is `"[object Object]"`. The recorder that sets span
 * status (tool execution via `setExecError`, generation via `setCallError`)
 * must publish the string message, or JSON when the value has none.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serializeError } from '../src/errors/serialize.js';
import { type Harness, createHarness } from './_harness.js';

const STREAM_ERROR = 'An error occurred while streaming the response';

describe('error text on span status', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'full' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  async function toolError(err: unknown): Promise<ReadableSpan> {
    const rec = h.client.startToolExecution({ toolName: 'search' });
    rec.setExecError(err);
    await rec.end();
    const [span] = h.spans.getFinishedSpans();
    if (!span) throw new Error('expected a finished tool span');
    return span;
  }

  function texts(span: ReadableSpan): { status: string; exception: string } {
    const status = span.status.message ?? '';
    const event = span.events.find((candidate) => candidate.name === 'exception');
    const message = event?.attributes?.['exception.message'];
    const exception = typeof message === 'string' ? message : '';
    expect(status).not.toContain('[object Object]');
    expect(exception).not.toContain('[object Object]');
    return { status, exception };
  }

  it('keeps an Error message, and records that Error so its name and stack survive', async () => {
    class ProviderErr extends Error {
      constructor() {
        super('rate limited');
        this.name = 'ProviderErr';
      }
    }
    const err = new ProviderErr();
    const span = await toolError(err);
    const { status, exception } = texts(span);
    expect(status).toBe('rate limited');
    expect(exception).toBe('rate limited');
    const event = span.events.find((candidate) => candidate.name === 'exception');
    expect(event?.attributes?.['exception.type']).toBe('ProviderErr');
    expect(event?.attributes?.['exception.stacktrace']).toBe(err.stack);
  });

  it('keeps a string', async () => {
    const { status, exception } = texts(await toolError('rate limited'));
    expect(status).toBe('rate limited');
    expect(exception).toBe('rate limited');
  });

  it.each<[unknown, string]>([
    [{ message: 'rate limited' }, 'rate limited'],
    [{ message: 'rate limited', error: 'other' }, 'rate limited'],
    [{ message: '', error: 'rate limited' }, 'rate limited'],
    [{ error: 'rate limited' }, 'rate limited'],
    [{ type: 'api_error', message: STREAM_ERROR }, STREAM_ERROR],
    [{ message: { detail: 'nope' } }, '{"message":{"detail":"nope"}}'],
    [{ message: { detail: 'nope' }, error: 'rate limited' }, 'rate limited'],
    [{ code: 503, reason: 'overloaded' }, '{"code":503,"reason":"overloaded"}'],
    [503, '503'],
    [false, 'false'],
  ])('records %j on the tool span status and the exception', async (err, expected) => {
    const { status, exception } = texts(await toolError(err));
    expect(status).toBe(expected);
    expect(exception).toBe(expected);
  });

  it('stringifies a bigint', async () => {
    const { status, exception } = texts(await toolError(1n));
    expect(status).toBe('1');
    expect(exception).toBe('1');
  });

  it('records the same text on a generation call error', async () => {
    const err = { code: 503, reason: 'overloaded' };
    const rec = h.client.startGeneration({ model: { provider: 'openai', name: 'gpt-4o' } });
    rec.setCallError(err);
    await rec.end();

    expect(rec.last?.callError).toBe('{"code":503,"reason":"overloaded"}');
    const [span] = h.spans.getFinishedSpans();
    const { status, exception } = texts(span!);
    expect(status).toBe('{"code":503,"reason":"overloaded"}');
    expect(exception).toBe('{"code":503,"reason":"overloaded"}');
  });

  it('falls back to String() for a circular tool error', async () => {
    const err: { self?: unknown } = {};
    err.self = err;
    const span = await toolError(err);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe(String(err));
    const event = span.events.find((candidate) => candidate.name === 'exception');
    expect(event?.attributes?.['exception.message']).toBe(String(err));
  });

  it('records the category instead of the message under metadata_only', async () => {
    await h.shutdown();
    h = createHarness({ contentCaptureMode: 'metadata_only' });

    const rec = h.client.startToolExecution({ toolName: 'search' });
    rec.setExecError({ status: 429, message: 'slow down' });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('rate_limit');
    expect(span?.attributes['error.category']).toBe('rate_limit');
    expect(span?.events.map((event) => event.name)).not.toContain('exception');
    expect(JSON.stringify(span?.status)).not.toContain('slow down');
  });

  it('keeps a serialized object out of the span under allow_list', async () => {
    await h.shutdown();
    h = createHarness({ contentCaptureMode: 'allow_list' });

    const rec = h.client.startToolExecution({ toolName: 'search' });
    rec.setExecError({ status: 429, message: 'slow down', detail: 'secret' });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    // AllowListSpan keeps only the status code.
    expect(span?.status.message).toBeUndefined();
    const exported = JSON.stringify({ status: span?.status, events: span?.events });
    expect(exported).not.toContain('slow down');
    expect(exported).not.toContain('secret');
  });
});

describe('serializeError', () => {
  it('returns an empty string for null and undefined', () => {
    expect(serializeError(null)).toBe('');
    expect(serializeError(undefined)).toBe('');
  });
});
