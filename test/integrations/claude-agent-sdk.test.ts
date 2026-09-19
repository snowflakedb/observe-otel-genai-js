/**
 * Tests for the Claude Agent SDK adapter.
 *
 * The SDK spawns the Claude Code CLI, so there is nothing to stub at the HTTP
 * layer. Every test feeds a hand-built `SDKMessage[]` through a fake `query`.
 * The adapter reads nothing but the stream, so a message list is the whole input
 * and message order is what makes the ordering races testable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ClaudeAgentSdkOptions,
  wrapQuery,
} from '../../src/integrations/claude-agent-sdk/index.js';
import type {
  AgentMessage,
  AgentQueryOptions,
} from '../../src/integrations/claude-agent-sdk/types.js';
import { type Harness, createHarness } from '../_harness.js';

// -----------------------------------------------------------------------------
// Fake stream
// -----------------------------------------------------------------------------

function fakeQuery(messages: AgentMessage[]) {
  return (_params: { prompt: unknown; options?: AgentQueryOptions }) =>
    (async function* () {
      for (const msg of messages) yield msg;
    })();
}

async function drain(it: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

// -----------------------------------------------------------------------------
// Message builders
// -----------------------------------------------------------------------------

const MODEL = 'claude-sonnet-4-5';

function init(sessionId = 'sess-1'): AgentMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: MODEL,
    tools: ['Read', 'Bash'],
    permissionMode: 'default',
    claude_code_version: '2.1.0',
  };
}

function assistant(
  id: string,
  content: Record<string, unknown>[],
  extra: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    type: 'assistant',
    message: { id, model: MODEL, role: 'assistant', content, stop_reason: null },
    parent_tool_use_id: null,
    ...extra,
  };
}

function userToolResult(
  toolUseId: string,
  text: string,
  extra: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
    parent_tool_use_id: null,
    ...extra,
  };
}

function taskStarted(
  toolUseId: string,
  subagentType: string | undefined = 'general-purpose',
  taskType = 'local_agent',
): AgentMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: `task-${toolUseId}`,
    tool_use_id: toolUseId,
    task_type: taskType,
    ...(subagentType ? { subagent_type: subagentType } : {}),
    session_id: 'sess-1',
  };
}

function taskNotification(toolUseId: string, summary: string, status = 'completed'): AgentMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: `task-${toolUseId}`,
    tool_use_id: toolUseId,
    status,
    summary,
    session_id: 'sess-1',
  };
}

function result(extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    duration_ms: 1200,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {
      [MODEL]: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
        costUSD: 0.0123,
        provider: 'firstParty',
      },
    },
    permission_denials: [],
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// Span helpers
// -----------------------------------------------------------------------------

function spansByName(h: Harness) {
  return h.spans.getFinishedSpans().map((s) => s.name);
}

function findSpan(h: Harness, name: string) {
  const found = h.spans.getFinishedSpans().find((s) => s.name === name);
  if (!found) throw new Error(`no span named ${name}; got ${spansByName(h).join(', ')}`);
  return found;
}

function allSpans(h: Harness, name: string) {
  return h.spans.getFinishedSpans().filter((s) => s.name === name);
}

/** OTel hrtime `[seconds, nanos]` as fractional milliseconds. */
function hrToMs([seconds, nanos]: [number, number]): number {
  return seconds * 1000 + nanos / 1e6;
}

function parentOf(h: Harness, child: { parentSpanContext?: { spanId?: string } }) {
  const pid = child.parentSpanContext?.spanId;
  return h.spans.getFinishedSpans().find((s) => s.spanContext().spanId === pid);
}

function run(h: Harness, messages: AgentMessage[], opts?: ClaudeAgentSdkOptions) {
  const traced = wrapQuery(h.client, fakeQuery(messages), opts ?? {});
  return drain(traced({ prompt: 'do the thing', options: { model: MODEL } }));
}

// -----------------------------------------------------------------------------

