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

/** `gen_ai.provider.name` follows the host the OpenAI client points at. */

import * as OpenAIModule from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { providerOfHost } from '../../src/integrations/_common/provider.js';
import { wrapOpenAI } from '../../src/integrations/openai/index.js';
import { OpenAIInstrumentation } from '../../src/integrations/openai/instrumentation.js';
import {
  ATTR_PROVIDER_NAME,
  ATTR_SERVER_ADDRESS,
  METRIC_OPERATION_DURATION,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';
import {
  type FakeOpenAIHandler,
  type FakeOpenAIServer,
  chatCompletion,
  fetchVia,
  responsesMessage,
  startFakeOpenAI,
} from './_openai-server.js';

const OpenAI = ((OpenAIModule as any).OpenAI ?? (OpenAIModule as any).default) as any;

const CORTEX_BASE_URL = 'https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1';
const CORTEX_HOST = 'myorg-myaccount.snowflakecomputing.com';
const MESSAGES = [{ role: 'user', content: 'hi' }];

const respond: FakeOpenAIHandler = (req) => {
  if (req.url.endsWith('/embeddings')) {
    return {
      object: 'list',
      model: 'e5-base-v2',
      data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };
  }
  if (req.url.endsWith('/responses')) return responsesMessage({ model: 'claude-haiku-4-5' });
  if (req.body.stream) {
    return {
      sse: [
        {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'hi' } }],
        },
      ],
    };
  }
  return chatCompletion({ model: 'claude-haiku-4-5' });
};

describe('providerOfHost', () => {
  it.each([
    ['myorg-myaccount.snowflakecomputing.com', 'snowflake'],
    ['myaccount.privatelink.snowflakecomputing.com', 'snowflake'],
    ['my-resource.openai.azure.com', 'azure.ai.openai'],
    ['my-resource.services.ai.azure.com', 'azure.ai.inference'],
    ['models.inference.ai.azure.com', 'azure.ai.inference'],
    ['bedrock-runtime.us-west-2.amazonaws.com', 'aws.bedrock'],
    ['api.groq.com', 'groq'],
    ['api.deepseek.com', 'deepseek'],
    ['api.x.ai', 'x_ai'],
    ['api.mistral.ai', 'mistral_ai'],
    ['generativelanguage.googleapis.com', 'gcp.gemini'],
  ])('maps %s to %s', (host, provider) => {
    expect(providerOfHost(host)).toBe(provider);
  });

  it.each([
    'api.openai.com',
    'localhost',
    'snowflakecomputing.com.example.com',
    'notsnowflakecomputing.com',
    undefined,
  ])('leaves %s unmapped', (host) => {
    expect(providerOfHost(host)).toBeUndefined();
  });
});

describe('OpenAI provider name', () => {
  let h: Harness;
  let server: FakeOpenAIServer;
  let unpatch: (() => void) | undefined;

  beforeEach(async () => {
    h = createHarness();
    server = await startFakeOpenAI(respond);
  });

  afterEach(async () => {
    unpatch?.();
    unpatch = undefined;
    await server.close();
    await h.shutdown();
  });

  /** Patches the live `openai` module and returns a client for `baseURL`. */
  function instrumentedClient(baseURL = CORTEX_BASE_URL) {
    const instr = new OpenAIInstrumentation({ enabled: false, client: h.client });
    const def = instr.getModuleDefinitions()[0];
    def?.patch?.(OpenAIModule);
    unpatch = () => def?.unpatch?.(OpenAIModule);
    return plainClient(baseURL);
  }

  function plainClient(baseURL = CORTEX_BASE_URL) {
    return new OpenAI({ apiKey: 'test', baseURL, maxRetries: 0, fetch: fetchVia(server) });
  }

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

  async function expectProvider(provider: string) {
    expect(onlySpan().attributes[ATTR_PROVIDER_NAME]).toBe(provider);
    expect(await durationProviders()).toEqual([provider]);
  }

  it('reports snowflake for a chat completion against Cortex', async () => {
    await instrumentedClient().chat.completions.create({
      model: 'claude-haiku-4-5',
      messages: MESSAGES,
    });

    await expectProvider('snowflake');
    expect(onlySpan().attributes[ATTR_SERVER_ADDRESS]).toBe(CORTEX_HOST);
  });

  it('reports snowflake for a streamed chat completion', async () => {
    const stream = await instrumentedClient().chat.completions.create({
      model: 'claude-haiku-4-5',
      messages: MESSAGES,
      stream: true,
    });
    for await (const _ of stream) {
      // drain
    }

    await expectProvider('snowflake');
  });

  it('reports snowflake on a failed call', async () => {
    await server.close();
    server = await startFakeOpenAI(() => ({ status: 500, body: { error: { message: 'boom' } } }));

    await expect(
      instrumentedClient().chat.completions.create({
        model: 'claude-haiku-4-5',
        messages: MESSAGES,
      }),
    ).rejects.toThrow();

    await expectProvider('snowflake');
  });

  it('reports snowflake for the Responses API', async () => {
    await instrumentedClient().responses.create({ model: 'claude-haiku-4-5', input: 'hi' });

    await expectProvider('snowflake');
  });

  it('reports snowflake for embeddings', async () => {
    await instrumentedClient().embeddings.create({ model: 'e5-base-v2', input: 'hi' });

    await expectProvider('snowflake');
  });

  it('reports snowflake through wrapOpenAI', async () => {
    await wrapOpenAI(h.client, plainClient()).chat.completions.create({
      model: 'claude-haiku-4-5',
      messages: MESSAGES,
    });

    await expectProvider('snowflake');
  });

  it('keeps openai for the default base URL', async () => {
    await instrumentedClient('https://api.openai.com/v1').chat.completions.create({
      model: 'gpt-4o-mini',
      messages: MESSAGES,
    });

    await expectProvider('openai');
  });
});
