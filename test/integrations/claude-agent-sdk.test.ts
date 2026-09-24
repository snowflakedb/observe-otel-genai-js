/**
 * Tests for the Claude Agent SDK adapter.
 *
 * The SDK spawns the Claude Code CLI, so there is nothing to stub at the HTTP layer:
 * each test feeds a message list through a fake `query`. Hand-built lists cover one
 * rule at a time; the replay tests at the end use trimmed recordings of real CLI
 * streams, whose message order is what the hand-built ones have to match.
 */

import { readFileSync } from 'node:fs';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClientConfig } from '../../src/config.js';
import {
  type ClaudeAgentSdkOptions,
  wrapQuery,
  wrapStartup,
} from '../../src/integrations/claude-agent-sdk/index.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  AgentQueryParams,
  AgentUsage,
} from '../../src/integrations/claude-agent-sdk/types.js';
import { type Harness, createHarness } from '../_harness.js';

const MODEL = 'claude-sonnet-4-5';
const ROOT = 'invoke_agent claude-agent-sdk';
const CHAT = `chat ${MODEL}`;

// -----------------------------------------------------------------------------
// Fake stream and message builders
// -----------------------------------------------------------------------------

/** Yields `messages` in order, waiting `pauses.get(i)` ms before message `i`. */
function fakeQuery(messages: AgentMessage[], pauses = new Map<number, number>()) {
  return (_params: AgentQueryParams) =>
    (async function* () {
      for (const [i, msg] of messages.entries()) {
        const pause = pauses.get(i);
        if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
        yield msg;
      }
    })();
}

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of it) out.push(m);
  return out;
}

function init(sessionId = 'sess-1'): AgentMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: MODEL };
}

function assistant(
  id: string,
  content: Record<string, unknown>[],
  extra: { parent?: string; usage?: AgentUsage; stopReason?: string } = {},
): AgentMessage {
  return {
    type: 'assistant',
    message: {
      id,
      model: MODEL,
      role: 'assistant',
      content,
      stop_reason: extra.stopReason ?? null,
      usage: extra.usage,
    },
    parent_tool_use_id: extra.parent ?? null,
  };
}

const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const delegate = (id: string, subagentType: string, prompt = 'look at x') =>
  toolUse(id, 'Agent', { subagent_type: subagentType, description: 'review x', prompt });

function toolResult(
  toolUseId: string,
  content: string,
  extra: { parent?: string; isError?: boolean } = {},
): AgentMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: extra.isError }],
    },
    parent_tool_use_id: extra.parent ?? null,
  };
}

function userText(t: string, parent?: string): AgentMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [text(t)] },
    parent_tool_use_id: parent ?? null,
  };
}

function taskStarted(toolUseId: string, taskType = 'local_agent'): AgentMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: `task_${toolUseId}`,
    tool_use_id: toolUseId,
    task_type: taskType,
  };
}

function taskNotification(
  toolUseId: string,
  summary: string,
  status: AgentMessage['status'] = 'completed',
): AgentMessage {
  return { type: 'system', subtype: 'task_notification', tool_use_id: toolUseId, status, summary };
}

function messageStart(id: string, ttftMs: number, usage?: AgentUsage): AgentMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    ttft_ms: ttftMs,
    event: { type: 'message_start', message: { id, model: MODEL, usage } },
  };
}

function messageDelta(usage: AgentUsage, stopReason = 'end_turn'): AgentMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_delta', delta: { stop_reason: stopReason }, usage },
  };
}

function result(extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    modelUsage: {
      [MODEL]: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
      },
    },
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// Span helpers
// -----------------------------------------------------------------------------

type FinishedSpan = ReturnType<Harness['spans']['getFinishedSpans']>[number];

function allSpans(h: Harness, name: string): FinishedSpan[] {
  return h.spans.getFinishedSpans().filter((s) => s.name === name);
}

function findSpan(h: Harness, name: string): FinishedSpan {
  const found = allSpans(h, name)[0];
  if (!found) {
    const names = h.spans.getFinishedSpans().map((s) => s.name);
    throw new Error(`no span named ${name}; got ${names.join(', ')}`);
  }
  return found;
}

function parentOf(h: Harness, child: FinishedSpan): FinishedSpan | undefined {
  const id = child.parentSpanContext?.spanId;
  return h.spans.getFinishedSpans().find((s) => s.spanContext().spanId === id);
}

function childrenOf(h: Harness, parent: FinishedSpan, name: string): FinishedSpan[] {
  return allSpans(h, name).filter((s) => parentOf(h, s) === parent);
}

/** Span names in the order they ended. */
function endOrder(h: Harness): string[] {
  return h.spans.getFinishedSpans().map((s) => s.name);
}

function attr(span: FinishedSpan, key: string): unknown {
  return span.attributes[key];
}

function msOf([seconds, nanos]: [number, number]): number {
  return seconds * 1000 + nanos / 1e6;
}

function run(
  h: Harness,
  messages: AgentMessage[],
  config: ClaudeAgentSdkOptions = {},
  options: AgentQueryOptions = {},
) {
  const traced = wrapQuery(h.client, fakeQuery(messages), config);
  return drain(traced({ prompt: 'do the thing', options: { model: MODEL, ...options } }));
}

const streamed = { includePartialMessages: true };

function useHarness(config?: ClientConfig): () => Harness {
  let h: Harness;
  beforeEach(() => {
    h = createHarness(config);
  });
  afterEach(async () => {
    await h.shutdown();
  });
  return () => h;
}

// -----------------------------------------------------------------------------

