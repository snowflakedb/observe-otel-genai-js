import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTR_AGENT_NAME,
  ATTR_CONVERSATION_ID,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_REQUEST_TEMPERATURE,
  ATTR_RESPONSE_MODEL,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  METRIC_OPERATION_DURATION,
  METRIC_TIME_TO_FIRST_TOKEN,
  METRIC_TOKEN_USAGE,
  OP_CHAT,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('GenerationRecorder', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a chat span with the canonical semconv attribute set', async () => {
    const rec = h.client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
      conversationId: 'conv-1',
      agentName: 'planner',
      temperature: 0.2,
    });

    rec.setResult({
      usage: { inputTokens: 25, outputTokens: 60 },
      responseId: 'resp_123',
      responseModel: 'gpt-4o-2024-08-06',
      stopReason: 'stop',
    });

    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span).toBeDefined();
    // Span name is `<operation> <request-model>`.
    expect(span!.name).toBe('chat gpt-4o');
    expect(span!.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span!.attributes[ATTR_PROVIDER_NAME]).toBe('openai');
    expect(span!.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-4o');
    expect(span!.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-4o-2024-08-06');
    expect(span!.attributes[ATTR_CONVERSATION_ID]).toBe('conv-1');
    expect(span!.attributes[ATTR_AGENT_NAME]).toBe('planner');
    expect(span!.attributes[ATTR_REQUEST_TEMPERATURE]).toBe(0.2);
    expect(span!.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(25);
    expect(span!.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(60);
  });

  it('records duration + token-usage histograms with the right token.type labels', async () => {
    const rec = h.client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
      agentName: 'planner',
    });
    rec.setResult({ usage: { inputTokens: 100, outputTokens: 50 } });
    await rec.end();

    const collected = await h.collectMetrics();
    const ops = flattenScopeMetrics(collected);

    const duration = ops.find((m) => m.descriptor.name === METRIC_OPERATION_DURATION);
    expect(duration, 'duration histogram present').toBeDefined();

    const tokens = ops.find((m) => m.descriptor.name === METRIC_TOKEN_USAGE);
    expect(tokens, 'token usage histogram present').toBeDefined();

    const tokenTypes = tokens!.dataPoints.map((p) => p.attributes['gen_ai.token.type']);
    expect(tokenTypes).toContain('input');
    expect(tokenTypes).toContain('output');
    // cache_read/cache_write/etc should NOT be emitted because their values are 0.
    expect(tokenTypes).not.toContain('cache_read');
    expect(tokenTypes).not.toContain('cache_write');
    expect(tokenTypes).not.toContain('reasoning');
  });

  it('records TTFT only for streaming generations when setFirstTokenAt() is called', async () => {
    const rec = h.client.startStreamingGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
      agentName: 'streamer',
    });
    rec.setFirstTokenAt(Date.now());
    rec.setResult({ usage: { inputTokens: 5, outputTokens: 1 } });
    await rec.end();

    const ops = flattenScopeMetrics(await h.collectMetrics());
    const ttft = ops.find((m) => m.descriptor.name === METRIC_TIME_TO_FIRST_TOKEN);
    expect(ttft, 'ttft histogram is recorded for streaming').toBeDefined();
  });

  it('does not record TTFT for non-streaming generations', async () => {
    const rec = h.client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
    });
    rec.setFirstTokenAt(Date.now()); // user accidentally calls this
    rec.setResult({ usage: { inputTokens: 5, outputTokens: 1 } });
    await rec.end();

    const ops = flattenScopeMetrics(await h.collectMetrics());
    const ttft = ops.find((m) => m.descriptor.name === METRIC_TIME_TO_FIRST_TOKEN);
    expect(ttft).toBeUndefined();
  });

  it('classifies a 429 provider error as rate_limit and sets ERROR status', async () => {
    const rec = h.client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
    });

    class ProviderErr extends Error {
      status = 429;
    }
    rec.setCallError(new ProviderErr('rate limited'));
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span!.attributes['error.type']).toBe('provider_call_error');
    expect(span!.attributes['error.category']).toBe('rate_limit');
    expect(span!.status.code).toBe(2 /* ERROR */);
  });

  it('await-using guarantees end() even when the body throws', async () => {
    let captured: Error | undefined;
    try {
      await using rec = h.client.startGeneration({
        model: { provider: 'openai', name: 'gpt-4o' },
      });
      rec.setResult({ usage: { inputTokens: 3, outputTokens: 0 } });
      throw new Error('boom');
    } catch (err) {
      captured = err as Error;
    }
    expect(captured?.message).toBe('boom');
    // span was finished by the asyncDispose hook
    expect(h.spans.getFinishedSpans().length).toBe(1);
  });

  it('end() is idempotent', async () => {
    const rec = h.client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
    });
    rec.setResult({ usage: { inputTokens: 1, outputTokens: 1 } });
    await rec.end();
    await rec.end();
    await rec.end();
    expect(h.spans.getFinishedSpans().length).toBe(1);
  });
});

interface FlatMetric {
  descriptor: { name: string };
  dataPoints: { attributes: Record<string, unknown>; value?: unknown }[];
}

function flattenScopeMetrics(collected: unknown): FlatMetric[] {
  const out: FlatMetric[] = [];
  const list = (collected as Array<{ scopeMetrics?: Array<{ metrics?: FlatMetric[] }> }>) ?? [];
  for (const rmEntry of list) {
    for (const sm of rmEntry.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        out.push(m);
      }
    }
  }
  return out;
}
