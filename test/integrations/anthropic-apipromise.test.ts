/**
 * APIPromise-preservation tests for the Anthropic adapter, using the REAL
 * `@anthropic-ai/sdk` with an injected `fetch` (no network).
 *
 * The other Anthropic tests use fake clients whose `create` returns a plain
 * `Promise`, which exercises the adapter's fallback path. These tests exercise
 * the real `APIPromise` path: instrumentation must preserve `.withResponse()`,
 * `.asResponse()`, streamed `for await`, and the `messages.stream()` helper
 * (which calls `create(...).withResponse()` internally) while still recording a
 * span.
 */

import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { patchMessagesCreate, wrapAnthropic } from '../../src/integrations/anthropic/index.js';
import {
  ATTR_RESPONSE_ID,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

/** Lets fire-and-forget `rec.end()` microtasks settle before asserting. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', 'request-id': 'req_ns' },
  });
}

function sseResponse(): Response {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"claude-x","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const body = new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(e));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_st' },
  });
}

const NON_STREAM_MESSAGE = {
  id: 'msg_ns',
  type: 'message',
  role: 'assistant',
  model: 'claude-x',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 1 },
};

const PARAMS = {
  model: 'claude-x',
  max_tokens: 16,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('Anthropic adapter — APIPromise preservation (real SDK)', () => {
  let h: Harness;
  let nextResponse: () => Response;

  const makeClient = () =>
    new Anthropic({
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.invalid',
      fetch: async () => nextResponse(),
    });

  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('await create() returns the message and records a span', async () => {
    nextResponse = () => jsonResponse(NON_STREAM_MESSAGE);
    const wrapped = wrapAnthropic(h.client, makeClient());

    const out = (await wrapped.messages.create(PARAMS)) as { id: string };
    await tick();

    expect(out.id).toBe('msg_ns');
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('msg_ns');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(3);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(1);
  });

  it('create(...).withResponse() still works and records a span', async () => {
    nextResponse = () => jsonResponse(NON_STREAM_MESSAGE);
    const wrapped = wrapAnthropic(h.client, makeClient());

    const { data, response } = await wrapped.messages.create(PARAMS).withResponse();
    await tick();

    expect(data.id).toBe('msg_ns');
    expect(response.status).toBe(200);
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('msg_ns');
  });

  it('create(...).asResponse() still returns a readable raw Response', async () => {
    nextResponse = () => jsonResponse(NON_STREAM_MESSAGE);
    const wrapped = wrapAnthropic(h.client, makeClient());

    // asResponse() does not parse the body, so the caller can still read it.
    const response = await wrapped.messages.create(PARAMS).asResponse();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe('msg_ns');
  });

  it('streamed create() is iterable and records TTFT + final usage', async () => {
    nextResponse = sseResponse;
    const wrapped = wrapAnthropic(h.client, makeClient());

    const stream = (await wrapped.messages.create({
      ...PARAMS,
      stream: true,
    })) as AsyncIterable<{ type: string; delta?: { text?: string } }>;

    let text = '';
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta') text += ev.delta?.text ?? '';
    }

    expect(text).toBe('hi');
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(2);
    const output = JSON.parse(span!.attributes['gen_ai.output.messages'] as string);
    expect(output[0].parts[0].content).toBe('hi');
  });

  it('messages.stream() helper (uses withResponse internally) records a span', async () => {
    // messages.stream() calls create(...).withResponse() under the hood, which
    // only works if the patched create preserves the APIPromise. Patch the real
    // prototype here (the auto-instrumentation does the same on module load).
    const proto = Anthropic.Messages.prototype as unknown as {
      create: (...a: unknown[]) => unknown;
    };
    const original = proto.create;
    proto.create = patchMessagesCreate(h.client)(
      original as (...a: unknown[]) => unknown,
    ) as typeof proto.create;

    try {
      nextResponse = sseResponse;
      const client = makeClient();
      const runner = client.messages.stream(PARAMS);
      const finalMessage = await runner.finalMessage();

      expect(finalMessage.content[0]).toMatchObject({ type: 'text', text: 'hi' });
      const [span] = h.spans.getFinishedSpans();
      expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(2);
    } finally {
      proto.create = original;
    }
  });
});