describe('Claude Agent SDK adapter: model calls', () => {
  const harness = useHarness();

  it('emits one invoke_agent and one chat for a plain answer', async () => {
    const h = harness();
    await run(h, [init(), assistant('msg_1', [text('hello')]), result()]);

    const root = findSpan(h, ROOT);
    expect(allSpans(h, ROOT)).toHaveLength(1);
    expect(childrenOf(h, root, CHAT)).toHaveLength(1);
    expect(attr(findSpan(h, CHAT), 'gen_ai.response.id')).toBe('msg_1');
  });

  it('merges the content blocks of one call into one chat span', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'thinking', thinking: 'hmm' }]),
      assistant('msg_1', [text('the answer')]),
      result(),
    ]);

    expect(allSpans(h, CHAT)).toHaveLength(1);
    const output = String(attr(findSpan(h, CHAT), 'gen_ai.output.messages'));
    expect(output).toContain('hmm');
    expect(output).toContain('the answer');
  });

  it('starts a new chat span when message.id changes', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('first')]),
      assistant('msg_2', [text('second')]),
      result(),
    ]);

    const [first, second] = allSpans(h, CHAT);
    expect(allSpans(h, CHAT)).toHaveLength(2);
    expect(attr(first!, 'gen_ai.response.id')).toBe('msg_1');
    expect(attr(second!, 'gen_ai.response.id')).toBe('msg_2');
  });

  it('keeps one chat span when a tool result arrives between blocks of a call', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_a', 'Read')]),
      toolResult('tu_a', 'a'),
      assistant('msg_1', [toolUse('tu_b', 'Read')]),
      toolResult('tu_b', 'b'),
      assistant('msg_2', [text('done')]),
      result(),
    ]);

    const [first, second] = allSpans(h, CHAT);
    expect(allSpans(h, CHAT)).toHaveLength(2);
    const output = String(attr(first!, 'gen_ai.output.messages'));
    expect(output).toContain('tu_a');
    expect(output).toContain('tu_b');
    // The next call sees both tool calls in one assistant message, then both results.
    const input = JSON.parse(String(attr(second!, 'gen_ai.input.messages'))) as { role: string }[];
    expect(input.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
  });

  it('replays the conversation so far as each chat input, across results', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('first answer')]),
      result(),
      userText('a follow-up'),
      assistant('msg_2', [text('second answer')]),
      result(),
    ]);

    const input = String(attr(allSpans(h, CHAT)[1]!, 'gen_ai.input.messages'));
    expect(input).toContain('do the thing');
    expect(input).toContain('first answer');
    expect(input).toContain('a follow-up');
  });

  it('replays at most the 40 latest messages as a chat input', async () => {
    const h = harness();
    const loop = Array.from({ length: 30 }, (_, i) => [
      assistant(`msg_${i}`, [toolUse(`tu_${i}`, 'Read')]),
      toolResult(`tu_${i}`, `result ${i}`),
    ]).flat();
    await run(h, [init(), ...loop, assistant('msg_last', [text('done')]), result()]);

    const last = allSpans(h, CHAT).at(-1)!;
    const input = JSON.parse(String(attr(last, 'gen_ai.input.messages'))) as unknown[];
    expect(input).toHaveLength(40);
    expect(JSON.stringify(input)).not.toContain('do the thing');
    expect(JSON.stringify(input.at(-1))).toContain('tu_29');
  });

  it('flags snapshot usage as partial and puts the run totals on invoke_agent', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('hi')], {
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
        stopReason: 'end_turn',
      }),
      result(),
    ]);

    const chat = findSpan(h, CHAT);
    expect(attr(chat, 'genai.usage.is_partial')).toBe(true);
    expect(attr(chat, 'gen_ai.usage.input_tokens')).toBe(9); // cache reads count as input
    expect(attr(chat, 'gen_ai.response.finish_reasons')).toEqual(['end_turn']);

    const root = findSpan(h, ROOT);
    expect(attr(root, 'gen_ai.usage.input_tokens')).toBe(130); // 100 + 20 read + 10 write
    expect(attr(root, 'gen_ai.usage.output_tokens')).toBe(50);
    expect(attr(root, 'gen_ai.usage.cache_write.input_tokens')).toBe(10);
    expect(attr(root, 'gen_ai.usage.cache_creation.input_tokens')).toBe(10);
    expect(attr(root, 'genai.usage.cost_usd')).toBeCloseTo(0.0123);
  });

  it('keeps one invoke_agent span per query, with the latest result totals', async () => {
    const h = harness();
    const totals = (input: number, cost: number) => ({
      modelUsage: { [MODEL]: { inputTokens: input, outputTokens: 1 } },
      total_cost_usd: cost,
    });
    await run(h, [
      init(),
      assistant('msg_1', [text('one')]),
      result({ ...totals(100, 0.01), result: 'one' }),
      assistant('msg_2', [text('two')]),
      result({ ...totals(250, 0.03), result: 'two' }),
    ]);

    const root = findSpan(h, ROOT);
    expect(allSpans(h, ROOT)).toHaveLength(1);
    expect(attr(root, 'gen_ai.usage.input_tokens')).toBe(250);
    expect(attr(root, 'genai.usage.cost_usd')).toBe(0.03);
    expect(String(attr(root, 'gen_ai.output.messages'))).toContain('two');
    expect(childrenOf(h, root, CHAT)).toHaveLength(2);
  });

  it('only gives the main thread the caller system prompt, effort and thinking settings', async () => {
    const h = harness();
    await run(
      h,
      [
        init(),
        assistant('msg_1', [delegate('task_1', 'helper')]),
        assistant('msg_s1', [text('sub')], { parent: 'task_1' }),
        taskNotification('task_1', 'ok'),
        result(),
      ],
      {},
      { systemPrompt: 'be brief', effort: 'high', thinking: { type: 'enabled', budgetTokens: 99 } },
    );

    const mainChat = childrenOf(h, findSpan(h, ROOT), CHAT)[0];
    const subChat = childrenOf(h, findSpan(h, 'invoke_agent helper'), CHAT)[0];
    expect(String(attr(mainChat!, 'gen_ai.system_instructions'))).toContain('be brief');
    expect(attr(mainChat!, 'gen_ai.request.reasoning.level')).toBe('high');
    expect(attr(mainChat!, 'gen_ai.request.thinking.enabled')).toBe(true);
    expect(attr(mainChat!, 'gen_ai.request.thinking.budget_tokens')).toBe(99);
    expect(attr(subChat!, 'gen_ai.request.thinking.enabled')).toBeUndefined();
    expect(attr(subChat!, 'gen_ai.system_instructions')).toBeUndefined();
    expect(attr(subChat!, 'gen_ai.request.reasoning.level')).toBeUndefined();
    expect(attr(subChat!, 'gen_ai.agent.name')).toBe('helper');
    expect(attr(findSpan(h, ROOT), 'gen_ai.request.reasoning.level')).toBe('high');
  });

  it('records a custom system prompt, but not a preset', async () => {
    const h = harness();
    const custom = { type: 'custom', prompt: 'you are a release bot' };
    await run(
      h,
      [init(), assistant('msg_1', [text('hi')]), result()],
      {},
      { systemPrompt: custom },
    );
    expect(String(attr(findSpan(h, CHAT), 'gen_ai.system_instructions'))).toContain('release bot');

    h.spans.reset();
    const preset = { type: 'preset', preset: 'claude_code', append: 'be terse' };
    await run(
      h,
      [init(), assistant('msg_1', [text('hi')]), result()],
      {},
      { systemPrompt: preset },
    );
    expect(attr(findSpan(h, CHAT), 'gen_ai.system_instructions')).toBeUndefined();
  });

  it('leaves out the snapshot output count and infers a tool_use finish', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Read')], {
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
      toolResult('tu_1', 'body'),
      result(),
    ]);

    const chat = findSpan(h, CHAT);
    expect(attr(chat, 'gen_ai.usage.input_tokens')).toBe(7);
    expect(attr(chat, 'gen_ai.usage.output_tokens')).toBeUndefined();
    expect(attr(chat, 'gen_ai.response.finish_reasons')).toEqual(['tool_use']);
  });

  it('dates a call from when the thread handed control back to its last block', async () => {
    const h = harness();
    const messages: AgentMessage[] = [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Bash')]),
      toolResult('tu_1', 'out'),
      assistant('msg_2', [text('done')]),
      result(),
    ];
    const pauses = new Map([
      [2, 30],
      [3, 30],
    ]);
    await drain(wrapQuery(h.client, fakeQuery(messages, pauses))({ prompt: 'p' }));

    const [first, second] = allSpans(h, CHAT);
    const tool = findSpan(h, 'execute_tool Bash');
    // The first call ends at its block, not when the tool result arrives 30ms later.
    expect(msOf(first!.endTime)).toBeLessThan(msOf(tool.endTime) - 20);
    // The second starts when the tool result went back, not when the first call ended.
    expect(msOf(second!.startTime)).toBeGreaterThanOrEqual(msOf(tool.endTime));
    expect(msOf(second!.startTime)).toBeLessThan(msOf(second!.endTime) - 20);
  });

  it('records a failed API call on a span named for the session model', async () => {
    // The CLI makes up an assistant message for the failure, with model <synthetic>.
    const h = harness();
    await run(h, [
      init(),
      {
        type: 'assistant',
        message: { id: 'uuid-1', model: '<synthetic>', content: [text('API Error: 404 model')] },
        parent_tool_use_id: null,
      },
      result({ is_error: true, result: 'API Error: 404 model', api_error_status: 404 }),
    ]);

    const chat = findSpan(h, CHAT);
    expect(chat.status.code).toBe(SpanStatusCode.ERROR);
    expect(chat.status.message).toBe('API Error: 404 model (HTTP 404)');
    expect(attr(chat, 'gen_ai.response.id')).toBeUndefined();
    expect(attr(chat, 'gen_ai.output.messages')).toBeUndefined();
  });

  it('fails a subagent call that the API rejected', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      assistant('msg_s1', [text('first')], { parent: 'task_1' }),
      {
        type: 'assistant',
        message: {
          id: 'uuid-2',
          model: '<synthetic>',
          content: [text('API Error: 400 bad model')],
        },
        parent_tool_use_id: 'task_1',
      },
      taskNotification('task_1', 'failed', 'failed'),
      result(),
    ]);

    const [, failed] = childrenOf(h, findSpan(h, 'invoke_agent worker'), CHAT);
    expect(failed!.status.message).toBe('API Error: 400 bad model');
  });

  it('marks an aborted call as failed', async () => {
    const h = harness();
    await run(h, [init(), { ...assistant('msg_1', [text('par')]), aborted: true }, result()]);
    expect(findSpan(h, CHAT).status.message).toBe('assistant message aborted');
  });

  it('sums the run totals across models', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('hi')]),
      result({
        modelUsage: {
          [MODEL]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1 },
          'claude-haiku-4-5': { inputTokens: 20, outputTokens: 7, cacheCreationInputTokens: 2 },
        },
      }),
    ]);

    const root = findSpan(h, ROOT);
    expect(attr(root, 'gen_ai.usage.input_tokens')).toBe(33);
    expect(attr(root, 'gen_ai.usage.output_tokens')).toBe(12);
    expect(attr(root, 'gen_ai.usage.cache_read.input_tokens')).toBe(1);
    expect(attr(root, 'gen_ai.usage.cache_write.input_tokens')).toBe(2);
  });

  it('reports the run thinking tokens from modelUsage', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('hi')]),
      result({
        modelUsage: {
          [MODEL]: { inputTokens: 10, outputTokens: 40, thinkingTokens: 25 },
          'claude-haiku-4-5': { inputTokens: 5, outputTokens: 8, thinkingTokens: 3 },
        },
      }),
    ]);

    expect(attr(findSpan(h, ROOT), 'gen_ai.usage.reasoning.output_tokens')).toBe(28);
  });

  it('keeps the usage from before a /clear in the run totals', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('first')]),
      result(),
      { type: 'conversation_reset', new_conversation_id: 'conv-2' },
      assistant('msg_2', [text('second')]),
      result({
        modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 2 } },
        total_cost_usd: 0.001,
      }),
    ]);

    const root = findSpan(h, ROOT);
    expect(attr(root, 'gen_ai.usage.output_tokens')).toBe(52);
    expect(attr(root, 'genai.usage.cost_usd')).toBeCloseTo(0.0133);
  });

  it('keeps the earlier totals when a later result reports zeroes', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('hi')]),
      result(),
      result({ modelUsage: {}, total_cost_usd: 0 }),
    ]);

    expect(attr(findSpan(h, ROOT), 'gen_ai.usage.output_tokens')).toBe(50);
  });

  it('reports no run totals for a resumed session', async () => {
    const h = harness();
    await run(h, [init(), assistant('msg_1', [text('hi')]), result()], {}, { resume: 'sess-0' });

    const root = findSpan(h, ROOT);
    expect(attr(root, 'gen_ai.usage.input_tokens')).toBeUndefined();
    expect(attr(root, 'genai.usage.cost_usd')).toBeUndefined();
  });

  it('applies the run options to each span type that has a field for them', async () => {
    const h = harness();
    await run(
      h,
      [
        init(),
        assistant('msg_1', [toolUse('tu_1', 'Read'), delegate('task_1', 'helper')]),
        assistant('msg_s1', [text('sub')], { parent: 'task_1' }),
        toolResult('tu_1', 'body'),
        toolResult('task_1', 'report'),
        result(),
      ],
      {
        userId: 'user-7',
        agentVersion: '2.0',
        conversationTitle: 'Billing question',
        parentGenerationIds: ['gen-parent'],
      },
    );

    const root = findSpan(h, ROOT);
    const mainChat = childrenOf(h, root, CHAT)[0]!;
    const tool = findSpan(h, 'execute_tool Read');
    expect(attr(root, 'user.id')).toBe('user-7');
    expect(attr(root, 'genai.parent_generation_ids')).toEqual(['gen-parent']);
    expect(attr(mainChat, 'user.id')).toBe('user-7');
    expect(attr(mainChat, 'genai.conversation.title')).toBe('Billing question');
    expect(attr(mainChat, 'gen_ai.agent.version')).toBe('2.0');
    expect(attr(findSpan(h, 'invoke_agent helper'), 'user.id')).toBe('user-7');
    expect(attr(tool, 'gen_ai.conversation.id')).toBe('sess-1');
    expect(attr(tool, 'gen_ai.agent.version')).toBe('2.0');
  });

  it('prefers the caller conversation id over the session id', async () => {
    const h = harness();
    await run(h, [init(), assistant('msg_1', [text('hi')]), result()], {
      conversationId: 'conv-9',
    });

    expect(attr(findSpan(h, ROOT), 'gen_ai.conversation.id')).toBe('conv-9');
    expect(attr(findSpan(h, CHAT), 'gen_ai.conversation.id')).toBe('conv-9');
  });
});

