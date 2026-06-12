/**
 * Targeted regression tests for metric-label correctness:
 *  - TTFT histogram includes gen_ai.operation.name
 *  - tool execution duration is on its own histogram (gen_ai.client.tool_execution.duration)
 *  - tool_calls_per_operation includes gen_ai.operation.name
 */

import {
  type DataPoint,
  DataPointType,
  type Histogram,
  type HistogramMetricData,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
