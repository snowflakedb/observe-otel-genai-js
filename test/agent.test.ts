import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assistantTextMessage, userTextMessage } from '../src/models/message.js';
import {
  ATTR_AGENT_ID,
  ATTR_AGENT_NAME,
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  OP_INVOKE_AGENT,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('AgentInvocationRecorder', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits invoke_agent span with the canonical attribute set (fluent variant)', async () => {
    const rec = h.client.invokeAgent({
      agentName: 'responder',
      agentId: 'agent_xyz',
      requestProvider: 'openai',
      requestModel: 'gpt-4o',
      input: [userTextMessage('answer the question')],
      contentCapture: 'full',
    });
    rec.setOutput([assistantTextMessage('hello there')]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('invoke_agent responder');
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
    expect(span?.attributes[ATTR_AGENT_NAME]).toBe('responder');
    expect(span?.attributes[ATTR_AGENT_ID]).toBe('agent_xyz');
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('openai');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-4o');
    expect(span?.kind).toBe(0 /* INTERNAL */);

    const input = JSON.parse(span!.attributes[ATTR_INPUT_MESSAGES] as string);
    expect(input).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'answer the question' }] },
    ]);
    const output = JSON.parse(span!.attributes[ATTR_OUTPUT_MESSAGES] as string);
    expect(output).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'hello there' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('falls back to the bare operation name when agentName is blank', async () => {
    const rec = h.client.invokeAgent({ agentName: '' });
    await rec.end();
    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('invoke_agent');
  });

  it('strips input/output messages under metadata_only', async () => {
    await h.shutdown();
    h = createHarness({ contentCaptureMode: 'metadata_only' });
    const rec = h.client.invokeAgent({
      agentName: 'responder',
      input: [userTextMessage('secret prompt')],
    });
    rec.setOutput([assistantTextMessage('secret answer')]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_INPUT_MESSAGES]).toBeUndefined();
    expect(span?.attributes[ATTR_OUTPUT_MESSAGES]).toBeUndefined();
  });

  it('callback variant auto-parents nested generation spans under the agent span', async () => {
    await h.client.invokeAgent({ agentName: 'planner' }, async () => {
      const gen = h.client.startGeneration({
        model: { provider: 'openai', name: 'gpt-4o' },
        agentName: 'planner',
      });
      gen.setResult({ usage: { inputTokens: 5, outputTokens: 2 } });
      await gen.end();
    });

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(2);
    const agentSpan = spans.find((s) => s.name.startsWith('invoke_agent'));
    const genSpan = spans.find((s) => s.name.startsWith('chat'));
    expect(agentSpan).toBeDefined();
    expect(genSpan).toBeDefined();
    // gen span's parent should be the agent span (same traceId, parentSpanId matches)
    expect(genSpan!.spanContext().traceId).toBe(agentSpan!.spanContext().traceId);
    expect(genSpan!.parentSpanContext?.spanId).toBe(agentSpan!.spanContext().spanId);
  });

  it('callback variant ends the span even when the body throws', async () => {
    await expect(
      h.client.invokeAgent({ agentName: 'failing' }, async () => {
        throw new Error('agent failed');
      }),
    ).rejects.toThrow('agent failed');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_AGENT_NAME]).toBe('failing');
    expect(span?.status.code).toBe(2 /* ERROR */);
  });

  it('withActiveContext parents nested spans under a fluent agent span and does not end it', async () => {
    const rec = h.client.invokeAgent({ agentName: 'streamer' });

    // Simulate a streaming turn: the work is kicked off inside withActiveContext
    // (where the agent span is active), but the span is ended later.
    await rec.withActiveContext(async () => {
      const gen = h.client.startGeneration({
        model: { provider: 'openai', name: 'gpt-4o' },
        agentName: 'streamer',
      });
      gen.setResult({ usage: { inputTokens: 5, outputTokens: 2 } });
      await gen.end();
    });

    // Before end(): only the child generation span has finished; the agent span is still open.
    let finished = h.spans.getFinishedSpans();
    expect(finished.find((s) => s.name.startsWith('invoke_agent'))).toBeUndefined();
    const genSpan = finished.find((s) => s.name.startsWith('chat'));
    expect(genSpan).toBeDefined();

    await rec.end();

    finished = h.spans.getFinishedSpans();
    const agentSpan = finished.find((s) => s.name.startsWith('invoke_agent'));
    expect(agentSpan).toBeDefined();
    // The generation span nests under the agent span.
    expect(genSpan!.spanContext().traceId).toBe(agentSpan!.spanContext().traceId);
    expect(genSpan!.parentSpanContext?.spanId).toBe(agentSpan!.spanContext().spanId);
  });

  it('withActiveContext returns the callback result', () => {
    const rec = h.client.invokeAgent({ agentName: 'returner' });
    const value = rec.withActiveContext(() => 42);
    expect(value).toBe(42);
  });
});
