/**
 * Tests for `LangChainInstrumentation`.
 *
 * Unlike the adapter tests (which drive `handle*` directly), these exercise the
 * real auto-injection path: a genuine `RunnableLambda` is invoked with NO
 * callbacks, and we assert that spans are still emitted because the
 * instrumentation patched `CallbackManager` to inject the handler.
 *
 * The patch is applied by invoking the instrumentation's own module-definition
 * `patch` against the live `@langchain/core` CallbackManager — the same class
 * LangChain uses internally — which is exactly what `registerInstrumentations`
 * does on module load, minus the require/import hook that vitest doesn't fire.
 */

import { CallbackManager } from '@langchain/core/callbacks/manager';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { RunnableLambda } from '@langchain/core/runnables';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LangChainInstrumentation } from '../../src/integrations/langchain/instrumentation.js';
import {
  ATTR_AGENT_NAME,
  ATTR_CONVERSATION_ID,
  ATTR_OPERATION_NAME,
  OP_INVOKE_AGENT,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

/**
 * Applies the instrumentation's real module patch to the live CallbackManager
 * and returns an unpatch fn. Uses `getModuleDefinitions()` so the exact patch
 * that ships to production is what gets exercised here. The definition's `name`
 * is the `.cjs` file; its `patch`/`unpatch` are what require-in-the-middle calls
 * in production.
 */
function patchLangChain(instr: LangChainInstrumentation): () => void {
  const def = instr.getModuleDefinitions()[0];
  if (!def?.patch) throw new Error('CallbackManager module patch not found in instrumentation');
  def.patch({ CallbackManager });
  return () => def.unpatch?.({ CallbackManager });
}

function invokeAgentSpans(h: Harness) {
  return h.spans
    .getFinishedSpans()
    .filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT);
}

describe('LangChainInstrumentation — auto-injection', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('instruments a bare invoke with no callbacks passed', async () => {
    // `enabled: false` skips the require-hook registration; we patch manually so
    // the test doesn't depend on module-load interception under vitest.
    const instr = new LangChainInstrumentation({
      client: h.client,
      agentName: 'auto-agent',
      enabled: false,
    });
    const unpatch = patchLangChain(instr);
    try {
      const echo = RunnableLambda.from((x: unknown) => x);
      await echo.invoke({ q: 'hello' });
      await awaitAllCallbacks();
      await instr.handler.dispose();

      const spans = invokeAgentSpans(h);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes[ATTR_AGENT_NAME]).toBe('auto-agent');
    } finally {
      unpatch();
    }
  });

  it('sets gen_ai.conversation.id on the auto-patched invoke_agent root from thread_id', async () => {
    // Regression: with no callbacks passed, LangChain's
    // `_configureSync` returns no manager for the root run and drops the
    // metadata it was handed. The wrapper fabricates a manager, so without the
    // fix the root `invoke_agent` span has no conversation id even though its
    // children (whose managers LangChain builds normally) do. `thread_id`
    // arrives via `configurable`, which LangChain promotes into run metadata —
    // the same shape a LangGraph checkpointer produces.
    const instr = new LangChainInstrumentation({ client: h.client, enabled: false });
    const unpatch = patchLangChain(instr);
    try {
      const echo = RunnableLambda.from((x: unknown) => x);
      await echo.invoke({ q: 'hello' }, { configurable: { thread_id: 'conv-auto-1' } });
      await awaitAllCallbacks();
      await instr.handler.dispose();

      const spans = invokeAgentSpans(h);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes[ATTR_CONVERSATION_ID]).toBe('conv-auto-1');
    } finally {
      unpatch();
    }
  });

  it('sets gen_ai.conversation.id on the auto-patched root from explicit metadata', async () => {
    // Same fabricated-manager path, but `thread_id` supplied directly as run
    // metadata rather than promoted from `configurable`.
    const instr = new LangChainInstrumentation({ client: h.client, enabled: false });
    const unpatch = patchLangChain(instr);
    try {
      const echo = RunnableLambda.from((x: unknown) => x);
      await echo.invoke({ q: 'hello' }, { metadata: { thread_id: 'conv-auto-2' } });
      await awaitAllCallbacks();
      await instr.handler.dispose();

      const spans = invokeAgentSpans(h);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes[ATTR_CONVERSATION_ID]).toBe('conv-auto-2');
    } finally {
      unpatch();
    }
  });

  it('does not double-instrument when the same run nests', async () => {
    const instr = new LangChainInstrumentation({
      client: h.client,
      agentName: 'auto-agent',
      captureNestedChains: false,
      enabled: false,
    });
    const unpatch = patchLangChain(instr);
    try {
      // A pipe is a RunnableSequence: the sequence is the top-level run and each
      // step is a child run (parentRunId set) that inherits the same handler.
      const chain = RunnableLambda.from((x: unknown) => x).pipe(
        RunnableLambda.from((x: unknown) => x),
      );
      await chain.invoke({ q: 'hello' });
      await awaitAllCallbacks();
      await instr.handler.dispose();

      // Only the top-level sequence becomes an invoke_agent span; the nested
      // steps inherit the handler but are skipped (captureNestedChains: false).
      expect(invokeAgentSpans(h)).toHaveLength(1);
    } finally {
      unpatch();
    }
  });

  it('stops instrumenting after the module is unpatched', async () => {
    const instr = new LangChainInstrumentation({ client: h.client, enabled: false });
    patchLangChain(instr)(); // patch then immediately unpatch

    const echo = RunnableLambda.from((x: unknown) => x);
    await echo.invoke({ q: 'hello' });
    await awaitAllCallbacks();
    await instr.handler.dispose();

    expect(invokeAgentSpans(h)).toHaveLength(0);
  });
});

describe('LangChainInstrumentation — manuallyInstrument (ESM entry point)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  // Undo the patch applied via `manuallyInstrument` so the shared live
  // CallbackManager doesn't stay wrapped across tests.
  function unpatch(instr: LangChainInstrumentation): void {
    instr.getModuleDefinitions()[0]?.unpatch?.({ CallbackManager });
  }

  it('injects the handler via the public manuallyInstrument entry point', async () => {
    const instr = new LangChainInstrumentation({
      client: h.client,
      agentName: 'manual-agent',
      enabled: false,
    });
    instr.manuallyInstrument({ CallbackManager });
    try {
      const echo = RunnableLambda.from((x: unknown) => x);
      await echo.invoke({ q: 'hello' });
      await awaitAllCallbacks();
      await instr.handler.dispose();

      const spans = invokeAgentSpans(h);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes[ATTR_AGENT_NAME]).toBe('manual-agent');
    } finally {
      unpatch(instr);
    }
  });

  it('is idempotent when called more than once', async () => {
    const instr = new LangChainInstrumentation({ client: h.client, enabled: false });
    instr.manuallyInstrument({ CallbackManager });
    instr.manuallyInstrument({ CallbackManager });
    try {
      const echo = RunnableLambda.from((x: unknown) => x);
      await echo.invoke({ q: 'hello' });
      await awaitAllCallbacks();
      await instr.handler.dispose();

      // A second patch must not double-wrap `_configureSync`, so the handler is
      // still injected exactly once.
      expect(invokeAgentSpans(h)).toHaveLength(1);
    } finally {
      unpatch(instr);
    }
  });
});