describe('Claude Agent SDK adapter: stream events', () => {
  const harness = useHarness();

  it('takes final usage, stop reason and reasoning tokens from message_delta', async () => {
    const h = harness();
    await run(
      h,
      [
        init(),
        messageStart('msg_1', 500, {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 40,
        }),
        assistant('msg_1', [text('hi')], { usage: { input_tokens: 10, output_tokens: 3 } }),
        // Only output figures: the rest comes from the snapshot.
        messageDelta(
          { output_tokens: 155, output_tokens_details: { thinking_tokens: 71 } },
          'tool_use',
        ),
        result(),
      ],
      {},
      streamed,
    );

    const chat = findSpan(h, CHAT);
    expect(attr(chat, 'gen_ai.usage.output_tokens')).toBe(155);
    expect(attr(chat, 'gen_ai.usage.input_tokens')).toBe(50);
    expect(attr(chat, 'gen_ai.usage.reasoning.output_tokens')).toBe(71);
    expect(attr(chat, 'gen_ai.response.finish_reasons')).toEqual(['tool_use']);
    expect(attr(chat, 'genai.usage.is_partial')).toBeUndefined();
  });

  it('keeps the call open for a message_delta that arrives after the tool result', async () => {
    // The CLI's real order for a delegation: the launch receipt comes back before the
    // call's own message_delta.
    const h = harness();
    await run(
      h,
      [
        init(),
        messageStart('msg_1', 100),
        assistant('msg_1', [delegate('task_1', 'worker')]),
        taskStarted('task_1'),
        toolResult('task_1', 'Async agent launched successfully.'),
        messageDelta({ input_tokens: 5, output_tokens: 255 }),
        messageStart('msg_2', 100),
        assistant('msg_2', [text('waiting')]),
        messageDelta({ input_tokens: 5, output_tokens: 20 }),
        result(),
        taskNotification('task_1', 'report'),
      ],
      {},
      streamed,
    );

    const [first, second] = allSpans(h, CHAT);
    expect(attr(first!, 'gen_ai.usage.output_tokens')).toBe(255);
    expect(attr(first!, 'genai.usage.is_partial')).toBeUndefined();
    expect(attr(second!, 'gen_ai.usage.output_tokens')).toBe(20);
  });

  it('closes a subagent call on its tool result, since subagents get no stream events', async () => {
    const h = harness();
    await run(
      h,
      [
        init(),
        messageStart('msg_1', 100),
        assistant('msg_1', [delegate('task_1', 'worker')]),
        messageDelta({ input_tokens: 5, output_tokens: 40 }),
        assistant('msg_s1', [toolUse('tu_9', 'Bash')], { parent: 'task_1' }),
        toolResult('tu_9', 'ok', { parent: 'task_1' }),
        assistant('msg_s2', [text('report')], { parent: 'task_1' }),
        toolResult('task_1', 'report'),
        result(),
      ],
      {},
      streamed,
    );

    const subChats = childrenOf(h, findSpan(h, 'invoke_agent worker'), CHAT);
    expect(subChats).toHaveLength(2);
    for (const chat of subChats) expect(attr(chat, 'genai.usage.is_partial')).toBe(true);
  });

  it('records time to first token and starts the span when the request did', async () => {
    const h = harness();
    const before = Date.now();
    await run(
      h,
      [init(), messageStart('msg_1', 640), assistant('msg_1', [text('hi')]), result()],
      {},
      streamed,
    );

    const chat = findSpan(h, CHAT);
    expect(attr(chat, 'gen_ai.response.time_to_first_chunk')).toBe(0.64);
    expect(msOf(chat.startTime)).toBeLessThanOrEqual(before - 600);
  });
});

