/**
 * Tests for `ClaudeAgentSdkInstrumentation`.
 *
 * These drive the patch through the definition `init()` returns, which is what the
 * ESM loader hook calls. The interesting cases are about whether the module object
 * accepts the patch.
 */

import { DiagLogLevel, diag } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAgentSdkInstrumentation } from '../../src/integrations/claude-agent-sdk/instrumentation.js';
import type {
  AgentMessage,
  AgentQueryParams,
} from '../../src/integrations/claude-agent-sdk/types.js';
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

type QueryFn = (params: AgentQueryParams) => AsyncIterable<AgentMessage>;

/** A mutable module namespace, like a bundled or loader-hook-rewritten module. */
function mutableModule(): { query: QueryFn; other: () => string } {
  return { query: rawQuery(), other: () => 'untouched' };
}

/** Like the loader hook's module object: accepts writes to exports, drops anything else. */
function hookModule(): { query: QueryFn } {
  const mod = { query: rawQuery() };
  return new Proxy(mod, {
    defineProperty: (target, key, desc) =>
      key !== 'query' || Reflect.defineProperty(target, key, desc),
    set: (target, key, value) => key !== 'query' || Reflect.set(target, key, value),
  });
}

/** Captures diag warnings. OTel's component logger passes its namespace first. */
function captureWarnings() {
  const warn = vi.fn();
  diag.setLogger(
    { verbose: () => {}, debug: () => {}, info: () => {}, warn, error: () => {} },
    DiagLogLevel.WARN,
  );
  return warn;
}

function agentSpans(h: Harness) {
  return h.spans.getFinishedSpans().filter((s) => s.name.startsWith('invoke_agent'));
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

  it('passes adapter options through to the adapter', async () => {
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
    expect(turn?.attributes['gen_ai.input.messages']).toBeUndefined();
  });

  it('does not double-wrap when patched twice', async () => {
    const mod = mutableModule();
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);
    const afterFirst = mod.query;
    patchModule(instrumentation, mod);
    expect(mod.query).toBe(afterFirst);

    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));
    expect(agentSpans(h)).toHaveLength(1);
  });

  it('does not double-wrap when a second instrumentation patches the same module', async () => {
    const mod = hookModule();
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    const second = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);
    patchModule(second, mod);

    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));
    expect(agentSpans(h)).toHaveLength(1);
    second.disable();
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

  it('restores and re-patches a loader-hook module across disable and enable', async () => {
    const mod = hookModule();
    const before = mod.query;
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);
    instrumentation.disable();
    expect(mod.query).toBe(before);

    patchModule(instrumentation, mod);
    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));
    expect(agentSpans(h)).toHaveLength(1);
  });

  it('patches the startup export, and restores it on disable', async () => {
    const startup = async () => ({ query: (_prompt: unknown) => rawQuery()() });
    const mod = { ...mutableModule(), startup };
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);

    const warm = await mod.startup();
    await drain(warm.query('hello') as AsyncIterable<AgentMessage>);
    expect(agentSpans(h)).toHaveLength(1);

    instrumentation.disable();
    expect(mod.startup).toBe(startup);
  });

  it('leaves other exports alone', () => {
    const mod = mutableModule();
    const other = mod.other;
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);
    expect(mod.other).toBe(other);
  });

  it('warns and leaves the module untouched when the namespace is frozen', async () => {
    const warn = captureWarnings();

    const mod = Object.freeze(mutableModule());
    const before = mod.query;
    instrumentation = new ClaudeAgentSdkInstrumentation({ client: h.client });
    patchModule(instrumentation, mod);

    expect(mod.query).toBe(before);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('rejects assignment'),
    );

    // The caller's stream still works: a failed patch must not break the SDK.
    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));
    expect(h.spans.getFinishedSpans()).toHaveLength(0);
  });

  it('detects a namespace whose descriptor lies about being writable', () => {
    const warn = captureWarnings();

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

  it('shuts down the client it created', async () => {
    const mod = mutableModule();
    instrumentation = new ClaudeAgentSdkInstrumentation();
    patchModule(instrumentation, mod);
    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));
    const owned = (instrumentation as unknown as { ownedClient: Harness['client'] }).ownedClient;

    await instrumentation.shutdown();
    expect(() =>
      owned.startGeneration({ model: { provider: 'anthropic', name: MODEL } }),
    ).toThrow();
  });

  it('creates its own client when none is supplied', async () => {
    const mod = mutableModule();
    instrumentation = new ClaudeAgentSdkInstrumentation({ agentName: 'self-client' });
    patchModule(instrumentation, mod);

    await drain(mod.query({ prompt: 'hello', options: { model: MODEL } }));

    // The self-created client uses the globally-registered providers, which the
    // harness owns, so its spans land in the harness exporter.
    expect(h.spans.getFinishedSpans().map((s) => s.name)).toContain('invoke_agent self-client');
    await instrumentation.shutdown();
  });
});