describe('Claude Agent SDK adapter — span structure', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits one invoke_agent and one chat for a plain text answer', async () => {
    await run(h, [init(), assistant('msg_1', [{ type: 'text', text: 'hello' }]), result()]);

    expect(allSpans(h, `chat ${MODEL}`)).toHaveLength(1);
    expect(allSpans(h, 'invoke_agent claude-agent-sdk')).toHaveLength(1);
    const chat = findSpan(h, `chat ${MODEL}`);
    expect(parentOf(h, chat)?.name).toBe('invoke_agent claude-agent-sdk');
  });

  it('merges consecutive assistant messages that share a message.id into one chat span', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'thinking', thinking: 'hmm' }]),
      assistant('msg_1', [{ type: 'text', text: 'the answer' }]),
      assistant('msg_1', [{ type: 'text', text: ' continues' }]),
      result(),
    ]);

    // One API call delivered as three content blocks -> one chat span.
    expect(allSpans(h, `chat ${MODEL}`)).toHaveLength(1);
    const out = findSpan(h, `chat ${MODEL}`).attributes['gen_ai.output.messages'] as string;
    expect(out).toContain('hmm');
    expect(out).toContain('the answer');
    expect(out).toContain(' continues');
  });

  it('cuts a new chat span when message.id changes', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } }]),
      userToolResult('tu_1', 'file body'),
      assistant('msg_2', [{ type: 'text', text: 'done reading' }]),
      result(),
    ]);

    expect(allSpans(h, `chat ${MODEL}`)).toHaveLength(2);
    expect(allSpans(h, 'execute_tool Read')).toHaveLength(1);
  });

  it('carries the running history into each chat span input', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'text', text: 'first' }]),
      userToolResult('tu_x', 'result text'),
      assistant('msg_2', [{ type: 'text', text: 'second' }]),
      result(),
    ]);

    const [, second] = allSpans(h, `chat ${MODEL}`);
    const input = second?.attributes['gen_ai.input.messages'] as string;
    expect(input).toContain('do the thing');
    expect(input).toContain('first');
  });

  it('marks chat-span usage as partial and puts authoritative totals on the turn', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'text', text: 'hi' }], {
        message: {
          id: 'msg_1',
          model: MODEL,
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
        },
      }),
      result(),
    ]);

    const chat = findSpan(h, `chat ${MODEL}`);
    // No message_delta in this fixture, so the snapshot is all we have.
    expect(chat.attributes['genai.usage.is_partial']).toBe(true);
    // Cache reads folded into input_tokens: 7 + 2 = 9.
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(9);

    const turn = findSpan(h, 'invoke_agent claude-agent-sdk');
    // modelUsage: 100 + 20 cache read + 10 cache write = 130.
    expect(turn.attributes['gen_ai.usage.input_tokens']).toBe(130);
    expect(turn.attributes['gen_ai.usage.output_tokens']).toBe(50);
    expect(turn.attributes['gen_ai.usage.cache_write.input_tokens']).toBe(10);
    expect(turn.attributes['genai.usage.cost_usd']).toBeCloseTo(0.0123);
  });
});

