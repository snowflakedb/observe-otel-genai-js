import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  generateTextHooks,
  mergeHooks,
  streamTextHooks,
  toAgentInputMessages,
} from '../../src/integrations/vercel-ai-sdk/index.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_TOOL_NAME,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  OP_CHAT,
} from '../../src/semconv.js';
import { type Harness, createHarness, findSpan } from '../_harness.js';

// ---------------------------------------------------------------------------
// AI SDK v7 event shape builders
// ---------------------------------------------------------------------------

function stepModel(provider = 'openai', modelId = 'gpt-4o') {
  return { provider, modelId };
}

function v7Usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens };
}

/** Builds a v7 `onStepStart` event (flat provider/modelId + messages). */
function stepStartEvent(opts: {
  stepNumber?: number;
  provider?: string;
  modelId?: string;
  messages?: Array<{ role: string; content: string }>;
  instructions?: unknown;
}) {
  return {
    stepNumber: opts.stepNumber ?? 0,
    provider: opts.provider ?? 'openai',
    modelId: opts.modelId ?? 'gpt-4o',
    messages: opts.messages ?? [],
    instructions: opts.instructions,
  };
}

function makeStepFinishEvent(opts: {
  stepNumber?: number;
  text?: string;
  toolCalls?: Array<{ toolName: string; toolCallId: string; input: unknown }>;
  toolResults?: Array<{
    toolCallId: string;
    toolName: string;
    output?: unknown;
  }>;
  toolErrors?: Array<{ toolCallId: string; toolName: string; error: unknown }>;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  responseId?: string;
}) {
  const toolCalls = opts.toolCalls ?? [];
  const toolResults = opts.toolResults ?? [];
  const toolErrors = opts.toolErrors ?? [];

  const content = [
    ...(opts.text ? [{ type: 'text' as const, text: opts.text }] : []),
    ...toolCalls.map((tc) => ({ type: 'tool-call' as const, ...tc })),
    ...toolErrors.map((te) => ({ type: 'tool-error' as const, ...te })),
  ];

  return {
    stepNumber: opts.stepNumber ?? 0,
    model: stepModel(),
    content,
    text: opts.text ?? '',
    toolCalls,
    toolResults,
    finishReason: opts.finishReason ?? 'stop',
    usage: v7Usage(opts.inputTokens ?? 10, opts.outputTokens ?? 5),
    response: { id: opts.responseId ?? 'resp-1', modelId: 'gpt-4o-served' },
    request: {},
  };
}

// ---------------------------------------------------------------------------
// Tests: streamTextHooks
// ---------------------------------------------------------------------------

describe('streamTextHooks — single-step generation', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a chat span with operation, provider, model, usage, and response metadata', async () => {
    const hooks = streamTextHooks(h.client, { agentName: 'test-agent' });

    hooks.onStepStart?.(
      stepStartEvent({
        provider: 'anthropic',
        modelId: 'claude-3-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );

    await hooks.onStepEnd(
      makeStepFinishEvent({
        text: 'world',
        inputTokens: 12,
        outputTokens: 4,
        responseId: 'resp-42',
      }),
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('anthropic');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('claude-3-5');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('resp-42');
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-4o-served');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(12);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(4);
  });

  it('captures gen_ai.input.messages from onStepStart (v7 agent path)', async () => {
    // In AI SDK v7, ToolLoopAgent fires onStepStart carrying `messages`, so the
    // agent chat span now records input messages (fixed the v6 agent gap where
    // agents ignored experimental_onStepStart).
    const hooks = streamTextHooks(h.client, { agentName: 'agent' });

    hooks.onStepStart?.(stepStartEvent({ messages: [{ role: 'user', content: 'what is otel?' }] }));
    await hooks.onStepEnd(makeStepFinishEvent({ text: 'a tracing framework' }));

    const [span] = h.spans.getFinishedSpans();
    const raw = span?.attributes[ATTR_INPUT_MESSAGES] as string | undefined;
    expect(raw).toBeDefined();
    const messages = JSON.parse(raw as string) as Array<{
      role: string;
      parts: Array<{ type: string; content?: string }>;
    }>;
    const user = messages.find((m) => m.role === 'user');
    expect(user?.parts.find((p) => p.type === 'text')?.content).toBe('what is otel?');
  });

  it('records TTFT via onChunk text-delta', async () => {
    const hooks = streamTextHooks(h.client);

    hooks.onStepStart?.(stepStartEvent({}));

    hooks.onChunk?.({ chunk: { type: 'text-delta', text: 'hi' } });
    hooks.onChunk?.({ chunk: { type: 'text-delta', text: ' there' } }); // second chunk ignored

    await hooks.onStepEnd(makeStepFinishEvent({ text: 'hi there' }));

    const metrics = await h.collectMetrics();
    const ttftMetric = metrics
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'gen_ai.client.time_to_first_token');
    expect(ttftMetric).toBeDefined();
  });

  it('ignores non-text-delta chunks', async () => {
    const hooks = streamTextHooks(h.client);
    hooks.onStepStart?.(stepStartEvent({}));
    // Should not throw
    hooks.onChunk?.({ chunk: { type: 'response-metadata' } });
    await hooks.onStepEnd(makeStepFinishEvent({}));
    expect(h.spans.getFinishedSpans().length).toBe(1);
  });

  it('closes all open recorders with error status on onError', async () => {
    const hooks = streamTextHooks(h.client);
    hooks.onStepStart?.(stepStartEvent({}));

    await hooks.onError?.({ error: new Error('stream failed') });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.status.code).toBe(2 /* ERROR */);
  });

  it('uses synthetic step timing when onStepStart does not fire', async () => {
    const hooks = streamTextHooks(h.client);
    // Skip onStepStart — simulate the fallback path
    await hooks.onStepEnd(makeStepFinishEvent({ inputTokens: 8, outputTokens: 3 }));

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(8);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(3);
  });
});

