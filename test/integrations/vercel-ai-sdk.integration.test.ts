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

import { trace } from '@opentelemetry/api';
import {
  APICallError,
  embed,
  generateObject,
  generateText,
  registerTelemetry,
  streamText,
  tool,
} from 'ai';
import { MockEmbeddingModelV3, MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { withAgent } from '../../src/context.js';
import {
  type DeriveOptionsEvent,
  genaiTelemetryIntegration,
} from '../../src/integrations/vercel-ai-sdk/index.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
  ATTR_SYSTEM_INSTRUCTIONS,
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_RESULT,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  OP_GENERATE_CONTENT,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

// ---------------------------------------------------------------------------
// Mock model builders (AI SDK v7 provider shapes)
// ---------------------------------------------------------------------------

function v7Finish(unified: 'stop' | 'tool-calls') {
  return { unified, raw: unified };
}
function v7Usage(i: number, o: number) {
  return {
    inputTokens: { total: i, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: o, text: undefined, reasoning: undefined },
  };
}

function textStreamModel(text: string, provider = 'mock', modelId = 'mock-stream') {
  return new MockLanguageModelV3({
    provider,
    modelId,
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: '0' });
          c.enqueue({ type: 'text-delta', id: '0', delta: text });
          c.enqueue({ type: 'text-end', id: '0' });
          c.enqueue({ type: 'finish', finishReason: v7Finish('stop'), usage: v7Usage(5, 2) });
          c.close();
        },
      }),
    }),
  });
}

/** Two-response streaming model: step 1 calls `ping`, step 2 emits final text. */
function toolLoopModel() {
  let call = 0;
  return new MockLanguageModelV3({
    provider: 'snowflake.chat',
    modelId: 'mock-tool',
    doStream: async () => {
      call += 1;
      if (call === 1) {
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'tool-input-start', id: 't0', toolName: 'ping' });
              c.enqueue({ type: 'tool-input-delta', id: 't0', delta: '{}' });
              c.enqueue({ type: 'tool-input-end', id: 't0' });
              c.enqueue({ type: 'tool-call', toolCallId: 't0', toolName: 'ping', input: '{}' });
              c.enqueue({
                type: 'finish',
                finishReason: v7Finish('tool-calls'),
                usage: v7Usage(4, 1),
              });
              c.close();
            },
          }),
        };
      }
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: '0' });
            c.enqueue({ type: 'text-delta', id: '0', delta: 'pong done' });
            c.enqueue({ type: 'text-end', id: '0' });
            c.enqueue({ type: 'finish', finishReason: v7Finish('stop'), usage: v7Usage(6, 3) });
            c.close();
          },
        }),
      };
    },
  });
}

async function drain(stream: { textStream: AsyncIterable<string>; usage: PromiseLike<unknown> }) {
  for await (const _ of stream.textStream) {
    /* drain */
  }
  await stream.usage;
}

function clearIntegrations() {
  (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown }).AI_SDK_TELEMETRY_INTEGRATIONS =
    undefined;
}

const byName = (h: Harness, prefix: string) =>
  h.spans.getFinishedSpans().filter((s) => s.name.startsWith(prefix));
const oneByName = (h: Harness, prefix: string) =>
  h.spans.getFinishedSpans().find((s) => s.name.startsWith(prefix));

// ---------------------------------------------------------------------------