describe('Claude Agent SDK adapter — tools', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('closes a tool span from the stream tool_result, with the response', async () => {
    await run(
      h,
      [
        init(),
        assistant('msg_1', [
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ]),
        userToolResult('tu_1', 'a\nb'),
        result(),
      ],
      { contentCapture: 'full' },
    );

    const tool = findSpan(h, 'execute_tool Bash');
    expect(tool.attributes['gen_ai.tool.call.id']).toBe('tu_1');
    expect(tool.attributes['gen_ai.tool.type']).toBe('function');
    expect(String(tool.attributes['gen_ai.tool.call.result'])).toContain('a\\nb');
  });

  it('records a tool failure from is_error on the tool_result', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }]),
      {
        ...userToolResult('tu_1', 'exit 1'),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'exit 1', is_error: true },
          ],
        },
      },
      result(),
    ]);

    const tool = findSpan(h, 'execute_tool Bash');
    expect(tool.attributes['error.type']).toBe('tool_execution_error');
    expect(tool.status.code).toBe(2); // ERROR
  });

  it('closes a tool from the stream alone, with no hook involved', async () => {
    // The span opens from the tool_use block and closes from the
    // tool_result block. Coarser (the duration then includes permission waiting
    // and queueing) but never missing.
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } }]),
      userToolResult('tu_1', 'body'),
      result(),
    ]);

    const tool = findSpan(h, 'execute_tool Read');
    expect(allSpans(h, 'execute_tool Read')).toHaveLength(1);
    expect(tool.status.code).not.toBe(2);
  });

  it('marks mcp tools as extension type', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [
        { type: 'tool_use', id: 'tu_1', name: 'mcp__weather__get', input: { city: 'Berlin' } },
      ]),
      userToolResult('tu_1', 'sunny'),
      result(),
    ]);

    expect(findSpan(h, 'execute_tool mcp__weather__get').attributes['gen_ai.tool.type']).toBe(
      'extension',
    );
  });

  it('waits for the notification on a backgrounded Bash, not its launch receipt', async () => {
    // Not only delegations: a `run_in_background` command is registered as a task too
    // (`task_type: local_bash`), and its tool_result is likewise just a receipt. The
    // rule keys off being a task at all, so this needs no special case.
    await run(
      h,
      [
        init(),
        assistant('msg_1', [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Bash',
            input: { command: 'sleep 8 && echo done', run_in_background: true },
          },
        ]),
        taskStarted('tu_1', undefined, 'local_bash'),
        userToolResult('tu_1', 'Command running in background with ID: bxnmsd4ot'),
        assistant('msg_2', [{ type: 'text', text: 'waiting' }]),
        taskNotification('tu_1', 'done'),
        result(),
      ],
      { contentCapture: 'full' },
    );

    const tool = findSpan(h, 'execute_tool Bash');
    expect(allSpans(h, 'execute_tool Bash')).toHaveLength(1);
    expect(String(tool.attributes['gen_ai.tool.call.result'])).toContain('done');
    expect(String(tool.attributes['gen_ai.tool.call.result'])).not.toContain(
      'running in background',
    );
    // It outlived the model call that came after the receipt, which is the point.
    const order = h.spans.getFinishedSpans().map((sp) => sp.name);
    expect(order.indexOf(`chat ${MODEL}`)).toBeLessThan(order.indexOf('execute_tool Bash'));
  });

  it('force-closes a tool that never returned', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }]),
      result(),
    ]);

    const tool = findSpan(h, 'execute_tool Bash');
    expect(tool.attributes['error.type']).toBe('tool_execution_error');
  });

  it("passes the caller's options through to the SDK untouched", async () => {
    // Nothing is injected any more, so the object the SDK receives should be the
    // very one the caller handed us — not a copy, and not augmented.
    let seen: AgentQueryOptions | undefined;
    const callerOptions: AgentQueryOptions = { model: MODEL };
    const traced = wrapQuery(
      h.client,
      (params) => {
        seen = params.options;
        return fakeQuery([init(), result()])(params);
      },
      {},
    );
    await drain(traced({ prompt: 'x', options: callerOptions }));

    expect(seen).toBe(callerOptions);
    expect(Object.keys(callerOptions)).toEqual(['model']);
  });
});

