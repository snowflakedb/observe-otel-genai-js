/**
 * `wrapOpenAI` tests against the REAL `openai` SDK with an injected `fetch` (no
 * network), so every call here goes through a genuine `APIPromise`, the only shape
 * a real client returns.
 *
 * Covered: `.withResponse()`, `.asResponse()`, streamed `for await`, `withMetadata`,
 * request failure, and body parse failure, across chat completions, embeddings,
 * and Responses.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withMetadata, wrapOpenAI } from '../../src/integrations/openai/index.js';
import {
  ATTR_ERROR_CATEGORY,
  ATTR_OPERATION_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  OP_CHAT,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';
import { responsesMessage } from './_openai-server.js';

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

/** A Responses stream `error` event, which carries no top-level `error` field. */
function errorEvent(code: string, message: string) {
  return { type: 'error', code, message, param: null, sequence_number: 1 };
}

/** A Responses result that failed with `code`, keeping the default usage. */
function failedResponse(code: string, id?: string) {
  return {
    ...responsesMessage({ id }),
    status: 'failed',
    error: { code, message: 'something went wrong' },
  };
}

/** An SSE response. With `dropConnection`, the body errors after the chunks instead of ending. */
function sseResponse(chunks: unknown[], { dropConnection = false } = {}): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  if (!dropConnection) lines.push('data: [DONE]\n\n');
  // Hand out one line per read, so a dropped connection errors only after the
  // chunks were delivered (erroring discards anything still queued).
  const body = new ReadableStream({
    pull(c) {
      const line = lines.shift();
      if (line !== undefined) c.enqueue(new TextEncoder().encode(line));
      else if (dropConnection) c.error(new Error('socket hang up'));
      else c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_st' },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'server_error' } }), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_err' },
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

  it('does not leak the metadata symbol into the request body', async () => {
    let sentBody: string | undefined;
    const openai = wrapOpenAI(
      h.client,
      new OpenAI({
        apiKey: 'test-key',
        baseURL: 'https://api.openai.invalid',
        fetch: async (_url, init) => {
          sentBody = init?.body as string;
          return jsonResponse(CHAT_COMPLETION);
        },
      }),
    );

    await openai.chat.completions.create(
      withMetadata({ ...CHAT_PARAMS }, { agentName: 'planner' }),
    );
    await tick();

    expect(sentBody).toBeDefined();
    expect(Object.keys(JSON.parse(sentBody as string))).toEqual(['model', 'messages']);
  });

  it('await responses.create() records a chat span and maps instructions', async () => {
    nextResponse = () => jsonResponse(responsesMessage({ id: 'resp_ns', model: 'gpt-x-2024' }));
    const openai = wrapOpenAI(h.client, makeClient());

    const out = await openai.responses.create({
      model: 'gpt-x',
      input: 'hi',
      instructions: 'be terse',
    });
    await tick();

    expect(out.id).toBe('resp_ns');
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-x');
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-x-2024');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('resp_ns');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(8);
    expect(span?.attributes['gen_ai.system_instructions']).toBeDefined();
  });

  it('responses.create(...).withResponse() still works and records a span', async () => {
    nextResponse = () => jsonResponse(responsesMessage({ id: 'resp_wr' }));
    const openai = wrapOpenAI(h.client, makeClient());

    const { data, response } = await openai.responses
      .create({ model: 'gpt-x', input: 'hi' })
      .withResponse();
    await tick();

    expect(data.id).toBe('resp_wr');
    expect(response.status).toBe(200);
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('resp_wr');
  });

  // The transform passed to `_thenUnwrap` only runs on success, so a failing
  // request has to be observed separately or the span would leak.
  it('records a failed responses.create on the span and still rejects', async () => {
    nextResponse = () => errorResponse(503, 'upstream is down');
    const openai = wrapOpenAI(h.client, makeClient());

    await expect(openai.responses.create({ model: 'gpt-x', input: 'hi' })).rejects.toThrow(
      /upstream is down/,
    );
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
  });

  // The failures below arrive inside a 200, so only the response content says the call failed.
  it('records a streamed Responses error event as a failed call', async () => {
    nextResponse = () =>
      sseResponse([
        { type: 'response.output_text.delta', delta: 'he', sequence_number: 1 },
        errorEvent('server_error', 'boom'),
      ]);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    for await (const _ of stream) {
      // drain
    }

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe('server_error');
  });

  it('keeps the error event when the caller throws out of the loop on it', async () => {
    nextResponse = () => sseResponse([errorEvent('rate_limit_exceeded', 'slow down')]);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    await expect(async () => {
      for await (const ev of stream) {
        if (ev.type === 'error') throw new Error(ev.message);
      }
    }).rejects.toThrow('slow down');
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe('rate_limit');
    expect(span?.status.message).toContain('slow down');
  });

  it('keeps the error event over a later failed response with no error detail', async () => {
    const failed = { ...responsesMessage(), status: 'failed', error: null };
    nextResponse = () =>
      sseResponse([
        errorEvent('rate_limit_exceeded', 'slow down'),
        { type: 'response.failed', response: failed, sequence_number: 2 },
      ]);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    for await (const _ of stream) {
      // drain
    }

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe('rate_limit');
  });

  it("prefers the failed response's own error over an earlier error event", async () => {
    nextResponse = () =>
      sseResponse([
        errorEvent('rate_limit_exceeded', 'slow down'),
        { type: 'response.failed', response: failedResponse('invalid_prompt'), sequence_number: 2 },
      ]);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    for await (const _ of stream) {
      // drain
    }

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe('client_error');
  });

  it('keeps the error event when the connection drops after it', async () => {
    nextResponse = () =>
      sseResponse([errorEvent('rate_limit_exceeded', 'slow down')], { dropConnection: true });
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    await expect(async () => {
      for await (const _ of stream) {
        // drain
      }
    }).rejects.toThrow('socket hang up');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe('rate_limit');
  });

  it('keeps the usage of a completed response when the connection drops after it', async () => {
    nextResponse = () =>
      sseResponse(
        [{ type: 'response.completed', response: responsesMessage(), sequence_number: 1 }],
        { dropConnection: true },
      );
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    await expect(async () => {
      for await (const _ of stream) {
        // drain
      }
    }).rejects.toThrow('socket hang up');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
  });

  it('records a streamed response.failed as a failed call and keeps its usage', async () => {
    nextResponse = () =>
      sseResponse([
        {
          type: 'response.failed',
          response: failedResponse('rate_limit_exceeded', 'resp_failed'),
          sequence_number: 1,
        },
      ]);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    for await (const _ of stream) {
      // drain
    }

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe('rate_limit');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('resp_failed');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
  });

  it('keeps the usage of a response.failed the caller breaks out on', async () => {
    nextResponse = () =>
      sseResponse([
        { type: 'response.failed', response: failedResponse('server_error'), sequence_number: 1 },
      ]);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    for await (const ev of stream) {
      if (ev.type === 'response.failed') break;
    }
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe('server_error');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
  });

  it('records a break after response.completed as a successful call', async () => {
    nextResponse = () =>
      sseResponse([
        { type: 'response.completed', response: responsesMessage(), sequence_number: 1 },
      ]);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    for await (const ev of stream) {
      if (ev.type === 'response.completed') break;
    }
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
  });

  it('still records a break before any final response as abandoned', async () => {
    nextResponse = () =>
      sseResponse([{ type: 'response.output_text.delta', delta: 'he', sequence_number: 1 }]);
    const openai = wrapOpenAI(h.client, makeClient());

    const stream = await openai.responses.create({ model: 'gpt-x', input: 'hi', stream: true });
    for await (const _ of stream) break;
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toContain('never consumed');
  });

  it('records a non-streamed response with status "failed" as a failed call and keeps its usage', async () => {
    nextResponse = () => jsonResponse(failedResponse('invalid_image', 'resp_bad_image'));
    const openai = wrapOpenAI(h.client, makeClient());

    const out = await openai.responses.create({ model: 'gpt-x', input: 'hi' });
    await tick();

    expect(out.status).toBe('failed');
    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe('client_error');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('resp_bad_image');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);

    const [resource] = await h.collectMetrics();
    const duration = resource?.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((m) => m.descriptor.name === 'gen_ai.client.operation.duration');
    expect(duration?.dataPoints[0]?.attributes['error.type']).toBe('provider_call_error');
  });

  it.each([
    ['rate_limit_exceeded', 'rate_limit'],
    ['insufficient_quota', 'rate_limit'],
    ['server_error', 'server_error'],
    ['vector_store_timeout', 'timeout'],
    ['image_too_large', 'client_error'],
  ])('classifies a failed response with code %s as %s', async (code, category) => {
    nextResponse = () => jsonResponse(failedResponse(code));
    const openai = wrapOpenAI(h.client, makeClient());

    await openai.responses.create({ model: 'gpt-x', input: 'hi' });
    await tick();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_ERROR_CATEGORY]).toBe(category);
  });
});
