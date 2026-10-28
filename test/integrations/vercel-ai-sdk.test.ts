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

import { MockEmbeddingModelV3, MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tool } from 'ai';
import { z } from 'zod';

import {
  wrapEmbed,
  wrapGenerateObject,
  wrapGenerateText,
  wrapStreamText,
} from '../../src/integrations/vercel-ai-sdk/index.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_REQUEST_PRESENCE_PENALTY,
  ATTR_REQUEST_SEED,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_SYSTEM_INSTRUCTIONS,
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
    // Content capture is off by default.
    expect(span?.attributes).not.toHaveProperty(ATTR_INPUT_MESSAGES);
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

describe('Vercel AI SDK adapter — wrapper messages', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'full' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  const messagesOf = (key: string) =>
    JSON.parse(String(h.spans.getFinishedSpans()[0]?.attributes[key]));

  it('wrapGenerateText records the prompt and the reply', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hello' }],
        finishReason: v7Finish('stop'),
        usage: v7Usage(1, 1),
        warnings: [],
      }),
    });
    await wrapGenerateText(h.client, { model, prompt: 'hi' });

    expect(messagesOf(ATTR_INPUT_MESSAGES)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
    ]);
    expect(messagesOf(ATTR_OUTPUT_MESSAGES)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }], finish_reason: 'stop' },
    ]);
  });

  it("wrapGenerateText records only the last step's reply of a tool loop", async () => {
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        step++ === 0
          ? {
              content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'ping', input: '{}' }],
              finishReason: v7Finish('tool-calls'),
              usage: v7Usage(1, 1),
              warnings: [],
            }
          : {
              content: [{ type: 'text', text: 'pong' }],
              finishReason: v7Finish('stop'),
              usage: v7Usage(1, 1),
              warnings: [],
            },
    });
    await wrapGenerateText(h.client, {
      model,
      prompt: 'ping',
      tools: { ping: tool({ inputSchema: z.object({}), execute: async () => 'pong' }) },
      stopWhen: (({ steps }: { steps: unknown[] }) => steps.length >= 2) as never,
    });

    expect(messagesOf(ATTR_OUTPUT_MESSAGES)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'pong' }], finish_reason: 'stop' },
    ]);
  });

  it('wrapGenerateText leaves the tool result out when the run stops on a tool step', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'ping', input: '{}' }],
        finishReason: v7Finish('tool-calls'),
        usage: v7Usage(1, 1),
        warnings: [],
      }),
    });
    await wrapGenerateText(h.client, {
      model,
      prompt: 'ping',
      tools: { ping: tool({ inputSchema: z.object({}), execute: async () => 'pong' }) },
    });

    expect(messagesOf(ATTR_OUTPUT_MESSAGES)).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 't1', name: 'ping', arguments: {} }],
        finish_reason: 'tool-calls',
      },
    ]);
  });

  it('wrapGenerateText records the input of a call that fails', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      wrapGenerateText(h.client, { model, prompt: 'hi', maxRetries: 0 }),
    ).rejects.toThrow('boom');
    expect(messagesOf(ATTR_INPUT_MESSAGES)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
    ]);
  });

  it('records instructions as the system prompt, and nothing with recordInputs: false', async () => {
    const model = () =>
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          finishReason: v7Finish('stop'),
          usage: v7Usage(1, 1),
          warnings: [],
        }),
      });
    await wrapGenerateText(h.client, { model: model(), instructions: 'be terse', prompt: 'hi' });
    await wrapGenerateText(h.client, {
      model: model(),
      instructions: 'be terse',
      prompt: 'hi',
      telemetry: { recordInputs: false, recordOutputs: false },
    });

    const [recorded, withheld] = h.spans.getFinishedSpans();
    expect(recorded?.attributes[ATTR_SYSTEM_INSTRUCTIONS]).toBeDefined();
    for (const key of [ATTR_SYSTEM_INSTRUCTIONS, ATTR_INPUT_MESSAGES, ATTR_OUTPUT_MESSAGES]) {
      expect(withheld?.attributes, key).not.toHaveProperty(key);
    }
  });

  it('wrapStreamText records the messages and the streamed reply', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'hi there' });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({
              type: 'finish',
              finishReason: v7Finish('stop'),
              usage: v7Usage(1, 1),
            });
            controller.close();
          },
        }),
      }),
    });
    const stream = wrapStreamText(h.client, {
      model,
      messages: [{ role: 'user', content: 'say hi' }],
    });
    for await (const _chunk of stream.textStream) {
      /* drain */
    }
    await stream.usage;

    expect(messagesOf(ATTR_INPUT_MESSAGES)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'say hi' }] },
    ]);
    expect(messagesOf(ATTR_OUTPUT_MESSAGES)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'hi there' }], finish_reason: 'stop' },
    ]);
  });
});

describe('Vercel AI SDK adapter — wrapGenerateObject', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('records all the request parameters', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '{"ok":true}' }],
        finishReason: v7Finish('stop'),
        usage: v7Usage(1, 1),
        warnings: [],
      }),
    });
    await wrapGenerateObject(h.client, {
      model,
      schema: z.object({ ok: z.boolean() }),
      prompt: 'hi',
      seed: 7,
      presencePenalty: 0.5,
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_REQUEST_SEED]).toBe(7);
    expect(span?.attributes[ATTR_REQUEST_PRESENCE_PENALTY]).toBe(0.5);
  });
});

describe('Vercel AI SDK adapter — wrapStreamText time to first token', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('measures it to the first output, not to the stream opening', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            await new Promise((resolve) => setTimeout(resolve, 100));
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'hi' });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({
              type: 'finish',
              finishReason: v7Finish('stop'),
              usage: v7Usage(1, 1),
            });
            controller.close();
          },
        }),
      }),
    });
    const stream = wrapStreamText(h.client, { model, prompt: 'hi' });
    for await (const _chunk of stream.textStream) {
      /* drain */
    }
    await stream.usage;

    const ttft = h.spans.getFinishedSpans()[0]?.attributes[ATTR_RESPONSE_TIME_TO_FIRST_CHUNK];
    expect(ttft).toBeGreaterThanOrEqual(0.09);
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