describe('genaiTelemetryIntegration', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'no_tool_content' });
  });
  afterEach(async () => {
    clearIntegrations();
    await h.shutdown();
  });

  it('nests chat under invoke_agent for a single streamText and records usage', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await drain(streamText({ model: textStreamModel('hi there'), prompt: 'hi' }));

    const agent = oneByName(h, 'invoke_agent');
    const chat = oneByName(h, 'chat');
    expect(agent).toBeDefined();
    expect(chat).toBeDefined();
    expect(chat!.spanContext().traceId).toBe(agent!.spanContext().traceId);
    expect(chat!.parentSpanContext?.spanId).toBe(agent!.spanContext().spanId);
    expect(chat!.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(5);
    expect(chat!.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(2);
    // agent output captured from aggregated content
    expect(agent!.attributes[ATTR_OUTPUT_MESSAGES]).toBeDefined();
  });

  it('works for non-streaming generateText', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-gen',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hello' }],
        finishReason: v7Finish('stop'),
        usage: v7Usage(9, 3),
        warnings: [],
        response: { id: 'r1', modelId: 'mock-gen-served', timestamp: new Date() },
      }),
    });
    const out = await generateText({ model, prompt: 'hi' });
    expect(out.text).toBe('hello');
    expect(oneByName(h, 'invoke_agent')).toBeDefined();
    expect(oneByName(h, 'chat')?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(9);
  });

  it('normalizes provider names on operation and generation spans', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    const model = new MockLanguageModelV3({
      provider: 'snowflake.chat',
      modelId: 'snowflake-gen',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hello' }],
        finishReason: v7Finish('stop'),
        usage: v7Usage(2, 1),
        warnings: [],
      }),
    });

    await generateText({ model, prompt: 'hi' });

    expect(oneByName(h, 'invoke_agent')?.attributes[ATTR_PROVIDER_NAME]).toBe('snowflake');
    expect(oneByName(h, 'chat')?.attributes[ATTR_PROVIDER_NAME]).toBe('snowflake');
  });

  it('nests execute_tool under chat under invoke_agent in a 2-step tool loop', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await drain(
      streamText({
        model: toolLoopModel(),
        prompt: 'ping please',
        tools: {
          ping: tool({
            description: 'ping',
            inputSchema: z.object({}),
            execute: async () => 'pong',
          }),
        },
        stopWhen: (({ steps }: { steps: unknown[] }) => steps.length >= 2) as never,
      }),
    );

    const agent = oneByName(h, 'invoke_agent');
    const chats = byName(h, 'chat');
    const toolSpan = oneByName(h, 'execute_tool');
    expect(agent).toBeDefined();
    expect(chats.length).toBe(2);
    expect(toolSpan).toBeDefined();
    expect(chats.every((c) => c.parentSpanContext?.spanId === agent!.spanContext().spanId)).toBe(
      true,
    );
    const toolParent = chats.find(
      (c) => c.spanContext().spanId === toolSpan!.parentSpanContext?.spanId,
    );
    expect(toolParent).toBeDefined();
  });

  it('parents spans created inside tool.execute under the execute_tool span', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await drain(
      streamText({
        model: toolLoopModel(),
        prompt: 'ping please',
        tools: {
          ping: tool({
            description: 'ping',
            inputSchema: z.object({}),
            execute: async () => {
              // Stand-in for auto-instrumented HTTP/undici work kicked off after
              // an await — must nest under execute_tool, not an ambient ancestor.
              await Promise.resolve();
              const child = trace.getTracer('genai-otel-test').startSpan('tool.downstream');
              child.end();
              return 'pong';
            },
          }),
        },
        stopWhen: (({ steps }: { steps: unknown[] }) => steps.length >= 2) as never,
      }),
    );

    const toolSpan = oneByName(h, 'execute_tool');
    const downstream = oneByName(h, 'tool.downstream');
    expect(toolSpan).toBeDefined();
    expect(downstream).toBeDefined();
    expect(downstream!.parentSpanContext?.spanId).toBe(toolSpan!.spanContext().spanId);
  });

  it('parents nested generateText inside tool.execute under the execute_tool span', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await drain(
      streamText({
        model: toolLoopModel(),
        prompt: 'ping please',
        tools: {
          ping: tool({
            description: 'ping',
            inputSchema: z.object({}),
            execute: async () => {
              await generateText({
                model: textStreamModel('nested', 'mock', 'nested-gen'),
                prompt: 'from tool',
              });
              return 'pong';
            },
          }),
        },
        stopWhen: (({ steps }: { steps: unknown[] }) => steps.length >= 2) as never,
      }),
    );

    const toolSpan = oneByName(h, 'execute_tool');
    expect(toolSpan).toBeDefined();
    const nestedAgent = h.spans
      .getFinishedSpans()
      .find(
        (s) =>
          s.name.startsWith('invoke_agent') &&
          s.parentSpanContext?.spanId === toolSpan!.spanContext().spanId,
      );
    expect(nestedAgent).toBeDefined();
    const nestedChat = h.spans
      .getFinishedSpans()
      .find(
        (s) =>
          s.name.startsWith('chat') &&
          s.parentSpanContext?.spanId === nestedAgent!.spanContext().spanId,
      );
    expect(nestedChat).toBeDefined();
  });

  it('keeps two concurrent operations isolated via callId', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    const a = streamText({ model: textStreamModel('AAA'), prompt: 'a' });
    const b = streamText({ model: textStreamModel('BBB'), prompt: 'b' });
    await Promise.all([drain(a), drain(b)]);

    const agents = byName(h, 'invoke_agent');
    const chats = byName(h, 'chat');
    expect(agents.length).toBe(2);
    expect(chats.length).toBe(2);
    const parents = new Set(chats.map((c) => c.parentSpanContext?.spanId));
    expect(parents.size).toBe(2);
    expect(
      chats.every((c) =>
        agents.some((ag) => ag.spanContext().spanId === c.parentSpanContext?.spanId),
      ),
    ).toBe(true);
  });

  it('derives identity/tags from runtimeContext', async () => {
    const deriveOptions = (e: DeriveOptionsEvent) => {
      const rc = (e.runtimeContext ?? {}) as Record<string, unknown>;
      return {
        agentName: e.functionId ?? 'fallback',
        conversationId: rc.conversationId as string | undefined,
        userId: rc.userId as string | undefined,
        tags: { agentMode: String(rc.agentMode ?? '') },
      };
    };
    registerTelemetry(genaiTelemetryIntegration(h.client, { deriveOptions }));
    await drain(
      streamText({
        model: textStreamModel('hi'),
        prompt: 'hi',
        runtimeContext: { conversationId: 'conv-1', userId: 'u-1', agentMode: 'General' },
        telemetry: {
          functionId: 'o11y-agent',
          includeRuntimeContext: { conversationId: true, userId: true, agentMode: true },
        } as never,
      }),
    );
    const agent = oneByName(h, 'invoke_agent');
    expect(agent?.name).toBe('invoke_agent o11y-agent');
    expect(agent?.attributes['gen_ai.conversation.id']).toBe('conv-1');
    expect(agent?.attributes['user.id']).toBe('u-1');
  });

  it('emitOperationSpan=false suppresses the invoke_agent span', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client, { emitOperationSpan: false }));
    await drain(streamText({ model: textStreamModel('hi'), prompt: 'hi' }));
    expect(oneByName(h, 'invoke_agent')).toBeUndefined();
    const chat = oneByName(h, 'chat');
    expect(chat).toBeDefined();
    // No agent parent — chat is a root span.
    expect(chat!.parentSpanContext).toBeUndefined();
  });

  it('captures a generate_content span for generateObject', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-obj',
      doGenerate: async () => ({
        content: [{ type: 'text', text: '{"ok":true}' }],
        finishReason: v7Finish('stop'),
        usage: v7Usage(11, 6),
        warnings: [],
        response: { id: 'obj-1', modelId: 'mock-obj-served', timestamp: new Date() },
      }),
    });
    const out = await generateObject({
      model,
      schema: z.object({ ok: z.boolean() }),
      prompt: 'give me ok',
    });
    expect(out.object.ok).toBe(true);
    const gen = byName(h, 'chat').concat(
      h.spans
        .getFinishedSpans()
        .filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_GENERATE_CONTENT),
    );
    expect(gen.length).toBeGreaterThan(0);
    const input = h.spans.getFinishedSpans().find((s) => s.attributes[ATTR_INPUT_MESSAGES]);
    expect(input).toBeDefined();
  });

  it('marks the agent span ERROR when the model call throws', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-fail',
      doGenerate: async () => {
        throw new Error('provider boom');
      },
    });
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow(
      'provider boom',
    );
    expect(oneByName(h, 'invoke_agent')?.status.code).toBe(2 /* ERROR */);
    expect(oneByName(h, 'chat')?.status.code).toBe(2 /* ERROR */);
    expect(h.openSpanCount()).toBe(0);
  });

  it('does not mark a call as failed when its model call succeeds on retry', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    let attempts = 0;
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-retry',
      doGenerate: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new APICallError({
            message: 'rate limited',
            url: 'https://example.test',
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { 'retry-after-ms': '0' },
            isRetryable: true,
          });
        }
        return {
          content: [{ type: 'text', text: 'hello' }],
          finishReason: v7Finish('stop'),
          usage: v7Usage(3, 1),
          warnings: [],
        };
      },
    });

    await generateText({ model, prompt: 'hi', maxRetries: 1 });

    expect(attempts).toBe(2);
    expect(oneByName(h, 'invoke_agent')?.status.code).not.toBe(2);
    const chat = oneByName(h, 'chat');
    expect(chat?.status.code).not.toBe(2);
    expect(chat?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(1);
  });

  it('records the error of an operation that fails outside the model call', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await expect(
      generateText({
        model: textStreamModel('unused'),
        prompt: 'hi',
        prepareStep: () => {
          throw new Error('prepare boom');
        },
      }),
    ).rejects.toThrow('prepare boom');

    const agent = oneByName(h, 'invoke_agent');
    expect(agent?.status.code).toBe(2 /* ERROR */);
    expect(agent?.status.message).toBe('prepare boom');
  });

  it('records the error on the call that failed while another call is running', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-slow',
      doGenerate: async () => {
        await released;
        return {
          content: [{ type: 'text', text: 'fine' }],
          finishReason: v7Finish('stop'),
          usage: v7Usage(1, 1),
          warnings: [],
        };
      },
    });
    const ok = generateText({
      model: slowModel,
      prompt: 'a',
      telemetry: { functionId: 'ok-agent' } as never,
    });

    await expect(
      generateText({
        model: textStreamModel('unused'),
        prompt: 'b',
        telemetry: { functionId: 'bad-agent' } as never,
        prepareStep: () => {
          throw new Error('prepare boom');
        },
      }),
    ).rejects.toThrow('prepare boom');
    release();
    await ok;

    const agents = byName(h, 'invoke_agent');
    expect(agents.map((s) => s.name).sort()).toEqual([
      'invoke_agent bad-agent',
      'invoke_agent ok-agent',
    ]);
    const bad = agents.find((s) => s.name === 'invoke_agent bad-agent');
    const good = agents.find((s) => s.name === 'invoke_agent ok-agent');
    expect(bad?.status).toMatchObject({ code: 2, message: 'prepare boom' });
    expect(good?.status.code).not.toBe(2);
  });

  it('leaves embed untraced, whether it succeeds or fails', async () => {
    registerTelemetry(genaiTelemetryIntegration(h.client));
    const model = (fail: boolean) =>
      new MockEmbeddingModelV3({
        provider: 'mock',
        modelId: 'mock-embed',
        doEmbed: async ({ values }: { values: string[] }) => {
          if (fail) throw new Error('embed boom');
          return { embeddings: values.map(() => [0.1]), usage: { tokens: 1 }, warnings: [] };
        },
      });

    await embed({ model: model(false), value: 'hi' });
    await expect(embed({ model: model(true), value: 'hi', maxRetries: 0 })).rejects.toThrow(
      'embed boom',
    );

    expect(h.spans.getFinishedSpans()).toEqual([]);
  });
});

