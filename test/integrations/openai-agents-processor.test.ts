/**
 * Unit tests for `GenAIOtelTracingProcessor`, driven by synthetic span payloads.
 *
 * This file covers states the SDK does not reach on demand: eviction, callbacks
 * arriving out of order, span types that only appear in voice or MCP runs, and
 * the payload that tells the AI SDK path from the OpenAI one.
 */

import { SpanStatusCode, context as otelContext } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mapAgentsItems } from '../../src/integrations/openai-agents/_map.js';
import type {
  SdkSpan,
  SdkSpanData,
  SdkTrace,
} from '../../src/integrations/openai-agents/_sdk-types.js';
import { GenAIOtelTracingProcessor } from '../../src/integrations/openai-agents/index.js';
import { RUN_TOKEN_KEY } from '../../src/integrations/openai-agents/processor.js';
import {
  ATTR_AGENT_NAME,
  ATTR_CONVERSATION_ID,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  OP_CHAT,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

let nextId = 0;
function id(prefix: string): string {
  nextId += 1;
  return `${prefix}_${nextId}`;
}

function makeTrace(overrides: Partial<SdkTrace> = {}): SdkTrace {
  return {
    traceId: overrides.traceId ?? id('trace'),
    name: overrides.name ?? 'Agent workflow',
    groupId: overrides.groupId ?? null,
    metadata: overrides.metadata,
  };
}

function makeSpan(
  traceId: string,
  data: SdkSpanData,
  overrides: Partial<Pick<SdkSpan, 'spanId' | 'parentId' | 'startedAt' | 'endedAt' | 'error'>> = {},
): SdkSpan {
  return {
    traceId,
    spanId: overrides.spanId ?? id('span'),
    parentId: overrides.parentId ?? null,
    spanData: data,
    startedAt: overrides.startedAt ?? '2026-09-11T00:00:00.000Z',
    endedAt: 'endedAt' in overrides ? (overrides.endedAt ?? null) : '2026-09-11T00:00:01.000Z',
    error: overrides.error ?? null,
  };
}

/** Drives one span through its whole lifecycle, as the SDK would. */
async function runSpan(processor: GenAIOtelTracingProcessor, span: SdkSpan): Promise<void> {
  await processor.onSpanStart(span);
  await processor.onSpanEnd(span);
}

describe('GenAIOtelTracingProcessor', () => {
  let h: Harness;
  let processor: GenAIOtelTracingProcessor;

  beforeEach(() => {
    h = createHarness();
    processor = new GenAIOtelTracingProcessor({ client: h.client, contentCapture: 'full' });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  const names = () => h.spans.getFinishedSpans().map((s) => s.name);
  const spansWithOp = (op: string) =>
    h.spans.getFinishedSpans().filter((s) => s.attributes[ATTR_OPERATION_NAME] === op);
  const only = <T>(list: T[]): T => {
    expect(list).toHaveLength(1);
    return list[0] as T;
  };
  /** `invoke_agent` spans for the SDK's agents, leaving out the run container. */
  const agentSpans = () =>
    spansWithOp(OP_INVOKE_AGENT).filter((s) => s.name.startsWith(`${OP_INVOKE_AGENT} `));
  const ops = () =>
    h.spans.getFinishedSpans().map((s) => s.attributes[ATTR_OPERATION_NAME] ?? '<none>');

  it('emits no span for the SDK types that have no semconv operation', async () => {
    // Nine span types, none with an operation in the GenAI conventions. Emitting
    // them anyway would fill a trace viewer with spans carrying no attributes.
    // `task` and `turn` are tracked for error routing without getting a span.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const suppressed: SdkSpanData[] = [
      { type: 'task', name: 'Agent workflow' },
      { type: 'turn', turn: 1, agent_name: 'a' },
      { type: 'guardrail', name: 'jailbreak', triggered: false },
      { type: 'custom', name: 'my-span', data: {} },
      { type: 'mcp_tools', server: 'srv', result: ['a'] },
      { type: 'handoff', from_agent: 'a', to_agent: 'b' },
      { type: 'speech', output: { data: '', format: 'pcm' } },
      { type: 'transcription', input: { data: '', format: 'pcm' } },
      { type: 'speech_group' },
    ];
    for (const data of suppressed) await runSpan(processor, makeSpan(trace.traceId, data));
    await processor.onTraceEnd(trace);

    // Only the run container, which every trace gets.
    expect(names()).toEqual(['Agent workflow']);
  });

  it('emits a chat span for an AI SDK generation but not for an OpenAI one', async () => {
    // The dual-emit guard. `model_impl: 'ai-sdk'` is the only positive marker for
    // the path where nothing else can emit; the OpenAI transports carry sampling
    // settings or a base_url there and belong to the openai instrumentation.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    await runSpan(
      processor,
      makeSpan(trace.traceId, {
        type: 'generation',
        model: 'anthropic.messages:claude-sonnet-4-5',
        model_config: { provider: 'anthropic.messages', model_impl: 'ai-sdk' },
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    );
    await runSpan(
      processor,
      makeSpan(trace.traceId, {
        type: 'generation',
        model: 'gpt-4o-mini',
        model_config: { temperature: 0.5, top_p: 1 },
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
    );
    await runSpan(processor, makeSpan(trace.traceId, { type: 'response', _response: {} }));
    await processor.onTraceEnd(trace);

    const chat = h.spans
      .getFinishedSpans()
      .filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_CHAT);
    expect(chat).toHaveLength(1);
    expect(chat[0]?.attributes[ATTR_PROVIDER_NAME]).toBe('anthropic');
    expect(chat[0]?.attributes[ATTR_REQUEST_MODEL]).toBe('claude-sonnet-4-5');
  });

  it('treats an unrecognised model_config as not-AI-SDK', async () => {
    // The two guesses cost different amounts: guessing "not AI SDK" costs a span
    // the openai instrumentation covers, guessing "AI SDK" double-counts a call.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    for (const model_config of [
      undefined,
      {},
      { model_impl: 'something-else' },
      { provider: 'x' },
    ]) {
      await runSpan(
        processor,
        makeSpan(trace.traceId, { type: 'generation', model: 'm', model_config }),
      );
    }
    await processor.onTraceEnd(trace);

    expect(ops()).not.toContain(OP_CHAT);
  });

  it('parents a tool span under the agent across hierarchy-only spans', async () => {
    // The SDK nests `function` under `turn` under `agent`. `turn` gets no span, so
    // the parent walk is what keeps the tool span from being reparented to the
    // trace root.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const agent = makeSpan(trace.traceId, { type: 'agent', name: 'worker' });
    const turn = makeSpan(
      trace.traceId,
      { type: 'turn', turn: 1, agent_name: 'worker' },
      { parentId: agent.spanId },
    );
    const fn = makeSpan(
      trace.traceId,
      { type: 'function', name: 'lookup', input: '{"q":1}', output: 'result' },
      { parentId: turn.spanId },
    );
    await processor.onSpanStart(agent);
    await processor.onSpanStart(turn);
    await runSpan(processor, fn);
    await processor.onSpanEnd(turn);
    await processor.onSpanEnd(agent);
    await processor.onTraceEnd(trace);

    const finished = h.spans.getFinishedSpans();
    const toolSpan = finished.find((s) => s.attributes[ATTR_OPERATION_NAME] === OP_EXECUTE_TOOL);
    const agentSpan = finished.find((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT);
    expect(toolSpan?.parentSpanContext?.spanId).toBe(agentSpan?.spanContext().spanId);
  });

  it('times spans from the SDK timestamps, not from callback delivery', async () => {
    // The SDK dispatches `onSpanEnd` detached and un-awaited, so a processor that
    // stamps `Date.now()` measures its own callback lag on top of the real
    // duration. This span claims a 2.5s life; a clock-based end would report the
    // handful of microseconds this test takes.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    await runSpan(
      processor,
      makeSpan(
        trace.traceId,
        { type: 'agent', name: 'slow' },
        { startedAt: '2026-09-11T00:00:00.000Z', endedAt: '2026-09-11T00:00:02.500Z' },
      ),
    );
    await processor.onTraceEnd(trace);

    const agentSpan = h.spans
      .getFinishedSpans()
      .find((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT);
    const [seconds, nanos] = agentSpan?.duration ?? [0, 0];
    expect(seconds + nanos / 1e9).toBeCloseTo(2.5, 3);
  });

  it('puts the trace group id on every span as the conversation id', async () => {
    // `Trace.groupId` is documented as a chat-thread identifier, which is what
    // `gen_ai.conversation.id` means. It is visible only at the agents layer; a
    // model-provider instrumentation never sees it.
    const trace = makeTrace({ groupId: 'thread-42' });
    await processor.onTraceStart(trace);
    await runSpan(processor, makeSpan(trace.traceId, { type: 'agent', name: 'a' }));
    await processor.onTraceEnd(trace);

    for (const span of h.spans.getFinishedSpans()) {
      expect(span.attributes[ATTR_CONVERSATION_ID]).toBe('thread-42');
    }
  });

  it('never lets a malformed payload throw out of a callback', async () => {
    // The SDK invokes these as `void processor.onSpanStart(span).catch(...)`, so a
    // throw would surface as an unhandled rejection inside the user's agent run.
    const trace = makeTrace();
    await expect(processor.onTraceStart(trace)).resolves.toBeUndefined();
    const broken = {
      traceId: trace.traceId,
      spanId: 'span-broken',
      parentId: null,
      spanData: null,
      startedAt: null,
      endedAt: null,
      error: null,
    } as unknown as SdkSpan;
    await expect(processor.onSpanStart(broken)).resolves.toBeUndefined();
    await expect(processor.onSpanEnd(broken)).resolves.toBeUndefined();
    // A span for a trace we never saw, i.e. one that started before we registered.
    // It is ignored.
    const orphan = makeSpan('trace-never-started', { type: 'agent', name: 'orphan' });
    await expect(runSpan(processor, orphan)).resolves.toBeUndefined();
    await expect(processor.onTraceEnd(trace)).resolves.toBeUndefined();
  });

  it('reports the run container as invoke_agent, named after the trace', async () => {
    // One shape for every run, single agent or handed off, as the Python
    // instrumentation reports it.
    for (const [name, agents] of [
      ['solo-run', ['only']],
      ['multi-run', ['first', 'second']],
    ] as const) {
      const trace = makeTrace({ name });
      await processor.onTraceStart(trace);
      for (const agent of agents) {
        await runSpan(processor, makeSpan(trace.traceId, { type: 'agent', name: agent }));
      }
      await processor.onTraceEnd(trace);
    }

    const roots = h.spans.getFinishedSpans().filter((s) => !s.parentSpanContext);
    expect(roots.map((s) => s.name)).toEqual(['solo-run', 'multi-run']);
    for (const root of roots) {
      expect(root.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
      expect(root.attributes[ATTR_AGENT_NAME]).toBeUndefined();
    }
  });

  it('omits a failed tool result but keeps its arguments', async () => {
    // Arguments are what you need to reproduce the failure. When a tool throws,
    // `output` holds a framework-generated fallback string, and recording that as
    // `gen_ai.tool.call.result` misreports it as real output.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    await runSpan(
      processor,
      makeSpan(
        trace.traceId,
        {
          type: 'function',
          name: 'flaky',
          input: '{"a":1}',
          output: 'An error occurred while running the tool.',
        },
        { error: { message: 'Error running tool', data: { error: 'ToolBoomError: nope' } } },
      ),
    );
    await processor.onTraceEnd(trace);

    const toolSpan = h.spans
      .getFinishedSpans()
      .find((s) => s.attributes[ATTR_OPERATION_NAME] === OP_EXECUTE_TOOL);
    expect(toolSpan?.attributes['gen_ai.tool.call.arguments']).toBe('{"a":1}');
    expect(toolSpan?.attributes['gen_ai.tool.call.result']).toBeUndefined();
    // The SDK's structured error record still yields a usable, bounded type.
    expect(toolSpan?.attributes['error.type']).toBe('ToolBoomError');
  });

  it('keeps a guardrail tripwire distinguishable in error.type', async () => {
    // Guardrails get no span: `GuardrailSpanData` carries only
    // `{ name, triggered }` and semconv has no guardrail concept. So a tripwire's
    // only trace is the error type on the agent span, and the allow-list keeps the
    // `TripwireTriggered` suffix from being sanitized away with everything else.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    await runSpan(
      processor,
      makeSpan(
        trace.traceId,
        { type: 'agent', name: 'guarded' },
        { error: { message: 'InputGuardrailTripwireTriggered' } },
      ),
    );
    await processor.onTraceEnd(trace);

    const agentSpan = h.spans
      .getFinishedSpans()
      .find((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT);
    expect(agentSpan?.attributes['error.type']).toBe('InputGuardrailTripwireTriggered');
  });

  it('routes a turn error onto the enclosing agent span', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const agent = makeSpan(trace.traceId, { type: 'agent', name: 'worker' });
    const turn = makeSpan(
      trace.traceId,
      { type: 'turn', turn: 1, agent_name: 'worker' },
      {
        parentId: agent.spanId,
        error: { message: 'Error in agent run', data: { error: 'TurnError: x' } },
      },
    );
    await processor.onSpanStart(agent);
    await processor.onSpanStart(turn);
    await processor.onSpanEnd(turn);
    await processor.onSpanEnd(agent);
    await processor.onTraceEnd(trace);

    const agentSpan = h.spans
      .getFinishedSpans()
      .find((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT);
    expect(agentSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(agentSpan?.attributes['error.type']).toBe('TurnError');
  });

  it('does not let a recovered model attempt fail the agent span', async () => {
    // `modelRetry` may retry a `generation` / `response` failure and succeed, so
    // that failure must not propagate. A `turn` or `task` error is what says the
    // run itself failed.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const agent = makeSpan(trace.traceId, { type: 'agent', name: 'retrying' });
    await processor.onSpanStart(agent);
    await runSpan(
      processor,
      makeSpan(
        trace.traceId,
        { type: 'response' },
        { parentId: agent.spanId, error: { message: 'RateLimitError: slow down' } },
      ),
    );
    await processor.onSpanEnd(agent);
    await processor.onTraceEnd(trace);

    const finished = h.spans.getFinishedSpans();
    for (const span of finished) {
      expect(span.status.code, `${span.name} should not be in error`).not.toBe(
        SpanStatusCode.ERROR,
      );
    }
  });

  it('ends the least recently active trace once the cap is hit, without marking it failed', async () => {
    const bounded = new GenAIOtelTracingProcessor({ client: h.client, maxTracesInFlight: 2 });
    const [t1, t2, t3] = [
      makeTrace({ name: 't1' }),
      makeTrace({ name: 't2' }),
      makeTrace({ name: 't3' }),
    ];
    await bounded.onTraceStart(t1);
    await bounded.onTraceStart(t2);
    // Activity on t1 makes t2 the idle one.
    await bounded.onSpanStart(makeSpan(t1.traceId, { type: 'turn', turn: 1, agent_name: 'a' }));
    await bounded.onTraceStart(t3);
    await vi.waitFor(() => expect(names()).toEqual(['t2']));

    expect(h.spans.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.UNSET);
    await bounded.stop();
  });

  it('only flushes when the SDK shuts it down, so later runs are still traced', async () => {
    // The SDK shuts processors down when it replaces its processor list and on
    // process signals; neither means tracing is over.
    const trace = makeTrace({ name: 'still-running' });
    await processor.onTraceStart(trace);
    await processor.shutdown();
    await processor.onTraceEnd(trace);
    const after = makeTrace({ name: 'after-shutdown' });
    await processor.onTraceStart(after);
    await processor.onTraceEnd(after);

    expect(names()).toEqual(['still-running', 'after-shutdown']);
  });

  it('ends everything still open on stop, and ignores work until resumed', async () => {
    const trace = makeTrace({ name: 'abandoned' });
    await processor.onTraceStart(trace);
    await processor.onSpanStart(
      makeSpan(trace.traceId, { type: 'agent', name: 'stuck' }, { endedAt: null }),
    );
    await processor.stop();
    expect(names().sort()).toEqual(['abandoned', 'invoke_agent stuck']);

    const ignored = makeTrace({ name: 'while-stopped' });
    await processor.onTraceStart(ignored);
    await processor.onTraceEnd(ignored);
    processor.resume();
    const resumed = makeTrace({ name: 'after-resume' });
    await processor.onTraceStart(resumed);
    await processor.onTraceEnd(resumed);

    expect(names()).not.toContain('while-stopped');
    expect(names()).toContain('after-resume');
  });

  it('gives a span its normal ending when the trace end arrives before the span end', async () => {
    // The SDK awaits trace ends but not span ends, so a slow processor ahead of
    // this one can deliver the trace end first.
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const agent = makeSpan(
      trace.traceId,
      { type: 'agent', name: 'late' },
      { startedAt: '2026-09-11T00:00:00.000Z', endedAt: '2026-09-11T00:00:02.000Z' },
    );
    await processor.onSpanStart(agent);
    await processor.onTraceEnd(trace);
    await processor.onSpanEnd(agent);

    const agentSpan = only(agentSpans());
    const [seconds] = agentSpan.duration;
    expect(seconds).toBe(2);
    expect(agentSpan.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('puts a top-level task error on the container of the run that owns it', async () => {
    // A streamed run that fails reports the error only on its task span; the run
    // itself does not reject.
    const failedTask = (traceId: string) =>
      makeSpan(
        traceId,
        { type: 'task', name: 'run' },
        { error: { message: 'Error in agent run', data: { error: 'BadRequestError: nope' } } },
      );
    const owned = makeTrace({ name: 'owned-run' });
    const run = otelContext.active().setValue(RUN_TOKEN_KEY, processor.beginRun(true));
    await otelContext.with(run, () => processor.onTraceStart(owned));
    await runSpan(processor, failedTask(owned.traceId));
    await processor.onTraceEnd(owned);

    // A `withTrace` block may catch the failure and carry on, so its trace is left alone.
    const block = makeTrace({ name: 'user-block' });
    await processor.onTraceStart(block);
    await runSpan(processor, failedTask(block.traceId));
    await processor.onTraceEnd(block);

    const byName = (name: string) => h.spans.getFinishedSpans().find((s) => s.name === name);
    expect(byName('owned-run')?.attributes['error.type']).toBe('BadRequestError');
    expect(byName('user-block')?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records a span it only hears about when the span ends', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    await processor.onSpanEnd(makeSpan(trace.traceId, { type: 'agent', name: 'late' }));
    await processor.onTraceEnd(trace);

    expect(agentSpans()).toHaveLength(1);
  });

  it('does not open a span again when its start arrives after its end', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const agent = makeSpan(trace.traceId, { type: 'agent', name: 'late' });
    await processor.onSpanEnd(agent);
    await processor.onSpanStart(agent);
    await processor.onTraceEnd(trace);

    expect(agentSpans()).toHaveLength(1);
    expect(h.openSpanCount()).toBe(0);
  });

  it('ends the earlier trace when a second one opens with the same id', async () => {
    // `RunConfig.traceId` gives every run of a Runner the same trace id.
    const first = makeTrace({ traceId: 'shared', name: 'first' });
    await processor.onTraceStart(first);
    await processor.onSpanStart(
      makeSpan('shared', { type: 'agent', name: 'a' }, { endedAt: null }),
    );
    const second = makeTrace({ traceId: 'shared', name: 'second' });
    await processor.onTraceStart(second);
    await processor.onTraceEnd(second);

    await vi.waitFor(() => expect(h.openSpanCount()).toBe(0));
    expect(names()).toEqual(expect.arrayContaining(['first', 'second', 'invoke_agent a']));
  });

  it('drops a span start that arrives after its trace closed', async () => {
    const trace = makeTrace({ name: 'finished' });
    await processor.onTraceStart(trace);
    await processor.onTraceEnd(trace);
    await processor.onSpanStart(
      makeSpan(trace.traceId, { type: 'agent', name: 'late' }, { endedAt: null }),
    );
    await processor.stop();

    expect(names()).toEqual(['finished']);
  });

  it('does not reopen a trace for a late span from the run that produced it', async () => {
    // Output guardrail spans start and end in the run's last millisecond, so time
    // cannot tell a late delivery from a resume. The run marker can.
    const trace = makeTrace({ name: 'guarded-run' });
    const tracked = new GenAIOtelTracingProcessor({
      client: h.client,
      getCurrentTrace: () => trace,
    });
    const run = otelContext.active().setValue(RUN_TOKEN_KEY, tracked.beginRun(false));
    await otelContext.with(run, async () => {
      await tracked.onTraceStart(trace);
      await tracked.onTraceEnd(trace);
      const now = new Date(Date.now() + 1000).toISOString();
      await runSpan(
        tracked,
        makeSpan(trace.traceId, { type: 'guardrail' }, { startedAt: now, endedAt: now }),
      );
    });
    await tracked.stop();

    expect(names()).toEqual(['guarded-run']);
  });

  it('reopens the trace of a resumed run, and closes it when the run ends', async () => {
    // The SDK sends no trace start for a resumed run.
    const trace = makeTrace({ name: 'resumed-run' });
    const resuming = new GenAIOtelTracingProcessor({
      client: h.client,
      getCurrentTrace: () => trace,
    });
    const now = new Date().toISOString();
    const task = makeSpan(trace.traceId, { type: 'task', name: 'run' }, { startedAt: now });
    await resuming.onSpanStart(task);
    await runSpan(
      resuming,
      makeSpan(
        trace.traceId,
        { type: 'agent', name: 'a' },
        { parentId: task.spanId, startedAt: now },
      ),
    );
    await resuming.onSpanEnd(task);

    expect(names().sort()).toEqual(['invoke_agent a', 'resumed-run']);
    expect(h.openSpanCount()).toBe(0);
  });

  it('marks an MCP tool, which the SDK only flags once the tool runs', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const data = { type: 'function', name: 'search', input: '{}', output: 'x' } as {
      type: 'function';
      name: string;
      input: string;
      output: string;
      mcp_data?: string;
    };
    const span = makeSpan(trace.traceId, data);
    await processor.onSpanStart(span);
    data.mcp_data = '{"server":"docs"}';
    await processor.onSpanEnd(span);
    await processor.onTraceEnd(trace);

    expect(only(spansWithOp(OP_EXECUTE_TOOL)).attributes['gen_ai.tool.type']).toBe('mcp');
  });

  it('keeps error text off the container under metadata_only capture', async () => {
    const quiet = new GenAIOtelTracingProcessor({
      client: h.client,
      contentCapture: 'metadata_only',
    });
    const trace = makeTrace({ name: 'quiet-run' });
    await quiet.onTraceStart(trace);
    await quiet.failTrace(trace.traceId, new Error('customer 42 said something private'));

    const root = only(h.spans.getFinishedSpans());
    expect(root.attributes['error.type']).toBe('Error');
    expect(root.status.message).toBe('Error');
  });

  it('reports _OTHER on the container for an error with no class-like name', async () => {
    const trace = makeTrace({ name: 'odd-run' });
    await processor.onTraceStart(trace);
    await processor.failTrace(trace.traceId, 'just a string');

    expect(only(h.spans.getFinishedSpans()).attributes['error.type']).toBe('_OTHER');
  });

  it('keeps the recorder category when an error has no usable class name', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    await runSpan(
      processor,
      makeSpan(
        trace.traceId,
        { type: 'function', name: 'f', input: '{}', output: 'x' },
        { error: { message: 'the tool said something long and arbitrary here' } },
      ),
    );
    await processor.onTraceEnd(trace);

    expect(only(spansWithOp(OP_EXECUTE_TOOL)).attributes['error.type']).toBe(
      'tool_execution_error',
    );
  });

  it('accepts a plain Error as error.type', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    await runSpan(
      processor,
      makeSpan(
        trace.traceId,
        { type: 'function', name: 'f', input: '{}', output: 'x' },
        { error: { message: 'Error running tool', data: { error: 'Error: boom' } } },
      ),
    );
    await processor.onTraceEnd(trace);

    expect(only(spansWithOp(OP_EXECUTE_TOOL)).attributes['error.type']).toBe('Error');
  });

  it('maps AI SDK provider ids to well-known provider names', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    for (const model of [
      'amazon-bedrock:claude',
      'google.generative-ai:gemini-2.5-pro',
      'openai.responses:gpt-4o',
      'acme.chat:m1',
    ]) {
      await runSpan(
        processor,
        makeSpan(trace.traceId, {
          type: 'generation',
          model,
          model_config: { model_impl: 'ai-sdk' },
        }),
      );
    }
    await processor.onTraceEnd(trace);

    expect(spansWithOp(OP_CHAT).map((s) => s.attributes[ATTR_PROVIDER_NAME])).toEqual([
      'aws.bedrock',
      'gcp.gemini',
      'openai',
      'acme',
    ]);
  });

  it('maps Agents protocol items, including tool results and reasoning', () => {
    const messages = mapAgentsItems([
      { type: 'reasoning', content: [{ type: 'input_text', text: 'thinking' }] },
      { type: 'function_call', callId: 'c1', name: 'lookup', arguments: '{}' },
      {
        type: 'function_call_result',
        callId: 'c1',
        name: 'lookup',
        output: { type: 'text', text: 'found' },
      },
      { role: 'user', content: 'thanks' },
    ]);

    expect(messages.map((m) => [m.role, m.parts.map((p) => p.kind)])).toEqual([
      ['assistant', ['thinking', 'tool_call']],
      ['tool', ['tool_result']],
      ['user', ['text']],
    ]);
    expect(messages[1]?.parts[0]?.toolResult?.content).toBe('found');
  });

  it('records the agent input and output from its model calls', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const agent = makeSpan(trace.traceId, { type: 'agent', name: 'a' });
    await processor.onSpanStart(agent);
    await runSpan(
      processor,
      makeSpan(
        trace.traceId,
        {
          type: 'generation',
          model: 'anthropic.messages:claude',
          model_config: { model_impl: 'ai-sdk' },
          input: [
            { role: 'system', content: 'Be brief.' },
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          ],
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello' }],
            },
          ],
        },
        { parentId: agent.spanId },
      ),
    );
    await processor.onSpanEnd(agent);
    await processor.onTraceEnd(trace);

    const chat = only(spansWithOp(OP_CHAT));
    expect(String(chat.attributes['gen_ai.system_instructions'])).toContain('Be brief.');
    expect(String(chat.attributes['gen_ai.input.messages'])).not.toContain('Be brief.');
    const agentSpan = only(agentSpans());
    expect(String(agentSpan.attributes['gen_ai.input.messages'])).toContain('hi');
    expect(String(agentSpan.attributes['gen_ai.output.messages'])).toContain('hello');
  });

  it('keeps the agent input and output when the run is cut off before the agent ends', async () => {
    const trace = makeTrace();
    await processor.onTraceStart(trace);
    const agent = makeSpan(trace.traceId, { type: 'agent', name: 'a' }, { endedAt: null });
    await processor.onSpanStart(agent);
    await runSpan(
      processor,
      makeSpan(
        trace.traceId,
        {
          type: 'response',
          _input: 'where is my order',
          _response: {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'checking' }],
              },
            ],
          },
        },
        { parentId: agent.spanId },
      ),
    );
    await processor.failTrace(trace.traceId, new Error('boom'));

    const agentSpan = only(agentSpans());
    expect(String(agentSpan.attributes['gen_ai.input.messages'])).toContain('where is my order');
    expect(String(agentSpan.attributes['gen_ai.output.messages'])).toContain('checking');
  });
});