describe('Claude Agent SDK adapter: tools', () => {
  const harness = useHarness({ contentCaptureMode: 'full' });

  it('closes a tool span on its tool_result, with the result', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Bash', { command: 'ls' })]),
      toolResult('tu_1', 'a\nb'),
      result(),
    ]);

    const tool = findSpan(h, 'execute_tool Bash');
    expect(attr(tool, 'gen_ai.tool.call.id')).toBe('tu_1');
    expect(attr(tool, 'gen_ai.tool.type')).toBe('function');
    expect(String(attr(tool, 'gen_ai.tool.call.result'))).toContain('a\\nb');
    expect(parentOf(h, tool)?.name).toBe(ROOT);
  });

  it('records a failed tool call', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Bash')]),
      toolResult('tu_1', 'exit 1', { isError: true }),
      result(),
    ]);

    const tool = findSpan(h, 'execute_tool Bash');
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(attr(tool, 'error.type')).toBe('tool_execution_error');
  });

  it('marks MCP tools as extensions', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'mcp__weather__get')]),
      toolResult('tu_1', 'sunny'),
      result(),
    ]);

    expect(attr(findSpan(h, 'execute_tool mcp__weather__get'), 'gen_ai.tool.type')).toBe(
      'extension',
    );
  });

  it('closes a background command on its notification, not its launch receipt', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [
        toolUse('tu_1', 'Bash', { command: 'sleep 8', run_in_background: true }),
      ]),
      taskStarted('tu_1', 'local_bash'),
      toolResult('tu_1', 'Command running in background with ID: b1'),
      assistant('msg_2', [text('waiting')]),
      result(),
      taskNotification('tu_1', 'finished'),
    ]);

    const tool = findSpan(h, 'execute_tool Bash');
    expect(String(attr(tool, 'gen_ai.tool.call.result'))).toContain('finished');
    const order = endOrder(h);
    expect(order.indexOf(CHAT)).toBeLessThan(order.indexOf('execute_tool Bash'));
  });

  it('closes a background command still running at the end without an error', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Bash', { run_in_background: true })]),
      taskStarted('tu_1', 'local_bash'),
      toolResult('tu_1', 'Command running in background with ID: b1'),
      result(),
    ]);

    const tool = findSpan(h, 'execute_tool Bash');
    expect(tool.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(String(attr(tool, 'gen_ai.tool.call.result'))).toContain('running in background');
  });

  it('matches a notification that names only its task id', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Bash', { run_in_background: true })]),
      taskStarted('tu_1', 'local_bash'),
      toolResult('tu_1', 'Command running in background with ID: b1'),
      assistant('msg_2', [text('waiting')]),
      result(),
      { ...taskNotification('tu_1', 'finished'), tool_use_id: undefined, task_id: 'task_tu_1' },
    ]);

    expect(String(attr(findSpan(h, 'execute_tool Bash'), 'gen_ai.tool.call.result'))).toContain(
      'finished',
    );
  });

  it('closes a background task on its terminal update when no notification follows', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Bash', { run_in_background: true })]),
      taskStarted('tu_1', 'local_bash'),
      toolResult('tu_1', 'Command running in background with ID: b1'),
      assistant('msg_2', [text('waiting')]),
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task_tu_1',
        patch: { status: 'failed' },
      },
      assistant('msg_3', [text('it failed')]),
      result(),
    ]);

    const bash = findSpan(h, 'execute_tool Bash');
    expect(bash.status.code).toBe(SpanStatusCode.ERROR);
    const order = endOrder(h);
    expect(order.indexOf('execute_tool Bash')).toBeLessThan(order.lastIndexOf(CHAT));
  });

  it('prefers the notification that follows a terminal update', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Bash', { run_in_background: true })]),
      taskStarted('tu_1', 'local_bash'),
      toolResult('tu_1', 'Command running in background with ID: b1'),
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task_tu_1',
        patch: { status: 'completed' },
      },
      taskNotification('tu_1', 'finished'),
      result(),
    ]);

    expect(String(attr(findSpan(h, 'execute_tool Bash'), 'gen_ai.tool.call.result'))).toContain(
      'finished',
    );
  });

  it('does not treat a stopped task as a failure', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [toolUse('tu_1', 'Bash', { run_in_background: true })]),
      taskStarted('tu_1', 'local_bash'),
      taskNotification('tu_1', 'stopped by user', 'stopped'),
      result(),
    ]);

    expect(findSpan(h, 'execute_tool Bash').status.code).not.toBe(SpanStatusCode.ERROR);
  });
});