describe('streamTextHooks — multi-step generation', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits one generation span per step', async () => {
    const hooks = streamTextHooks(h.client);

    hooks.onStepStart?.(stepStartEvent({}));
    await hooks.onStepEnd(makeStepFinishEvent({ stepNumber: 0, inputTokens: 10, outputTokens: 3 }));

    hooks.onStepStart?.(stepStartEvent({ stepNumber: 1 }));
    await hooks.onStepEnd(makeStepFinishEvent({ stepNumber: 1, inputTokens: 20, outputTokens: 7 }));

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(2);
    expect(spans[0]?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(10);
    expect(spans[1]?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
  });
});

describe('streamTextHooks — tool execution (full path with per-tool callbacks)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a discrete execute_tool span on success', async () => {
    const hooks = streamTextHooks(h.client, { agentName: 'test-agent' });

    hooks.onStepStart?.(stepStartEvent({}));

    hooks.onToolExecutionStart?.({
      toolCall: {
        toolName: 'search',
        toolCallId: 'tc-1',
        input: { q: 'otel' },
      },
    });

    await hooks.onToolExecutionEnd?.({
      toolCall: {
        toolName: 'search',
        toolCallId: 'tc-1',
        input: { q: 'otel' },
      },
      toolExecutionMs: 120,
      toolOutput: { type: 'tool-result', output: { results: ['a', 'b'] } },
    });

    await hooks.onStepEnd(
      makeStepFinishEvent({
        stepNumber: 0,
        toolCalls: [{ toolName: 'search', toolCallId: 'tc-1', input: { q: 'otel' } }],
        toolResults: [
          {
            toolCallId: 'tc-1',
            toolName: 'search',
            output: { results: ['a', 'b'] },
          },
        ],
      }),
    );

    const toolSpan = findSpan(h.spans, (n) => n.startsWith('execute_tool'));
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.attributes[ATTR_TOOL_NAME]).toBe('search');
    expect(toolSpan?.status.code).not.toBe(2 /* ERROR */);
  });

  it('emits a discrete execute_tool span on tool error', async () => {
    const hooks = streamTextHooks(h.client);

    hooks.onStepStart?.(stepStartEvent({}));

    hooks.onToolExecutionStart?.({
      toolCall: {
        toolName: 'fetch',
        toolCallId: 'tc-err',
        input: { url: 'x' },
      },
    });

    await hooks.onToolExecutionEnd?.({
      toolCall: {
        toolName: 'fetch',
        toolCallId: 'tc-err',
        input: { url: 'x' },
      },
      toolExecutionMs: 50,
      toolOutput: { type: 'tool-error', error: new Error('connection refused') },
    });

    await hooks.onStepEnd(
      makeStepFinishEvent({
        stepNumber: 0,
        toolCalls: [{ toolName: 'fetch', toolCallId: 'tc-err', input: { url: 'x' } }],
        toolErrors: [
          {
            toolCallId: 'tc-err',
            toolName: 'fetch',
            error: new Error('connection refused'),
          },
        ],
      }),
    );

    const toolSpan = findSpan(h.spans, (n) => n.startsWith('execute_tool'));
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.status.code).toBe(2 /* ERROR */);
  });

  it('does not double-record a tool handled by onToolExecutionEnd', async () => {
    const hooks = streamTextHooks(h.client);

    hooks.onStepStart?.(stepStartEvent({}));
    hooks.onToolExecutionStart?.({
      toolCall: { toolName: 'lookup', toolCallId: 'tc-dup', input: {} },
    });
    await hooks.onToolExecutionEnd?.({
      toolCall: { toolName: 'lookup', toolCallId: 'tc-dup', input: {} },
      toolExecutionMs: 10,
      toolOutput: { type: 'tool-result', output: 'found' },
    });
    await hooks.onStepEnd(
      makeStepFinishEvent({
        stepNumber: 0,
        toolCalls: [{ toolName: 'lookup', toolCallId: 'tc-dup', input: {} }],
        toolResults: [{ toolCallId: 'tc-dup', toolName: 'lookup', output: 'found' }],
      }),
    );

    const toolSpans = h.spans.getFinishedSpans().filter((s) => s.name.startsWith('execute_tool'));
    expect(toolSpans.length).toBe(1); // not 2
  });
});

