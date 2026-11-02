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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAgent, withUserId } from '../src/context.js';
import {
  ATTR_AGENT_DESCRIPTION,
  ATTR_AGENT_ID,
  ATTR_AGENT_NAME,
  ATTR_AGENT_VERSION,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_USER_ID,
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

describe('AgentCreationRecorder — user id', () => {
  let h: Harness;
  afterEach(async () => {
    await h.shutdown();
  });

  it('takes the user id from the seed, then the withUserId scope, then the client', async () => {
    h = createHarness({ userId: 'client-user' });
    await withUserId('scoped-user', () =>
      h.client.createAgent({ agentName: 'own', userId: 'own-user' }).end(),
    );
    await withUserId('scoped-user', () => h.client.createAgent({ agentName: 'scoped' }).end());
    await h.client.createAgent({ agentName: 'default' }).end();

    const byAgent = Object.fromEntries(
      h.spans
        .getFinishedSpans()
        .map((s) => [s.attributes[ATTR_AGENT_NAME], s.attributes[ATTR_USER_ID]]),
    );
    expect(byAgent).toEqual({ own: 'own-user', scoped: 'scoped-user', default: 'client-user' });
  });

  it('hands its user id, and not its agent name, to the spans inside it', async () => {
    h = createHarness();
    await withAgent('outer', () =>
      h.client.createAgent({ agentName: 'setup', userId: 'u-1' }, async () => {
        await h.client.startToolExecution({ toolName: 'register' }).end();
      }),
    );

    const tool = h.spans.getFinishedSpans().find((s) => s.name.startsWith('execute_tool'));
    expect(tool?.attributes[ATTR_USER_ID]).toBe('u-1');
    expect(tool?.attributes[ATTR_AGENT_NAME]).toBe('outer');
  });

  it("keeps the enclosing agent's identity on the spans inside it", async () => {
    h = createHarness();
    await h.client.invokeAgent(
      { agentName: 'outer', agentVersion: '7', conversationId: 'conv-1' },
      () =>
        h.client.createAgent({ agentName: 'setup', userId: 'u-1' }, async () => {
          await h.client.startToolExecution({ toolName: 'register' }).end();
        }),
    );

    const tool = h.spans.getFinishedSpans().find((s) => s.name.startsWith('execute_tool'));
    expect(tool?.attributes[ATTR_AGENT_NAME]).toBe('outer');
    expect(tool?.attributes[ATTR_AGENT_VERSION]).toBe('7');
    expect(tool?.attributes['gen_ai.conversation.id']).toBe('conv-1');
    expect(tool?.attributes[ATTR_USER_ID]).toBe('u-1');
  });

  it('hands its user id down through withActiveContext on the fluent variant', async () => {
    h = createHarness();
    const rec = h.client.createAgent({ agentName: 'setup', userId: 'u-1' });
    await rec.withActiveContext(() => h.client.startToolExecution({ toolName: 'register' }).end());
    await rec.end();

    const tool = h.spans.getFinishedSpans().find((s) => s.name.startsWith('execute_tool'));
    expect(tool?.attributes[ATTR_USER_ID]).toBe('u-1');
  });

  it('labels the duration metric with the user id when that option is on', async () => {
    h = createHarness({ metricAttributes: { userId: true } });
    await h.client.createAgent({ agentName: 'a', userId: 'u-1' }).end();

    const point = flattenMetrics(await h.collectMetrics())
      .find((m) => m.descriptor.name === 'gen_ai.client.operation.duration')
      ?.dataPoints.find((p) => p.attributes[ATTR_OPERATION_NAME] === OP_CREATE_AGENT);
    expect(point?.attributes[ATTR_USER_ID]).toBe('u-1');
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
