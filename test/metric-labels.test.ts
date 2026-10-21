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

/**
 * Targeted regression tests for metric-label correctness:
 *  - TTFT histogram includes gen_ai.operation.name
 *  - tool execution duration is on its own histogram (gen_ai.client.tool_execution.duration)
 *  - tool_calls_per_operation includes gen_ai.operation.name
 *  - gen_ai.conversation.id is added only when the client opts in
 *  - string labels are trimmed, as span attributes are
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
import { withUserId } from '../src/context.js';
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
    await h.client.invokeWorkflow({ workflowName: 'rag', conversationId }).end();
    await h.client.startRetrieval({ dataSourceId: 'docs', conversationId }).end();
    await h.client
      .startEmbedding({ model: { provider: 'openai', name: 'embed-3' }, conversationId })
      .end();

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
      'gen_ai.invoke_workflow.duration',
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

describe('user id on metrics', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.shutdown();
    h = undefined;
  });

  async function recordOneOfEach(config?: ClientConfig, userId = 'user-1') {
    h = createHarness(config);
    const gen = h.client.startStreamingGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
      userId,
    });
    gen.setFirstTokenAt(Date.now() + 5);
    gen.setResult({ usage: { inputTokens: 10, outputTokens: 5 } });
    await gen.end();
    await h.client.startToolExecution({ toolName: 'search', userId }).end();
    await h.client.invokeAgent({ agentName: 'planner', userId }).end();
    await h.client.invokeWorkflow({ workflowName: 'rag', userId }).end();
    await h.client.startRetrieval({ dataSourceId: 'docs', userId }).end();
    await h.client.startEmbedding({ model: { provider: 'openai', name: 'embed-3' }, userId }).end();

    const metrics = await h.collectMetrics();
    return metrics[0]!.scopeMetrics.flatMap((sm) => sm.metrics);
  }

  const points = (all: Awaited<ReturnType<typeof recordOneOfEach>>) =>
    all.flatMap((m) => m.dataPoints.map((p) => p.attributes));

  it('is left off by default', async () => {
    const all = await recordOneOfEach();
    expect(points(all).length).toBeGreaterThan(0);
    for (const attrs of points(all)) expect(attrs).not.toHaveProperty('user.id');
  });

  it('is added to every metric when the client opts in', async () => {
    const all = await recordOneOfEach({ metricAttributes: { userId: true } });
    expect(all.map((m) => m.descriptor.name).sort()).toEqual([
      'gen_ai.client.operation.duration',
      'gen_ai.client.time_to_first_token',
      'gen_ai.client.token.usage',
      'gen_ai.client.tool_calls_per_operation',
      'gen_ai.client.tool_execution.duration',
      'gen_ai.invoke_workflow.duration',
    ]);
    for (const m of all) {
      for (const p of m.dataPoints)
        expect(p.attributes['user.id'], m.descriptor.name).toBe('user-1');
    }
  });

  it('is omitted when the operation has no user id', async () => {
    const all = await recordOneOfEach({ metricAttributes: { userId: true } }, '');
    for (const attrs of points(all)) expect(attrs).not.toHaveProperty('user.id');
  });

  it('takes the user id from the scope, the agent above, or the client', async () => {
    h = createHarness({ metricAttributes: { userId: true }, userId: 'client-user' });
    await withUserId('scoped-user', () =>
      h!.client.startToolExecution({ toolName: 'from-scope' }).end(),
    );
    await h.client.invokeAgent({ agentName: 'planner', userId: 'agent-user' }, () =>
      h!.client.startToolExecution({ toolName: 'from-agent' }).end(),
    );
    await h.client.startToolExecution({ toolName: 'from-client' }).end();

    const metrics = await h.collectMetrics();
    const tool = metrics[0]!.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'gen_ai.client.tool_execution.duration')!;
    const byTool = Object.fromEntries(
      tool.dataPoints.map((p) => [p.attributes['gen_ai.tool.name'], p.attributes['user.id']]),
    );
    expect(byTool).toEqual({
      'from-scope': 'scoped-user',
      'from-agent': 'agent-user',
      'from-client': 'client-user',
    });
  });
});

describe('label trimming', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.shutdown();
    h = undefined;
  });

  it('trims every string label', async () => {
    h = createHarness({ metricAttributes: { conversationId: true, userId: true } });
    const identity = { agentName: ' planner ', conversationId: ' conv-1 ', userId: ' user-1 ' };
    const gen = h.client.startStreamingGeneration({
      model: { provider: ' openai ', name: ' gpt-4o ' },
      ...identity,
    });
    gen.setFirstTokenAt(Date.now() + 5);
    gen.setResult({ usage: { inputTokens: 10, outputTokens: 5 } });
    await gen.end();
    await h.client.startToolExecution({ toolName: ' search ', ...identity }).end();
    await h.client.invokeAgent(identity).end();

    const metrics = await h.collectMetrics();
    const all = metrics[0]!.scopeMetrics.flatMap((sm) => sm.metrics);
    expect(all.map((m) => m.descriptor.name).sort()).toEqual([
      'gen_ai.client.operation.duration',
      'gen_ai.client.time_to_first_token',
      'gen_ai.client.token.usage',
      'gen_ai.client.tool_calls_per_operation',
      'gen_ai.client.tool_execution.duration',
    ]);
    for (const m of all) {
      for (const { attributes } of m.dataPoints) {
        for (const value of Object.values(attributes)) {
          if (typeof value === 'string') expect(value, m.descriptor.name).toBe(value.trim());
        }
        expect(attributes['gen_ai.agent.name'], m.descriptor.name).toBe('planner');
        expect(attributes['gen_ai.conversation.id'], m.descriptor.name).toBe('conv-1');
        expect(attributes['user.id'], m.descriptor.name).toBe('user-1');
      }
    }
    const tool = findMetric(metrics[0]!, 'gen_ai.client.tool_execution.duration');
    expect(tool!.dataPoints[0]!.attributes['gen_ai.tool.name']).toBe('search');
  });

  it('gives a padded error type the same trimmed value on the span and the metric', async () => {
    h = createHarness();
    const rec = h.client.startToolExecution({ toolName: 'search' });
    rec.setExecError(new Error('boom'));
    rec.setErrorType(' Timeout ');
    await rec.end();

    const span = h.spans.getFinishedSpans()[0]!;
    expect(span.attributes['error.type']).toBe('Timeout');
    const metrics = await h.collectMetrics();
    const tool = findMetric(metrics[0]!, 'gen_ai.client.tool_execution.duration');
    expect(tool!.dataPoints[0]!.attributes['error.type']).toBe('Timeout');
  });

  it('trims the labels of the workflow duration too', async () => {
    h = createHarness({ metricAttributes: { conversationId: true, userId: true } });
    await h.client
      .invokeWorkflow({ workflowName: ' rag ', conversationId: ' conv-1 ', userId: ' user-1 ' })
      .end();

    const metrics = await h.collectMetrics();
    const workflow = findMetric(metrics[0]!, 'gen_ai.invoke_workflow.duration');
    expect(workflow!.dataPoints[0]!.attributes).toMatchObject({
      'gen_ai.workflow.name': 'rag',
      'gen_ai.conversation.id': 'conv-1',
      'user.id': 'user-1',
    });
  });

  it('leaves off an opted-in label that is only spaces', async () => {
    h = createHarness({ metricAttributes: { conversationId: true, userId: true } });
    await h.client
      .startToolExecution({ toolName: 'search', conversationId: ' ', userId: ' ' })
      .end();

    const metrics = await h.collectMetrics();
    const tool = findMetric(metrics[0]!, 'gen_ai.client.tool_execution.duration');
    const attrs = tool!.dataPoints[0]!.attributes;
    expect(attrs).not.toHaveProperty('gen_ai.conversation.id');
    expect(attrs).not.toHaveProperty('user.id');
  });
});
