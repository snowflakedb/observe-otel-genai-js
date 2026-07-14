import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentTurn } from '../../src/integrations/vercel-ai-sdk/index.js';
import { type Message, userTextMessage } from '../../src/models/message.js';
import { ATTR_INPUT_MESSAGES, ATTR_OUTPUT_MESSAGES } from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

// ---------------------------------------------------------------------------
// Minimal AI SDK v7 event builders (subset needed to drive the hook bag).
// ---------------------------------------------------------------------------

function stepStartEvent(messages: Array<{ role: string; content: string }> = []) {
  return {
    stepNumber: 0,
    provider: 'openai',
    modelId: 'gpt-4o',
    messages,
    instructions: undefined,
  };
}

function stepFinishEvent(text = 'done') {
  return {
    stepNumber: 0,
    model: { provider: 'openai', modelId: 'gpt-4o' },
    content: text ? [{ type: 'text' as const, text }] : [],
    text,
    toolCalls: [],
    toolResults: [],
    finishReason: 'stop',
    usage: { inputTokens: 3, outputTokens: 1 },
    response: { id: 'resp-1', modelId: 'gpt-4o-served' },
  };
}

const agentSpan = (h: Harness) =>
  h.spans.getFinishedSpans().find((s) => s.name.startsWith('invoke_agent'));
const chatSpan = (h: Harness) => h.spans.getFinishedSpans().find((s) => s.name.startsWith('chat'));

describe('agentTurn', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('maps ModelMessage[] input, skipping system messages', () => {
    const turn = agentTurn(h.client, {
      agentName: 'responder',
      input: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hello' },
      ] as never,
    });
    turn.end();

    const span = agentSpan(h);
    const input = JSON.parse(span!.attributes[ATTR_INPUT_MESSAGES] as string);
    expect(input).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }]);
  });

  it('passes through input already in Message[] form', () => {
    const messages: Message[] = [userTextMessage('hi there')];
    const turn = agentTurn(h.client, { agentName: 'responder', input: messages });
    turn.end();

    const input = JSON.parse(agentSpan(h)!.attributes[ATTR_INPUT_MESSAGES] as string);
    expect(input).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'hi there' }] }]);
  });

  it('run() parents step spans under the agent span and does not end it', async () => {
    const turn = agentTurn(h.client, { agentName: 'streamer' }, { agentName: 'streamer' });

    // streamText is called synchronously inside run(); the per-step spans the
    // hooks open capture the agent span as their active parent.
    turn.run(() => {
      turn.hooks.onStepStart?.(stepStartEvent([{ role: 'user', content: 'hi' }]));
    });
    await turn.hooks.onStepEnd(stepFinishEvent());

    // Before end(): the child chat span finished, the agent span is still open.
    expect(agentSpan(h)).toBeUndefined();
    expect(chatSpan(h)).toBeDefined();

    turn.end({ output: 'ok' });

    const agent = agentSpan(h);
    const chat = chatSpan(h);
    expect(agent).toBeDefined();
    expect(chat!.spanContext().traceId).toBe(agent!.spanContext().traceId);
    expect(chat!.parentSpanContext?.spanId).toBe(agent!.spanContext().spanId);
  });

  it('folds a caller onStepEnd into the hook bag (both fire)', async () => {
    let callerFired = false;
    const turn = agentTurn(
      h.client,
      { agentName: 'composer' },
      { agentName: 'composer' },
      {
        onStepEnd: () => {
          callerFired = true;
        },
      },
    );
    turn.hooks.onStepStart?.(stepStartEvent());
    await turn.hooks.onStepEnd(stepFinishEvent());
    turn.end();

    expect(callerFired).toBe(true);
    expect(chatSpan(h)).toBeDefined();
  });

  it('end({output: string}) records gen_ai.output.messages', () => {
    const turn = agentTurn(h.client, { agentName: 'responder' });
    turn.end({ output: 'final answer' });

    const output = JSON.parse(agentSpan(h)!.attributes[ATTR_OUTPUT_MESSAGES] as string);
    expect(output).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'final answer' }] },
    ]);
  });

  it('end({error}) marks the span as ERROR', () => {
    const turn = agentTurn(h.client, { agentName: 'responder' });
    turn.end({ error: new Error('boom') });
    expect(agentSpan(h)?.status.code).toBe(2 /* ERROR */);
  });

  it('is idempotent — error wins over a later output, second call is a no-op', () => {
    const turn = agentTurn(h.client, { agentName: 'responder' });
    turn.end({ error: new Error('boom') });
    turn.end({ output: 'late output' });

    const spans = h.spans.getFinishedSpans().filter((s) => s.name.startsWith('invoke_agent'));
    expect(spans.length).toBe(1);
    expect(spans[0]?.status.code).toBe(2 /* ERROR */);
    expect(spans[0]?.attributes[ATTR_OUTPUT_MESSAGES]).toBeUndefined();
  });

  it('await using closes an un-ended turn on scope exit', async () => {
    {
      await using turn = agentTurn(h.client, { agentName: 'disposer' });
      void turn;
    }
    expect(agentSpan(h)).toBeDefined();
  });
});