describe('Claude Agent SDK adapter: subagents', () => {
  const harness = useHarness({ contentCaptureMode: 'full' });

  it('nests a background subagent under its delegation until the notification', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      taskStarted('task_1'),
      toolResult('task_1', 'Async agent launched successfully.'),
      assistant('msg_s1', [toolUse('tu_9', 'Bash')], { parent: 'task_1' }),
      toolResult('tu_9', 'from-subagent', { parent: 'task_1' }),
      assistant('msg_s2', [text('report')], { parent: 'task_1' }),
      taskNotification('task_1', 'the real report'),
      result(),
    ]);

    const delegation = findSpan(h, 'execute_tool Agent');
    const sub = findSpan(h, 'invoke_agent worker');
    expect(parentOf(h, sub)).toBe(delegation);
    expect(parentOf(h, findSpan(h, 'execute_tool Bash'))).toBe(sub);
    expect(childrenOf(h, sub, CHAT)).toHaveLength(2);
    expect(String(attr(delegation, 'gen_ai.tool.call.result'))).toContain('the real report');
    expect(String(attr(sub, 'gen_ai.output.messages'))).toContain('the real report');
    expect(String(attr(sub, 'gen_ai.input.messages'))).toContain('look at x');
    const order = endOrder(h);
    expect(order.indexOf('invoke_agent worker')).toBeLessThan(order.indexOf('execute_tool Agent'));
  });

  it('keeps a delegation open when its receipt arrives before task_started', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      toolResult('task_1', 'Async agent launched successfully.'),
      taskStarted('task_1'),
      assistant('msg_s1', [text('report')], { parent: 'task_1' }),
      taskNotification('task_1', 'the real report'),
      result(),
    ]);

    const sub = findSpan(h, 'invoke_agent worker');
    expect(parentOf(h, sub)).toBe(findSpan(h, 'execute_tool Agent'));
    expect(childrenOf(h, sub, CHAT)).toHaveLength(1);
  });

  it('closes an inline delegation on the tool_result that follows its notification', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker', 'check it')]),
      taskStarted('task_1'),
      userText('check it', 'task_1'),
      assistant('msg_s1', [text('working')], { parent: 'task_1' }),
      taskNotification('task_1', 'short summary'),
      toolResult('task_1', 'the full report'),
      result(),
    ]);

    const delegation = findSpan(h, 'execute_tool Agent');
    expect(allSpans(h, 'execute_tool Agent')).toHaveLength(1);
    expect(String(attr(delegation, 'gen_ai.tool.call.result'))).toContain('the full report');
    const subChat = childrenOf(h, findSpan(h, 'invoke_agent worker'), CHAT)[0]!;
    // The echoed prompt is not added a second time.
    const input = String(attr(subChat, 'gen_ai.input.messages'));
    expect(input.split('check it')).toHaveLength(2);
  });

  it("takes a subagent's last call usage from its delegation's tool result", async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      taskStarted('task_1'),
      assistant('msg_s1', [text('report')], {
        parent: 'task_1',
        usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 100 },
      }),
      taskNotification('task_1', 'report'),
      {
        ...toolResult('task_1', 'report'),
        tool_use_result: {
          status: 'completed',
          usage: { input_tokens: 12, output_tokens: 521, cache_read_input_tokens: 100 },
        },
      },
      result(),
    ]);

    const subChat = childrenOf(h, findSpan(h, 'invoke_agent worker'), CHAT)[0]!;
    expect(attr(subChat, 'gen_ai.usage.output_tokens')).toBe(521);
    expect(attr(subChat, 'genai.usage.is_partial')).toBeUndefined();
  });

  it('keeps a failed foreground task failed when its tool_result never comes', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      taskStarted('task_1'),
      taskNotification('task_1', 'gave up', 'failed'),
      result(),
    ]);

    expect(findSpan(h, 'execute_tool Agent').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('marks a failed delegation, and its subagent, as errors', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      taskStarted('task_1'),
      assistant('msg_s1', [text('trying')], { parent: 'task_1' }),
      taskNotification('task_1', 'gave up', 'failed'),
      toolResult('task_1', 'gave up'),
      result(),
    ]);

    expect(findSpan(h, 'execute_tool Agent').status.code).toBe(SpanStatusCode.ERROR);
    expect(findSpan(h, 'invoke_agent worker').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('keeps two parallel subagents apart when they finish out of order', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_a', 'alpha'), delegate('task_b', 'beta')]),
      assistant('msg_b1', [text('from beta')], { parent: 'task_b' }),
      assistant('msg_a1', [text('from alpha')], { parent: 'task_a' }),
      toolResult('task_b', 'beta done'),
      toolResult('task_a', 'alpha done'),
      result(),
    ]);

    const alpha = findSpan(h, 'invoke_agent alpha');
    expect(attr(parentOf(h, alpha)!, 'gen_ai.tool.call.id')).toBe('task_a');
    expect(attr(parentOf(h, findSpan(h, 'invoke_agent beta'))!, 'gen_ai.tool.call.id')).toBe(
      'task_b',
    );
    const alphaChat = childrenOf(h, alpha, CHAT)[0]!;
    expect(String(attr(alphaChat, 'gen_ai.output.messages'))).toContain('from alpha');
    expect(String(attr(alphaChat, 'gen_ai.output.messages'))).not.toContain('from beta');
  });

  it('leaves a running subagent alone when the main thread emits a result', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      taskStarted('task_1'),
      toolResult('task_1', 'Async agent launched successfully.'),
      assistant('msg_s1', [text('part one')], { parent: 'task_1' }),
      result(),
      // Same id: the subagent's call is still delivering its blocks across the result.
      assistant('msg_s1', [toolUse('tu_9', 'Bash')], { parent: 'task_1' }),
      toolResult('tu_9', 'ok', { parent: 'task_1' }),
      taskNotification('task_1', 'report'),
      result(),
    ]);

    const subChats = childrenOf(h, findSpan(h, 'invoke_agent worker'), CHAT);
    expect(subChats).toHaveLength(1);
    expect(String(attr(subChats[0]!, 'gen_ai.output.messages'))).toContain('part one');
  });

  it('dates a subagent from the start of its delegation', async () => {
    const h = harness();
    const messages: AgentMessage[] = [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      taskStarted('task_1'),
      toolResult('task_1', 'Async agent launched successfully.'),
      assistant('msg_s1', [text('late start')], { parent: 'task_1' }),
      taskNotification('task_1', 'report'),
      result(),
    ];
    await drain(wrapQuery(h.client, fakeQuery(messages, new Map([[4, 30]])))({ prompt: 'p' }));

    const delegation = findSpan(h, 'execute_tool Agent');
    const sub = findSpan(h, 'invoke_agent worker');
    expect(msOf(sub.startTime)).toBe(msOf(delegation.startTime));
  });

  it('closes the tools of a subagent that is stopped mid-call', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      taskStarted('task_1'),
      assistant('msg_s1', [toolUse('tu_9', 'Bash')], { parent: 'task_1' }),
      taskNotification('task_1', 'stopped', 'stopped'),
      toolResult('task_1', 'stopped'),
      result(),
    ]);

    expect(endOrder(h)).toEqual([
      'execute_tool Bash',
      CHAT,
      'invoke_agent worker',
      'execute_tool Agent',
      CHAT,
      ROOT,
    ]);
  });

  it('nests a subagent that delegates again', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'outer')]),
      assistant('msg_s1', [delegate('task_2', 'inner')], { parent: 'task_1' }),
      assistant('msg_t1', [text('deep')], { parent: 'task_2' }),
      toolResult('task_2', 'inner done', { parent: 'task_1' }),
      toolResult('task_1', 'outer done'),
      result(),
    ]);

    const outer = findSpan(h, 'invoke_agent outer');
    const inner = findSpan(h, 'invoke_agent inner');
    expect(parentOf(h, parentOf(h, inner)!)).toBe(outer);
    expect(childrenOf(h, inner, CHAT)).toHaveLength(1);
  });

  it('ignores messages for a delegation that is not open', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [delegate('task_1', 'worker')]),
      assistant('msg_s1', [text('work')], { parent: 'task_1' }),
      taskNotification('task_1', 'done'),
      toolResult('task_1', 'done'),
      assistant('msg_s2', [text('late')], { parent: 'task_1' }),
      assistant('msg_x', [text('orphan')], { parent: 'task_unknown' }),
      result(),
    ]);

    expect(allSpans(h, 'invoke_agent worker')).toHaveLength(1);
    expect(
      h.spans.getFinishedSpans().filter((s) => s.name.startsWith('invoke_agent')),
    ).toHaveLength(2);
    expect(allSpans(h, CHAT)).toHaveLength(2);
  });
});

