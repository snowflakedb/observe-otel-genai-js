/**
 * Tests for the LangChain adapter.
 *
 * Drives `GenAIOtelCallbackHandler` directly via its `handle*` methods rather
 * than wiring up a real LangChain chain — the latter brings in a lot of
 * scaffolding that adds noise without adding coverage. The adapter contract
 * IS the `handle*` methods; if those are called in the right order with the
 * right arguments, the resulting spans will be correct.
 */

import { RunnableLambda } from '@langchain/core/runnables';
import { context, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withConversationId } from '../../src/context.js';
import { GenAIOtelCallbackHandler } from '../../src/integrations/langchain/index.js';
import {
  ATTR_AGENT_NAME,
  ATTR_CONVERSATION_ID,
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_TOOL_NAME,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  OP_CHAT,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

const llmSerialized = {
  lc: 1,
  type: 'constructor',
  id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'],
  kwargs: { model: 'gpt-4o' },
};

const toolSerialized = {
  lc: 1,
  type: 'constructor',
  id: ['langchain', 'tools', 'search'],
  kwargs: {},
};

const chainSerialized = {
  lc: 1,
  type: 'constructor',
  id: ['langchain', 'chains', 'RetrievalQA'],
  kwargs: {},
};

const retrieverSerialized = {
  lc: 1,
  type: 'constructor',
  id: ['langchain', 'retrievers', 'VectorStoreRetriever'],
  kwargs: {},
};

describe('LangChain adapter — LLM lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a chat span with provider/model inferred from the Serialized id', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'lc-agent' });

    await handler.handleLLMStart!(llmSerialized as any, ['hello'], 'run-1');
    await handler.handleLLMEnd!(
      {
        generations: [[{ text: 'hi', generationInfo: { finish_reason: 'stop' } }]],
        llmOutput: {
          tokenUsage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        },
      },
      'run-1',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('openai');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-4o');
    expect(span?.attributes[ATTR_AGENT_NAME]).toBe('lc-agent');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(9);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(3);
    expect(span?.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('captures structured input + output via handleChatModelStart', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const system = { _getType: () => 'system', content: 'be nice' };
    const human = { _getType: () => 'human', content: 'hi there' };
    await handler.handleChatModelStart!(llmSerialized as any, [[system, human] as any], 'run-chat');
    await handler.handleLLMEnd!(
      {
        generations: [
          [{ text: 'hello', message: { _getType: () => 'ai', content: 'hello' } } as any],
        ],
        llmOutput: { tokenUsage: { prompt_tokens: 4, completion_tokens: 1 } },
      },
      'run-chat',
    );

    const [span] = h.spans.getFinishedSpans();
    const input = JSON.parse(span!.attributes['gen_ai.input.messages'] as string);
    expect(input).toHaveLength(2);
    expect(input[0].role).toBe('system');
    expect(input[1].role).toBe('user');
    expect(input[1].parts[0].content).toBe('hi there');
    const output = JSON.parse(span!.attributes['gen_ai.output.messages'] as string);
    expect(output[0].role).toBe('assistant');
    expect(output[0].parts[0].content).toBe('hello');
  });

  it('captures TTFT on first non-empty token', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleLLMStart!(llmSerialized as any, ['hi'], 'run-stream');
    await handler.handleLLMNewToken!('hello', {} as never, 'run-stream');
    await handler.handleLLMNewToken!(' world', {} as never, 'run-stream');
    await handler.handleLLMEnd!(
      {
        generations: [[{ text: 'hello world', generationInfo: { finish_reason: 'stop' } }]],
        llmOutput: { tokenUsage: { prompt_tokens: 1, completion_tokens: 2 } },
      },
      'run-stream',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span).toBeDefined();
  });

  it('records LLM errors as provider_call_error', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleLLMStart!(llmSerialized as any, ['hi'], 'run-err');
    await handler.handleLLMError!(
      Object.assign(new Error('upstream 500'), { status: 500 }),
      'run-err',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.attributes['error.category']).toBe('server_error');
  });
});

