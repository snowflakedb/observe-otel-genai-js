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
 * Tests for `OpenAIInstrumentation`.
 *
 * These drive a **real** `openai` client against a local HTTP server, which the
 * adapter tests cannot do. Two things depend on it:
 *
 *  - The instrumentation patches `Completions.prototype.create`, so the test has
 *    to go through a real resource instance to prove the patch is on the right
 *    prototype at all.
 *  - `create()` returns the SDK's `APIPromise`. Preserving it keeps
 *    `.withResponse()` and the SDK's own `.stream()` helper working, and only a
 *    real client returns one.
 *
 * vitest never fires the require/import hook, so the module patch is applied by
 * hand through `getModuleDefinitions()` and the function that ships to production
 * is what runs. `openai-agents-cjs-autopatch.test.ts` covers the hook itself.
 */

import { DiagLogLevel, diag } from '@opentelemetry/api';
import * as OpenAIModule from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isInstrumented } from '../../src/integrations/_common/instrumented.js';
import { withMetadata, wrapOpenAI } from '../../src/integrations/openai/index.js';
import { OpenAIInstrumentation } from '../../src/integrations/openai/instrumentation.js';
import {
  ATTR_AGENT_NAME,
  ATTR_OPERATION_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_SYSTEM_INSTRUCTIONS,
  ATTR_TOOL_DEFINITIONS,
  ATTR_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  ATTR_USAGE_REASONING_TOKENS,
  OP_CHAT,
  OP_EMBEDDINGS,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';
import {
  type FakeOpenAIServer,
  chatCompletion,
  responsesMessage,
  startFakeOpenAI,
} from './_openai-server.js';

const OpenAI = ((OpenAIModule as any).OpenAI ?? (OpenAIModule as any).default) as any;

/**
 * Applies the instrumentation's real module patch to the live `openai` module,
 * through `getModuleDefinitions()` so the shipped patch is what gets tested.
 */
function patchOpenAI(instr: OpenAIInstrumentation): () => void {
  const def = instr.getModuleDefinitions()[0];
  if (!def?.patch) throw new Error('openai module patch not found in instrumentation');
  def.patch(OpenAIModule);
  return () => def.unpatch?.(OpenAIModule);
}

type CreateHolder = { create: (...args: unknown[]) => unknown };

/**
 * Puts a shimmer-style wrapper carrying none of our markers on `proto.create`, as
 * another library's instrumentation would. `isWrapped` requires all three
 * markers, which is what shimmer sets; a wrapper missing any reads as unwrapped.
 */
function installForeignWrapper(proto: CreateHolder) {
  const original = proto.create;
  const foreign = function foreignWrapper(this: unknown, ...args: unknown[]) {
    return original.apply(this, args);
  };
  Object.defineProperty(foreign, '__original', { value: original });
  Object.defineProperty(foreign, '__unwrap', {
    value: () => {
      proto.create = original;
    },
  });
  Object.defineProperty(foreign, '__wrapped', { value: true });
  proto.create = foreign;
  return {
    foreign,
    restore: () => {
      proto.create = original;
    },
  };
}

/** A stand-in `openai` module exposing the three resources the instrumentation patches. */
function fakeOpenAIModule() {
  const resource = () =>
    class {
      create() {
        return undefined;
      }
    };
  return {
    OpenAI: { Chat: { Completions: resource() }, Responses: resource(), Embeddings: resource() },
  };
}

function chatSpans(h: Harness) {
  return h.spans.getFinishedSpans().filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_CHAT);
}

/** The chat span, asserting there is only one. */
function onlyChatSpan(h: Harness) {
  const spans = chatSpans(h);
  expect(spans).toHaveLength(1);
  const span = spans[0];
  if (!span) throw new Error('no chat span emitted');
  return span;
}