describe('streamTextHooks — tool execution (fallback path via onStepEnd only)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits an execute_tool span from step.toolCalls when no experimental callbacks fire', async () => {
    const hooks = streamTextHooks(h.client);
    // No onStepStart, no onToolExecutionStart/End

    await hooks.onStepEnd(
      makeStepFinishEvent({
        stepNumber: 0,
        toolCalls: [{ toolName: 'calc', toolCallId: 'tc-fb', input: { expr: '1+1' } }],
        toolResults: [{ toolCallId: 'tc-fb', toolName: 'calc', output: 2 }],
      }),
    );

    const toolSpan = findSpan(h.spans, (n) => n.startsWith('execute_tool'));
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.attributes[ATTR_TOOL_NAME]).toBe('calc');
    expect(toolSpan?.status.code).not.toBe(2 /* ERROR */);
  });

  it('records tool errors from content tool-error parts in fallback path', async () => {
    const hooks = streamTextHooks(h.client);

    await hooks.onStepEnd(
      makeStepFinishEvent({
        toolCalls: [{ toolName: 'risky', toolCallId: 'tc-risky', input: {} }],
        toolErrors: [{ toolCallId: 'tc-risky', toolName: 'risky', error: 'boom' }],
      }),
    );

    const toolSpan = findSpan(h.spans, (n) => n.startsWith('execute_tool'));
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.status.code).toBe(2 /* ERROR */);
  });
});

// ---------------------------------------------------------------------------
// Tests: generateTextHooks
// ---------------------------------------------------------------------------

describe('generateTextHooks — basic generation', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a chat span via onStepEnd', async () => {
    const hooks = generateTextHooks(h.client, { agentName: 'gen-agent' });
    // generateTextHooks omits onChunk and onError — verified at the type level
    // by the GenerateTextHooks = Omit<StreamTextHooks, 'onChunk' | 'onError'> type.

    hooks.onStepStart?.(stepStartEvent({ provider: 'cohere', modelId: 'cmd-r' }));
    await hooks.onStepEnd(makeStepFinishEvent({ inputTokens: 7, outputTokens: 2 }));

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('cohere');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('cmd-r');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Tests: reasoning content capture
// ---------------------------------------------------------------------------

describe('streamTextHooks — reasoning content', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('captures reasoning parts as assistant thinking in output messages', async () => {
    const hooks = streamTextHooks(h.client);
    hooks.onStepStart?.(stepStartEvent({}));

    await hooks.onStepEnd({
      stepNumber: 0,
      model: stepModel(),
      content: [
        { type: 'reasoning', text: 'let me think' },
        { type: 'text', text: 'the answer is 4' },
      ],
      text: 'the answer is 4',
      toolCalls: [],
      toolResults: [],
      finishReason: 'stop',
      usage: v7Usage(10, 5),
      response: { id: 'resp-r', modelId: 'gpt-4o-served' },
    });

    const [span] = h.spans.getFinishedSpans();
    const raw = span?.attributes[ATTR_OUTPUT_MESSAGES] as string | undefined;
    expect(raw).toBeDefined();
    const messages = JSON.parse(raw as string) as Array<{
      role: string;
      parts: Array<{ type: string; content?: string }>;
    }>;
    const assistant = messages.find((m) => m.role === 'assistant');
    const reasoning = assistant?.parts.find((p) => p.type === 'reasoning');
    expect(reasoning?.content).toBe('let me think');
  });
});

// ---------------------------------------------------------------------------
// Tests: tool recorder lifecycle (no leak / no double-record)
// ---------------------------------------------------------------------------