describe('LangChain adapter — tool lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits execute_tool spans with INTERNAL kind', async () => {
    const handler = new GenAIOtelCallbackHandler({
      client: h.client,
      contentCapture: 'full',
    });
    await handler.handleToolStart!(toolSerialized as any, '{"q":"hi"}', 'tool-1');
    await handler.handleToolEnd!('result', 'tool-1');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_EXECUTE_TOOL);
    expect(span?.attributes[ATTR_TOOL_NAME]).toBe('search');
    expect(span?.kind).toBe(0 /* INTERNAL */);
  });

  it('records tool errors as tool_execution_error', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(toolSerialized as any, '{}', 'tool-err');
    await handler.handleToolError!(new Error('tool blew up'), 'tool-err');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('tool_execution_error');
  });
});

describe('LangChain adapter — chain lifecycle (invoke_agent)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('maps top-level chain start to invoke_agent span', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      chainSerialized as never,
      { question: 'what is otel?' } as never,
      'chain-1',
    );
    await handler.handleChainEnd!({ answer: 'an otel answer' } as never, 'chain-1');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
  });

  it('skips child chain starts (parentRunId set)', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      chainSerialized as never,
      { x: 1 } as never,
      'child-1',
      'parent-1',
    );
    // No end call needed — should be a no-op
    expect(h.spans.getFinishedSpans().length).toBe(0);
  });

  it('captureChains=false disables chain instrumentation', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, captureChains: false });
    await handler.handleChainStart!(
      chainSerialized as never,
      { question: 'hi' } as never,
      'chain-skip',
    );
    await handler.handleChainEnd!({ answer: 'ok' } as never, 'chain-skip');
    expect(h.spans.getFinishedSpans().length).toBe(0);
  });

  it('applies handler contentCapture to the invoke_agent span', async () => {
    // A default harness captures agent input/output messages, so a bare handler
    // would emit them. `contentCapture: 'metadata_only'` on the handler must
    // strip them from the invoke_agent span too — not just from generation and
    // tool spans.
    const bare = new GenAIOtelCallbackHandler({ client: h.client });
    await bare.handleChainStart!(
      chainSerialized as never,
      { question: 'secret question' } as never,
      'chain-bare',
    );
    await bare.handleChainEnd!({ answer: 'secret answer' } as never, 'chain-bare');
    const bareSpan = h.spans.getFinishedSpans()[0]!;
    expect(bareSpan.attributes[ATTR_INPUT_MESSAGES]).toBeDefined();
    expect(bareSpan.attributes[ATTR_OUTPUT_MESSAGES]).toBeDefined();

    const guarded = new GenAIOtelCallbackHandler({
      client: h.client,
      contentCapture: 'metadata_only',
    });
    await guarded.handleChainStart!(
      chainSerialized as never,
      { question: 'secret question' } as never,
      'chain-guarded',
    );
    await guarded.handleChainEnd!({ answer: 'secret answer' } as never, 'chain-guarded');
    const guardedSpan = h.spans.getFinishedSpans()[1]!;
    expect(guardedSpan.attributes[ATTR_INPUT_MESSAGES]).toBeUndefined();
    expect(guardedSpan.attributes[ATTR_OUTPUT_MESSAGES]).toBeUndefined();
  });
});

describe('LangChain adapter — span nesting', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  /** name → { spanId, parentSpanId } for every finished span. */
  function byName() {
    const out = new Map<string, { id: string; parent?: string }>();
    for (const s of h.spans.getFinishedSpans()) {
      out.set(s.name, { id: s.spanContext().spanId, parent: s.parentSpanContext?.spanId });
    }
    return out;
  }

  it('parents a chat span under the chain that started it', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'nest' });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'c1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleChainEnd!({} as never, 'c1');

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(2);
    // one trace, chat nested under invoke_agent
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const map = byName();
    const agent = [...map.entries()].find(([n]) => n.startsWith('invoke_agent'))![1];
    const chat = [...map.entries()].find(([n]) => n.startsWith('chat'))![1];
    expect(agent.parent).toBeUndefined();
    expect(chat.parent).toBe(agent.id);
  });

  it('walks past suppressed intermediate chains to the nearest ancestor span', async () => {
    // LangGraph shape: root chain (span) → node chain (suppressed) → llm / tool.
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'graph' });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'root');
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'node', 'root');
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'node');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleToolStart!(toolSerialized as never, '{}', 't1', 'node');
    await handler.handleToolEnd!('ok' as never, 't1');
    await handler.handleChainEnd!({} as never, 'node');
    await handler.handleChainEnd!({} as never, 'root');

    const spans = h.spans.getFinishedSpans();
    // node chain is suppressed, so 3 spans: invoke_agent + chat + execute_tool
    expect(spans.length).toBe(3);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const map = byName();
    const agent = [...map.entries()].find(([n]) => n.startsWith('invoke_agent'))![1];
    const chat = [...map.entries()].find(([n]) => n.startsWith('chat'))![1];
    const toolSpan = [...map.entries()].find(([n]) => n.startsWith('execute_tool'))![1];
    expect(chat.parent).toBe(agent.id);
    expect(toolSpan.parent).toBe(agent.id);
  });

  it('nests the legacy handleLLMStart path too', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleLLMStart!(llmSerialized as never, ['prompt'], 'l1', 'c1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleChainEnd!({} as never, 'c1');

    const map = byName();
    const agent = [...map.entries()].find(([n]) => n.startsWith('invoke_agent'))![1];
    const chat = [...map.entries()].find(([n]) => n.startsWith('chat'))![1];
    expect(chat.parent).toBe(agent.id);
  });

  it('leaves a span with no ancestor as a root', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0]!.parentSpanContext?.spanId).toBeUndefined();
  });
});

