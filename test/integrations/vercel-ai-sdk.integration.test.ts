import { trace } from '@opentelemetry/api';
import { generateObject, generateText, registerTelemetry, streamText, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type DeriveOptionsEvent,
  genaiTelemetryIntegration,
} from '../../src/integrations/vercel-ai-sdk/index.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
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
    const agent = oneByName(h, 'invoke_agent');
    expect(agent?.status.code).toBe(2 /* ERROR */);
  });
});
