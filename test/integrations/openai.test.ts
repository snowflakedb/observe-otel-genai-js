/**
 * Tests for the OpenAI adapter.
 *
 * We don't hit the real OpenAI API. Instead we construct a fake OpenAI client
 * shape that exposes `chat.completions.create` and `embeddings.create` so we
 * can verify the adapter's instrumentation without a network call.
 */

import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  instrumentedChatCompletion,
  instrumentedEmbedding,
  withMetadata,
  wrapOpenAI,
} from '../../src/integrations/openai/index.js';
import {
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  OP_CHAT,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

interface FakeChatResponse {
  id: string;
  model: string;
  choices: Array<{ finish_reason: string; message: { role: string; content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function makeFakeOpenAI(
  responses: {
    chat?: () => Promise<FakeChatResponse> | Promise<AsyncIterable<unknown>>;
    embeddings?: () => Promise<{
      data: Array<{ embedding: number[] }>;
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
    }>;
  } = {},
): OpenAI {
  return {
    chat: {
      completions: {
        create: (params: unknown) => {
          const isStream = (params as { stream?: boolean }).stream === true;
          if (isStream) return responses.chat!() as Promise<AsyncIterable<unknown>>;
          return responses.chat!() as Promise<FakeChatResponse>;
        },
      },
    },
    embeddings: {
      create: () => responses.embeddings!(),
    },
  } as unknown as OpenAI;
}

describe('OpenAI adapter — instrumentedChatCompletion', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits chat span with usage + response metadata', async () => {
    const fake = makeFakeOpenAI({
      chat: async () => ({
        id: 'chatcmpl-1',
        model: 'gpt-4o-2024-08-06',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
    });

    const out = await instrumentedChatCompletion(h.client, fake, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(out.id).toBe('chatcmpl-1');
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('openai');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-4o');
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-4o-2024-08-06');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('chatcmpl-1');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(7);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(2);
    expect(span?.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('captures input + output messages as structured attributes', async () => {
    const fake = makeFakeOpenAI({
      chat: async () => ({
        id: 'c-content',
        model: 'gpt-4o',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello back' } }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }),
    });

    await instrumentedChatCompletion(h.client, fake, {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    });

    const [span] = h.spans.getFinishedSpans();
    const input = JSON.parse(span!.attributes['gen_ai.input.messages'] as string);
    expect(input).toHaveLength(2);
    expect(input[0].role).toBe('system');
    expect(input[1].role).toBe('user');
    expect(input[1].parts[0].content).toBe('hi');
    const output = JSON.parse(span!.attributes['gen_ai.output.messages'] as string);
    expect(output[0].role).toBe('assistant');
    expect(output[0].parts[0].content).toBe('hello back');
  });

  it('records provider errors as provider_call_error', async () => {
    const fake = makeFakeOpenAI({
      chat: async () => {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    });

    await expect(
      instrumentedChatCompletion(h.client, fake, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('rate limited');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.attributes['error.category']).toBe('rate_limit');
  });
});

describe('OpenAI adapter — streaming chat', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('captures TTFT + final usage from a streamed response', async () => {
    const fake = makeFakeOpenAI({
      chat: async () => {
        async function* gen() {
          yield {
            id: 'chatcmpl-stream-1',
            model: 'gpt-4o-stream',
            choices: [{ delta: { content: 'hi' }, finish_reason: null }],
          };
          yield {
            id: 'chatcmpl-stream-1',
            model: 'gpt-4o-stream',
            choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          };
        }
        return gen() as AsyncIterable<unknown>;
      },
    });

    const wrapped = wrapOpenAI(h.client, fake);
    const stream = (await wrapped.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    } as any)) as unknown as AsyncIterable<unknown>;

    for await (const _chunk of stream) {
      /* drain */
    }

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(5);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(2);
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-4o-stream');
    const output = JSON.parse(span!.attributes['gen_ai.output.messages'] as string);
    expect(output[0].parts[0].content).toBe('hi there');
  });
});

describe('OpenAI adapter — wrapOpenAI proxy + withMetadata', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('honors agentName and conversationId attached via withMetadata', async () => {
    const fake = makeFakeOpenAI({
      chat: async () => ({
        id: 'r-1',
        model: 'gpt-4o',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    });

    const wrapped = wrapOpenAI(h.client, fake);
    await wrapped.chat.completions.create(
      withMetadata(
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { agentName: 'planner', conversationId: 'conv-meta-1' },
      ),
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['gen_ai.agent.name']).toBe('planner');
    expect(span?.attributes['gen_ai.conversation.id']).toBe('conv-meta-1');
  });
});

describe('OpenAI adapter — instrumentedEmbedding', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits an embeddings span with input_count + dimension count', async () => {
    const fake = makeFakeOpenAI({
      embeddings: async () => ({
        model: 'text-embedding-3-large',
        data: [{ embedding: new Array(3072).fill(0.01) as number[] }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }),
    });

    await instrumentedEmbedding(h.client, fake, {
      model: 'text-embedding-3-large',
      input: 'hello world',
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['gen_ai.embeddings.input_count']).toBe(1);
    expect(span?.attributes['gen_ai.embeddings.dimension.count']).toBe(3072);
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(5);
  });
});
