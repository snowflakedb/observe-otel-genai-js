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
 * Tests for the `allow_list` content mode: every span the client creates must
 * reach the exporter with allowlisted attribute keys only, no content,
 * exceptions reduced to their type, and no status message.
 *
 * Fixtures put the word "secret" in every content field and error message, and
 * nowhere else, so a leak shows up as that word in the exported span.
 */

import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Client } from '../src/client.js';
import type { ClientConfig } from '../src/config.js';
import { AllowListSpan, CONTENT_ALLOW_LIST } from '../src/content/allow-list.js';
import { withAgent, withContentCaptureMode } from '../src/context.js';
import {
  assistantTextMessage,
  textPart,
  toolCallPart,
  toolResultPart,
  userTextMessage,
} from '../src/models/message.js';
import * as semconv from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

const MODEL = { provider: 'openai', name: 'gpt-4o' };

/** Keys known to carry content. None may be allowlisted. */
const CONTENT_KEYS: readonly string[] = [
  'gen_ai.embeddings.input_texts',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.tool.definitions',
];

/**
 * Keys the library emits that are neither kept nor in `CONTENT_KEYS`. They are
 * dropped under `allow_list`. Moving one into the list needs a privacy review.
 */
const NOT_ALLOWLISTED: Record<string, string> = {
  // User-written or retrieved text: content, even though CONTENT_KEYS does not list it.
  'genai.conversation.title': 'conversation title written by the user',
  'gen_ai.request.stop_sequences': 'free text chosen by the caller',
  'gen_ai.retrieval.query.text': 'retrieval query text',
  'gen_ai.retrieval.documents': 'retrieved documents',
  // Metadata, pending privacy review.
  'gen_ai.conversation.compacted': 'pending privacy review',
  'gen_ai.request.reasoning.level': 'pending privacy review',
  'gen_ai.response.time_to_first_chunk': 'pending privacy review',
  'genai.usage.cost_usd': 'pending privacy review',
  'genai.usage.is_partial': 'pending privacy review',
  'gen_ai.embeddings.input_count': 'pending privacy review',
  'gen_ai.embeddings.dimension.count': 'pending privacy review',
  'gen_ai.data_source.id': 'pending privacy review',
  'gen_ai.retrieval.top_k': 'pending privacy review',
  'gen_ai.workflow.name': 'pending privacy review',
};

/**
 * Asserts a span honors the `allow_list` mode: allowlisted attribute keys only
 * (on the span, its events, and its links), exceptions reduced to
 * `exception.type`, no status message, and no "secret" anywhere.
 */
function expectAllowListed(span: ReadableSpan): void {
  const allowed = (key: string) => expect(CONTENT_ALLOW_LIST.has(key), `${span.name}: ${key}`);
  for (const key of Object.keys(span.attributes)) allowed(key).toBe(true);
  for (const event of span.events) {
    const keys = Object.keys(event.attributes ?? {});
    if (event.name === 'exception') expect(keys).toEqual(['exception.type']);
    for (const key of keys) allowed(key).toBe(true);
  }
  for (const link of span.links) {
    for (const key of Object.keys(link.attributes ?? {})) allowed(key).toBe(true);
  }
  expect(span.status.message ?? '').toBe('');
  const exported = JSON.stringify([span.attributes, span.events, span.links, span.status]);
  expect(exported, span.name).not.toMatch(/secret/);
}

describe('allowlist data', () => {
  it('has no key that is both kept and content', () => {
    expect(CONTENT_KEYS.filter((key) => CONTENT_ALLOW_LIST.has(key))).toEqual([]);
  });

  it('classifies every attribute key the library defines', () => {
    const known = new Set([
      ...CONTENT_ALLOW_LIST,
      ...CONTENT_KEYS,
      ...Object.keys(NOT_ALLOWLISTED),
    ]);
    const unclassified = Object.entries(semconv)
      .filter(([name]) => name.startsWith('ATTR_'))
      .map(([, key]) => key as string)
      .filter((key) => !known.has(key));
    expect(unclassified).toEqual([]);
  });

  it('lists no key as not allowlisted when it is already kept', () => {
    expect(Object.keys(NOT_ALLOWLISTED).filter((key) => CONTENT_ALLOW_LIST.has(key))).toEqual([]);
  });
});

function secretMessages() {
  return [
    userTextMessage('secret prompt'),
    {
      role: 'assistant' as const,
      parts: [
        textPart('secret reasoning'),
        toolCallPart({ name: 'search', id: 'call-1', inputJson: '{"q":"secret query"}' }),
      ],
    },
    {
      role: 'tool' as const,
      parts: [toolResultPart({ toolCallId: 'call-1', name: 'search', content: 'secret result' })],
    },
  ];
}

