/**
 * Tests for the per-call helpers `instrumentedChatCompletion` and
 * `instrumentedEmbedding`.
 *
 * These await the result themselves and never touch the `APIPromise` machinery,
 * so a small fake client is enough here.
 *
 * `wrapOpenAI` is tested against the real SDK in `openai-apipromise.test.ts`. It
 * only instruments a real `APIPromise`, so a fake returning a plain promise would
 * get no span there.
 */

import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  instrumentedChatCompletion,
  instrumentedEmbedding,
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
    chat?: () => Promise<FakeChatResponse>;
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
        create: () => responses.chat!() as Promise<FakeChatResponse>,
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