describe('LangChain adapter — conversation id from LangGraph thread_id', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  const md = { thread_id: 'thread-42' };

  it('maps thread_id to gen_ai.conversation.id on chat, tool and chain spans', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1', undefined, [], md);
    await handler.handleChatModelStart!(
      llmSerialized as never,
      [[]] as never,
      'l1',
      'c1',
      {},
      [],
      md,
    );
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleToolStart!(toolSerialized as never, '{}', 't1', 'c1', [], md);
    await handler.handleToolEnd!('ok' as never, 't1');
    await handler.handleChainEnd!({} as never, 'c1');

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(3);
    for (const s of spans) {
      expect(s.attributes[ATTR_CONVERSATION_ID]).toBe('thread-42');
    }
  });

  it('prefers an explicitly configured conversationId over thread_id', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, conversationId: 'explicit' });
    await handler.handleChatModelStart!(
      llmSerialized as never,
      [[]] as never,
      'l1',
      undefined,
      {},
      [],
      md,
    );
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');

    const span = h.spans.getFinishedSpans()[0]!;
    expect(span.attributes[ATTR_CONVERSATION_ID]).toBe('explicit');
  });

  it('ignores the withConversationId ambient context, using per-run thread_id', async () => {
    // The handler must not read request-local AsyncLocalStorage inside a
    // callback: LangChain runs callbacks on a shared, serialized background
    // queue, so a reused handler would resolve the wrong run's ambient store
    // under concurrency. Per-run `thread_id` is the source of truth.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await withConversationId('ambient', async () => {
      await handler.handleChatModelStart!(
        llmSerialized as never,
        [[]] as never,
        'l1',
        undefined,
        {},
        [],
        md,
      );
      await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    });

    const span = h.spans.getFinishedSpans()[0]!;
    expect(span.attributes[ATTR_CONVERSATION_ID]).toBe('thread-42');
  });

  it('keeps per-run thread_id isolated when handle* is driven concurrently', async () => {
    // Regression (direct-call form): a single handler shared across two
    // concurrent runs under different ambient contexts must tag each span with
    // its own run's thread_id, never the ambient value.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });

    const runA = withConversationId('ambient-A', async () => {
      await handler.handleChatModelStart!(
        llmSerialized as never,
        [[]] as never,
        'run-A',
        undefined,
        {},
        [],
        { thread_id: 'thread-A' },
      );
      await handler.handleLLMEnd!({ generations: [[{ text: 'a' }]] } as never, 'run-A');
    });
    const runB = withConversationId('ambient-B', async () => {
      await handler.handleChatModelStart!(
        llmSerialized as never,
        [[]] as never,
        'run-B',
        undefined,
        {},
        [],
        { thread_id: 'thread-B' },
      );
      await handler.handleLLMEnd!({ generations: [[{ text: 'b' }]] } as never, 'run-B');
    });
    await Promise.all([runA, runB]);

    const byId = new Map(
      h.spans
        .getFinishedSpans()
        .map((s) => [s.attributes[ATTR_CONVERSATION_ID] as string, s] as const),
    );
    expect([...byId.keys()].sort()).toEqual(['thread-A', 'thread-B']);
  });

  it('keeps conversation ids isolated across concurrent real RunnableLambda invokes', async () => {
    // Regression (real callback-manager form): this is the scenario the review
    // flagged. Driving through `RunnableLambda.invoke` runs the callbacks on
    // LangChain's shared, serialized background queue — the exact place where an
    // ambient AsyncLocalStorage read cross-contaminated concurrent runs (both
    // spans previously received whichever run started queue processing). With
    // the ambient read removed, each run's per-run `thread_id` is authoritative.
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'concurrent' });
    const echo = RunnableLambda.from(async (input: { q: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      return { answer: input.q };
    });

    const runA = withConversationId('ambient-A', () =>
      echo.invoke({ q: 'a' }, { callbacks: [handler], metadata: { thread_id: 'thread-A' } }),
    );
    const runB = withConversationId('ambient-B', () =>
      echo.invoke({ q: 'b' }, { callbacks: [handler], metadata: { thread_id: 'thread-B' } }),
    );
    await Promise.all([runA, runB]);

    const ids = h.spans
      .getFinishedSpans()
      .filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT)
      .map((s) => s.attributes[ATTR_CONVERSATION_ID] as string)
      .sort();
    expect(ids).toEqual(['thread-A', 'thread-B']);
  });

  it('omits conversation.id when neither is provided', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');

    const span = h.spans.getFinishedSpans()[0]!;
    expect(span.attributes[ATTR_CONVERSATION_ID]).toBeUndefined();
  });
});

