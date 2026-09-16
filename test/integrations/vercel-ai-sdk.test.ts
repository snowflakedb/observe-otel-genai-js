import { MockEmbeddingModelV3, MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  wrapEmbed,
  wrapGenerateText,
  wrapStreamText,
} from '../../src/integrations/vercel-ai-sdk/index.js';
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

// AI SDK v7 reports usage as a nested provider shape; the SDK flattens
// `inputTokens.total` / `outputTokens.total` into the top-level
// `result.usage.inputTokens` / `.outputTokens` that the adapter reads.
function v7Usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: undefined,
      reasoning: undefined,
    },
  };
}

// v7 reports the provider finish reason as a structured object.
function v7Finish(
  unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other',
) {
  return { unified, raw: unified };
}

describe('Vercel AI SDK adapter — wrapGenerateText', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a chat span with usage + response metadata mapped from the AI SDK result', async () => {
    const model = new MockLanguageModelV3({
      provider: 'snowflake.chat',
      modelId: 'mock-1',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hello' }],
        finishReason: v7Finish('stop'),
        usage: v7Usage(9, 3),
        warnings: [],
        response: { id: 'aim-resp-1', modelId: 'mock-1-served', timestamp: new Date() },
      }),
    });

    const out = await wrapGenerateText(h.client, {
      model,
      prompt: 'hi',
    });

    expect(out.text).toBe('hello');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('snowflake');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('mock-1');
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('mock-1-served');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('aim-resp-1');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(9);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(3);
  });

  it('records call errors via setCallError when the provider throws', async () => {
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-1',
      doGenerate: async () => {
        throw new Error('upstream failure');
      },
    });

    await expect(wrapGenerateText(h.client, { model, prompt: 'x' })).rejects.toThrow(
      'upstream failure',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.status.code).toBe(2 /* ERROR */);
  });
});

describe('Vercel AI SDK adapter — wrapStreamText', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a streaming chat span with TTFT and final usage', async () => {
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-stream',
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'hi ' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'there' });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({
              type: 'finish',
              finishReason: v7Finish('stop'),
              usage: v7Usage(5, 2),
            });
            controller.close();
          },
        }),
      }),
    });

    const stream = wrapStreamText(h.client, { model, prompt: 'hi' });
    // Drain the text stream to ensure onChunk + onEnd run.
    // textStream is synchronous on a real StreamTextResult.
    for await (const _chunk of stream.textStream) {
      /* drain */
    }
    // Wait for the recorder's end() to land in the exporter.
    await stream.usage;

    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('chat mock-stream');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(5);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(2);
  });
});

describe('Vercel AI SDK adapter — wrapEmbed', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits an embeddings span with input tokens', async () => {
    const model = new MockEmbeddingModelV3({
      provider: 'snowflake.completion',
      modelId: 'text-embed-mock',
      doEmbed: async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => [0.1, 0.2, 0.3]),
        usage: { tokens: 7 },
        warnings: [],
      }),
    });

    const out = await wrapEmbed(h.client, {
      model,
      value: 'hello world',
    });

    expect(out.embedding.length).toBe(3);
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(7);
    expect(span?.attributes['gen_ai.embeddings.input_count']).toBe(1);
    expect(span?.attributes['gen_ai.embeddings.dimension.count']).toBe(3);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('snowflake');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('text-embed-mock');
  });
});