describe('genaiTelemetryIntegration identity', () => {
  let h: Harness;
  afterEach(async () => {
    clearIntegrations();
    await h.shutdown();
  });

  const run = (telemetry?: Record<string, unknown>) =>
    drain(
      streamText({ model: textStreamModel('hi'), prompt: 'hi', telemetry: telemetry as never }),
    );

  it("names a call with no functionId after the client's agent", async () => {
    h = createHarness({ agentName: 'shop-bot' });
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await run();
    expect(oneByName(h, 'invoke_agent')?.name).toBe('invoke_agent shop-bot');
    expect(oneByName(h, 'chat')?.attributes['gen_ai.agent.name']).toBe('shop-bot');
  });

  it('takes the name of an enclosing scope when deriveOptions gives none', async () => {
    h = createHarness({ agentName: 'shop-bot' });
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await withAgent('scoped', () => run());
    expect(oneByName(h, 'invoke_agent')?.name).toBe('invoke_agent scoped');
  });

  it('gives an unnamed call a plain invoke_agent span and no agent name', async () => {
    h = createHarness();
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await run();
    const agent = oneByName(h, 'invoke_agent');
    expect(agent?.name).toBe('invoke_agent');
    expect(agent?.attributes['gen_ai.agent.name']).toBeUndefined();
  });

  it('lets functionId beat the enclosing scope and the client', async () => {
    h = createHarness({ agentName: 'shop-bot' });
    registerTelemetry(genaiTelemetryIntegration(h.client));
    await withAgent('scoped', () => run({ functionId: 'query-card' }));
    expect(oneByName(h, 'invoke_agent')?.name).toBe('invoke_agent query-card');
  });

  it("hands the operation's identity to its tool spans and to a nested generateText", async () => {
    h = createHarness();
    const deriveOptions = (e: DeriveOptionsEvent) =>
      e.functionId === 'outer-agent'
        ? { agentName: e.functionId, conversationId: 'conv-1', userId: 'u-1' }
        : {};
    registerTelemetry(genaiTelemetryIntegration(h.client, { deriveOptions }));
    await drain(
      streamText({
        model: toolLoopModel(),
        prompt: 'ping please',
        telemetry: { functionId: 'outer-agent' } as never,
        tools: {
          ping: tool({
            description: 'ping',
            inputSchema: z.object({}),
            execute: async () => {
              await generateText({
                model: textStreamModel('nested', 'mock', 'nested-gen'),
                prompt: 'from tool',
              });
              return 'pong';
            },
          }),
        },
        stopWhen: (({ steps }: { steps: unknown[] }) => steps.length >= 2) as never,
      }),
    );

    const nestedChat = h.spans
      .getFinishedSpans()
      .find(
        (s) => s.attributes['gen_ai.request.model'] === 'nested-gen' && s.name.startsWith('chat'),
      );
    for (const span of [oneByName(h, 'execute_tool'), nestedChat]) {
      expect(span?.attributes['gen_ai.agent.name']).toBe('outer-agent');
      expect(span?.attributes['gen_ai.conversation.id']).toBe('conv-1');
      expect(span?.attributes['user.id']).toBe('u-1');
    }
  });

  it("keeps the client's version when deriveOptions gives the client's agent name", async () => {
    h = createHarness({ agentName: 'o11y', agentVersion: 'agent-v1' });
    registerTelemetry(
      genaiTelemetryIntegration(h.client, { deriveOptions: () => ({ agentName: 'o11y' }) }),
    );
    await run({ functionId: 'o11y-agent' });
    for (const name of ['invoke_agent', 'chat']) {
      expect(oneByName(h, name)?.attributes['gen_ai.agent.name']).toBe('o11y');
      expect(oneByName(h, name)?.attributes['gen_ai.agent.version']).toBe('agent-v1');
    }
  });
});