describe('Claude Agent SDK adapter — subagents', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('nests a subagent invoke_agent under the Task tool span', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [
        {
          type: 'tool_use',
          id: 'task_1',
          name: 'Task',
          input: { subagent_type: 'code-reviewer', description: 'review', prompt: 'look at x' },
        },
      ]),
      assistant('msg_sub_1', [{ type: 'text', text: 'reviewing' }], {
        parent_tool_use_id: 'task_1',
      }),
      userToolResult('task_1', 'review done'),
      result(),
    ]);

    const sub = findSpan(h, 'invoke_agent code-reviewer');
    expect(parentOf(h, sub)?.name).toBe('execute_tool Task');
    expect(parentOf(h, findSpan(h, 'execute_tool Task'))?.name).toBe(
      'invoke_agent claude-agent-sdk',
    );
    expect(sub.attributes['gen_ai.agent.description']).toBe('review');
    // The subagent's own chat span nests under the subagent, not the turn.
    const subChats = allSpans(h, `chat ${MODEL}`).filter(
      (s) => parentOf(h, s)?.name === 'invoke_agent code-reviewer',
    );
    expect(subChats).toHaveLength(1);
  });

  it('ends a subagent before the Task tool span that owns it', async () => {
    // The Task tool's tool_result closes its span, so unless closing a tool finishes
    // its subagent first, the child outlives its parent.
    await run(h, [
      init(),
      assistant('msg_1', [
        { type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'alpha' } },
      ]),
      assistant('msg_s1', [{ type: 'text', text: 'sub work' }], {
        parent_tool_use_id: 'task_1',
      }),
      userToolResult('task_1', 'done'),
      result(),
    ]);

    const tool = findSpan(h, 'execute_tool Task');
    const sub = findSpan(h, 'invoke_agent alpha');
    expect(parentOf(h, sub)?.spanContext().spanId).toBe(tool.spanContext().spanId);

    // Assert the order they *ended*, not their timestamps: host.now() is
    // millisecond-resolution and all of this happens inside one millisecond, so
    // comparing endTime cannot tell the two apart. The exporter records spans as
    // they end, so its ordering is exact.
    const order = h.spans.getFinishedSpans().map((s) => s.name);
    expect(order.indexOf('invoke_agent alpha')).toBeLessThan(order.indexOf('execute_tool Task'));
    expect(hrToMs(sub.startTime)).toBeGreaterThanOrEqual(hrToMs(tool.startTime));
  });

  it('keeps a backgrounded delegation open until its task notification', async () => {
    // Run in the background, the Task tool_result comes back in milliseconds saying
    // only that the agent launched, and the subagent's messages arrive long after.
    // Closing on that receipt would report a near-instant delegation and leave the
    // subagent nothing open to nest under.
    await run(
      h,
      [
        init(),
        assistant('msg_1', [
          { type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'worker' } },
        ]),
        taskStarted('task_1', 'worker'),
        userToolResult('task_1', 'Async agent launched successfully. agentId: abc'),
        // …the subagent only starts working now.
        assistant('msg_s1', [{ type: 'tool_use', id: 'tu_9', name: 'Bash', input: {} }], {
          parent_tool_use_id: 'task_1',
        }),
        userToolResult('tu_9', 'from-subagent', { parent_tool_use_id: 'task_1' }),
        assistant('msg_s2', [{ type: 'text', text: 'report' }], { parent_tool_use_id: 'task_1' }),
        taskNotification('task_1', 'the real report'),
        result(),
      ],
      { contentCapture: 'full' },
    );

    const tool = findSpan(h, 'execute_tool Task');
    // Nesting survives: the tool was still open when the subagent first spoke.
    expect(parentOf(h, findSpan(h, 'invoke_agent worker'))?.name).toBe('execute_tool Task');
    expect(parentOf(h, findSpan(h, 'execute_tool Bash'))?.name).toBe('invoke_agent worker');
    // The notification's summary is the result, not the launch receipt.
    expect(String(tool.attributes['gen_ai.tool.call.result'])).toContain('the real report');
    expect(String(tool.attributes['gen_ai.tool.call.result'])).not.toContain('launched');
    // Child still ends before its parent.
    const order = h.spans.getFinishedSpans().map((sp) => sp.name);
    expect(order.indexOf('invoke_agent worker')).toBeLessThan(order.indexOf('execute_tool Task'));
  });

  it('closes an inline delegation on its notification, ignoring the tool_result after', async () => {
    // Run inline the notification arrives first and the tool_result that follows is a
    // no-op, so one uniform rule covers both modes.
    await run(
      h,
      [
        init(),
        assistant('msg_1', [
          { type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'worker' } },
        ]),
        taskStarted('task_1', 'worker'),
        assistant('msg_s1', [{ type: 'text', text: 'working' }], { parent_tool_use_id: 'task_1' }),
        taskNotification('task_1', 'inline report'),
        userToolResult('task_1', 'inline report'),
        result(),
      ],
      { contentCapture: 'full' },
    );

    expect(allSpans(h, 'execute_tool Task')).toHaveLength(1);
    expect(parentOf(h, findSpan(h, 'invoke_agent worker'))?.name).toBe('execute_tool Task');
    expect(
      String(findSpan(h, 'execute_tool Task').attributes['gen_ai.tool.call.result']),
    ).toContain('inline report');
  });

  it('marks a delegation that ended in a failure state', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [
        { type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'worker' } },
      ]),
      taskStarted('task_1', 'worker'),
      userToolResult('task_1', 'Async agent launched successfully.'),
      taskNotification('task_1', 'gave up', 'failed'),
      result(),
    ]);

    const tool = findSpan(h, 'execute_tool Task');
    expect(tool.status.code).toBe(2);
    expect(tool.attributes['error.type']).toBe('tool_execution_error');
  });

  it('keeps two parallel subagents apart when they finish out of order', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [
        { type: 'tool_use', id: 'task_a', name: 'Task', input: { subagent_type: 'alpha' } },
        { type: 'tool_use', id: 'task_b', name: 'Task', input: { subagent_type: 'beta' } },
      ]),
      assistant('msg_b1', [{ type: 'text', text: 'from beta' }], { parent_tool_use_id: 'task_b' }),
      assistant('msg_a1', [{ type: 'text', text: 'from alpha' }], { parent_tool_use_id: 'task_a' }),
      // b returns first, a second — reverse of launch order.
      userToolResult('task_b', 'beta done'),
      userToolResult('task_a', 'alpha done'),
      result(),
    ]);

    const alpha = findSpan(h, 'invoke_agent alpha');
    const beta = findSpan(h, 'invoke_agent beta');
    expect(parentOf(h, alpha)?.attributes['gen_ai.tool.call.id']).toBe('task_a');
    expect(parentOf(h, beta)?.attributes['gen_ai.tool.call.id']).toBe('task_b');

    const alphaChat = allSpans(h, `chat ${MODEL}`).find(
      (s) => parentOf(h, s)?.name === 'invoke_agent alpha',
    );
    expect(String(alphaChat?.attributes['gen_ai.output.messages'])).toContain('from alpha');
  });

  it('synthesizes a subagent span when the launching Task block was never seen', async () => {
    await run(h, [
      init(),
      assistant('msg_orphan', [{ type: 'text', text: 'orphan work' }], {
        parent_tool_use_id: 'task_missing',
      }),
      result(),
    ]);

    expect(allSpans(h, 'invoke_agent subagent')).toHaveLength(1);
  });

  it('opens the subagent while its Task tool is still open', async () => {
    // Why parenting needs nothing more than the live-tool map: a Task tool's
    // tool_result *is* the subagent's report, so it can never arrive before the
    // subagent's own messages. The tool is still open when the subagent span opens.
    await run(h, [
      init(),
      assistant('msg_1', [
        { type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'late' } },
      ]),
      assistant('msg_sub', [{ type: 'text', text: 'working' }], {
        parent_tool_use_id: 'task_1',
      }),
      userToolResult('task_1', 'ok'),
      result(),
    ]);

    expect(parentOf(h, findSpan(h, 'invoke_agent late'))?.name).toBe('execute_tool Task');
  });

  it('routes subagent tool calls under the subagent', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [
        { type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'searcher' } },
      ]),
      assistant('msg_s1', [{ type: 'tool_use', id: 'tu_9', name: 'Grep', input: { q: 'x' } }], {
        parent_tool_use_id: 'task_1',
      }),
      userToolResult('tu_9', 'match', { parent_tool_use_id: 'task_1' }),
      userToolResult('task_1', 'search done'),
      result(),
    ]);

    expect(parentOf(h, findSpan(h, 'execute_tool Grep'))?.name).toBe('invoke_agent searcher');
  });
});

