import { generateText, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { genaiOtelMiddleware } from '../../src/integrations/vercel-ai-sdk/index.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_SYSTEM_INSTRUCTIONS,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  OP_CHAT,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

// Provider-level (LanguageModelV3) usage is nested; finishReason is an object.
function v3Usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
  };
}
function v3Finish(
  unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other',
) {
  return { unified, raw: unified };
}

describe('Vercel AI SDK middleware — genaiOtelMiddleware (wrapGenerate)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits one chat span with usage + response metadata when the wrapped model generates', async () => {
    const base = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-1',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hello' }],
        finishReason: v3Finish('stop'),
        usage: v3Usage(11, 4),
        warnings: [],
        response: { id: 'resp-mw-1', modelId: 'mock-1-served', timestamp: new Date() },
      }),
    });
    const model = wrapLanguageModel({
      model: base,
      middleware: genaiOtelMiddleware(h.client, { agentName: 'o11y' }),
    });

    const out = await generateText({ model, prompt: 'hi there' });
    expect(out.text).toBe('hello');

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(1);
    const span = spans[0];
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('mock');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('mock-1');
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('mock-1-served');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('resp-mw-1');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(11);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(4);
  });

  it('records system content only in system_instructions, never duplicated into input.messages', async () => {
    const base = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-1',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: v3Finish('stop'),
        usage: v3Usage(5, 2),
        warnings: [],
        response: { id: 'resp-sys', modelId: 'mock-1', timestamp: new Date() },
      }),
    });
    const model = wrapLanguageModel({ model: base, middleware: genaiOtelMiddleware(h.client) });

    await generateText({
      model,
      system: 'You are a helpful assistant.',
      prompt: 'hi there',
    });

    const [span] = h.spans.getFinishedSpans();
    const system = JSON.parse(span!.attributes[ATTR_SYSTEM_INSTRUCTIONS] as string);
    expect(system).toEqual([{ type: 'text', content: 'You are a helpful assistant.' }]);

    const input = JSON.parse(span!.attributes[ATTR_INPUT_MESSAGES] as string);
    expect(input.some((m: { role: string }) => m.role === 'system')).toBe(false);
    expect(input).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'hi there' }] }]);
  });

  it('records a provider_call_error span when the wrapped model throws', async () => {
    const base = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-1',
      doGenerate: async () => {
        throw new Error('upstream boom');
      },
    });
    const model = wrapLanguageModel({ model: base, middleware: genaiOtelMiddleware(h.client) });

    await expect(generateText({ model, prompt: 'x' })).rejects.toThrow('upstream boom');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.status.code).toBe(2 /* ERROR */);
  });
});

describe('Vercel AI SDK middleware — genaiOtelMiddleware (wrapStream)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a streaming chat span with final usage', async () => {
    const base = new MockLanguageModelV3({
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
              finishReason: v3Finish('stop'),
              usage: v3Usage(6, 3),
            });
            controller.close();
          },
        }),
      }),
    });
    const model = wrapLanguageModel({ model: base, middleware: genaiOtelMiddleware(h.client) });

    const stream = streamText({ model, prompt: 'hi' });
    for await (const _chunk of stream.textStream) {
      /* drain */
    }
    await stream.usage;

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0]?.name).toBe('chat mock-stream');
    expect(spans[0]?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(6);
    expect(spans[0]?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(3);
  });
});
