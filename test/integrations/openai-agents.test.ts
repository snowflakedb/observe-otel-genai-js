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
 * End-to-end tests for `OpenAIAgentsInstrumentation`.
 *
 * These drive a **real** `Agent` / `Runner` / `tool` against a local HTTP server
 * standing in for the OpenAI API. No synthetic span payloads: the SDK builds its
 * own trace, calls its own model classes, and hands us the same callbacks it would
 * in production.
 *
 * Three assertions depend on that:
 *
 *  - **Cross-instrumentation nesting.** The chat span comes from
 *    `OpenAIInstrumentation`, a *separate* instrumentation, and must land as a
 *    child of `invoke_agent`. Nothing keeps an OTel context alive across the
 *    Agents SDK's start/end callbacks, so this works only because the agents
 *    instrumentation activates context around the model call. A synthetic-span
 *    test cannot catch a regression here.
 *  - **No duplicate chat spans.** Both instrumentations see every model call on
 *    the OpenAI path, and one span per call is the contract.
 *  - **No leaked spans after a failure.** The SDK skips `trace.end()` when a run
 *    rejects, so every failure path is checked for spans left open.
 *
 * The SDK disables tracing whenever `NODE_ENV === 'test'`, so `beforeEach` turns it
 * back on with the SDK's own switch. Without that these tests would assert on an
 * empty exporter and pass for the wrong reason. The switch is process-wide state
 * with no reset API, so `beforeEach` re-establishes it for every test; that is what
 * keeps the one test that wants it *off* from leaking into the rest of the file.
 */

