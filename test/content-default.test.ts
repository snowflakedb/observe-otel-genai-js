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
 * Locks the default content-capture mode. A `Client` built without a
 * `contentCaptureMode` must emit no content on any span it creates: no
 * prompts, replies, system instructions, tool payloads or definitions,
 * retrieval or embedding text, and no exception events or raw error text.
 *
 * Fixtures put the word "secret" in each content field and error message they
 * set, and nowhere else, so a leak shows up as that word in the exported span.
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Client } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { resolveContentCaptureMode } from '../src/content/capture.js';
import { assistantTextMessage, toolCallPart, userTextMessage } from '../src/models/message.js';
import {
  ATTR_EMBEDDING_INPUT_TEXTS,
  ATTR_INPUT_MESSAGES,
  ATTR_OUTPUT_MESSAGES,
  ATTR_RETRIEVAL_DOCUMENTS,
  ATTR_RETRIEVAL_QUERY_TEXT,
  ATTR_SYSTEM_INSTRUCTIONS,
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_RESULT,
  ATTR_TOOL_DEFINITIONS,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

const MODEL = { provider: 'openai', name: 'gpt-4o' };

const CONTENT_KEYS = [
  ATTR_INPUT_MESSAGES,
  ATTR_OUTPUT_MESSAGES,
  ATTR_SYSTEM_INSTRUCTIONS,
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_RESULT,
  ATTR_TOOL_DEFINITIONS,
  ATTR_RETRIEVAL_QUERY_TEXT,
  ATTR_RETRIEVAL_DOCUMENTS,
  ATTR_EMBEDDING_INPUT_TEXTS,
];

function expectNoContent(span: ReadableSpan): void {
  for (const key of CONTENT_KEYS) expect(span.attributes[key], key).toBeUndefined();
  expect(span.events.map((e) => e.name)).not.toContain('exception');
  const exported = JSON.stringify([span.attributes, span.events, span.status]);
  expect(exported, span.name).not.toMatch(/secret/);
}

const secretInput = () => [
  userTextMessage('secret prompt'),
  {
    role: 'assistant' as const,
    parts: [toolCallPart({ name: 'search', id: 'call-1', inputJson: '{"q":"secret query"}' })],
  },
];

const spanTypes: Array<[string, (client: Client) => Promise<void>]> = [
  [
    'generation',
    async (client) => {
      const rec = client.startGeneration({
        model: MODEL,
        conversationTitle: 'secret title',
        systemPrompt: 'secret system prompt',
        tools: [{ name: 'search', description: 'secret tool description' }],
      });
      rec.setResult({ input: secretInput(), output: [assistantTextMessage('secret answer')] });
      rec.setCallError(new Error('secret provider error'));
      await rec.end();
    },
  ],
  [
    'streaming generation',
    async (client) => {
      const rec = client.startStreamingGeneration({ model: MODEL });
      rec.setFirstTokenAt(Date.now());
      rec.setResult({ input: secretInput(), output: [assistantTextMessage('secret answer')] });
      rec.setMappingError(new Error('secret mapping error'));
      await rec.end();
    },
  ],
  [
    'agent',
    async (client) => {
      const rec = client.invokeAgent({ agentName: 'planner', input: secretInput() });
      rec.setOutput([assistantTextMessage('secret answer')]);
      rec.setError(new Error('secret agent error'));
      await rec.end();
    },
  ],
  [
    'agent (callback)',
    async (client) => {
      await expect(
        client.invokeAgent({ agentName: 'planner', input: secretInput() }, async () => {
          throw new Error('secret agent error');
        }),
      ).rejects.toThrow();
    },
  ],
  [
    'agent creation',
    async (client) => {
      const rec = client.createAgent({ agentName: 'planner' });
      rec.setError(new Error('secret setup error'));
      await rec.end();
    },
  ],
  [
    'agent creation (callback)',
    async (client) => {
      await expect(
        client.createAgent({ agentName: 'planner' }, async () => {
          throw new Error('secret setup error');
        }),
      ).rejects.toThrow();
    },
  ],
  [
    'tool',
    async (client) => {
      const rec = client.startToolExecution({
        toolName: 'search',
        toolCallId: 'call-1',
        conversationTitle: 'secret title',
      });
      rec.setResult({ arguments: { q: 'secret query' }, result: 'secret result' });
      rec.setExecError(new Error('secret tool error'));
      await rec.end();
    },
  ],
  [
    'embedding',
    async (client) => {
      const rec = client.startEmbedding({ model: { provider: 'openai', name: 'embed-3' } });
      rec.setResult({ inputCount: 1, inputTexts: ['secret text'] });
      rec.setCallError(new Error('secret embedding error'));
      await rec.end();
    },
  ],
  [
    'retrieval',
    async (client) => {
      const rec = client.startRetrieval({ dataSourceId: 'kb', queryText: 'secret query' });
      rec.setDocuments([{ id: 'doc-1', content: 'secret document' }]);
      rec.setCallError(new Error('secret retrieval error'));
      await rec.end();
    },
  ],
];

describe('default content-capture mode', () => {
  it('is metadata_only, both unset and as the `default` fallthrough', () => {
    expect(resolveConfig().contentCaptureMode).toBe('metadata_only');
    expect(resolveContentCaptureMode(undefined, undefined, 'default')).toBe('metadata_only');
  });
});

describe('a Client with no content-capture configuration', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it.each(spanTypes)('emits no content on %s spans', async (_, record) => {
    await record(h.client);
    expectNoContent(h.spans.getFinishedSpans()[0]!);
  });

  it('keeps embedding input texts off even with embedding input capture turned on', async () => {
    await h.shutdown();
    h = createHarness({
      embeddingCapture: { captureInput: true, maxInputItems: 20, maxTextLength: 1024 },
    });
    const rec = h.client.startEmbedding({ model: { provider: 'openai', name: 'embed-3' } });
    rec.setResult({ inputCount: 1, inputTexts: ['secret text'] });
    await rec.end();
    expectNoContent(h.spans.getFinishedSpans()[0]!);
  });
});
