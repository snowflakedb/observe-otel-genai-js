/**
 * Tests for `ClaudeAgentSdkInstrumentation`.
 *
 * These drive the patch through the `InstrumentationNodeModuleDefinition` that
 * `init()` returns — the same function import-in-the-middle calls when the loader
 * hook rewrites the module. That is the only way the patch runs in production, so
 * it is what the tests exercise.
 *
 * The SDK is ESM-only, so the interesting cases are all about whether the module
 * namespace accepts the patch: a plain object does, a frozen namespace does not,
 * and a namespace with a lying property descriptor must be detected rather than
 * silently no-op'd.
 */

import { DiagLogLevel, diag } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAgentSdkInstrumentation } from '../../src/integrations/claude-agent-sdk/instrumentation.js';
import type { AgentMessage, AgentQueryFn } from '../../src/integrations/claude-agent-sdk/types.js';
import { type Harness, createHarness } from '../_harness.js';

const MODEL = 'claude-sonnet-4-5';

function messages(): AgentMessage[] {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: MODEL },
    {
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: MODEL,
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
      },
      parent_tool_use_id: null,
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      is_error: false,
      num_turns: 1,
      result: 'hi',
      stop_reason: 'end_turn',
      total_cost_usd: 0.001,
      modelUsage: { [MODEL]: { inputTokens: 10, outputTokens: 2, costUSD: 0.001 } },
    },
  ];
}

/** Stands in for the SDK's `query` export. */
function rawQuery() {
  return async function* () {
    for (const m of messages()) yield m;
  };
}

/** A mutable module namespace, like a bundled or IITM-rewritten module. */
function mutableModule(): { query: AgentQueryFn; other: () => string } {
  return { query: rawQuery() as unknown as AgentQueryFn, other: () => 'untouched' };
}

/**
 * Runs the module patch the way the loader hook does. `init()` is protected
 * because nothing but OTel should call it; reaching through in a test is the
 * price of covering the real path instead of a test-only entry point.
 */
function patchModule(
  instrumentation: ClaudeAgentSdkInstrumentation,
  mod: unknown,
  version = '0.3.239',
): void {
  const def = (
    instrumentation as unknown as {
      init(): { patch?: (m: unknown, v?: string) => unknown };
    }
  ).init();
  def.patch?.(mod, version);
}

async function drain(it: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

describe('ClaudeAgentSdkInstrumentation', () => {
  let h: Harness;
  let instrumentation: ClaudeAgentSdkInstrumentation;

  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    instrumentation?.disable();
    await h.shutdown();
    diag.disable();
  });

  it('patches the query export and emits the full span tree with no call-site wiring', async () => {
    const mod = mutableModule();
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client, agentName: 'auto' });
    patchModule(instrumentation, mod);

    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));

    const names = h.spans.getFinishedSpans().map((s) => s.name);
    expect(names).toContain('invoke_agent auto');
    expect(names).toContain(`chat ${MODEL}`);
  });

  it('passes adapter options through and strips the instrumentation-level ones', async () => {
    const mod = mutableModule();
    instrumentation = new ClaudeAgentSdkInstrumentation({
      client: h.client,
      agentName: 'configured',
      contentCapture: 'metadata_only',
      enabled: true,
    });
    patchModule(instrumentation, mod);

    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));

    const turn = h.spans.getFinishedSpans().find((s) => s.name === 'invoke_agent configured');
    expect(turn).toBeDefined();
    // `contentCapture` reached the adapter; `client` and `enabled` did not leak
    // into it as attributes.
    expect(turn?.attributes['gen_ai.input.messages']).toBeUndefined();
  });

  it('is idempotent — patching twice does not double-wrap', async () => {
    const mod = mutableModule();
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);
    const afterFirst = mod.query;
    patchModule(instrumentation, mod);
    expect(mod.query).toBe(afterFirst);

    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));
    expect(
      h.spans.getFinishedSpans().filter((s) => s.name.startsWith('invoke_agent')),
    ).toHaveLength(1);
  });

  it('restores the original export on disable', () => {
    const mod = mutableModule();
    const before = mod.query;
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);
    expect(mod.query).not.toBe(before);

    instrumentation.disable();
    expect(mod.query).toBe(before);
  });

  it('leaves other exports alone', () => {
    const mod = mutableModule();
    const other = mod.other;
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);
    expect(mod.other).toBe(other);
  });

  it('warns and leaves the module untouched when the namespace is frozen', async () => {
    const warn = vi.fn();
    diag.setLogger(
      { verbose: () => {}, debug: () => {}, info: () => {}, warn, error: () => {} },
      DiagLogLevel.WARN,
    );

    const mod = Object.freeze(mutableModule());
    const before = mod.query;
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);

    expect(mod.query).toBe(before);
    // OTel's component logger prepends its namespace, so the message is arg 2.
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('rejects assignment'),
    );

    // The caller's stream still works — a failed patch must not break the SDK.
    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));
    expect(h.spans.getFinishedSpans()).toHaveLength(0);
  });

  it('detects a namespace whose descriptor lies about being writable', () => {
    const warn = vi.fn();
    diag.setLogger(
      { verbose: () => {}, debug: () => {}, info: () => {}, warn, error: () => {} },
      DiagLogLevel.WARN,
    );

    // A no-op setter: assignment "succeeds" but the binding never changes. This
    // is the case a descriptor check would miss and the probe catches.
    const original = rawQuery();
    const mod = {} as { query?: unknown };
    Object.defineProperty(mod, 'query', {
      get: () => original,
      set: () => {
        /* silently swallow */
      },
      configurable: true,
      enumerable: true,
    });

    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);

    expect(mod.query).toBe(original);
    // OTel's component logger prepends its namespace, so the message is arg 2.
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('rejects assignment'),
    );
  });

  it('skips a namespace with no query export', () => {
    const mod = { other: () => 'x' } as { query?: unknown; other: () => string };
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    expect(() => patchModule(instrumentation, mod)).not.toThrow();
    expect(mod.query).toBeUndefined();
  });

  it('does not shut down a client it was given', async () => {
    const mod = mutableModule();
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);
    await instrumentation.shutdown();

    // The harness client is still usable, so shutdown() left it alone.
    const rec = h.client.startGeneration({ model: { provider: 'anthropic', name: MODEL } });
    await rec.end();
    expect(h.spans.getFinishedSpans().some((s) => s.name === `chat ${MODEL}`)).toBe(true);
  });

  it('creates its own client when none is supplied', async () => {
    const mod = mutableModule();
    instrumentation = new ClaudeAgentSdkInstrumentation({ agentName: 'self-client' });
    patchModule(instrumentation, mod);

    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));

    // The self-created client uses the globally-registered providers, which the
    // harness owns — so its spans land in the harness exporter.
    expect(h.spans.getFinishedSpans().map((s) => s.name)).toContain('invoke_agent self-client');
    await instrumentation.shutdown();
  });
});