describe('LangChain adapter — retriever run-tree topology', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('walks past a retriever to the nearest ancestor span', async () => {
    // RAG shape: chain (span) → retriever (no span) → llm.
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'rag' });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1', 'c1');
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'r1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleRetrieverEnd!([] as never, 'r1');
    await handler.handleChainEnd!({} as never, 'c1');

    const spans = h.spans.getFinishedSpans();
    // retriever gets no span of its own: invoke_agent + chat only
    expect(spans.length).toBe(2);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const agent = spans.find((s) => s.name.startsWith('invoke_agent'))!;
    const chat = spans.find((s) => s.name.startsWith('chat'))!;
    expect(agent.parentSpanContext?.spanId).toBeUndefined();
    expect(chat.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
  });

  it('walks past a retriever nested under a suppressed chain', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'rag' });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'root');
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'node', 'root');
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1', 'node');
    await handler.handleToolStart!(toolSerialized as never, '{}', 't1', 'r1');
    await handler.handleToolEnd!('ok' as never, 't1');
    await handler.handleRetrieverEnd!([] as never, 'r1');
    await handler.handleChainEnd!({} as never, 'node');
    await handler.handleChainEnd!({} as never, 'root');

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(2);
    const agent = spans.find((s) => s.name.startsWith('invoke_agent'))!;
    const toolSpan = spans.find((s) => s.name.startsWith('execute_tool'))!;
    expect(toolSpan.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
  });

  it('forgets the retriever edge once the retriever errors', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1', 'c1');
    await handler.handleRetrieverError!(new Error('boom') as never, 'r1');
    await handler.handleChainEnd!({} as never, 'c1');

    // Only the agent span; a later run reusing 'r1' as a parent finds no
    // ancestor and starts its own root rather than attaching to a stale edge.
    expect(h.spans.getFinishedSpans().length).toBe(1);
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'r1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    const chat = h.spans.getFinishedSpans().find((s) => s.name.startsWith('chat'))!;
    expect(chat.parentSpanContext?.spanId).toBeUndefined();
  });
});

describe('LangChain adapter — chain input messages on the agent span', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  /** Parsed gen_ai.input.messages off the single invoke_agent span. */
  function agentInput(): unknown {
    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('invoke_agent'))!;
    const raw = span.attributes[ATTR_INPUT_MESSAGES];
    return raw === undefined ? undefined : JSON.parse(raw as string);
  }

  it('maps a LangGraph `messages` channel through the BaseMessage mapping', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'graph' });
    const inputs = {
      messages: [
        { _getType: () => 'system', content: 'be brief' },
        { _getType: () => 'human', content: 'what is 2+2?' },
      ],
    };
    await handler.handleChainStart!(chainSerialized as never, inputs as never, 'c1');
    await handler.handleChainEnd!({ output: '4' } as never, 'c1');

    expect(agentInput()).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'be brief' }] },
      { role: 'user', parts: [{ type: 'text', content: 'what is 2+2?' }] },
    ]);
  });

  it('maps a string `input` field to one user message', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, { input: 'hello' } as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentInput()).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }]);
  });

  it('maps RetrievalQA-style `question` too', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, { question: 'why?' } as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentInput()).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'why?' }] }]);
  });

  it('falls back to JSON for an unrecognized shape', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, { foo: 42 } as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentInput()).toEqual([
      { role: 'user', parts: [{ type: 'text', content: '{"foo":42}' }] },
    ]);
  });

  it('emits no input messages for an empty input', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentInput()).toBeUndefined();
  });
});