describe('genaiTelemetryIntegration recordInputs / recordOutputs', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'full' });
    registerTelemetry(genaiTelemetryIntegration(h.client));
  });
  afterEach(async () => {
    clearIntegrations();
    await h.shutdown();
  });

  const runToolLoop = (telemetry?: { recordInputs?: boolean; recordOutputs?: boolean }) =>
    drain(
      streamText({
        model: toolLoopModel(),
        system: 'be terse',
        prompt: 'ping please',
        tools: {
          ping: tool({
            description: 'ping',
            inputSchema: z.object({}),
            execute: async () => 'pong',
          }),
        },
        stopWhen: (({ steps }: { steps: unknown[] }) => steps.length >= 2) as never,
        telemetry,
      }),
    );

  it('records the system prompt, tool arguments and tool result by default', async () => {
    await runToolLoop();
    const toolSpan = oneByName(h, 'execute_tool');
    expect(oneByName(h, 'chat')?.attributes[ATTR_SYSTEM_INSTRUCTIONS]).toBeDefined();
    expect(toolSpan?.attributes[ATTR_TOOL_CALL_ARGUMENTS]).toBeDefined();
    expect(toolSpan?.attributes[ATTR_TOOL_CALL_RESULT]).toBeDefined();
  });

  it('omits the system prompt and tool arguments when recordInputs is false', async () => {
    await runToolLoop({ recordInputs: false });
    const toolSpan = oneByName(h, 'execute_tool');
    expect(
      byName(h, 'chat').every((c) => c.attributes[ATTR_SYSTEM_INSTRUCTIONS] === undefined),
    ).toBe(true);
    expect(toolSpan?.attributes[ATTR_TOOL_CALL_ARGUMENTS]).toBeUndefined();
    expect(toolSpan?.attributes[ATTR_TOOL_CALL_RESULT]).toBeDefined();
  });

  it('omits the tool result when recordOutputs is false', async () => {
    await runToolLoop({ recordOutputs: false });
    const toolSpan = oneByName(h, 'execute_tool');
    expect(toolSpan?.attributes[ATTR_TOOL_CALL_ARGUMENTS]).toBeDefined();
    expect(toolSpan?.attributes[ATTR_TOOL_CALL_RESULT]).toBeUndefined();
  });
});
