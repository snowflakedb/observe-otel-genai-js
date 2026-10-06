/**
 * `wrapOpenAI` tests against the REAL `openai` SDK with an injected `fetch` (no
 * network), so every call here goes through a genuine `APIPromise`, the only shape
 * a real client returns.
 *
 * Covered: `.withResponse()`, `.asResponse()`, streamed `for await`, body parse
 * failures, and `withMetadata`, across chat completions and embeddings.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withMetadata, wrapOpenAI } from '../../src/integrations/openai/index.js';
import {
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

/** Lets fire-and-forget `rec.end()` microtasks settle before asserting. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_ns' },
  });
}

/** A 200 whose body is not valid JSON, so the SDK's parse step fails. */
function brokenJsonResponse(): Response {
  return new Response('{not json', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks: unknown[]): Response {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(l));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_st' },
  });
}

const CHAT_COMPLETION = {
  id: 'chatcmpl_ns',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-x',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const CHAT_CHUNKS = [
  {
    id: 'chatcmpl_st',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-x',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_st',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-x',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  {
    id: 'chatcmpl_st',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-x',
    choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  },
];

const EMBEDDING_RESPONSE = {
  object: 'list',
  data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: 2, total_tokens: 2 },
};

const CHAT_PARAMS = {
  model: 'gpt-x',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('OpenAI adapter — APIPromise preservation (real SDK)', () => {
  let h: Harness;
  let nextResponse: () => Response;

  const makeClient = () =>
    new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.invalid',
      fetch: async () => nextResponse(),
    });

  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('await chat.completions.create() returns the completion and records a span', async () => {
    nextResponse = () => jsonResponse(CHAT_COMPLETION);
    const openai = wrapOpenAI(h.client, makeClient());

    const out = await openai.chat.completions.create(CHAT_PARAMS);
    await tick();

    expect(out.id).toBe('chatcmpl_ns');
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('chatcmpl_ns');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(3);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(1);
  });

  it('chat.completions.create(...).withResponse() still works and records a span', async () => {
    nextResponse = () => jsonResponse(CHAT_COMPLETION);
    const openai = wrapOpenAI(h.client, makeClient());

    const { data, response } = await openai.chat.completions.create(CHAT_PARAMS).withResponse();
    await tick();

    expect(data.id).toBe('chatcmpl_ns');
    expect(response.status).toBe(200);
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('chatcmpl_ns');
  });

  it('chat.completions.create(...).asResponse() returns a readable raw Response and ends the span', async () => {
    nextResponse = () => jsonResponse(CHAT_COMPLETION);
    const openai = wrapOpenAI(h.client, makeClient());

    const response = await openai.chat.completions.create(CHAT_PARAMS).asResponse();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe('chatcmpl_ns');
    await tick();

    const spans = h.spans.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('records the error when a 200 body fails to parse on await', async () => {
    nextResponse = brokenJsonResponse;
    const openai = wrapOpenAI(h.client, makeClient());

    await expect(openai.chat.completions.create(CHAT_PARAMS)).rejects.toThrow();
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records the error when a 200 body fails to parse in withResponse()', async () => {
    nextResponse = brokenJsonResponse;
    const openai = wrapOpenAI(h.client, makeClient());

    await expect(openai.chat.completions.create(CHAT_PARAMS).withResponse()).rejects.toThrow();
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records the error when a promise derived via _thenUnwrap fails to parse', async () => {
    // The SDK's own helpers (e.g. chat.completions.parse) derive from create() this way.
    nextResponse = brokenJsonResponse;
    const openai = wrapOpenAI(h.client, makeClient());

    const derived = (
      openai.chat.completions.create(CHAT_PARAMS) as unknown as {
        _thenUnwrap: (fn: (v: unknown) => unknown) => Promise<unknown>;
      }
    )._thenUnwrap((v) => v);
    await expect(derived).rejects.toThrow();
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('streamed chat.completions.create() is iterable and records TTFT + final usage', async () => {
    nextResponse = () => sseResponse(CHAT_CHUNKS);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.chat.completions.create({
      ...CHAT_PARAMS,
      stream: true,
      stream_options: { include_usage: true },
    });

    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices?.[0]?.delta?.content ?? '';
    }

    expect(text).toBe('hi');
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(4);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(2);
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-x');
    const output = JSON.parse(span!.attributes['gen_ai.output.messages'] as string);
    expect(output[0].parts[0].content).toBe('hi');
  });

  it('embeddings.create(...).withResponse() still works and records a span', async () => {
    nextResponse = () => jsonResponse(EMBEDDING_RESPONSE);
    const openai = wrapOpenAI(h.client, makeClient());

    const { data, response } = await openai.embeddings
      .create({ model: 'text-embedding-3-small', input: 'hello' })
      .withResponse();
    await tick();

    // The SDK requests base64 and decodes the vector; assert on stable fields
    // rather than the decoded values (the mock returns a plain numeric array).
    expect(data.model).toBe('text-embedding-3-small');
    expect(data.data).toHaveLength(1);
    expect(response.status).toBe(200);
    expect(h.spans.getFinishedSpans().length).toBeGreaterThanOrEqual(1);
  });

  it('embeddings.create(...).asResponse() ends the span', async () => {
    nextResponse = () => jsonResponse(EMBEDDING_RESPONSE);
    const openai = wrapOpenAI(h.client, makeClient());

    const response = await openai.embeddings
      .create({ model: 'text-embedding-3-small', input: 'hello' })
      .asResponse();
    expect(response.status).toBe(200);
    await tick();

    expect(h.spans.getFinishedSpans()).toHaveLength(1);
  });

  it('records the error when an embeddings body fails to parse', async () => {
    nextResponse = brokenJsonResponse;
    const openai = wrapOpenAI(h.client, makeClient());

    await expect(
      openai.embeddings.create({ model: 'text-embedding-3-small', input: 'hello' }),
    ).rejects.toThrow();
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('withMetadata still applies agentName and conversationId', async () => {
    nextResponse = () => jsonResponse(CHAT_COMPLETION);
    const openai = wrapOpenAI(h.client, makeClient());

    await openai.chat.completions.create(
      withMetadata({ ...CHAT_PARAMS }, { agentName: 'planner', conversationId: 'conv-1' }),
    );
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['gen_ai.agent.name']).toBe('planner');
    expect(span?.attributes['gen_ai.conversation.id']).toBe('conv-1');
  });
});
