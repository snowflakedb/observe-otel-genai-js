import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTR_AGENT_DESCRIPTION,
  ATTR_AGENT_ID,
  ATTR_AGENT_NAME,
  ATTR_AGENT_VERSION,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  OP_CREATE_AGENT,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('AgentCreationRecorder', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('fluent variant emits create_agent span with canonical attributes', async () => {
    const rec = h.client.createAgent({
      agentName: 'planner',
      agentId: 'agent_001',
      agentVersion: '0.2.1',
      agentDescription: 'Breaks the user query into discrete steps.',
      requestProvider: 'openai',
      requestModel: 'gpt-4o',
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('create_agent planner');
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CREATE_AGENT);
    expect(span?.attributes[ATTR_AGENT_NAME]).toBe('planner');
    expect(span?.attributes[ATTR_AGENT_ID]).toBe('agent_001');
    expect(span?.attributes[ATTR_AGENT_VERSION]).toBe('0.2.1');
    expect(span?.attributes[ATTR_AGENT_DESCRIPTION]).toBe(
      'Breaks the user query into discrete steps.',
    );
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('openai');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-4o');
    expect(span?.kind).toBe(0 /* INTERNAL */);
  });

  it('falls back to the bare operation name when agentName is blank', async () => {
    const rec = h.client.createAgent({ agentName: '' });
    await rec.end();
    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('create_agent');
  });

  it('callback variant auto-parents nested spans under create_agent', async () => {
    await h.client.createAgent({ agentName: 'responder' }, async () => {
      // Pretend we register a tool — emit a generation as a stand-in for any
      // child span emitted during setup work.
      const gen = h.client.startGeneration({
        model: { provider: 'openai', name: 'gpt-4o' },
        agentName: 'responder',
      });
      gen.setResult({ usage: { inputTokens: 1, outputTokens: 1 } });
      await gen.end();
    });

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(2);
    const createSpan = spans.find((s) => s.name.startsWith('create_agent'));
    const childSpan = spans.find((s) => s.name.startsWith('chat'));
    expect(createSpan).toBeDefined();
    expect(childSpan).toBeDefined();
    expect(childSpan!.spanContext().traceId).toBe(createSpan!.spanContext().traceId);
    expect(childSpan!.parentSpanContext?.spanId).toBe(createSpan!.spanContext().spanId);
  });

  it('records errors from the setup callback and surfaces ERROR status', async () => {
    await expect(
      h.client.createAgent({ agentName: 'broken' }, async () => {
        throw new Error('tool registration failed');
      }),
    ).rejects.toThrow('tool registration failed');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_AGENT_NAME]).toBe('broken');
    expect(span?.attributes['error.type']).toBe('validation_error');
    expect(span?.status.code).toBe(2 /* ERROR */);
  });

  it('records the operation.duration metric with operation=create_agent', async () => {
    const rec = h.client.createAgent({ agentName: 'metric-check' });
    await rec.end();

    const collected = await h.collectMetrics();
    const durationMetric = flattenMetrics(collected).find(
      (m) => m.descriptor.name === 'gen_ai.client.operation.duration',
    );
    expect(durationMetric).toBeDefined();
    const createPoint = durationMetric!.dataPoints.find(
      (p) => p.attributes[ATTR_OPERATION_NAME] === OP_CREATE_AGENT,
    );
    expect(createPoint).toBeDefined();
    expect(createPoint!.attributes[ATTR_AGENT_NAME]).toBe('metric-check');
  });

  it('end() is idempotent', async () => {
    const rec = h.client.createAgent({ agentName: 'idem' });
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

function flattenMetrics(collected: unknown): FlatMetric[] {
  const out: FlatMetric[] = [];
  const list = (collected as Array<{ scopeMetrics?: Array<{ metrics?: FlatMetric[] }> }>) ?? [];
  for (const rmEntry of list) {
    for (const sm of rmEntry.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) out.push(m);
    }
  }
  return out;
}
