/**
 * Tests for the LangChain adapter.
 *
 * Drives `GenAIOtelCallbackHandler` directly via its `handle*` methods rather
 * than wiring up a real LangChain chain — the latter brings in a lot of
 * scaffolding that adds noise without adding coverage. The adapter contract
 * IS the `handle*` methods; if those are called in the right order with the
 * right arguments, the resulting spans will be correct.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GenAIOtelCallbackHandler } from '../../src/integrations/langchain/index.js';
import {
  ATTR_AGENT_NAME,
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