/** Drives one span of every type, each with content and a failure. */
async function driveEverySpanType(client: Client): Promise<void> {
  const first = client.startGeneration({
    model: MODEL,
    conversationId: 'conv-1',
    conversationTitle: 'secret title',
    systemPrompt: 'secret system prompt',
    stopSequences: ['secret stop'],
    tools: [{ name: 'search', inputSchemaJson: '{"secret":"schema"}' }],
    temperature: 0.2,
  });
  first.setResult({
    input: secretMessages(),
    output: [assistantTextMessage('secret answer')],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'stop',
  });
  first.setCallError(new Error('secret provider error'));
  await first.end();

  const streaming = client.startStreamingGeneration({
    model: MODEL,
    parentGenerationIds: [first.last!.id!],
  });
  streaming.setFirstTokenAt(Date.now());
  streaming.setResult({ output: [assistantTextMessage('secret streamed answer')] });
  streaming.setMappingError(new Error('secret mapping error'));
  await streaming.end();

  const embedding = client.startEmbedding({ model: { provider: 'openai', name: 'embed-3' } });
  embedding.setResult({ inputCount: 1, inputTokens: 3, inputTexts: ['secret text'] });
  embedding.setCallError(new Error('secret embedding error'));
  await embedding.end();

  const tool = client.startToolExecution({
    toolName: 'search',
    toolCallId: 'call-1',
    conversationTitle: 'secret title',
  });
  tool.setResult({ arguments: { q: 'secret query' }, result: 'secret result' });
  tool.setExecError(new Error('secret tool error'));
  await tool.end();

  const retrieval = client.startRetrieval({ dataSourceId: 'kb', queryText: 'secret query' });
  retrieval.setDocuments([{ id: 'doc-1', content: 'secret document' }]);
  retrieval.setCallError(new Error('secret retrieval error'));
  await retrieval.end();

  const agent = client.invokeAgent({
    agentName: 'planner',
    input: secretMessages(),
    parentGenerationIds: [first.last!.id!],
  });
  agent.setOutput([assistantTextMessage('secret agent answer')]);
  agent.setError(new Error('secret agent error'));
  await agent.end();

  await expect(
    client.invokeAgent({ agentName: 'callback-agent', input: secretMessages() }, async () => {
      trace.getActiveSpan()?.recordException(new RangeError('secret recorded by user code'));
      throw new TypeError('secret thrown by the agent');
    }),
  ).rejects.toThrow('secret thrown by the agent');

  const creation = client.createAgent({ agentName: 'planner' });
  creation.setError(new Error('secret setup error'));
  await creation.end();

  await expect(
    client.createAgent({ agentName: 'callback-planner' }, async () => {
      throw new Error('secret setup error');
    }),
  ).rejects.toThrow();
}