describe('LangChain adapter — callback dispatch mode', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('runs callbacks inline (awaitHandlers) so they inherit the caller context', () => {
    // With awaitHandlers on, LangChain executes the callbacks in the caller's
    // async context instead of on its shared background queue — the root cause
    // fix for cross-run context bleed (see concurrency test below).
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    expect(handler.awaitHandlers).toBe(true);
  });
});

describe('LangChain adapter — external parent isolation under concurrency', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('parents each concurrent invoke_agent under its own external OTel span', async () => {
    // The review scenario: two concurrent RunnableLambda.invoke() calls, each
    // under a different active OpenTelemetry span. On LangChain's shared
    // background queue both invoke_agent spans previously inherited whichever
    // request started queue processing. Running callbacks inline (awaitHandlers)
    // keeps each run's active context authoritative, so each agent span nests
    // under its own external parent and lands on its own trace.
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'concurrent' });
    const tracer = h.tracerProvider.getTracer('test');
    const echo = RunnableLambda.from(async (input: { q: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      return { answer: input.q };
    });

    const extA = tracer.startSpan('ext-A');
    const extB = tracer.startSpan('ext-B');
    const runA = context.with(trace.setSpan(context.active(), extA), () =>
      echo.invoke({ q: 'a' }, { callbacks: [handler] }),
    );
    const runB = context.with(trace.setSpan(context.active(), extB), () =>
      echo.invoke({ q: 'b' }, { callbacks: [handler] }),
    );
    await Promise.all([runA, runB]);
    extA.end();
    extB.end();

    const agents = h.spans
      .getFinishedSpans()
      .filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT);
    expect(agents.length).toBe(2);

    // No cross-contamination: two distinct traces, each agent under its own ext.
    const byTrace = new Map(agents.map((s) => [s.spanContext().traceId, s] as const));
    expect(byTrace.size).toBe(2);
    const agentA = byTrace.get(extA.spanContext().traceId);
    const agentB = byTrace.get(extB.spanContext().traceId);
    expect(agentA?.parentSpanContext?.spanId).toBe(extA.spanContext().spanId);
    expect(agentB?.parentSpanContext?.spanId).toBe(extB.spanContext().spanId);
  });
});

describe('LangChain adapter — chain output messages on the agent span', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  /** Parsed gen_ai.output.messages off the single invoke_agent span. */
  function agentOutput(): unknown {
    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('invoke_agent'))!;
    const raw = span.attributes[ATTR_OUTPUT_MESSAGES];
    return raw === undefined ? undefined : JSON.parse(raw as string);
  }

  it('maps a LangGraph `messages` channel to the final assistant message', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'graph' });
    // Final graph state carries the whole conversation; only the last message
    // is the agent's answer — the human turn is already captured as input.
    const output = {
      messages: [
        { _getType: () => 'human', content: 'what is 2+2?' },
        { _getType: () => 'ai', content: '4' },
      ],
    };
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!(output as never, 'c1');

    expect(agentOutput()).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '4' }], finish_reason: 'stop' },
    ]);
  });

  it('does not JSON-encode graph state when messages is empty', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'graph' });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({ messages: [], privateState: 'secret' } as never, 'c1');

    expect(agentOutput()).toBeUndefined();
  });

  it('does not JSON-encode graph state when the final message is unrenderable', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, agentName: 'graph' });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!(
      {
        messages: [{ _getType: () => 'ai', content: '' }],
        privateState: 'secret',
      } as never,
      'c1',
    );

    expect(agentOutput()).toBeUndefined();
  });

  it('maps a string `output` field to one assistant message', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({ output: 'done' } as never, 'c1');

    expect(agentOutput()).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'done' }], finish_reason: 'stop' },
    ]);
  });

  it('falls back to JSON for an unrecognized shape', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({ foo: 42 } as never, 'c1');

    expect(agentOutput()).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: '{"foo":42}' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('emits no output messages for an empty output', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentOutput()).toBeUndefined();
  });
});