describe('streamTextHooks — tool recorder lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('closes an open recorder exactly once when onToolExecutionEnd never fires', async () => {
    const hooks = streamTextHooks(h.client);
    hooks.onStepStart?.(stepStartEvent({}));
    // Tool starts but the matching onToolExecutionEnd never arrives.
    hooks.onToolExecutionStart?.({
      toolCall: { toolName: 'search', toolCallId: 'tc-open', input: { q: 'x' } },
    });

    await hooks.onStepEnd(
      makeStepFinishEvent({
        stepNumber: 0,
        toolCalls: [{ toolName: 'search', toolCallId: 'tc-open', input: { q: 'x' } }],
        toolResults: [{ toolCallId: 'tc-open', toolName: 'search', output: { ok: true } }],
      }),
    );

    const toolSpans = h.spans.getFinishedSpans().filter((s) => s.name.startsWith('execute_tool'));
    expect(toolSpans.length).toBe(1); // reused open recorder — neither leaked nor duplicated
    expect(toolSpans[0]?.attributes[ATTR_TOOL_NAME]).toBe('search');
    expect(toolSpans[0]?.status.code).not.toBe(2 /* ERROR */);
  });
});

// ---------------------------------------------------------------------------
// Tests: toAgentInputMessages (public ModelMessage[] -> Message[] mapper)
// ---------------------------------------------------------------------------

describe('toAgentInputMessages', () => {
  it('skips system messages and maps string content to a text part', () => {
    const out = toAgentInputMessages([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hello' },
    ] as never);

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
    expect(out[0]?.parts).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('maps array content parts (text / reasoning / tool-call / tool-result)', () => {
    const out = toAgentInputMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'reasoning', text: 'internal' },
          { type: 'tool-call', toolName: 'search', toolCallId: 'tc-1', input: { q: 'otel' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolName: 'search', toolCallId: 'tc-1', output: 'hit' }],
      },
    ] as never);

    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe('assistant');
    expect(out[0]?.parts.map((p) => p.kind)).toEqual(['text', 'thinking', 'tool_call']);
    expect(out[1]?.role).toBe('tool');
    expect(out[1]?.parts[0]?.kind).toBe('tool_result');
  });

  it('coerces unknown roles to user', () => {
    const out = toAgentInputMessages([{ role: 'developer', content: 'x' }] as never);
    expect(out[0]?.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Tests: caller-hook composition (mergeHooks + callerHooks 3rd arg)
// ---------------------------------------------------------------------------

describe('streamTextHooks — caller-hook composition', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('runs the SDK onStepEnd before the caller onStepEnd, and both fire', async () => {
    const order: string[] = [];
    const hooks = streamTextHooks(
      h.client,
      { agentName: 'compose' },
      {
        onStepEnd: async () => {
          order.push('caller');
        },
      },
    );

    hooks.onStepStart?.(stepStartEvent({ messages: [{ role: 'user', content: 'hi' }] }));
    await hooks.onStepEnd(makeStepFinishEvent({ text: 'ok', inputTokens: 3, outputTokens: 1 }));

    // SDK telemetry still emitted...
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(3);
    // ...and the caller callback ran after the SDK closed the span.
    expect(order).toEqual(['caller']);
  });

  it('composes onStepStart (both handlers invoked)', async () => {
    let callerStarts = 0;
    const hooks = streamTextHooks(
      h.client,
      {},
      {
        onStepStart: () => {
          callerStarts++;
        },
      },
    );

    hooks.onStepStart?.(stepStartEvent({}));
    await hooks.onStepEnd(makeStepFinishEvent({}));

    expect(callerStarts).toBe(1);
    expect(h.spans.getFinishedSpans().length).toBe(1);
  });

  it('leaves the bag unchanged when no caller hooks are supplied', async () => {
    const hooks = streamTextHooks(h.client, {});
    hooks.onStepStart?.(stepStartEvent({}));
    await hooks.onStepEnd(makeStepFinishEvent({ inputTokens: 5 }));
    expect(h.spans.getFinishedSpans().length).toBe(1);
  });

  it('mergeHooks passes through a caller-only callback (no SDK counterpart)', async () => {
    let errors = 0;
    const merged = mergeHooks(streamTextHooks(h.client, {}), {
      onError: () => {
        errors++;
      },
    });
    await merged.onError?.({ error: new Error('boom') });
    expect(errors).toBe(1);
  });

  it('runs the caller handler even when the telemetry handler throws', async () => {
    let callerRan = false;
    const merged = mergeHooks(
      {
        onStepEnd: () => {
          throw new Error('telemetry blew up');
        },
      } as never,
      {
        onStepEnd: () => {
          callerRan = true;
        },
      },
    );
    await expect(merged.onStepEnd(makeStepFinishEvent({}))).resolves.toBeUndefined();
    expect(callerRan).toBe(true);
  });
});
