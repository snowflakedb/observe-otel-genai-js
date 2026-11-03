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

/** A ChatOpenAI pointed at another provider reports that provider. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GenAIOtelCallbackHandler } from '../../src/integrations/langchain/index.js';
import { ATTR_PROVIDER_NAME, METRIC_OPERATION_DURATION } from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

const CORTEX_BASE_URL = 'https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1';

/** The `Serialized` a LangChain chat model hands its callbacks, as `@langchain/openai` 1.x builds it. */
function serialized(namespace: string, className: string, baseURL?: string) {
  return {
    lc: 1,
    type: 'constructor',
    id: ['langchain', 'chat_models', namespace, className],
    kwargs: {
      model: 'claude-haiku-4-5',
      ...(baseURL ? { configuration: { baseURL } } : {}),
    },
  };
}

const human = { _getType: () => 'human', content: 'hi' };
const result = {
  generations: [[{ text: 'hi', message: { _getType: () => 'ai', content: 'hi' } } as any]],
};

describe('LangChain provider from base URL', () => {
  let h: Harness;
  let handler: GenAIOtelCallbackHandler;

  beforeEach(() => {
    h = createHarness();
    handler = new GenAIOtelCallbackHandler({ client: h.client });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  function onlySpan() {
    const spans = h.spans.getFinishedSpans();
    expect(spans).toHaveLength(1);
    return spans[0]!;
  }

  async function durationProviders(): Promise<unknown[]> {
    return (await h.collectMetrics())
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .filter((m) => m.descriptor.name === METRIC_OPERATION_DURATION)
      .flatMap((m) => m.dataPoints.map((p) => p.attributes[ATTR_PROVIDER_NAME]));
  }

  async function chat(llm: object) {
    await handler.handleChatModelStart!(llm as any, [[human] as any], 'run');
    await handler.handleLLMEnd!(result, 'run');
  }

  it('reports snowflake for a ChatOpenAI pointed at Cortex', async () => {
    await chat(serialized('openai', 'ChatOpenAI', CORTEX_BASE_URL));

    expect(onlySpan().attributes[ATTR_PROVIDER_NAME]).toBe('snowflake');
    expect(await durationProviders()).toEqual(['snowflake']);
  });

  it('reports snowflake on a failed call', async () => {
    await handler.handleChatModelStart!(
      serialized('openai', 'ChatOpenAI', CORTEX_BASE_URL) as any,
      [[human] as any],
      'run',
    );
    await handler.handleLLMError!(new Error('boom'), 'run');

    expect(onlySpan().attributes[ATTR_PROVIDER_NAME]).toBe('snowflake');
    expect(await durationProviders()).toEqual(['snowflake']);
  });

  it.each([
    ['without a base URL', undefined],
    ['for an unknown host', 'http://localhost:8080/v1'],
  ])('keeps openai %s', async (_, baseURL) => {
    await chat(serialized('openai', 'ChatOpenAI', baseURL));

    expect(onlySpan().attributes[ATTR_PROVIDER_NAME]).toBe('openai');
  });

  it('keeps a provider the class name already names', async () => {
    await chat(serialized('deepseek', 'ChatDeepSeek', CORTEX_BASE_URL));

    expect(onlySpan().attributes[ATTR_PROVIDER_NAME]).toBe('deepseek');
  });
});