describe('Claude Agent SDK adapter: content capture', () => {
  const messages = [
    init(),
    assistant('msg_1', [delegate('task_1', 'worker', 'secret prompt')]),
    assistant('msg_s1', [toolUse('tu_9', 'Bash', { command: 'cat secret' })], { parent: 'task_1' }),
    toolResult('tu_9', 'secret file', { parent: 'task_1' }),
    assistant('msg_s2', [text('summary')], { parent: 'task_1' }),
    toolResult('task_1', 'secret report'),
    result(),
  ];

  describe('default mode (no tool content)', () => {
    const harness = useHarness();

    it('leaves tool content, including the delegation prompt and report, off every span', async () => {
      const h = harness();
      await run(h, messages);

      for (const span of h.spans.getFinishedSpans()) {
        for (const value of Object.values(span.attributes)) {
          expect(String(value)).not.toMatch(/secret/);
        }
      }
    });
  });

  describe('metadata_only', () => {
    const harness = useHarness({ contentCaptureMode: 'metadata_only' });

    it('emits no content', async () => {
      const h = harness();
      await run(h, messages);

      for (const span of h.spans.getFinishedSpans()) {
        expect(attr(span, 'gen_ai.input.messages')).toBeUndefined();
        expect(attr(span, 'gen_ai.output.messages')).toBeUndefined();
        expect(attr(span, 'gen_ai.tool.call.arguments')).toBeUndefined();
        expect(attr(span, 'gen_ai.tool.call.result')).toBeUndefined();
      }
    });
  });
});