import * as Agents from '@openai/agents';
import * as AiSdkExt from '@openai/agents-extensions/ai-sdk';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import * as OpenAIModule from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  withAgent,
  withContentCaptureMode,
  withConversationId,
  withUserId,
} from '../../src/context.js';
import { OpenAIAgentsInstrumentation } from '../../src/integrations/openai-agents/instrumentation.js';
import { OpenAIInstrumentation } from '../../src/integrations/openai/instrumentation.js';
import {
  ATTR_AGENT_NAME,
  ATTR_AGENT_VERSION,
  ATTR_CONVERSATION_ID,
  ATTR_ERROR_TYPE,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_RESULT,
  ATTR_TOOL_NAME,
  ATTR_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_REASONING_TOKENS,
  ATTR_WORKFLOW_NAME,
  METRIC_TIME_TO_FIRST_TOKEN,
  OP_CHAT,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
  OP_INVOKE_WORKFLOW,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';
import {
  type FakeOpenAIHandler,
  type FakeOpenAIServer,
  chatCompletion,
  responsesMessage,
  responsesStreamEvents,
  responsesToolCall,
  startFakeOpenAI,
} from './_openai-server.js';

const A = Agents as any;
const OpenAI = ((OpenAIModule as any).OpenAI ?? (OpenAIModule as any).default) as any;

/**
 * Applies an instrumentation's real module patches by hand.
 *
 * vitest never fires OpenTelemetry's require/import hook, so these definitions run
 * against the live module namespaces instead. `getModuleDefinitions()` means the
 * shipped `patch` functions are what run; only the hook that would have called them
 * is missing, and `openai-agents-cjs-autopatch.test.ts` covers that.
 */
function applyPatches(
  instr: OpenAIAgentsInstrumentation | OpenAIInstrumentation,
  modules: Record<string, object>,
): () => void {
  const applied: Array<() => void> = [];
  for (const def of instr.getModuleDefinitions()) {
    const target = modules[def.name];
    if (!target) continue;
    def.patch?.(target);
    applied.push(() => def.unpatch?.(target));
  }
  return () => {
    for (const undo of applied.reverse()) undo();
  };
}

interface Setup {
  server: FakeOpenAIServer;
  agents: OpenAIAgentsInstrumentation;
  openai: OpenAIInstrumentation;
  /** The model to hand each `Agent`; see {@link responsesModel}. */
  model?: any;
  unpatch(): void;
}

/**
 * Builds an `OpenAIResponsesModel` bound to this test's server.
 *
 * Constructing the model here sidesteps `OpenAIProvider`'s cache and still
 * exercises the prototype the instrumentation patches. The provider memoizes model
 * wrappers by name, and a cached wrapper holds on to whichever client built it, so
 * `setDefaultOpenAIClient` plus a model *name* would leave run #2 reusing run #1's
 * client and hitting a port that has since closed.
 */
function responsesModel(server: FakeOpenAIServer): any {
  return new A.OpenAIResponsesModel(
    new OpenAI({ apiKey: 'test', baseURL: server.baseURL }),
    'gpt-4o-mini',
  );
}

describe('OpenAIAgentsInstrumentation — real Agent/Runner', () => {
  let h: Harness;
  let active: Setup | undefined;

  beforeEach(() => {
    h = createHarness();
    // Process-wide SDK state with no reset API. Re-establishing it here keeps the
    // one test that turns tracing off from affecting the ones after it.
    A.setTracingDisabled(false);
  });

  afterEach(async () => {
    if (active) {
      await active.agents.shutdown();
      active.unpatch();
      await active.server.close();
      active = undefined;
    }
    await h.shutdown();
  });

  /**
   * Wires both instrumentations against one exporter and points the SDK's default
   * OpenAI client at the fake server. Both are needed together: by design, the
   * agents instrumentation emits no chat span on the OpenAI model path.
   */
  async function setup(
    handler: FakeOpenAIHandler,
    options: { contentCapture?: 'full' | 'default' } = {},
  ): Promise<Setup> {
    const server = await startFakeOpenAI(handler);
    const agents = new OpenAIAgentsInstrumentation({
      enabled: false,
      client: h.client,
      contentCapture: options.contentCapture,
    });
    const openai = new OpenAIInstrumentation({ enabled: false, client: h.client });
    const unpatchAgents = applyPatches(agents, {
      '@openai/agents-core': Agents,
      '@openai/agents': Agents,
      '@openai/agents-openai': Agents,
      '@openai/agents-extensions': AiSdkExt,
    });
    const unpatchOpenAI = applyPatches(openai, { openai: OpenAIModule });
    active = {
      server,
      agents,
      openai,
      model: responsesModel(server),
      unpatch: () => {
        unpatchOpenAI();
        unpatchAgents();
      },
    };
    return active;
  }

  /** Patches only the agents instrumentation, for runs on the AI SDK model path. */
  async function setupAiSdk(core: object = Agents): Promise<void> {
    const server = await startFakeOpenAI(() => ({}));
    const agents = new OpenAIAgentsInstrumentation({ enabled: false, client: h.client });
    const unpatch = applyPatches(agents, {
      '@openai/agents-core': core,
      '@openai/agents': Agents,
      '@openai/agents-extensions': AiSdkExt,
    });
    active = { server, agents, openai: new OpenAIInstrumentation(), unpatch };
  }

  const spansNamed = (op: string) =>
    h.spans.getFinishedSpans().filter((s) => s.attributes[ATTR_OPERATION_NAME] === op);
  const agentSpans = () => spansNamed(OP_INVOKE_AGENT);

  /** The finished span that is `span`'s parent, if it is one of ours. */
  const parentOf = (span: { parentSpanContext?: { spanId: string } } | undefined) => {
    const id = span?.parentSpanContext?.spanId;
    if (!id) return undefined;
    return h.spans.getFinishedSpans().find((s) => s.spanContext().spanId === id);
  };

  /** Asserts the list holds one span and returns it. */
  const only = <T>(spans: T[], what: string): T => {
    expect(spans, `expected exactly one ${what}`).toHaveLength(1);
    const span = spans[0];
    if (!span) throw new Error(`no ${what} emitted`);
    return span;
  };

  /**
   * Waits for a span carrying `op` to reach the exporter.
   *
   * Only streamed runs need this. `Runner.run()` does not resolve until the trace
   * has ended, but `stream.completed` resolves while the SDK is still dispatching
   * its span- and trace-end callbacks, so chat, agent and workflow spans can be open
   * for a few ticks after the last event. No span is lost either way, since
   * `shutdown()` ends whatever is still in flight, but a parentage assertion has to
   * wait for the parent to arrive.
   */
  const waitForSpan = async (op: string, attempts = 50): Promise<void> => {
    for (let i = 0; i < attempts; i += 1) {
      if (spansNamed(op).length > 0) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('nests the openai chat span under invoke_agent and emits exactly one per call', async () => {
    // The load-bearing test. Two model calls, two chat spans, each parented on the
    // agent span. That holds only because the model patch activates the agent's
    // OTel context around `getResponse`; without it they detach to the trace root.
    const setupResult = await setup((_req, i) =>
      i === 0
        ? responsesToolCall({ name: 'get_weather', args: { city: 'Tokyo' } })
        : responsesMessage({ text: 'It is sunny in Tokyo.' }),
    );

    const agent = new A.Agent({
      name: 'weather-agent',
      instructions: 'Be helpful.',
      model: setupResult.model,
      tools: [weatherTool()],
    });
    const result = await new A.Runner().run(agent, 'What is the weather in Tokyo?');

    expect(result.finalOutput).toBe('It is sunny in Tokyo.');

    const chat = spansNamed(OP_CHAT);
    // One per model call: the openai instrumentation emits, the agents
    // instrumentation declines, and neither doubles up.
    expect(chat).toHaveLength(2);
    const agentSpan = only(agentSpans(), 'invoke_agent span');
    for (const span of chat) {
      expect(parentOf(span)?.spanContext().spanId).toBe(agentSpan.spanContext().spanId);
    }
  });

  it('carries the conversation id and agent name onto the chat span', async () => {
    // Neither is visible below the agents layer: `Trace.groupId` exists only here,
    // and the openai instrumentation sees one isolated HTTP call with no idea which
    // agent asked for it. The model wrapper installs both as ambient defaults, so a
    // conversation stays filterable down to the model call and every model call is
    // attributable to an agent.
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));

    const agent = new A.Agent({
      name: 'attributed-agent',
      instructions: 'x',
      model: setupResult.model,
    });
    await new A.Runner({ groupId: 'thread-99', workflowName: 'wf' }).run(agent, 'hi');

    const chat = only(spansNamed(OP_CHAT), 'chat span');
    expect(chat.attributes[ATTR_CONVERSATION_ID]).toBe('thread-99');
    expect(chat.attributes[ATTR_AGENT_NAME]).toBe('attributed-agent');
    // And the agent span agrees, so the two join.
    const agentSpan = only(agentSpans(), 'invoke_agent span');
    expect(agentSpan.attributes[ATTR_CONVERSATION_ID]).toBe('thread-99');
  });

  it("prefers the run's conversationId over groupId, on every span of the run", async () => {
    // The SDK sends `conversationId` as the Responses `conversation`, which the chat
    // span records as its own. The agent spans must use the same id, or one run would
    // show up as two conversations.
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));
    const agent = new A.Agent({ name: 'conv-agent', instructions: 'x', model: setupResult.model });
    await new A.Runner({ groupId: 'thread-1' }).run(agent, 'hi', { conversationId: 'conv_1' });

    const ids = h.spans.getFinishedSpans().map((s) => [s.name, s.attributes[ATTR_CONVERSATION_ID]]);
    expect(ids.length).toBeGreaterThan(2);
    for (const [name, id] of ids) expect(id, String(name)).toBe('conv_1');
  });

  it("keeps an outer agent's version off the chat spans of a run", async () => {
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));
    const agent = new A.Agent({ name: 'inner-agent', instructions: 'x', model: setupResult.model });
    await withAgent('outer-agent', '3', () => new A.Runner().run(agent, 'hi'));

    const chat = only(spansNamed(OP_CHAT), 'chat span');
    expect(chat.attributes[ATTR_AGENT_NAME]).toBe('inner-agent');
    expect(chat.attributes[ATTR_AGENT_VERSION]).toBeUndefined();
  });

  it('names an openai API error by its class on the workflow span', async () => {
    // The openai package's error classes keep `name` as 'Error'.
    const setupResult = await setup(() => ({
      status: 401,
      body: { error: { message: 'bad key' } },
    }));
    const agent = new A.Agent({
      name: 'denied-agent',
      instructions: 'x',
      model: setupResult.model,
    });
    await expect(new A.Runner().run(agent, 'hi')).rejects.toThrow();

    await vi.waitFor(() => expect(spansNamed(OP_INVOKE_WORKFLOW)).toHaveLength(1));
    expect(only(spansNamed(OP_INVOKE_WORKFLOW), 'workflow span').attributes[ATTR_ERROR_TYPE]).toBe(
      'AuthenticationError',
    );
    // The agent span sees only the error's text, so it keeps its own category.
    expect(only(agentSpans(), 'agent span').attributes[ATTR_ERROR_TYPE]).toBe(
      'provider_call_error',
    );
  });

  it('names an openai API error by its class on the workflow span of a streamed run', async () => {
    // A streamed run does not reject, and the SDK's error record names no class; the
    // streamed result keeps the error object.
    const setupResult = await setup(() => ({
      status: 401,
      body: { error: { message: 'bad key' } },
    }));
    const agent = new A.Agent({
      name: 'denied-streamer',
      instructions: 'x',
      model: setupResult.model,
    });
    const stream = await new A.Runner().run(agent, 'hi', { stream: true });
    await expect(
      (async () => {
        for await (const _event of stream.toStream()) {
          // drain
        }
        await stream.completed;
      })(),
    ).rejects.toThrow();

    await vi.waitFor(() => expect(spansNamed(OP_INVOKE_WORKFLOW)).toHaveLength(1));
    expect(only(spansNamed(OP_INVOKE_WORKFLOW), 'workflow span').attributes[ATTR_ERROR_TYPE]).toBe(
      'AuthenticationError',
    );
  });

  it('records trace metadata on the workflow span', async () => {
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));
    const agent = new A.Agent({ name: 'meta-agent', instructions: 'x', model: setupResult.model });
    await new A.Runner({ traceMetadata: { tenant: 'acme' } }).run(agent, 'hi');

    const root = only(
      h.spans.getFinishedSpans().filter((s) => !s.parentSpanContext),
      'root span',
    );
    expect(root.attributes['genai.metadata.tenant']).toBe('acme');
  });

  it('parents the tool span under invoke_agent and names it from the tool', async () => {
    const setupResult = await setup((_req, i) =>
      i === 0
        ? responsesToolCall({ name: 'get_weather', args: { city: 'Tokyo' } })
        : responsesMessage({ text: 'done' }),
    );

    const agent = new A.Agent({
      name: 'weather-agent',
      instructions: 'x',
      model: setupResult.model,
      tools: [weatherTool()],
    });
    await new A.Runner().run(agent, 'weather?');

    const tool = only(spansNamed(OP_EXECUTE_TOOL), 'execute_tool span');
    expect(tool.name).toBe('execute_tool get_weather');
    expect(tool.attributes[ATTR_TOOL_NAME]).toBe('get_weather');
    expect(parentOf(tool)?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
  });

  it('captures tool arguments and results only under full content capture', async () => {
    // Under `full` capture the tool payloads reach the span. The default,
    // `metadata_only`, keeps them off a plain install.
    const setupResult = await setup(
      (_req, i) =>
        i % 2 === 0
          ? responsesToolCall({ name: 'get_weather', args: { city: 'Tokyo' } })
          : responsesMessage({ text: 'done' }),
      { contentCapture: 'full' },
    );

    const agent = new A.Agent({
      name: 'weather-agent',
      instructions: 'x',
      model: setupResult.model,
      tools: [weatherTool()],
    });
    await new A.Runner().run(agent, 'weather?');

    const tool = only(spansNamed(OP_EXECUTE_TOOL), 'execute_tool span');
    expect(tool.attributes[ATTR_TOOL_CALL_ARGUMENTS]).toBe('{"city":"Tokyo"}');
    expect(String(tool.attributes[ATTR_TOOL_CALL_RESULT])).toContain('sunny in Tokyo');
  });

  it('reports the run as invoke_workflow, named after its first agent when it has no name', async () => {
    // The SDK names an unnamed workflow "Agent workflow", a constant the semantic
    // conventions say not to record; they name it after the entry agent instead.
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));

    const agent = new A.Agent({ name: 'solo-agent', instructions: 'x', model: setupResult.model });
    await new A.Runner().run(agent, 'hi');

    const root = only(
      h.spans.getFinishedSpans().filter((s) => !s.parentSpanContext),
      'root span',
    );
    expect(root.name).toBe('invoke_workflow solo-agent');
    expect(root.kind).toBe(SpanKind.INTERNAL);
    expect(root.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_WORKFLOW);
    expect(root.attributes[ATTR_WORKFLOW_NAME]).toBe('solo-agent');
    expect(root.attributes[ATTR_AGENT_NAME]).toBeUndefined();
  });

  it('names the workflow span after RunConfig.workflowName', async () => {
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));

    const agent = new A.Agent({ name: 'solo-agent', instructions: 'x', model: setupResult.model });
    await new A.Runner({ workflowName: 'triage' }).run(agent, 'hi');

    const root = only(spansNamed(OP_INVOKE_WORKFLOW), 'invoke_workflow span');
    expect(root.name).toBe('invoke_workflow triage');
    expect(root.attributes[ATTR_WORKFLOW_NAME]).toBe('triage');
  });

  it('keeps both agents of a handoff under the one workflow span', async () => {
    const setupResult = await setup((req, i) => {
      if (i === 0) {
        // The SDK derives the handoff tool's name from the agent name, so pick it
        // out of the request instead of hardcoding it.
        const tools = (req.body.tools ?? []) as Array<{ name?: string }>;
        const handoff = tools.find((t) => t.name?.startsWith('transfer_to'));
        return responsesToolCall({ name: handoff?.name ?? 'transfer', args: {} });
      }
      return responsesMessage({ text: '¡Hola!' });
    });

    const spanish = new A.Agent({
      name: 'spanish-agent',
      instructions: 'Reply in Spanish.',
      model: setupResult.model,
    });
    const triage = new A.Agent({
      name: 'triage-agent',
      instructions: 'Route.',
      model: setupResult.model,
      handoffs: [spanish],
    });
    const result = await new A.Runner().run(triage, 'Hola');

    expect(result.finalOutput).toBe('¡Hola!');
    const root = only(
      h.spans.getFinishedSpans().filter((s) => !s.parentSpanContext),
      'root span',
    );
    expect(root.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_WORKFLOW);
    const agents = agentSpans();
    expect(agents).toHaveLength(2);
    for (const span of agents) {
      expect(parentOf(span)?.spanContext().spanId).toBe(root.spanContext().spanId);
    }
  });

  it('emits no span for the handoff itself', async () => {
    // The conventions define no handoff operation and no handoff attributes: "the
    // next `invoke_agent` span represents the handoff". So a handoff shows up only
    // as a second agent under the same workflow, in timestamp order.
    const setupResult = await setup((req, i) => {
      if (i === 0) {
        const tools = (req.body.tools ?? []) as Array<{ name?: string }>;
        const handoff = tools.find((t) => t.name?.startsWith('transfer_to'));
        return responsesToolCall({ name: handoff?.name ?? 'transfer', args: {} });
      }
      return responsesMessage({ text: 'hola' });
    });

    const spanish = new A.Agent({
      name: 'spanish-agent',
      instructions: 'x',
      model: setupResult.model,
    });
    const triage = new A.Agent({
      name: 'triage-agent',
      instructions: 'x',
      model: setupResult.model,
      handoffs: [spanish],
    });
    await new A.Runner().run(triage, 'hola');

    expect(agentSpans().map((s) => s.attributes[ATTR_AGENT_NAME])).toEqual([
      'triage-agent',
      'spanish-agent',
    ]);
    // No span, and no attributes describing the edge.
    expect(h.spans.getFinishedSpans().some((s) => s.name.includes('handoff'))).toBe(false);
    for (const span of h.spans.getFinishedSpans()) {
      const keys = Object.keys(span.attributes);
      expect(keys.filter((k) => k.startsWith('graph.'))).toEqual([]);
    }
  });

  it('emits the chat span itself on the AI SDK model path', async () => {
    // No fake HTTP here: `aisdk()` bypasses the openai client, so nothing else
    // could emit this span. It is also the only path where cached and reasoning
    // token counts reach us.
    await setupAiSdk();

    const agent = new A.Agent({
      name: 'aisdk-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel()),
    });
    const result = await new A.Runner().run(agent, 'hi');

    expect(result.finalOutput).toBe('from the ai sdk');
    const chat = only(spansNamed(OP_CHAT), 'chat span');
    // The AI SDK provider id `anthropic.messages` maps to the well-known name.
    expect(chat.attributes[ATTR_PROVIDER_NAME]).toBe('anthropic');
    expect(chat.attributes[ATTR_REQUEST_MODEL]).toBe('claude-sonnet-4-5');
    expect(chat.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(31);
    expect(chat.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(12);
    expect(chat.attributes[ATTR_USAGE_REASONING_TOKENS]).toBe(5);
    expect(parentOf(chat)?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
  });

  it('marks a streamed run with gen_ai.request.stream without the model patch', async () => {
    const server = await startFakeOpenAI(() => ({}));
    const agents = new OpenAIAgentsInstrumentation({
      enabled: false,
      client: h.client,
    });
    const unpatch = applyPatches(agents, {
      '@openai/agents-core': Agents,
      '@openai/agents': Agents,
      // '@openai/agents-extensions' is left out on purpose.
    });
    active = { server, agents, openai: new OpenAIInstrumentation(), unpatch };

    const agent = new A.Agent({
      name: 'unpatched-model-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ firstTokenDelayMs: 10 })),
    });
    const stream = await new A.Runner().run(agent, 'hi', { stream: true });
    for await (const _event of stream.toStream()) {
      // drain
    }
    await stream.completed;
    await waitForSpan(OP_CHAT);

    const chat = only(spansNamed(OP_CHAT), 'chat span');
    expect(chat.attributes['gen_ai.request.stream']).toBe(true);
  });

  it('nests a streamed chat span under invoke_agent and attributes it', async () => {
    // The streaming counterpart of the load-bearing nesting test, and it has to go
    // through real SSE over HTTP to mean anything. `OpenAIResponsesModel`'s streamed
    // method is an `async *` generator, so its body, including the HTTP request,
    // waits for the consumer's first `next()`, by which point the caller's
    // `context.with` has long returned. An async generator body does not inherit the
    // AsyncLocalStorage store from where it was created, so the OTel context and the
    // ambient agents identity have to be re-entered around every `next()`, not only
    // around the iterator's construction. Get that wrong and the chat span detaches
    // into its own root with no conversation id and no agent name, while every
    // non-streamed assertion still passes.
    const setupResult = await setup(() => ({
      sse: responsesStreamEvents({ text: 'streamed hi', model: 'gpt-4o-mini' }),
    }));

    const agent = new A.Agent({
      name: 'streaming-openai-agent',
      instructions: 'x',
      model: setupResult.model,
    });
    const stream = await new A.Runner({ groupId: 'thread-stream-1' }).run(agent, 'hi', {
      stream: true,
    });
    for await (const _event of stream.toStream()) {
      // drain
    }
    await stream.completed;
    await waitForSpan(OP_INVOKE_AGENT);

    const chat = only(spansNamed(OP_CHAT), 'chat span');
    expect(parentOf(chat)?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
    expect(chat.attributes[ATTR_CONVERSATION_ID]).toBe('thread-stream-1');
    expect(chat.attributes[ATTR_AGENT_NAME]).toBe('streaming-openai-agent');
    expect(chat.attributes['gen_ai.request.stream']).toBe(true);
    expect(h.openSpanCount()).toBe(0);
  });

  it('does not mark a non-streamed run as streaming', async () => {
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));
    const agent = new A.Agent({ name: 'sync-agent', instructions: 'x', model: setupResult.model });
    await new A.Runner().run(agent, 'hi');

    const chat = only(spansNamed(OP_CHAT), 'chat span');
    expect(chat.attributes['gen_ai.request.stream']).toBeUndefined();
  });

  it('measures time-to-first-token from the first content delta, not the first event', async () => {
    // A stream opens with bookkeeping events in the same millisecond as the
    // request. The stub waits 60ms before its first text delta and 60ms more
    // before finishing, so TTFT must land between the two.
    await setupAiSdk();

    const agent = new A.Agent({
      name: 'streaming-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ firstTokenDelayMs: 60, finishDelayMs: 60 })),
    });
    const stream = await new A.Runner().run(agent, 'hi', { stream: true });
    for await (const _event of stream.toStream()) {
      // drain
    }
    await stream.completed;
    // The metric is recorded when the chat span ends.
    await waitForSpan(OP_CHAT);
    const [chatSeconds, chatNanos] = only(spansNamed(OP_CHAT), 'chat span').duration;

    const metrics = await h.collectMetrics();
    const ttft = metrics
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === METRIC_TIME_TO_FIRST_TOKEN);
    expect(ttft).toBeDefined();
    // `dataPoints` is a union over aggregation shapes; TTFT is a histogram.
    const points = (ttft?.dataPoints ?? []) as Array<{ value: { sum: number; count: number } }>;
    const point = only(points, 'TTFT data point');
    const value = point.value;
    expect(value.count).toBe(1);
    expect(value.sum).toBeGreaterThanOrEqual(0.05);
    expect(value.sum).toBeLessThan(chatSeconds + chatNanos / 1e9 - 0.03);
  });

  it('closes every span with an error when a run rejects', async () => {
    // The SDK does not call `trace.end()` on rejection, because `withTrace`'s
    // lifecycle wrapper ends the trace only on its success path. Without the
    // failure boundary the workflow span would leak.
    await setupAiSdk();

    const agent = new A.Agent({
      name: 'doomed-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ throws: true })),
    });

    await expect(new A.Runner().run(agent, 'hi')).rejects.toThrow('model exploded');
    // The rejection is reported without holding up the error, so spans close a
    // few ticks later.
    await vi.waitFor(() => expect(h.spans.getFinishedSpans()).toHaveLength(3));

    const finished = h.spans.getFinishedSpans();
    // Workflow, agent, and chat: all three ended.
    expect(finished).toHaveLength(3);
    expect(h.openSpanCount()).toBe(0);
    for (const span of finished) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    }
    expect(finished.map((s) => s.attributes[ATTR_ERROR_TYPE])).toEqual([
      'BoomError',
      'BoomError',
      'BoomError',
    ]);
  });

  it('closes a withTrace block that throws, with the error on it', async () => {
    // The SDK skips `trace.end()` when the `withTrace` callback throws. vitest loads
    // the SDK as ES modules, whose exports are read-only, so this patches a
    // CommonJS-style copy of them.
    const core = { ...Agents };
    await setupAiSdk(core);
    const agent = new A.Agent({
      name: 'doomed-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ throws: true })),
    });

    await expect(
      core.withTrace('outer-workflow', async () => {
        await new A.Runner().run(agent, 'hi');
      }),
    ).rejects.toThrow('model exploded');

    await vi.waitFor(() => expect(h.openSpanCount()).toBe(0));
    const workflow = h.spans
      .getFinishedSpans()
      .find((s) => s.name === 'invoke_workflow outer-workflow');
    expect(workflow?.status.code).toBe(SpanStatusCode.ERROR);
    expect(workflow?.attributes[ATTR_ERROR_TYPE]).toBe('BoomError');
  });

  it('does not fail the outer run when an agent used as a tool fails and the run recovers', async () => {
    const setupResult = await setup((_req, i) =>
      i === 0
        ? responsesToolCall({ name: 'ask_helper', args: { input: 'help' } })
        : responsesMessage({ text: 'done anyway' }),
    );
    const helper = new A.Agent({
      name: 'helper-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ throws: true })),
    });
    const outer = new A.Agent({
      name: 'outer-agent',
      instructions: 'x',
      model: setupResult.model,
      tools: [helper.asTool({ toolName: 'ask_helper', toolDescription: 'Ask the helper.' })],
    });

    const result = await new A.Runner().run(outer, 'go');

    expect(result.finalOutput).toBe('done anyway');
    const root = only(
      h.spans.getFinishedSpans().filter((s) => !s.parentSpanContext),
      'root span',
    );
    expect(root.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(root.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_WORKFLOW);
  });

  it('does not fail a withTrace block that recovers from a failed run', async () => {
    const core = { ...Agents };
    await setupAiSdk(core);
    const failing = new A.Agent({
      name: 'failing-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ throws: true })),
    });
    const fallback = new A.Agent({
      name: 'fallback-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel()),
    });

    await core.withTrace('recovering-block', async () => {
      await new A.Runner().run(failing, 'hi').catch(() => {});
      await new A.Runner().run(fallback, 'hi');
    });

    const block = h.spans.getFinishedSpans().find((s) => s.name.includes('recovering-block'));
    expect(block?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('marks a tool that throws as failed', async () => {
    const setupResult = await setup((_req, i) =>
      i === 0 ? responsesToolCall({ name: 'broken', args: {} }) : responsesMessage({ text: 'ok' }),
    );
    const broken = A.tool({
      name: 'broken',
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true,
      execute: async () => {
        throw new Error('tool exploded');
      },
    });
    const agent = new A.Agent({
      name: 'tool-agent',
      instructions: 'x',
      model: setupResult.model,
      tools: [broken],
    });
    await new A.Runner().run(agent, 'go');

    const tool = only(spansNamed(OP_EXECUTE_TOOL), 'execute_tool span');
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    // 0.19 redacts tool error details by default, leaving no class name to read,
    // so error.type falls back to the recorder's own category.
    expect(['Error', 'tool_execution_error']).toContain(tool.attributes[ATTR_ERROR_TYPE]);
  });

  it('nests chat spans and records agent messages on the Chat Completions path', async () => {
    const server = await setup(() => chatCompletion({ content: 'hello from chat' }), {
      contentCapture: 'full',
    });
    const model = new A.OpenAIChatCompletionsModel(
      new OpenAI({ apiKey: 'test', baseURL: server.server.baseURL }),
      'gpt-4o-mini',
    );
    const agent = new A.Agent({ name: 'chat-agent', instructions: 'Be brief.', model });
    await new A.Runner({ groupId: 'thread-chat' }).run(agent, 'say hello');

    const chat = only(spansNamed(OP_CHAT), 'chat span');
    const agentSpan = only(agentSpans(), 'invoke_agent span');
    expect(parentOf(chat)?.spanContext().spanId).toBe(agentSpan.spanContext().spanId);
    expect(chat.attributes[ATTR_CONVERSATION_ID]).toBe('thread-chat');
    const input = String(agentSpan.attributes['gen_ai.input.messages']);
    expect(input).toContain('say hello');
    expect(input).not.toContain('Be brief.');
    expect(String(agentSpan.attributes['gen_ai.output.messages'])).toContain('hello from chat');
  });

  it('records agent messages on the Responses path', async () => {
    const setupResult = await setup(
      (_req, i) =>
        i === 0
          ? responsesToolCall({ name: 'get_weather', args: { city: 'Tokyo' } })
          : responsesMessage({ text: 'It is sunny in Tokyo.' }),
      { contentCapture: 'full' },
    );
    const agent = new A.Agent({
      name: 'weather-agent',
      instructions: 'x',
      model: setupResult.model,
      tools: [weatherTool()],
    });
    await new A.Runner().run(agent, 'What is the weather in Tokyo?');

    const agentSpan = only(agentSpans(), 'invoke_agent span');
    expect(String(agentSpan.attributes['gen_ai.input.messages'])).toContain('weather in Tokyo?');
    const output = String(agentSpan.attributes['gen_ai.output.messages']);
    expect(output).toContain('It is sunny in Tokyo.');
    expect(output).toContain('"finish_reason":"stop"');
  });

  it('closes every span when a streamed run fails', async () => {
    await setupAiSdk();
    const agent = new A.Agent({
      name: 'doomed-streamer',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ throws: true })),
    });
    const stream = await new A.Runner().run(agent, 'hi', { stream: true });
    await expect(
      (async () => {
        for await (const _event of stream.toStream()) {
          // drain
        }
        await stream.completed;
      })(),
    ).rejects.toThrow('model exploded');

    await vi.waitFor(() => expect(agentSpans()).toHaveLength(1));
    await vi.waitFor(() => expect(h.openSpanCount()).toBe(0));
    expect(only(agentSpans(), 'invoke_agent span').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('keeps concurrent runs apart', async () => {
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));
    const agent = new A.Agent({
      name: 'shared-agent',
      instructions: 'x',
      model: setupResult.model,
    });
    await Promise.all(
      ['thread-a', 'thread-b'].map((groupId) => new A.Runner({ groupId }).run(agent, 'hi')),
    );
    for (const chat of spansNamed(OP_CHAT)) {
      const agentSpan = parentOf(chat);
      expect(agentSpan?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
      expect(chat.attributes[ATTR_CONVERSATION_ID]).toBe(
        agentSpan?.attributes[ATTR_CONVERSATION_ID],
      );
    }
    expect(new Set(spansNamed(OP_CHAT).map((s) => s.attributes[ATTR_CONVERSATION_ID]))).toEqual(
      new Set(['thread-a', 'thread-b']),
    );
  });

  it('traces again after being disabled and re-enabled', async () => {
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));
    const agent = new A.Agent({
      name: 'toggled-agent',
      instructions: 'x',
      model: setupResult.model,
    });
    setupResult.agents.disable();
    setupResult.agents.enable();
    await new A.Runner().run(agent, 'hi');

    expect(agentSpans()).toHaveLength(1);
  });

  it('traces a run resumed after a tool approval', async () => {
    // The SDK reuses the first run's trace on resume and sends no new trace start.
    await setupAiSdk();
    const danger = A.tool({
      name: 'danger',
      description: 'Needs approval',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true,
      needsApproval: true,
      execute: async () => 'done',
    });
    const agent = new A.Agent({
      name: 'careful-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ toolCallFirst: 'danger' })),
      tools: [danger],
    });
    const runner = new A.Runner();
    const first = await runner.run(agent, 'go');
    for (const interruption of first.interruptions) first.state.approve(interruption);
    await runner.run(agent, first.state);

    await vi.waitFor(() => expect(h.openSpanCount()).toBe(0));
    expect(agentSpans()).toHaveLength(2);
    const tool = only(spansNamed(OP_EXECUTE_TOOL), 'execute_tool span');
    expect(parentOf(tool)?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
  });

  it("keeps the run's conversationId on a run resumed from its state", async () => {
    await setupAiSdk();
    const danger = A.tool({
      name: 'danger',
      description: 'Needs approval',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true,
      needsApproval: true,
      execute: async () => 'done',
    });
    const agent = new A.Agent({
      name: 'careful-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel({ toolCallFirst: 'danger' })),
      tools: [danger],
    });
    const runner = new A.Runner({ groupId: 'thread-1' });
    const first = await runner.run(agent, 'go', { conversationId: 'conv_1' });
    for (const interruption of first.interruptions) first.state.approve(interruption);
    await runner.run(agent, first.state);

    await vi.waitFor(() => expect(h.openSpanCount()).toBe(0));
    const ids = h.spans.getFinishedSpans().map((s) => [s.name, s.attributes[ATTR_CONVERSATION_ID]]);
    for (const [name, id] of ids) expect(id, String(name)).toBe('conv_1');
  });

  it("gives the spans of a run inside withTrace the run's conversationId", async () => {
    const core = { ...Agents };
    await setupAiSdk(core);
    const agent = new A.Agent({
      name: 'traced-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel()),
    });
    await core.withTrace('block', () =>
      new A.Runner().run(agent, 'hi', { conversationId: 'conv_1' }),
    );

    await vi.waitFor(() => expect(h.openSpanCount()).toBe(0));
    for (const op of [OP_INVOKE_AGENT, OP_CHAT]) {
      const span = only(
        spansNamed(op).filter((s) => s.name !== 'block'),
        op,
      );
      expect(span.attributes[ATTR_CONVERSATION_ID]).toBe('conv_1');
    }
  });

  it('takes a scope set inside withTrace, not the one the trace opened under', async () => {
    const core = { ...Agents };
    await setupAiSdk(core);
    const agent = new A.Agent({
      name: 'scoped-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel()),
    });
    await core.withTrace('block', () =>
      withUserId('u1', () => withConversationId('c1', () => new A.Runner().run(agent, 'hi'))),
    );

    await vi.waitFor(() => expect(h.openSpanCount()).toBe(0));
    for (const op of [OP_INVOKE_AGENT, OP_CHAT]) {
      const span = only(
        spansNamed(op).filter((s) => s.name !== 'block'),
        op,
      );
      expect(span.attributes[ATTR_CONVERSATION_ID], op).toBe('c1');
      expect(span.attributes['user.id'], op).toBe('u1');
    }
  });

  it('applies an allow_list mode set inside withTrace', async () => {
    const core = { ...Agents };
    await setupAiSdk(core);
    const agent = new A.Agent({
      name: 'filtered-agent',
      instructions: 'Be brief.',
      model: AiSdkExt.aisdk(fakeLanguageModel()),
    });
    await withContentCaptureMode('full', () =>
      core.withTrace('block', () =>
        withContentCaptureMode('allow_list', () => new A.Runner().run(agent, 'hi')),
      ),
    );

    await vi.waitFor(() => expect(h.openSpanCount()).toBe(0));
    for (const op of [OP_INVOKE_AGENT, OP_CHAT]) {
      const span = only(
        spansNamed(op).filter((s) => s.name !== 'block'),
        op,
      );
      expect(span.attributes['gen_ai.input.messages'], op).toBeUndefined();
      expect(span.attributes['gen_ai.output.messages'], op).toBeUndefined();
    }
  });

  it('emits AI SDK chat spans when this processor is the only one', async () => {
    // With no processor ahead of it, this one hears a `generation` span start
    // before the AI SDK bridge has filled in the model.
    await setupAiSdk();
    A.setTraceProcessors([]);
    const agent = new A.Agent({
      name: 'solo-aisdk-agent',
      instructions: 'x',
      model: AiSdkExt.aisdk(fakeLanguageModel()),
    });
    await new A.Runner().run(agent, 'hi');

    const chat = only(spansNamed(OP_CHAT), 'chat span');
    expect(parentOf(chat)?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
  });

  it('stays registered when the app replaces the SDK processor list', async () => {
    const setupResult = await setup(() => responsesMessage({ text: 'hi' }));
    A.setTraceProcessors([]);
    const agent = new A.Agent({ name: 'kept-agent', instructions: 'x', model: setupResult.model });
    await new A.Runner().run(agent, 'hi');

    expect(agentSpans()).toHaveLength(1);
  });

  it('leaves wrappers it deferred to in place when disabled', () => {
    // Another library already wrapped these, so patching skips them, and disabling
    // must not remove them either. Shimmer-style markers, as `isWrapped` expects.
    const targets = [
      [Agents.Runner.prototype, 'run'],
      [Agents.OpenAIResponsesModel.prototype, 'getResponse'],
    ] as unknown as [Record<string, unknown>, string][];
    const originals = targets.map(([target, name]) => target[name]);
    const foreign = targets.map(([target, name]) => {
      const original = target[name] as (...args: unknown[]) => unknown;
      const wrapper = function (this: unknown, ...args: unknown[]) {
        return original.apply(this, args);
      };
      const unwrap = () => {
        target[name] = original;
      };
      Object.assign(wrapper, { __original: original, __unwrap: unwrap, __wrapped: true });
      target[name] = wrapper;
      return wrapper;
    });

    try {
      const agents = new OpenAIAgentsInstrumentation({ enabled: false, client: h.client });
      agents.manuallyInstrument(Agents);
      agents.disable();

      expect(targets.map(([target, name]) => target[name])).toEqual(foreign);
    } finally {
      targets.forEach(([target, name], i) => {
        target[name] = originals[i];
      });
    }
  });

  it('keeps the run working when tracing is disabled', async () => {
    // The run has to succeed with the SDK's tracing switch off. `beforeEach` turned
    // tracing on for every test, so this one turns it back off to exercise the
    // disabled path.
    A.setTracingDisabled(true);
    const server = await startFakeOpenAI(() => responsesMessage({ text: 'quiet' }));
    const agents = new OpenAIAgentsInstrumentation({ enabled: false, client: h.client });
    const openai = new OpenAIInstrumentation({ enabled: false, client: h.client });
    const unpatchAgents = applyPatches(agents, {
      '@openai/agents-core': Agents,
      '@openai/agents': Agents,
    });
    const unpatchOpenAI = applyPatches(openai, { openai: OpenAIModule });
    active = {
      server,
      agents,
      openai,
      unpatch: () => {
        unpatchOpenAI();
        unpatchAgents();
      },
    };

    const agent = new A.Agent({
      name: 'quiet-agent',
      instructions: 'x',
      model: responsesModel(server),
    });
    const result = await new A.Runner().run(agent, 'hi');

    expect(result.finalOutput).toBe('quiet');
    // The openai instrumentation is independent of the SDK's tracing switch, so
    // its chat span is still emitted; the agent orchestration spans are not.
    expect(agentSpans()).toHaveLength(0);
    expect(spansNamed(OP_CHAT)).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function weatherTool() {
  return A.tool({
    name: 'get_weather',
    description: 'Get weather for a city',
    // A plain JSON schema keeps the test from pinning a zod major of its own.
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    strict: true,
    execute: async ({ city }: { city: string }) => `sunny in ${city}`,
  });
}

class BoomError extends Error {
  constructor() {
    super('model exploded');
    this.name = 'BoomError';
  }
}

/**
 * A minimal `LanguageModelV2` standing in for `@ai-sdk/anthropic` and friends.
 *
 * The provider *interface* is what defines the AI SDK path, so a hand-written stub
 * covers it without a provider package. It also pins the usage shape the
 * `@openai/agents-extensions` bridge reads: nested
 * `{ total, cacheRead, cacheWrite }` on `inputTokens` and
 * `{ total, reasoning, text }` on `outputTokens`, where a reader might expect flat
 * counts.
 */
function fakeLanguageModel(
  options: {
    throws?: boolean;
    firstTokenDelayMs?: number;
    finishDelayMs?: number;
    /** Asks for this tool on the first call, then answers. */
    toolCallFirst?: string;
  } = {},
): any {
  let calls = 0;
  return {
    specificationVersion: 'v2',
    provider: 'anthropic.messages',
    modelId: 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate() {
      if (options.throws) throw new BoomError();
      calls += 1;
      if (options.toolCallFirst && calls === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: options.toolCallFirst,
              input: '{}',
            },
          ],
          finishReason: 'tool-calls',
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
          response: { id: 'aisdk-tool' },
        };
      }
      return {
        content: [{ type: 'text', text: 'from the ai sdk' }],
        finishReason: 'stop',
        usage: {
          inputTokens: { total: 31, cacheRead: 12, cacheWrite: 0 },
          outputTokens: { total: 9, reasoning: 5, text: 4 },
        },
        warnings: [],
        response: { id: 'aisdk-1' },
      };
    },
    async doStream() {
      if (options.throws) throw new BoomError();
      const delay = options.firstTokenDelayMs ?? 0;
      async function* events() {
        yield { type: 'stream-start', warnings: [] };
        yield { type: 'text-start', id: '1' };
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        yield { type: 'text-delta', id: '1', delta: 'from the ai sdk' };
        if (options.finishDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.finishDelayMs));
        }
        yield { type: 'text-end', id: '1' };
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: { total: 7 }, outputTokens: { total: 2 } },
        };
      }
      return { stream: events(), response: { id: 'aisdk-stream-1' } };
    },
  };
}
