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

import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientConfig } from '../src/config.js';
import { withConversationId, withUserId } from '../src/context.js';
import { assistantTextMessage, userTextMessage } from '../src/models/message.js';
import {
  ATTR_AGENT_NAME,
  ATTR_CONVERSATION_ID,
  ATTR_ERROR_CATEGORY,
  ATTR_ERROR_TYPE,
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_USER_ID,
  ATTR_WORKFLOW_NAME,
  METRIC_INVOKE_WORKFLOW_DURATION,
  OP_INVOKE_WORKFLOW,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('WorkflowInvocationRecorder', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.shutdown();
    h = undefined;
  });

  function harness(config?: ClientConfig): Harness {
    h = createHarness(config);
    return h;
  }

  it('emits an invoke_workflow span with no agent name, even when the client has one', async () => {
    const { client, spans } = harness({ agentName: 'client-agent', contentCaptureMode: 'full' });
    const rec = client.invokeWorkflow({
      workflowName: 'rag',
      conversationId: 'conv-1',
      userId: 'user-1',
      input: [userTextMessage('question')],
    });
    rec.setOutput([assistantTextMessage('answer')]);
    await rec.end();

    const [span] = spans.getFinishedSpans();
    expect(span?.name).toBe('invoke_workflow rag');
    expect(span?.kind).toBe(0 /* INTERNAL */);
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_WORKFLOW);
    expect(span?.attributes[ATTR_WORKFLOW_NAME]).toBe('rag');
    expect(span?.attributes[ATTR_CONVERSATION_ID]).toBe('conv-1');
    expect(span?.attributes[ATTR_USER_ID]).toBe('user-1');
    expect(span?.attributes).not.toHaveProperty(ATTR_AGENT_NAME);
    expect(JSON.parse(span!.attributes[ATTR_INPUT_MESSAGES] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'question' }] },
    ]);
    expect(JSON.parse(span!.attributes[ATTR_OUTPUT_MESSAGES] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'answer' }], finish_reason: 'stop' },
    ]);
  });

  it('is named plain invoke_workflow without a workflow name', async () => {
    const { client, spans } = harness();
    await client.invokeWorkflow({}).end();
    const [span] = spans.getFinishedSpans();
    expect(span?.name).toBe('invoke_workflow');
    expect(span?.attributes).not.toHaveProperty(ATTR_WORKFLOW_NAME);
  });

  it('records its duration in gen_ai.invoke_workflow.duration, with the workflow name', async () => {
    const { client, collectMetrics } = harness({ agentName: 'client-agent' });
    await client.invokeWorkflow({ workflowName: 'rag' }).end();

    const metrics = (await collectMetrics())[0]!.scopeMetrics.flatMap((sm) => sm.metrics);
    expect(metrics.map((m) => m.descriptor.name)).toEqual([METRIC_INVOKE_WORKFLOW_DURATION]);
    expect(metrics[0]!.dataPoints.map((p) => p.attributes)).toEqual([
      { [ATTR_WORKFLOW_NAME]: 'rag', [ATTR_ERROR_TYPE]: '', [ATTR_ERROR_CATEGORY]: '' },
    ]);
    const point = metrics[0]!.dataPoints[0]!.value as { buckets: { boundaries: number[] } };
    expect(point.buckets.boundaries).toEqual([1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200]);
  });

  it('callback variant nests its steps, which take its conversation id but no agent name', async () => {
    const { client, spans } = harness();
    await client.invokeWorkflow({ workflowName: 'rag', conversationId: 'conv-1' }, () =>
      client.startToolExecution({ toolName: 'search' }).end(),
    );

    const finished = spans.getFinishedSpans();
    const workflow = finished.find(
      (s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_WORKFLOW,
    )!;
    const tool = finished.find((s) => s.name === 'execute_tool search')!;
    expect(tool.parentSpanContext?.spanId).toBe(workflow.spanContext().spanId);
    expect(tool.attributes[ATTR_CONVERSATION_ID]).toBe('conv-1');
    expect(tool.attributes).not.toHaveProperty(ATTR_AGENT_NAME);
  });

  it('hands down its user id, and a scope inside it still wins', async () => {
    const { client, spans } = harness();
    await client.invokeWorkflow({ userId: 'user-1' }, async () => {
      await client.startToolExecution({ toolName: 'plain' }).end();
      await withUserId('user-2', () => client.startToolExecution({ toolName: 'scoped' }).end());
    });

    const userOf = (name: string) =>
      spans.getFinishedSpans().find((s) => s.name === name)!.attributes[ATTR_USER_ID];
    expect(userOf('execute_tool plain')).toBe('user-1');
    expect(userOf('execute_tool scoped')).toBe('user-2');
  });

  it('takes its conversation id from the enclosing scope', async () => {
    const { client, spans } = harness();
    await withConversationId('conv-scope', () => client.invokeWorkflow({}).end());
    expect(spans.getFinishedSpans()[0]?.attributes[ATTR_CONVERSATION_ID]).toBe('conv-scope');
  });

  it("keeps the enclosing agent's name for spans inside it, with its own conversation id", async () => {
    const { client, spans } = harness();
    await client.invokeAgent({ agentName: 'planner', conversationId: 'conv-agent' }, () =>
      client.invokeWorkflow({ workflowName: 'steps', conversationId: 'conv-workflow' }, () =>
        client.startToolExecution({ toolName: 'search' }).end(),
      ),
    );

    const finished = spans.getFinishedSpans();
    const workflow = finished.find((s) => s.name === 'invoke_workflow steps')!;
    expect(workflow.attributes).not.toHaveProperty(ATTR_AGENT_NAME);
    const tool = finished.find((s) => s.name === 'execute_tool search')!;
    expect(tool.attributes[ATTR_AGENT_NAME]).toBe('planner');
    expect(tool.attributes[ATTR_CONVERSATION_ID]).toBe('conv-workflow');
  });

  it('callback variant records the error by its class name and rethrows it', async () => {
    class BoomError extends Error {}
    const { client, spans } = harness();
    const boom = new BoomError('boom');
    await expect(
      client.invokeWorkflow({ workflowName: 'rag' }, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const [span] = spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes[ATTR_ERROR_TYPE]).toBe('BoomError');
  });

  it('leaves out input and output under metadata_only', async () => {
    const { client, spans } = harness({ contentCaptureMode: 'metadata_only' });
    const rec = client.invokeWorkflow({ input: [userTextMessage('secret')] });
    rec.setOutput([assistantTextMessage('secret answer')]);
    await rec.end();

    const [span] = spans.getFinishedSpans();
    expect(span?.attributes).not.toHaveProperty(ATTR_INPUT_MESSAGES);
    expect(span?.attributes).not.toHaveProperty(ATTR_OUTPUT_MESSAGES);
  });
});
