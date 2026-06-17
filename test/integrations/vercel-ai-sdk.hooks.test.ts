import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateTextHooks, streamTextHooks } from '../../src/integrations/vercel-ai-sdk/index.js';
import {
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
// AI SDK v6 event shape builders
// ---------------------------------------------------------------------------

function stepModel(provider = 'openai', modelId = 'gpt-4o') {
  return { provider, modelId };
}

function v6Usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens };
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
    usage: v6Usage(opts.inputTokens ?? 10, opts.outputTokens ?? 5),
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

    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel('anthropic', 'claude-3-5'),
      messages: [{ role: 'user', content: 'hello' }],
    });

    await hooks.onStepFinish(
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

  it('records TTFT via onChunk text-delta', async () => {
    const hooks = streamTextHooks(h.client);

    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });

    hooks.onChunk?.({ chunk: { type: 'text-delta', text: 'hi' } });
    hooks.onChunk?.({ chunk: { type: 'text-delta', text: ' there' } }); // second chunk ignored

    await hooks.onStepFinish(makeStepFinishEvent({ text: 'hi there' }));

    const metrics = await h.collectMetrics();
    const ttftMetric = metrics
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'gen_ai.client.time_to_first_token');
    expect(ttftMetric).toBeDefined();
  });

  it('ignores non-text-delta chunks', async () => {
    const hooks = streamTextHooks(h.client);
    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });
    // Should not throw
    hooks.onChunk?.({ chunk: { type: 'response-metadata' } });
    await hooks.onStepFinish(makeStepFinishEvent({}));
    expect(h.spans.getFinishedSpans().length).toBe(1);
  });

  it('closes all open recorders with error status on onError', async () => {
    const hooks = streamTextHooks(h.client);
    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });

    await hooks.onError?.({ error: new Error('stream failed') });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.status.code).toBe(2 /* ERROR */);
  });

  it('uses synthetic step timing when experimental_onStepStart does not fire', async () => {
    const hooks = streamTextHooks(h.client);
    // Skip experimental_onStepStart — simulate ToolLoopAgent fallback path
    await hooks.onStepFinish(makeStepFinishEvent({ inputTokens: 8, outputTokens: 3 }));

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

    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });
    await hooks.onStepFinish(
      makeStepFinishEvent({ stepNumber: 0, inputTokens: 10, outputTokens: 3 }),
    );

    hooks.experimental_onStepStart?.({
      stepNumber: 1,
      model: stepModel(),
      messages: [],
    });
    await hooks.onStepFinish(
      makeStepFinishEvent({ stepNumber: 1, inputTokens: 20, outputTokens: 7 }),
    );

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(2);
    expect(spans[0]?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(10);
    expect(spans[1]?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
  });
});

describe('streamTextHooks — tool execution (full path with experimental callbacks)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a discrete execute_tool span on success', async () => {
    const hooks = streamTextHooks(h.client, { agentName: 'test-agent' });

    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });

    hooks.experimental_onToolCallStart?.({
      toolCall: {
        toolName: 'search',
        toolCallId: 'tc-1',
        input: { q: 'otel' },
      },
      stepNumber: 0,
      model: stepModel(),
    });

    await hooks.experimental_onToolCallFinish?.({
      toolCall: {
        toolName: 'search',
        toolCallId: 'tc-1',
        input: { q: 'otel' },
      },
      durationMs: 120,
      success: true,
      output: { results: ['a', 'b'] },
      stepNumber: 0,
    });

    await hooks.onStepFinish(
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

    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });

    hooks.experimental_onToolCallStart?.({
      toolCall: {
        toolName: 'fetch',
        toolCallId: 'tc-err',
        input: { url: 'x' },
      },
      stepNumber: 0,
    });

    await hooks.experimental_onToolCallFinish?.({
      toolCall: {
        toolName: 'fetch',
        toolCallId: 'tc-err',
        input: { url: 'x' },
      },
      durationMs: 50,
      success: false,
      error: new Error('connection refused'),
      stepNumber: 0,
    });

    await hooks.onStepFinish(
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

  it('does not double-record a tool handled by experimental_onToolCallFinish', async () => {
    const hooks = streamTextHooks(h.client);

    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });
    hooks.experimental_onToolCallStart?.({
      toolCall: { toolName: 'lookup', toolCallId: 'tc-dup', input: {} },
      stepNumber: 0,
    });
    await hooks.experimental_onToolCallFinish?.({
      toolCall: { toolName: 'lookup', toolCallId: 'tc-dup', input: {} },
      durationMs: 10,
      success: true,
      output: 'found',
      stepNumber: 0,
    });
    await hooks.onStepFinish(
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

describe('streamTextHooks — tool execution (fallback path via onStepFinish only)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits an execute_tool span from step.toolCalls when no experimental callbacks fire', async () => {
    const hooks = streamTextHooks(h.client);
    // No experimental_onStepStart, no experimental_onToolCallStart/Finish

    await hooks.onStepFinish(
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

    await hooks.onStepFinish(
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

  it('emits a chat span via onStepFinish', async () => {
    const hooks = generateTextHooks(h.client, { agentName: 'gen-agent' });
    // generateTextHooks omits onChunk and onError — verified at the type level
    // by the GenerateTextHooks = Omit<StreamTextHooks, 'onChunk' | 'onError'> type.

    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel('cohere', 'cmd-r'),
      messages: [],
    });
    await hooks.onStepFinish(makeStepFinishEvent({ inputTokens: 7, outputTokens: 2 }));

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
    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });

    await hooks.onStepFinish({
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
      usage: v6Usage(10, 5),
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

  it('closes an open recorder exactly once when onToolCallFinish never fires', async () => {
    const hooks = streamTextHooks(h.client);
    hooks.experimental_onStepStart?.({
      stepNumber: 0,
      model: stepModel(),
      messages: [],
    });
    // Tool starts but the matching experimental_onToolCallFinish never arrives.
    hooks.experimental_onToolCallStart?.({
      toolCall: { toolName: 'search', toolCallId: 'tc-open', input: { q: 'x' } },
      stepNumber: 0,
    });

    await hooks.onStepFinish(
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
