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
import {
  ATTR_AGENT_NAME,
  ATTR_EMBEDDING_DIMENSION_COUNT,
  ATTR_EMBEDDING_INPUT_COUNT,
  ATTR_EMBEDDING_INPUT_TEXTS,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_USAGE_INPUT_TOKENS,
  OP_EMBEDDINGS,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('EmbeddingRecorder', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({
      embeddingCapture: { captureInput: true, maxInputItems: 3, maxTextLength: 10 },
    });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits embedding span with operation=embeddings and dimension count', async () => {
    const rec = h.client.startEmbedding({
      model: { provider: 'openai', name: 'text-embedding-3-large' },
      agentName: 'rag',
      dimensions: 3072,
      encodingFormat: 'float',
    });
    rec.setResult({ inputCount: 5, inputTokens: 12, dimensions: 3072 });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('embeddings text-embedding-3-large');
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_EMBEDDINGS);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('openai');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('text-embedding-3-large');
    expect(span?.attributes[ATTR_AGENT_NAME]).toBe('rag');
    expect(span?.attributes[ATTR_EMBEDDING_INPUT_COUNT]).toBe(5);
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(12);
    expect(span?.attributes[ATTR_EMBEDDING_DIMENSION_COUNT]).toBe(3072);
  });

  it('captures and truncates inputTexts when captureInput=true', async () => {
    const rec = h.client.startEmbedding({
      model: { provider: 'openai', name: 'text-embedding-3-large' },
      contentCapture: 'full',
    });
    rec.setResult({
      inputCount: 4,
      inputTexts: [
        'a-very-long-text-that-will-be-truncated',
        'short',
        'another-medium-length-text',
        // 4th item dropped because maxInputItems=3
        'should-be-dropped',
      ],
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const texts = span?.attributes[ATTR_EMBEDDING_INPUT_TEXTS] as string[];
    expect(texts.length).toBe(3);
    expect(texts[0]!.length).toBeLessThanOrEqual(10);
    expect(texts[0]!.endsWith('...')).toBe(true);
    expect(texts[1]).toBe('short'); // already short enough
  });
});