describe('allow_list content mode', () => {
  let h: Harness;
  afterEach(async () => {
    await h.shutdown();
  });

  function useHarness(config: ClientConfig = {}): Harness {
    h = createHarness({
      ...config,
      embeddingCapture: { captureInput: true, maxInputItems: 20, maxTextLength: 1024 },
    });
    return h;
  }

  function spanNamed(name: string): ReadableSpan {
    const span = h.spans.getFinishedSpans().find((s) => s.name === name);
    if (!span) throw new Error(`no span named ${name}`);
    return span;
  }

  it('exports only allowlisted data on every span type', async () => {
    useHarness({ contentCaptureMode: 'allow_list' });
    await driveEverySpanType(h.client);

    const spans = h.spans.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual([
      'chat gpt-4o',
      'chat gpt-4o',
      'create_agent callback-planner',
      'create_agent planner',
      'embeddings embed-3',
      'execute_tool search',
      'invoke_agent callback-agent',
      'invoke_agent planner',
      'retrieval kb',
    ]);
    for (const span of spans) {
      expectAllowListed(span);
      expect(span.events.some((e) => e.name === 'exception')).toBe(true);
    }
    // The exception recorded by user code arrives, then the one the agent threw.
    expect(spanNamed('invoke_agent callback-agent').events.map((e) => e.attributes)).toEqual([
      { 'exception.type': 'RangeError' },
      { 'exception.type': 'TypeError' },
    ]);
  });

  it('records metrics with allowlisted label keys only', async () => {
    useHarness({ contentCaptureMode: 'allow_list' });
    await driveEverySpanType(h.client);

    const metrics = (await h.collectMetrics())
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics);
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      for (const point of metric.dataPoints) {
        for (const key of Object.keys(point.attributes)) {
          expect(CONTENT_ALLOW_LIST.has(key), `${metric.descriptor.name}: ${key}`).toBe(true);
        }
      }
    }
  });

  it('keeps allowlisted metadata', async () => {
    useHarness({ contentCaptureMode: 'allow_list' });
    await driveEverySpanType(h.client);

    const chat = h.spans.getFinishedSpans().find((s) => s.attributes['genai.generation.id'])!;
    expect(chat.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(chat.attributes['gen_ai.conversation.id']).toBe('conv-1');
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(10);
    expect(chat.attributes['gen_ai.request.temperature']).toBe(0.2);
    expect(chat.attributes['error.type']).toBe('provider_call_error');
    expect(spanNamed('invoke_agent planner').links).toHaveLength(1);
  });

  it('keeps the agent name on embedding spans', async () => {
    useHarness({ contentCaptureMode: 'allow_list' });
    await withAgent('planner', () =>
      h.client.startEmbedding({ model: { provider: 'openai', name: 'embed-3' } }).end(),
    );

    expect(spanNamed('embeddings embed-3').attributes['gen_ai.agent.name']).toBe('planner');
  });

  it('runs the agent callback with the filtered span as the active span', async () => {
    useHarness({ contentCaptureMode: 'allow_list' });
    await h.client.invokeAgent({ agentName: 'planner' }, async () => {
      trace.getActiveSpan()?.setAttribute('gen_ai.future.thing', 'x');
      trace.getActiveSpan()?.setAttribute('gen_ai.tool.name', 'search');
      await h.client.startGeneration({ model: MODEL }).end();
    });

    const agent = spanNamed('invoke_agent planner');
    expect(agent.attributes['gen_ai.future.thing']).toBeUndefined();
    expect(agent.attributes['gen_ai.tool.name']).toBe('search');
    expect(spanNamed('chat gpt-4o').parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
  });

  it('leaves the active span unfiltered under full', async () => {
    useHarness({ contentCaptureMode: 'full' });
    await h.client.invokeAgent({ agentName: 'planner' }, async () => {
      trace.getActiveSpan()?.setAttribute('gen_ai.future.thing', 'x');
    });

    expect(spanNamed('invoke_agent planner').attributes['gen_ai.future.thing']).toBe('x');
  });

  it('applies a per-call allow_list inside an ambient full', async () => {
    useHarness({ contentCaptureMode: 'full' });
    await withContentCaptureMode('full', async () => {
      const rec = h.client.invokeAgent({
        agentName: 'planner',
        input: secretMessages(),
        contentCapture: 'allow_list',
      });
      await rec.end();
    });

    expectAllowListed(spanNamed('invoke_agent planner'));
  });

  describe('the mode in effect when a span starts decides the filter', () => {
    it('stays filtered when it ends outside the scope', async () => {
      useHarness({ contentCaptureMode: 'full' });
      const rec = withContentCaptureMode('allow_list', () =>
        h.client.startGeneration({ model: MODEL, conversationTitle: 'secret title' }),
      );
      rec.setResult({ input: secretMessages(), output: [assistantTextMessage('secret answer')] });
      rec.setCallError(new TypeError('secret provider error'));
      await rec.end();

      const span = spanNamed('chat gpt-4o');
      expectAllowListed(span);
      expect(span.events.map((e) => e.attributes)).toEqual([{ 'exception.type': 'TypeError' }]);
    });
  });
});

describe('AllowListSpan', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  function finished(): ReadableSpan {
    const [span] = h.spans.getFinishedSpans();
    if (!span) throw new Error('no finished span');
    return span;
  }

  it('keeps event names and timestamps passed in place of attributes', () => {
    const span = new AllowListSpan(trace.getTracer('test').startSpan('op'));
    span.addEvent('step', { 'gen_ai.tool.name': 'search', 'gen_ai.tool.call.arguments': 'secret' });
    span.addEvent('timed', new Date(1000));
    span.addEvent('timed-later', undefined, new Date(2000));
    span.end();

    const [step, timed, later] = finished().events;
    expect(step?.attributes).toEqual({ 'gen_ai.tool.name': 'search' });
    expect(timed?.time).toEqual([1, 0]);
    expect(later?.time).toEqual([2, 0]);
  });

  it('records an exception with its type only, picked like the OTel SDK does', () => {
    const span = new AllowListSpan(trace.getTracer('test').startSpan('op'));
    span.recordException(new TypeError('secret prompt in the message'));
    span.recordException(Object.assign(new Error('secret'), { code: 'ECONNRESET' }));
    span.recordException({ code: 503, message: 'secret' });
    span.recordException('secret string error');
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'secret error text' });
    span.end();

    expect(finished().events.map((e) => e.attributes)).toEqual([
      { 'exception.type': 'TypeError' },
      { 'exception.type': 'ECONNRESET' },
      { 'exception.type': '503' },
    ]);
    expect(finished().status).toEqual({ code: SpanStatusCode.ERROR });
  });
});