describe('OpenAIInstrumentation', () => {
  let h: Harness;
  let server: FakeOpenAIServer;
  let unpatch: (() => void) | undefined;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(async () => {
    unpatch?.();
    unpatch = undefined;
    await server?.close();
    await h.shutdown();
  });

  async function setup(
    handler: Parameters<typeof startFakeOpenAI>[0],
    config: ConstructorParameters<typeof OpenAIInstrumentation>[0] = {},
  ) {
    server = await startFakeOpenAI(handler);
    // `enabled: false` skips require-hook registration; we patch by hand below.
    const instr = new OpenAIInstrumentation({ enabled: false, client: h.client, ...config });
    unpatch = patchOpenAI(instr);
    return new OpenAI({ apiKey: 'test', baseURL: server.baseURL });
  }

  it('emits a chat span for an unwrapped client', async () => {
    const client = await setup(() => chatCompletion({ id: 'chatcmpl-1' }));

    const result = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.choices[0].message.content).toBe('hello from chat');
    const span = onlyChatSpan(h);
    expect(span.name).toBe('chat gpt-4o-mini');
    expect(span.attributes[ATTR_RESPONSE_ID]).toBe('chatcmpl-1');
    expect(span.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(7);
    expect(span.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(3);
    expect(span.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(2);
    expect(span.attributes[ATTR_USAGE_REASONING_TOKENS]).toBe(1);
  });

  it('emits a chat span for the Responses API, mapping instructions to system_instructions', async () => {
    const client = await setup(() => responsesMessage({ id: 'resp-1', text: 'terse answer' }), {
      contentCapture: 'no_tool_content',
    });

    const result = await client.responses.create({
      model: 'gpt-4o-mini',
      input: 'hi',
      instructions: 'Be terse.',
    });

    expect(result.status).toBe('completed');
    const span = onlyChatSpan(h);
    expect(span.attributes[ATTR_RESPONSE_ID]).toBe('resp-1');
    // Responses carries the system prompt out-of-band, so it maps to
    // `gen_ai.system_instructions`; Chat Completions puts it in an input message.
    expect(String(span.attributes[ATTR_SYSTEM_INSTRUCTIONS])).toContain('Be terse.');
    expect(span.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
    expect(span.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(4);
    expect(span.attributes[ATTR_USAGE_REASONING_TOKENS]).toBe(2);
  });

  it('maps Responses tool definitions from the top level, not from a nested function object', async () => {
    // Responses puts `name` / `description` / `parameters` on the tool itself;
    // Chat Completions nests them under `function`. Reading the wrong level
    // yields a nameless definition that gets dropped, so this asserts the name
    // survives, and under `full` capture the schema too.
    const client = await setup(() => responsesMessage(), { contentCapture: 'full' });

    await client.responses.create({
      model: 'gpt-4o-mini',
      input: 'hi',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Look up weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });

    const definitions = String(onlyChatSpan(h).attributes[ATTR_TOOL_DEFINITIONS]);
    expect(definitions).toContain('get_weather');
    expect(definitions).toContain('Look up weather');
    expect(definitions).toContain('city');
  });

  it('omits tool descriptions and schemas under no_tool_content capture', async () => {
    const client = await setup(() => responsesMessage(), { contentCapture: 'no_tool_content' });

    await client.responses.create({
      model: 'gpt-4o-mini',
      input: 'hi',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Look up weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });

    const definitions = String(onlyChatSpan(h).attributes[ATTR_TOOL_DEFINITIONS]);
    expect(definitions).toContain('get_weather');
    expect(definitions).not.toContain('Look up weather');
    expect(definitions).not.toContain('city');
  });

  it('emits an embeddings span', async () => {
    const client = await setup(() => ({
      object: 'list',
      model: 'text-embedding-3-small',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }));

    await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'hi',
      encoding_format: 'float',
    });

    const spans = h.spans
      .getFinishedSpans()
      .filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_EMBEDDINGS);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes[ATTR_REQUEST_MODEL]).toBe('text-embedding-3-small');
  });

  it('preserves the APIPromise so withResponse() still works', async () => {
    const client = await setup(() => chatCompletion({ id: 'chatcmpl-wr' }));

    const { data, response } = await client.chat.completions
      .create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .withResponse();

    expect(response.status).toBe(200);
    expect(data.id).toBe('chatcmpl-wr');
    expect(chatSpans(h)).toHaveLength(1);
  });

  it('records a request failure on the span and still rejects', async () => {
    const client = await setup(() => ({
      status: 500,
      body: { error: { message: 'upstream boom' } },
    }));

    await expect(
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow();

    // 2 === SpanStatusCode.ERROR
    expect(onlyChatSpan(h).status.code).toBe(2);
  });

  it('applies config metadata as a default and lets withMetadata override it', async () => {
    const client = await setup(() => chatCompletion(), { agentName: 'config-default' });

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await client.chat.completions.create(
      withMetadata(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        { agentName: 'per-call' },
      ),
    );

    const names = chatSpans(h).map((s) => s.attributes[ATTR_AGENT_NAME]);
    expect(names).toEqual(['config-default', 'per-call']);
  });

  it('does not leak the metadata symbol into the request body', async () => {
    const client = await setup(() => chatCompletion());

    await client.chat.completions.create(
      withMetadata(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        { agentName: 'a' },
      ),
    );

    expect(Object.keys(server.requests[0]?.body ?? {}).sort()).toEqual(['messages', 'model']);
  });

  it('emits exactly one span when wrapOpenAI and the instrumentation are both installed', async () => {
    // The proxy resolves `create` through the prototype, so once the
    // instrumentation has patched it, the proxy would instrument an
    // already-instrumented call and double-report every request.
    const client = await setup(() => chatCompletion());
    const wrapped = wrapOpenAI(h.client, client);

    await wrapped.chat.completions.create(
      withMetadata(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        { agentName: 'planner' },
      ),
    );

    // The proxy must leave the metadata on params for the patched method to read.
    expect(onlyChatSpan(h).attributes[ATTR_AGENT_NAME]).toBe('planner');
  });

  it('still emits through wrapOpenAI after the instrumentation is unpatched', async () => {
    // The mirror of the case above. With no patch in place the proxy has to do
    // the work itself, or disabling the instrumentation would turn off telemetry
    // for wrapped clients too.
    const client = await setup(() => chatCompletion());
    unpatch?.();
    unpatch = undefined;
    const wrapped = wrapOpenAI(h.client, client);

    await wrapped.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(chatSpans(h)).toHaveLength(1);
  });

  it('leaves calls untraced but working after unpatch', async () => {
    const client = await setup(() => chatCompletion());
    unpatch?.();
    unpatch = undefined;

    const result = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.choices[0].message.content).toBe('hello from chat');
    expect(chatSpans(h)).toHaveLength(0);
  });

  it('defers loudly when another library already instrumented the prototype', async () => {
    // `@opentelemetry/instrumentation-openai` patches these same prototypes, and
    // `@opentelemetry/auto-instrumentations-node` enables it by default. Deferring
    // is right, since two spans per call would double every token and duration
    // metric, but it drops everything only this library records, so it warns.
    // Simulated with a plain shimmer-style wrapper carrying none of our markers.
    const client = await setup(() => chatCompletion());
    unpatch?.();
    unpatch = undefined;

    const proto = Object.getPrototypeOf(client.chat.completions) as CreateHolder;
    const { foreign, restore } = installForeignWrapper(proto);

    const warnings: string[] = [];
    const previousLogger = {
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => {},
      debug: () => {},
      info: () => {},
      verbose: () => {},
    };
    try {
      diag.setLogger(previousLogger, DiagLogLevel.ALL);
      const instr = new OpenAIInstrumentation({ enabled: false, client: h.client });
      instr.getModuleDefinitions()[0]?.patch?.(OpenAIModule);

      expect(
        warnings.some((w) => w.includes('already instrumented by another library')),
        'expected a warning naming the conflict',
      ).toBe(true);
      // And it names a way out. The env var takes a package-name suffix, so the
      // full package name there disables nothing. This asserts the working form,
      // verified against @opentelemetry/auto-instrumentations-node.
      expect(
        warnings.some((w) => w.includes('OTEL_NODE_DISABLED_INSTRUMENTATIONS=openai')),
        'expected the suffix form of the env var',
      ).toBe(true);
      expect(
        warnings.some((w) => w.includes('OTEL_NODE_DISABLED_INSTRUMENTATIONS=@opentelemetry/')),
        'the full package name is not a working value for that env var',
      ).toBe(false);
      // The foreign wrapper stays in place; we do not fight over the prototype.
      expect(proto.create).toBe(foreign);
    } finally {
      diag.disable();
      restore();
    }
  });

  it('leaves a wrapper it deferred to in place when disabled', async () => {
    const client = await setup(() => chatCompletion());
    unpatch?.();
    unpatch = undefined;
    const proto = Object.getPrototypeOf(client.chat.completions) as CreateHolder;
    const { foreign, restore } = installForeignWrapper(proto);

    try {
      const instr = new OpenAIInstrumentation({ enabled: false, client: h.client });
      instr.manuallyInstrument(OpenAIModule);
      instr.disable();

      expect(proto.create).toBe(foreign);
    } finally {
      restore();
    }
  });

  it("does not remove another instance's patch when disabled", async () => {
    const client = await setup(() => chatCompletion());
    const second = new OpenAIInstrumentation({ enabled: false, client: h.client });
    second.manuallyInstrument(OpenAIModule);
    second.disable();

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(chatSpans(h)).toHaveLength(1);
  });

  it('unpatches every copy of openai it patched, not only the last one loaded', () => {
    // Two copies of the module can be loaded side by side, e.g. the app's and the
    // one @openai/agents-core depends on. OTel's hook remembers only the last.
    const copies = [fakeOpenAIModule(), fakeOpenAIModule()];
    const instr = new OpenAIInstrumentation({ enabled: false, client: h.client });
    const def = instr.getModuleDefinitions()[0];
    for (const copy of copies) def?.patch?.(copy);
    expect(
      copies.every((copy) => isInstrumented(copy.OpenAI.Chat.Completions.prototype.create)),
    ).toBe(true);

    instr.disable();

    expect(
      copies.some((copy) => isInstrumented(copy.OpenAI.Chat.Completions.prototype.create)),
    ).toBe(false);
  });

  it('unpatches on shutdown, so later calls go straight to the SDK', async () => {
    server = await startFakeOpenAI(() => chatCompletion());
    // No `client` in config, so the instrumentation builds and owns one.
    const instr = new OpenAIInstrumentation({ enabled: false });
    instr.manuallyInstrument(OpenAIModule);
    unpatch = () => instr.disable();
    const client = new OpenAI({ apiKey: 'test', baseURL: server.baseURL });
    const proto = Object.getPrototypeOf(client.chat.completions) as CreateHolder;
    // The owned client is built on the first call; shutdown then closes it.
    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(chatSpans(h)).toHaveLength(1);

    await instr.shutdown();

    expect(isInstrumented(proto.create)).toBe(false);
    const result = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.choices[0].message.content).toBe('hello from chat');
  });

  it.each([
    [
      'chat.completions',
      'startGeneration',
      { choices: [{ message: { content: 'hello from chat' } }] },
    ],
    ['responses', 'startGeneration', { id: 'resp-test' }],
    ['embeddings', 'startEmbedding', { model: 'text-embedding-3-small' }],
  ] as const)(
    'returns the SDK result untraced when recording %s fails after the call',
    async (resource, recorder, expected) => {
      const client = await setup((req) =>
        req.url.includes('/embeddings')
          ? {
              object: 'list',
              model: 'text-embedding-3-small',
              data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }
          : req.url.includes('/responses')
            ? responsesMessage()
            : chatCompletion(),
      );
      // What a shut-down `Client` does: refuse to start a recorder.
      vi.spyOn(h.client, recorder).mockImplementation(() => {
        throw new Error('client has been shut down');
      });

      const result =
        resource === 'chat.completions'
          ? await client.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [{ role: 'user', content: 'hi' }],
            })
          : resource === 'responses'
            ? await client.responses.create({ model: 'gpt-4o-mini', input: 'hi' })
            : await client.embeddings.create({
                model: 'text-embedding-3-small',
                input: 'hi',
                encoding_format: 'float',
              });

      expect(result).toMatchObject(expected);
      expect(h.spans.getFinishedSpans()).toHaveLength(0);
    },
  );

  it('is idempotent: patching twice does not double-instrument', async () => {
    const client = await setup(() => chatCompletion());
    const instr = new OpenAIInstrumentation({ enabled: false, client: h.client });
    const second = patchOpenAI(instr);

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    second();
    expect(chatSpans(h)).toHaveLength(1);
  });
});