describe('Claude Agent SDK adapter: errors and lifecycle', () => {
  const harness = useHarness();

  it('puts an API failure on the model call, and a later success leaves the run green', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('API Error: 400 unknown model')]),
      result({ is_error: true, result: 'API Error: 400 unknown model', api_error_status: 400 }),
      assistant('msg_2', [text('recovered')]),
      result({ result: 'recovered' }),
    ]);

    const [failed, recovered] = allSpans(h, CHAT);
    expect(failed!.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed!.status.message).toBe('API Error: 400 unknown model (HTTP 400)');
    expect(recovered!.status.code).toBe(SpanStatusCode.OK);
    const root = findSpan(h, ROOT);
    expect(root.status.code).toBe(SpanStatusCode.OK);
    expect(String(attr(root, 'gen_ai.output.messages'))).toContain('recovered');
    expect(String(attr(root, 'gen_ai.output.messages'))).toContain('end_turn');
  });

  it('puts an early stop on the run, not the model call', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('one')]),
      result({
        subtype: 'error_max_turns',
        is_error: true,
        result: undefined,
        errors: ['Reached maximum number of turns (1)'],
      }),
    ]);

    expect(findSpan(h, CHAT).status.code).toBe(SpanStatusCode.OK);
    const root = findSpan(h, ROOT);
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.status.message).toBe('Reached maximum number of turns (1)');
    expect(attr(root, 'gen_ai.output.messages')).toBeUndefined();
    expect(attr(root, 'gen_ai.usage.output_tokens')).toBe(50);
  });

  it('marks the run failed when the last result is an error', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('one')]),
      result(),
      assistant('msg_2', [text('two')]),
      result({
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
        terminal_reason: 'x',
      }),
    ]);

    const root = findSpan(h, ROOT);
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.status.message).toBe('claude agent run failed: x');
  });

  it('flags compaction on the run and on later chat spans', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('before')]),
      { type: 'system', subtype: 'compact_boundary' },
      assistant('msg_2', [text('after')]),
      result(),
    ]);

    const [before, after] = allSpans(h, CHAT);
    expect(attr(findSpan(h, ROOT), 'gen_ai.conversation.compacted')).toBe(true);
    expect(attr(before!, 'gen_ai.conversation.compacted')).toBeUndefined();
    expect(attr(after!, 'gen_ai.conversation.compacted')).toBe(true);
  });

  it('stops replaying the turns before a compaction or a /clear', async () => {
    const h = harness();
    await run(h, [
      init(),
      assistant('msg_1', [text('before compaction')]),
      result(),
      { type: 'system', subtype: 'compact_boundary' },
      userText('after compaction'),
      assistant('msg_2', [text('second')]),
      result(),
      { type: 'conversation_reset', new_conversation_id: 'conv-2' },
      userText('after clear'),
      assistant('msg_3', [text('third')]),
      result(),
    ]);

    const [, second, third] = allSpans(h, CHAT);
    const secondInput = String(attr(second!, 'gen_ai.input.messages'));
    expect(secondInput).not.toContain('before compaction');
    expect(secondInput).toContain('after compaction');
    const thirdInput = String(attr(third!, 'gen_ai.input.messages'));
    expect(thirdInput).not.toContain('second');
    expect(thirdInput).toContain('after clear');
    expect(attr(third!, 'gen_ai.conversation.compacted')).toBeUndefined();
  });

  it('ends every span without an error when the caller breaks out early', async () => {
    const h = harness();
    const closed: string[] = [];
    const query = (_params: AgentQueryParams) =>
      (async function* () {
        try {
          yield init();
          yield assistant('msg_1', [toolUse('tu_1', 'Bash')]);
          yield toolResult('tu_1', 'out');
        } finally {
          closed.push('stream');
        }
      })();

    for await (const msg of wrapQuery(h.client, query)({ prompt: 'p' })) {
      if ((msg as AgentMessage).type === 'assistant') break;
    }

    expect(closed).toEqual(['stream']);
    expect(endOrder(h)).toEqual(['execute_tool Bash', CHAT, ROOT]);
    for (const span of h.spans.getFinishedSpans())
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks the run failed when the stream ends with no result', async () => {
    const h = harness();
    await run(h, [init(), assistant('msg_1', [toolUse('tu_1', 'Bash')])]);

    expect(findSpan(h, ROOT).status.message).toBe('agent stream ended before any result message');
    expect(findSpan(h, 'execute_tool Bash').status.code).toBe(SpanStatusCode.ERROR);
    // The call had already delivered its reply; it did not fail.
    expect(findSpan(h, CHAT).status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('propagates a stream error and records it', async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      (async function* () {
        yield init();
        yield assistant('msg_1', [text('hi')]);
        throw new Error('cli died');
      })();

    await expect(drain(wrapQuery(h.client, query)({ prompt: 'p' }))).rejects.toThrow('cli died');
    expect(findSpan(h, ROOT).status.message).toBe('cli died');
  });

  it('fails a call cut off mid-stream when the stream breaks', async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      (async function* () {
        yield init();
        yield messageStart('msg_1', 100);
        yield assistant('msg_1', [text('hal')]);
        throw new Error('cli died');
      })();

    const traced = wrapQuery(h.client, query)({ prompt: 'p', options: streamed });
    await expect(drain(traced)).rejects.toThrow('cli died');
    expect(findSpan(h, CHAT).status.message).toBe('cli died');
  });

  it('records a run that fails before its first message', async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      (async function* () {
        yield* [];
        throw new Error('spawn claude ENOENT');
      })();

    await expect(drain(wrapQuery(h.client, query)({ prompt: 'p' }))).rejects.toThrow('ENOENT');
    expect(findSpan(h, ROOT).status.message).toBe('spawn claude ENOENT');
  });

  it('records a query() that throws synchronously, and rethrows it', async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) => {
      throw new Error('bad options');
    };

    expect(() => wrapQuery(h.client, query)({ prompt: 'p' })).toThrow('bad options');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(findSpan(h, ROOT).status.message).toBe('bad options');
  });

  it("does not replace the caller's error when recording fails", async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      (async function* () {
        yield init();
        throw new Error('cli died');
      })();
    await h.client.shutdown();

    await expect(drain(wrapQuery(h.client, query)({ prompt: 'p' }))).rejects.toThrow('cli died');
  });

  it('does not treat the result of an interrupted turn as a failure', async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      Object.assign(
        fakeQuery([
          init(),
          assistant('msg_1', [text('working')]),
          result({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] }),
        ])({ prompt: '' }),
        { interrupt: async () => {} },
      );

    const q = wrapQuery(h.client, query)({ prompt: 'p' });
    for await (const msg of q) {
      if ((msg as AgentMessage).type === 'assistant') await q.interrupt();
    }

    expect(findSpan(h, ROOT).status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('does not mark an interrupted run failed when the stream ends with no result', async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      Object.assign(fakeQuery([init(), assistant('msg_1', [text('partial')])])({ prompt: '' }), {
        interrupt: async () => {},
      });

    const q = wrapQuery(h.client, query)({ prompt: 'p' });
    await q.next();
    await q.interrupt();
    await drain(q);

    expect(findSpan(h, ROOT).status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('ends the run when the caller closes it between manual reads', async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      Object.assign(
        fakeQuery([init(), assistant('msg_1', [text('hi')]), result()])({ prompt: '' }),
        {
          close: () => {},
        },
      );

    const q = wrapQuery(h.client, query)({ prompt: 'p' });
    await q.next();
    await q.next();
    q.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const root = findSpan(h, ROOT);
    expect(root.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(allSpans(h, CHAT)).toHaveLength(1);
  });

  it('records a run the caller closes before reading anything', async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      Object.assign(fakeQuery([init(), result()])({ prompt: '' }), { close: () => {} });

    wrapQuery(h.client, query)({ prompt: 'p' }).close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findSpan(h, ROOT).status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("ends the run, and passes on the error, when the SDK's own close() throws", async () => {
    const h = harness();
    const query = (_params: AgentQueryParams) =>
      Object.assign(fakeQuery([init(), result()])({ prompt: '' }), {
        close: () => {
          throw new Error('close failed');
        },
      });

    const q = wrapQuery(h.client, query)({ prompt: 'p' });
    expect(() => q.close()).toThrow('close failed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(allSpans(h, ROOT)).toHaveLength(1);
    expect(findSpan(h, ROOT).status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('records a run the caller returns from before reading anything', async () => {
    const h = harness();
    await wrapQuery(h.client, fakeQuery([init(), result()]))({ prompt: 'p' }).return(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(allSpans(h, ROOT)).toHaveLength(1);
  });

  it('does not mark a run the caller closed as failed', async () => {
    const h = harness();
    let closed = false;
    const query = (_params: AgentQueryParams) =>
      Object.assign(
        (async function* () {
          yield init();
          yield assistant('msg_1', [text('hi')]);
          if (!closed) yield result();
        })(),
        {
          close: () => {
            closed = true;
          },
        },
      );

    const q = wrapQuery(h.client, query)({ prompt: 'p' });
    for await (const msg of q) {
      if ((msg as AgentMessage).type === 'assistant') q.close();
    }

    expect(findSpan(h, ROOT).status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("stops the CLI through the SDK's own return(), even while a read is waiting", async () => {
    const h = harness();
    const calls: string[] = [];
    const query = (_params: AgentQueryParams) => {
      let stopCli: () => void = () => {};
      const stream = (async function* () {
        yield init();
        await new Promise<void>((resolve) => {
          stopCli = resolve;
        });
      })();
      const generatorReturn = stream.return.bind(stream);
      // Like the real SDK: return() kills the CLI, which ends the read in progress.
      return Object.assign(stream, {
        return: (value?: unknown) => {
          calls.push('sdk return');
          stopCli();
          return generatorReturn(value as undefined);
        },
      });
    };

    const q = wrapQuery(h.client, query)({ prompt: 'p' });
    await q.next();
    const waiting = q.next();
    await q.return(undefined);
    await waiting;

    expect(calls[0]).toBe('sdk return');
    expect(findSpan(h, ROOT).status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("keeps the SDK's Query methods and observes iteration", async () => {
    const h = harness();
    const calls: string[] = [];
    const query = (_params: AgentQueryParams) =>
      Object.assign(
        fakeQuery([init(), assistant('msg_1', [text('hi')]), result()])({ prompt: '' }),
        {
          interrupt(this: unknown) {
            calls.push('interrupt');
            return this;
          },
        },
      );

    const q = wrapQuery(h.client, query)({ prompt: 'p' });
    const target = q.interrupt();
    await drain(q);

    expect(calls).toEqual(['interrupt']);
    expect(target).not.toBe(q); // called on the SDK's own object
    expect(allSpans(h, ROOT)).toHaveLength(1);
  });

  it('traces a query sent through a pre-warmed startup() handle', async () => {
    const h = harness();
    const prompts: unknown[] = [];
    const startup = async (_params?: { options?: AgentQueryOptions }) => ({
      query(prompt: unknown) {
        prompts.push(prompt);
        return fakeQuery([init(), assistant('msg_1', [text('hi')]), result()])({ prompt });
      },
      close() {},
    });

    const warm = await wrapStartup(
      h.client,
      startup,
    )({
      options: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
    });
    await drain(warm.query('warm prompt'));

    expect(prompts).toEqual(['warm prompt']);
    expect(String(attr(findSpan(h, ROOT), 'gen_ai.input.messages'))).toContain('warm prompt');
    expect(attr(findSpan(h, CHAT), 'gen_ai.provider.name')).toBe('aws.bedrock');
  });

  it('does not wrap a query twice', async () => {
    const h = harness();
    const once = wrapQuery(h.client, fakeQuery([init(), result()]));
    expect(wrapQuery(h.client, once)).toBe(once);
  });

  it('calls query() once, with the caller options untouched', async () => {
    const h = harness();
    const seen: AgentQueryParams[] = [];
    const options: AgentQueryOptions = { model: MODEL };
    const traced = wrapQuery(h.client, (params: AgentQueryParams) => {
      seen.push(params);
      return fakeQuery([init(), result()])(params);
    });
    const messages = await drain(traced({ prompt: 'x', options }));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.options).toBe(options);
    expect(Object.keys(options)).toEqual(['model']);
    expect(messages).toHaveLength(2);
  });

  it('reads the hosting platform from the env the CLI will see', async () => {
    const h = harness();
    await run(
      h,
      [init(), assistant('msg_1', [text('hi')]), result()],
      {},
      {
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      },
    );

    expect(attr(findSpan(h, ROOT), 'gen_ai.provider.name')).toBe('aws.bedrock');
    expect(attr(findSpan(h, CHAT), 'gen_ai.provider.name')).toBe('aws.bedrock');
  });

  it('defaults the provider to anthropic, including for a switched-off platform', async () => {
    const h = harness();
    await run(
      h,
      [init(), assistant('msg_1', [text('hi')]), result()],
      {},
      {
        env: { CLAUDE_CODE_USE_VERTEX: '0' },
      },
    );
    expect(attr(findSpan(h, CHAT), 'gen_ai.provider.name')).toBe('anthropic');
  });

  it('reads the platform flags the way the CLI does', async () => {
    const h = harness();
    const provider = async (env: Record<string, string>) => {
      h.spans.reset();
      await run(h, [init(), assistant('msg_1', [text('hi')]), result()], {}, { env });
      return attr(findSpan(h, CHAT), 'gen_ai.provider.name');
    };

    expect(await provider({ CLAUDE_CODE_USE_VERTEX: 'off' })).toBe('anthropic');
    expect(await provider({ CLAUDE_CODE_USE_VERTEX: ' Yes ' })).toBe('gcp.vertex_ai');
    expect(await provider({ CLAUDE_CODE_USE_MANTLE: '1' })).toBe('aws.bedrock');
    // Both set: the CLI checks Foundry first.
    expect(await provider({ CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1' })).toBe(
      'azure.ai.inference',
    );
  });

  it('opens the run under the span active when query() was called', async () => {
    const h = harness();
    const traced = wrapQuery(
      h.client,
      fakeQuery([init(), assistant('msg_1', [text('hi')]), result()]),
    );
    const caller = h.tracerProvider.getTracer('test').startSpan('caller');
    const stream = context.with(trace.setSpan(context.active(), caller), () =>
      traced({ prompt: 'do the thing' }),
    );
    // Read from outside the caller's span, as a consumer on another task would.
    await drain(stream);
    caller.end();

    expect(parentOf(h, findSpan(h, ROOT))?.name).toBe('caller');
  });

  it('keeps two concurrent runs apart', async () => {
    const h = harness();
    const queryA = fakeQuery([init('sess-a'), assistant('a_1', [text('A')]), result()]);
    const queryB = fakeQuery([init('sess-b'), assistant('b_1', [text('B')]), result()]);
    const runA = wrapQuery(h.client, queryA, { agentName: 'agent-a' });
    const runB = wrapQuery(h.client, queryB, { agentName: 'agent-b' });
    await Promise.all([drain(runA({ prompt: 'a' })), drain(runB({ prompt: 'b' }))]);

    const a = findSpan(h, 'invoke_agent agent-a');
    expect(attr(a, 'gen_ai.conversation.id')).toBe('sess-a');
    expect(attr(findSpan(h, 'invoke_agent agent-b'), 'gen_ai.conversation.id')).toBe('sess-b');
    const aOutput = String(attr(childrenOf(h, a, CHAT)[0]!, 'gen_ai.output.messages'));
    expect(aOutput).toContain('"A"');
    expect(aOutput).not.toContain('"B"');
  });
});

describe('Claude Agent SDK adapter: replayed CLI recordings', () => {
  const harness = useHarness({ contentCaptureMode: 'full' });

  function recording(name: string): AgentMessage[] {
    const path = new URL(`../fixtures/claude-agent-sdk/${name}.jsonl`, import.meta.url);
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentMessage);
  }

  it('background delegation', async () => {
    const h = harness();
    await run(h, recording('background-delegation'), {}, streamed);

    const root = findSpan(h, ROOT);
    const delegation = findSpan(h, 'execute_tool Agent');
    const sub = findSpan(h, 'invoke_agent general-purpose');
    expect(parentOf(h, delegation)).toBe(root);
    expect(parentOf(h, sub)).toBe(delegation);
    expect(parentOf(h, findSpan(h, 'execute_tool Bash'))).toBe(sub);

    const mainChats = childrenOf(h, root, CHAT);
    expect(mainChats.map((c) => attr(c, 'gen_ai.usage.output_tokens'))).toEqual([255, 115, 432]);
    for (const chat of mainChats) expect(attr(chat, 'genai.usage.is_partial')).toBeUndefined();
    expect(childrenOf(h, sub, CHAT)).toHaveLength(2);
    expect(String(attr(delegation, 'gen_ai.tool.call.result'))).not.toContain('launched');
    expect(root.status.code).toBe(SpanStatusCode.OK);
  });

  it('background command', async () => {
    const h = harness();
    await run(h, recording('background-bash'), {}, streamed);

    const [bash, read] = [findSpan(h, 'execute_tool Bash'), findSpan(h, 'execute_tool Read')];
    expect(String(attr(bash, 'gen_ai.tool.call.result'))).not.toContain('running in background');
    expect(bash.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(read.status.code).not.toBe(SpanStatusCode.ERROR);
    const outputs = allSpans(h, CHAT).map((c) => attr(c, 'gen_ai.usage.output_tokens'));
    expect(outputs).toEqual([282, 119, 154, 63]);
  });

  it('inline delegation', async () => {
    const h = harness();
    await run(h, recording('inline-delegation'), {}, streamed);

    const sub = findSpan(h, 'invoke_agent general-purpose');
    expect(parentOf(h, sub)?.name).toBe('execute_tool Agent');
    expect(childrenOf(h, sub, CHAT)).toHaveLength(2);
    expect(allSpans(h, 'execute_tool Agent')).toHaveLength(1);
    expect(childrenOf(h, findSpan(h, ROOT), CHAT)).toHaveLength(2);
  });
});
