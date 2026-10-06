/**
 * Targeted regression tests for metric-label correctness:
 *  - TTFT histogram includes gen_ai.operation.name
 *  - tool execution duration is on its own histogram (gen_ai.client.tool_execution.duration)
 *  - tool_calls_per_operation includes gen_ai.operation.name
 *  - gen_ai.conversation.id is added only when the client opts in
 */

import {
  type DataPoint,
  DataPointType,
  type Histogram,
  type HistogramMetricData,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientConfig } from '../src/config.js';
import { type Harness, createHarness } from './_harness.js';

function findMetric(rm: ResourceMetrics, name: string): HistogramMetricData | undefined {
  for (const sm of rm.scopeMetrics) {
    for (const m of sm.metrics) {
      if (m.descriptor.name === name && m.dataPointType === DataPointType.HISTOGRAM) {
        return m as HistogramMetricData;
      }
    }
  }
  return undefined;
}

function findPoint(
  m: HistogramMetricData | undefined,
  filter: (a: Record<string, unknown>) => boolean,
): DataPoint<Histogram> | undefined {
  return m?.dataPoints.find((p) => filter(p.attributes));
}

describe('metric labels', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('TTFT histogram carries gen_ai.operation.name', async () => {
    const rec = h.client.startStreamingGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
    });
    rec.setFirstTokenAt(Date.now() + 5);
    await rec.end();

    const metrics = await h.collectMetrics();
    const ttft = findMetric(metrics[0]!, 'gen_ai.client.time_to_first_token');
    expect(ttft).toBeDefined();
    const point = findPoint(ttft, (a) => a['gen_ai.operation.name'] === 'chat');
    expect(point).toBeDefined();
    expect(point?.attributes['gen_ai.provider.name']).toBe('openai');
    expect(point?.attributes['gen_ai.request.model']).toBe('gpt-4o');
  });

  it('tool execution duration is on a dedicated histogram', async () => {
    const rec = h.client.startToolExecution({
      toolName: 'search',
      requestProvider: 'openai',
      requestModel: 'gpt-4o',
    });
    await rec.end();

    const metrics = await h.collectMetrics();
    const toolDur = findMetric(metrics[0]!, 'gen_ai.client.tool_execution.duration');
    expect(toolDur).toBeDefined();
    const point = findPoint(toolDur, (a) => a['gen_ai.tool.name'] === 'search');
    expect(point).toBeDefined();

    // The shared operation duration histogram should NOT carry gen_ai.tool.name.
    const opDur = findMetric(metrics[0]!, 'gen_ai.client.operation.duration');
    const polluted = opDur?.dataPoints.find((p) => p.attributes['gen_ai.tool.name'] === 'search');
    expect(polluted).toBeUndefined();
  });

  it('tool_calls_per_operation carries gen_ai.operation.name', async () => {
    const rec = h.client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
    });
    rec.setResult({
      output: [
        {
          role: 'assistant',
          parts: [
            {
              kind: 'tool_call',
              toolCall: { id: 't1', name: 'search', inputJson: '{}' },
            },
          ],
        },
      ],
    });
    await rec.end();

    const metrics = await h.collectMetrics();
    const toolCalls = findMetric(metrics[0]!, 'gen_ai.client.tool_calls_per_operation');
    expect(toolCalls).toBeDefined();
    const point = findPoint(toolCalls, (a) => a['gen_ai.operation.name'] === 'chat');
    expect(point).toBeDefined();
  });
});

describe('conversation id on metrics', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.shutdown();
    h = undefined;
  });

  async function recordOneOfEach(config?: ClientConfig, conversationId = 'conv-1') {
    h = createHarness(config);
    const gen = h.client.startStreamingGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
      conversationId,
    });
    gen.setFirstTokenAt(Date.now() + 5);
    gen.setResult({ usage: { inputTokens: 10, outputTokens: 5 } });
    await gen.end();
    await h.client.startToolExecution({ toolName: 'search', conversationId }).end();
    await h.client.invokeAgent({ agentName: 'planner', conversationId }).end();
    await h.client.startRetrieval({ dataSourceId: 'docs', conversationId }).end();

    const metrics = await h.collectMetrics();
    return metrics[0]!.scopeMetrics.flatMap((sm) => sm.metrics);
  }

  it('is left off by default', async () => {
    const all = await recordOneOfEach();
    const points = all.flatMap((m) => m.dataPoints.map((p) => p.attributes));
    expect(points.length).toBeGreaterThan(0);
    for (const attrs of points) {
      expect(attrs['gen_ai.conversation.id']).toBeUndefined();
    }
  });

  it('is added to every metric when the client opts in', async () => {
    const all = await recordOneOfEach({ metricAttributes: { conversationId: true } });
    const names = all.map((m) => m.descriptor.name).sort();
    expect(names).toEqual([
      'gen_ai.client.operation.duration',
      'gen_ai.client.time_to_first_token',
      'gen_ai.client.token.usage',
      'gen_ai.client.tool_calls_per_operation',
      'gen_ai.client.tool_execution.duration',
    ]);
    for (const m of all) {
      for (const p of m.dataPoints) {
        expect(p.attributes['gen_ai.conversation.id'], m.descriptor.name).toBe('conv-1');
      }
    }
  });

  it('is omitted when the operation has no conversation id', async () => {
    const all = await recordOneOfEach({ metricAttributes: { conversationId: true } }, '');
    for (const attrs of all.flatMap((m) => m.dataPoints.map((p) => p.attributes))) {
      expect(attrs).not.toHaveProperty('gen_ai.conversation.id');
    }
  });
});
