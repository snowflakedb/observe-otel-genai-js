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

import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../../src/client.js';
import { genaiTelemetryIntegration } from '../../src/integrations/vercel-ai-sdk/index.js';
import { VercelAiSdkInstrumentation } from '../../src/integrations/vercel-ai-sdk/instrumentation.js';
import { type Harness, createHarness } from '../_harness.js';
import { InMemorySpanExporter, createTracerProvider, simpleSpanProcessor } from '../_otel-sdk.js';

/** The AI SDK's global list of telemetry integrations. */
const aiSdkGlobal = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] };
const integrations = () => aiSdkGlobal.AI_SDK_TELEMETRY_INTEGRATIONS ?? [];

const model = () =>
  new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-gen',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'hello' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });

const spanNames = (h: Harness) =>
  h.spans
    .getFinishedSpans()
    .map((s) => s.name)
    .sort();

describe('VercelAiSdkInstrumentation', () => {
  let h: Harness;
  let instr: VercelAiSdkInstrumentation | undefined;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await instr?.shutdown();
    instr = undefined;
    aiSdkGlobal.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
    await h.shutdown();
  });

  // Also guards the AI SDK's global list name, which the instrumentation writes to.
  it('traces AI SDK calls with no registerTelemetry call', async () => {
    instr = new VercelAiSdkInstrumentation({ client: h.client });
    await generateText({ model: model(), prompt: 'hi' });
    expect(spanNames(h)).toEqual(['chat mock-gen', 'invoke_agent ai-sdk']);
  });

  it('passes its options on to the integration', async () => {
    instr = new VercelAiSdkInstrumentation({
      client: h.client,
      emitOperationSpan: false,
      deriveOptions: () => ({ agentName: 'support' }),
    });
    await generateText({ model: model(), prompt: 'hi' });
    const [chat] = h.spans.getFinishedSpans();
    expect(spanNames(h)).toEqual(['chat mock-gen']);
    expect(chat?.attributes['gen_ai.agent.name']).toBe('support');
  });

  it('registers once however often it is enabled', () => {
    instr = new VercelAiSdkInstrumentation({ client: h.client });
    instr.enable();
    expect(integrations()).toHaveLength(1);
  });

  it('takes only its own integration off the list when disabled', async () => {
    const other = genaiTelemetryIntegration(h.client);
    aiSdkGlobal.AI_SDK_TELEMETRY_INTEGRATIONS = [other];
    instr = new VercelAiSdkInstrumentation({ client: h.client });
    instr.disable();

    expect(integrations()).toEqual([other]);
    h.resetSpans();
    await generateText({ model: model(), prompt: 'hi' });
    // Only the other integration is left, so each span is recorded once.
    expect(spanNames(h)).toEqual(['chat mock-gen', 'invoke_agent ai-sdk']);
  });

  it('builds its own client on the first call, from the providers it is given afterwards', async () => {
    // Not the global provider, so only a client built after setTracerProvider records here.
    const spans = new InMemorySpanExporter();
    const provider = createTracerProvider({ spanProcessors: [simpleSpanProcessor(spans)] });
    // As registerInstrumentations does: construct (which enables), then hand over providers.
    instr = new VercelAiSdkInstrumentation();
    instr.setTracerProvider(provider);
    await generateText({ model: model(), prompt: 'hi' });

    const finished = spans.getFinishedSpans();
    expect(finished.map((s) => s.name).sort()).toEqual(['chat mock-gen', 'invoke_agent ai-sdk']);
    expect(new Set(finished.map((s) => s.instrumentationScope.name))).toEqual(
      new Set(['@snowflake/observe-otel-genai/vercel-ai-sdk/instrumentation']),
    );
    expect(h.spans.getFinishedSpans()).toEqual([]);
    await provider.shutdown();
  });

  it('traces again after being disabled and enabled', async () => {
    instr = new VercelAiSdkInstrumentation({ client: h.client });
    instr.disable();
    instr.enable();
    expect(integrations()).toHaveLength(1);
    await generateText({ model: model(), prompt: 'hi' });
    expect(spanNames(h)).toEqual(['chat mock-gen', 'invoke_agent ai-sdk']);
  });

  it('shuts down a client it built, but not one it was given', async () => {
    const shutdown = vi.spyOn(Client.prototype, 'shutdown');
    try {
      const built = new VercelAiSdkInstrumentation();
      await generateText({ model: model(), prompt: 'hi' });
      await built.shutdown();
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(integrations()).toEqual([]);

      shutdown.mockClear();
      instr = new VercelAiSdkInstrumentation({ client: h.client });
      await instr.shutdown();
      instr = undefined;
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      shutdown.mockRestore();
    }
  });
});