describe('Claude Agent SDK adapter — lifecycle and edge cases', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('flags compaction on the turn and on later chat spans', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'text', text: 'before' }]),
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 20_000 },
      },
      userToolResult('tu_none', 'x'),
      assistant('msg_2', [{ type: 'text', text: 'after' }]),
      result(),
    ]);

    const turn = findSpan(h, 'invoke_agent claude-agent-sdk');
    expect(turn.attributes['gen_ai.conversation.compacted']).toBe(true);
    // The semconv boolean is all we emit; there is no bespoke compaction event.
    expect(turn.events).toHaveLength(0);

    const [, after] = allSpans(h, `chat ${MODEL}`);
    expect(after?.attributes['gen_ai.conversation.compacted']).toBe(true);
  });

  it('takes final usage, stop reason, and reasoning tokens from message_delta', async () => {
    // `message.usage` on a streamed assistant message is a mid-stream snapshot —
    // 3 output tokens here against a real 155. Only `message_delta` carries the
    // call's totals, and it arrives after the content blocks but before the span
    // closes.
    const traced = wrapQuery(
      h.client,
      fakeQuery([
        init(),
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          ttft_ms: 500,
          event: { type: 'message_start' },
        },
        assistant('msg_1', [{ type: 'text', text: 'hi' }], {
          message: {
            id: 'msg_1',
            model: MODEL,
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 40 },
          },
        }),
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: {
              input_tokens: 10,
              output_tokens: 155,
              cache_read_input_tokens: 40,
              output_tokens_details: { thinking_tokens: 71 },
            },
          },
        },
        result(),
      ]),
      {},
    );
    await drain(traced({ prompt: 'p', options: { model: MODEL, includePartialMessages: true } }));

    const chat = findSpan(h, `chat ${MODEL}`);
    expect(chat.attributes['gen_ai.usage.output_tokens']).toBe(155);
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(50); // 10 + 40 cache read
    expect(chat.attributes['gen_ai.usage.reasoning.output_tokens']).toBe(71);
    expect(chat.attributes['gen_ai.response.finish_reasons']).toEqual(['tool_use']);
    // Authoritative now, so the partial marker is gone.
    expect(chat.attributes['genai.usage.is_partial']).toBeUndefined();
  });

  it('flags usage as partial when no message_delta arrives', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'text', text: 'hi' }], {
        message: {
          id: 'msg_1',
          model: MODEL,
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      result(),
    ]);

    const chat = findSpan(h, `chat ${MODEL}`);
    expect(chat.attributes['genai.usage.is_partial']).toBe(true);
    expect(chat.attributes['gen_ai.usage.output_tokens']).toBe(3);
  });

  it('records TTFT from stream_event', async () => {
    const traced = wrapQuery(
      h.client,
      fakeQuery([
        init(),
        // ttft_ms rides on message_start, which precedes the assistant messages
        // of that call — so there is no chat span open yet when it arrives.
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          ttft_ms: 640,
          event: { type: 'message_start' },
        },
        assistant('msg_1', [{ type: 'text', text: 'hi' }]),
        result(),
      ]),
      {},
    );
    await drain(traced({ prompt: 'p', options: { model: MODEL, includePartialMessages: true } }));

    expect(findSpan(h, `chat ${MODEL}`).attributes['gen_ai.response.time_to_first_chunk']).toBe(
      0.64,
    );
  });

  it('reads the reasoning level, and emits none of the cut extensions', async () => {
    const traced = wrapQuery(h.client, fakeQuery([init(), result()]), {});
    await drain(traced({ prompt: 'p', options: { model: MODEL, effort: 'xhigh' } }));

    const turn = findSpan(h, 'invoke_agent claude-agent-sdk');
    expect(turn.attributes['gen_ai.request.reasoning.level']).toBe('xhigh');
    expect(turn.attributes['gen_ai.conversation.id']).toBe('sess-1');
    // Everything below was considered and cut: already covered by a convention,
    // derivable from the span tree, or wanted by nobody.
    for (const gone of [
      'genai.agent.session_id',
      'genai.agent.num_turns',
      'genai.agent.tools_available',
      'genai.agent.permission_mode',
      'genai.agent.permission_denials',
      'genai.agent.cli_version',
      'genai.agent.api_provider',
      'prompt.id',
      'genai.conversation.turn_index',
    ]) {
      expect(turn.attributes[gone]).toBeUndefined();
    }
  });

  it('marks the turn as failed on an error result', async () => {
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'text', text: 'partial' }]),
      result({ subtype: 'error_max_turns', is_error: true }),
    ]);

    const turn = findSpan(h, 'invoke_agent claude-agent-sdk');
    expect(turn.status.code).toBe(2);
    // Usage is still recorded on a failed run.
    expect(turn.attributes['gen_ai.usage.output_tokens']).toBe(50);
  });

  it('closes every span when the caller breaks out of the loop early', async () => {
    const traced = wrapQuery(
      h.client,
      fakeQuery([
        init(),
        assistant('msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }]),
        userToolResult('tu_1', 'out'),
        result(),
      ]),
      {},
    );

    let seen = 0;
    for await (const _msg of traced({ prompt: 'p', options: { model: MODEL } })) {
      seen += 1;
      if (seen === 2) break;
    }

    const names = spansByName(h);
    expect(names).toContain('invoke_agent claude-agent-sdk');
    expect(names).toContain(`chat ${MODEL}`);
    expect(names).toContain('execute_tool Bash');
    expect(findSpan(h, 'invoke_agent claude-agent-sdk').status.code).toBe(2);
  });

  it('propagates a stream error and still closes spans', async () => {
    const boom = new Error('cli died');
    const traced = wrapQuery(
      h.client,
      () =>
        (async function* () {
          yield init();
          yield assistant('msg_1', [{ type: 'text', text: 'hi' }]);
          throw boom;
        })(),
      {},
    );

    await expect(drain(traced({ prompt: 'p', options: { model: MODEL } }))).rejects.toThrow(
      'cli died',
    );
    expect(findSpan(h, 'invoke_agent claude-agent-sdk').status.code).toBe(2);
    expect(findSpan(h, `chat ${MODEL}`).status.code).toBe(2);
  });

  it('keeps one agent span for the whole query, whatever the result count', async () => {
    // A single query() can emit several results — a backgrounded delegation keeps the
    // run going past the first. They are checkpoints, so the span count does not move
    // and the totals are the latest result's, read as-is rather than differenced.
    const cumulative = (input: number, output: number) => ({
      [MODEL]: { inputTokens: input, outputTokens: output, costUSD: 0.01 },
    });
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'text', text: 'one' }]),
      result({ modelUsage: cumulative(100, 40), total_cost_usd: 0.01 }),
      assistant('msg_2', [{ type: 'text', text: 'two' }]),
      result({ modelUsage: cumulative(250, 90), total_cost_usd: 0.02 }),
    ]);

    const agents = allSpans(h, 'invoke_agent claude-agent-sdk');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.attributes['gen_ai.usage.input_tokens']).toBe(250);
    expect(agents[0]?.attributes['gen_ai.usage.output_tokens']).toBe(90);
    expect(agents[0]?.attributes['genai.usage.cost_usd']).toBe(0.01);
    // Both model calls hang off that one span, in one trace.
    const chats = allSpans(h, `chat ${MODEL}`);
    expect(chats).toHaveLength(2);
    expect(new Set(chats.map((c) => c.spanContext().traceId)).size).toBe(1);
    expect(parentOf(h, chats[0]!)?.name).toBe('invoke_agent claude-agent-sdk');
    expect(parentOf(h, chats[1]!)?.name).toBe('invoke_agent claude-agent-sdk');
  });

  it('records an API failure on the model call, and still ends the run green', async () => {
    // subtype stays 'success' when a call fails on an API error, and the error text
    // is in `result`. The call is what failed, so that is where it belongs; a later
    // result that succeeds leaves the run itself green.
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'text', text: 'API Error: 400 unknown model' }]),
      result({ is_error: true, result: 'API Error: 400 unknown model', api_error_status: 400 }),
      assistant('msg_2', [{ type: 'text', text: 'recovered' }]),
      result({ result: 'recovered' }),
    ]);

    const chats = allSpans(h, `chat ${MODEL}`);
    expect(chats[0]?.status.code).toBe(2);
    expect(String(chats[0]?.status.message)).toContain('400 unknown model');
    expect(chats[1]?.status.code).toBe(1);
    expect(findSpan(h, 'invoke_agent claude-agent-sdk').status.code).toBe(1);
  });

  it('puts an early-stop failure on the run, not on the model call', async () => {
    // error_max_turns means the loop hit a limit; the call before it succeeded, so
    // marking that call failed would be a lie. The text lives in `errors`.
    await run(h, [
      init(),
      assistant('msg_1', [{ type: 'text', text: 'one' }]),
      result({
        subtype: 'error_max_turns',
        is_error: true,
        result: undefined,
        errors: ['Reached maximum number of turns (1)'],
        terminal_reason: 'max_turns',
      }),
    ]);

    expect(findSpan(h, `chat ${MODEL}`).status.code).toBe(1);
    const agent = findSpan(h, 'invoke_agent claude-agent-sdk');
    expect(agent.status.code).toBe(2);
    expect(String(agent.status.message)).toContain('Reached maximum number of turns');
  });

  it('resolves a bedrock-served run from the routing env, before the span opens', async () => {
    const traced = wrapQuery(
      h.client,
      fakeQuery([init(), assistant('msg_1', [{ type: 'text', text: 'hi' }]), result()]),
      {},
    );
    // options.env replaces rather than merges, so it is exactly what the CLI
    // subprocess sees — which is why the platform is knowable up front.
    await drain(
      traced({
        prompt: 'p',
        options: { model: MODEL, env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
      }),
    );

    // The conformant attribute, on every span — no extension needed.
    expect(findSpan(h, 'invoke_agent claude-agent-sdk').attributes['gen_ai.provider.name']).toBe(
      'aws.bedrock',
    );
    expect(findSpan(h, `chat ${MODEL}`).attributes['gen_ai.provider.name']).toBe('aws.bedrock');
  });

  it('defaults to anthropic when no routing env var is set', async () => {
    await run(h, [init(), assistant('msg_1', [{ type: 'text', text: 'hi' }]), result()]);
    expect(findSpan(h, `chat ${MODEL}`).attributes['gen_ai.provider.name']).toBe('anthropic');
  });

  it('emits no content under metadata_only', async () => {
    await run(
      h,
      [
        init(),
        assistant('msg_1', [
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'secret' } },
        ]),
        userToolResult('tu_1', 'sensitive output'),
        result(),
      ],
      { contentCapture: 'metadata_only' },
    );

    for (const span of h.spans.getFinishedSpans()) {
      expect(span.attributes['gen_ai.input.messages']).toBeUndefined();
      expect(span.attributes['gen_ai.output.messages']).toBeUndefined();
      expect(span.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
      expect(span.attributes['gen_ai.tool.call.result']).toBeUndefined();
    }
  });

  it('keeps two concurrent runs from bleeding into each other', async () => {
    const runOne = wrapQuery(
      h.client,
      fakeQuery([
        init('sess-a'),
        assistant('a_1', [{ type: 'text', text: 'A' }]),
        result({ session_id: 'sess-a' }),
      ]),
      { agentName: 'agent-a' },
    );
    const runTwo = wrapQuery(
      h.client,
      fakeQuery([
        init('sess-b'),
        assistant('b_1', [{ type: 'text', text: 'B' }]),
        result({ session_id: 'sess-b' }),
      ]),
      { agentName: 'agent-b' },
    );

    await Promise.all([
      drain(runOne({ prompt: 'a', options: { model: MODEL } })),
      drain(runTwo({ prompt: 'b', options: { model: MODEL } })),
    ]);

    const a = findSpan(h, 'invoke_agent agent-a');
    const b = findSpan(h, 'invoke_agent agent-b');
    expect(a.attributes['gen_ai.conversation.id']).toBe('sess-a');
    expect(b.attributes['gen_ai.conversation.id']).toBe('sess-b');

    const aChat = allSpans(h, `chat ${MODEL}`).find(
      (s) => parentOf(h, s)?.name === 'invoke_agent agent-a',
    );
    expect(String(aChat?.attributes['gen_ai.output.messages'])).toContain('A');
    expect(String(aChat?.attributes['gen_ai.output.messages'])).not.toContain('B');
  });

  it('yields every message unchanged to the caller', async () => {
    const messages = [init(), assistant('msg_1', [{ type: 'text', text: 'hi' }]), result()];
    const out = await run(h, messages);
    expect(out).toHaveLength(3);
    expect(out[1]).toBe(messages[1]);
  });
});
