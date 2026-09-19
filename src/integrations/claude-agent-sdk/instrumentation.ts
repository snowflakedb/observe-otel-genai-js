/**
 * OpenTelemetry instrumentation for the Claude Agent SDK.
 *
 * Registers like any other OTel instrumentation:
 *
 *   import { registerInstrumentations } from '@opentelemetry/instrumentation';
 *   import { ClaudeAgentSdkInstrumentation } from '@genai-otel/core/claude-agent-sdk/instrumentation';
 *
 *   registerInstrumentations({ instrumentations: [new ClaudeAgentSdkInstrumentation()] });
 *
 * It replaces the module's `query` export with the traced wrapper, so every
 * `query({ prompt, options })` in the process emits the `invoke_agent` /
 * `chat` / `execute_tool` tree with no per-call-site wiring.
 *
 * ## ESM is the only build, and that decides how you register it
 *
 * `@anthropic-ai/claude-agent-sdk` ships a single ESM entry (`sdk.mjs`, no CJS),
 * so require-in-the-middle has nothing to intercept and a native module namespace
 * cannot be written to. Measured on Node 22 against 0.3.239:
 *
 *     import * as sdk from '@anthropic-ai/claude-agent-sdk';
 *     Object.getOwnPropertyDescriptor(sdk, 'query')  // { writable: true, configurable: false }
 *     Reflect.set(sdk, 'query', fn)                  // false — the write is rejected
 *
 * Note the descriptor claims `writable: true` and the assignment still fails, and
 * fails *silently* (no throw). {@link canAssign} probes for this instead of
 * trusting the descriptor, so a doomed patch warns rather than emitting nothing.
 *
 * **Registration goes through the OpenTelemetry ESM loader hook**, either in the
 * app's own entry file or in a `--import` preload. Both are documented in
 * `docs/integrations.md`; the short version is:
 *
 *     import { register } from 'node:module';
 *     register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
 *     registerInstrumentations({ instrumentations: [new ClaudeAgentSdkInstrumentation()] });
 *     const sdk = await import('@anthropic-ai/claude-agent-sdk');   // dynamic
 *
 * import-in-the-middle rewrites the module so its exports are backed by mutable
 * bindings, the patch lands at load time, and the code that calls `query` is
 * untouched. The import has to be dynamic (or the whole setup moved to a preload)
 * because a static import is hoisted above `register()` and resolves first.
 *
 * The rule is only about *when*, never about import style: once the hook is in
 * place before the module loads, every form sees the patched function — namespace
 * or named, static or dynamic. What fails is a module that loaded before the hook
 * existed, and no later patch can reach it. {@link wrapQuery} sidesteps the
 * question entirely: no hook, no ordering, always exact.
 */

import {
  InstrumentationBase,
  type InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';

import { Client } from '../../client.js';
import { VERSION } from '../../version.js';
import { type ClaudeAgentSdkOptions, wrapQuery } from './index.js';
import type { AgentQueryFn } from './types.js';

const MODULE_NAME = '@anthropic-ai/claude-agent-sdk';
/** The SDK is pre-1.0; the message shapes this adapter reads are stable across 0.3.x. */
const SUPPORTED_VERSIONS = ['>=0.3.0 <1'];

/** Marker so a module patched twice (hook + manual) is only wrapped once. */
const PATCHED = Symbol.for('@genai-otel/claude-agent-sdk.patched');

/** The subset of the SDK's module namespace this instrumentation touches. */
interface ClaudeAgentSdkModuleExports {
  query?: AgentQueryFn;
  [PATCHED]?: boolean;
}

export interface ClaudeAgentSdkInstrumentationConfig
  extends InstrumentationConfig,
    ClaudeAgentSdkOptions {
  /**
   * Reuse an existing `Client`. When omitted, one is created lazily from the
   * instrumentation's tracer/meter (i.e. the globally-registered providers).
   */
  client?: Client;
}

/**
 * Returns true when `query` can actually be replaced on this namespace object.
 *
 * Property descriptors are not trustworthy here: a native ESM namespace can
 * report `writable: true` while `[[Set]]` still rejects the write, and a no-op
 * setter can accept a write without changing the exported binding. So probe with
 * a distinct value and check that it stuck, then restore.
 */
function canAssign(moduleExports: ClaudeAgentSdkModuleExports): boolean {
  const original = moduleExports.query;
  if (typeof original !== 'function') return false;
  const probe = new Proxy(original, {}) as AgentQueryFn;
  try {
    if (!Reflect.set(moduleExports, 'query', probe)) return false;
    if (Reflect.get(moduleExports, 'query') !== probe) return false;
    return Reflect.set(moduleExports, 'query', original);
  } catch {
    try {
      Reflect.set(moduleExports, 'query', original);
    } catch {
      // Nothing to restore on a sealed namespace.
    }
    return false;
  }
}

export class ClaudeAgentSdkInstrumentation extends InstrumentationBase<ClaudeAgentSdkInstrumentationConfig> {
  /** The `Client` we created ourselves, so {@link shutdown} knows it owns it. */
  private ownedClient?: Client;
  /** Original `query` per patched namespace, so {@link disable} can put it back. */
  private readonly originals = new Map<ClaudeAgentSdkModuleExports, AgentQueryFn>();

  constructor(config: ClaudeAgentSdkInstrumentationConfig = {}) {
    super('@genai-otel/instrumentation-claude-agent-sdk', VERSION, config);
  }

  protected init(): InstrumentationNodeModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      MODULE_NAME,
      SUPPORTED_VERSIONS,
      (moduleExports: ClaudeAgentSdkModuleExports, moduleVersion?: string) =>
        this.patch(moduleExports, moduleVersion),
      (moduleExports?: ClaudeAgentSdkModuleExports) => this.unpatch(moduleExports),
    );
  }

  private resolveClient(): Client {
    const { client } = this.getConfig();
    if (client) return client;
    if (!this.ownedClient) {
      this.ownedClient = new Client({ tracer: this.tracer, meter: this.meter });
    }
    return this.ownedClient;
  }

  /** The adapter options, with the instrumentation-level keys stripped. */
  private adapterOptions(): ClaudeAgentSdkOptions {
    const { client: _client, enabled: _enabled, ...options } = this.getConfig();
    return options;
  }

  private patch(
    moduleExports: ClaudeAgentSdkModuleExports,
    moduleVersion?: string,
  ): ClaudeAgentSdkModuleExports {
    if (!moduleExports) return moduleExports;
    if (moduleExports[PATCHED]) {
      this._diag.debug(`${MODULE_NAME} already patched; skipping`);
      return moduleExports;
    }
    const original = moduleExports.query;
    if (typeof original !== 'function') {
      this._diag.debug(`${MODULE_NAME} has no query export; skipping patch`);
      return moduleExports;
    }
    if (!canAssign(moduleExports)) {
      this._diag.warn(
        `cannot replace the query export on ${MODULE_NAME} — the module namespace rejects assignment. Register the OpenTelemetry ESM loader hook, or wrap the call site with wrapQuery(client, query, options).`,
      );
      return moduleExports;
    }

    this._diag.debug(`patching ${MODULE_NAME} query${moduleVersion ? ` (v${moduleVersion})` : ''}`);
    const traced = wrapQuery(this.resolveClient(), original, this.adapterOptions());
    Reflect.set(moduleExports, 'query', traced);
    Object.defineProperty(moduleExports, PATCHED, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    // Keep the original reachable so unpatch works even for hook-supplied modules.
    this.originals.set(moduleExports, original);
    return moduleExports;
  }

  private unpatch(moduleExports?: ClaudeAgentSdkModuleExports): void {
    if (!moduleExports?.[PATCHED]) return;
    const original = this.originals.get(moduleExports);
    if (original) {
      try {
        Reflect.set(moduleExports, 'query', original);
      } catch {
        this._diag.debug(`could not restore the original query export on ${MODULE_NAME}`);
      }
    }
    this.originals.delete(moduleExports);
    Reflect.deleteProperty(moduleExports, PATCHED);
    this._diag.debug(`unpatched ${MODULE_NAME} query`);
  }

  /**
   * Removes the patch. Unlike {@link shutdown} this does not flush a
   * self-created `Client` — rely on your `TracerProvider` shutdown, or call
   * `shutdown()` instead.
   */
  override disable(): void {
    for (const moduleExports of [...this.originals.keys()]) this.unpatch(moduleExports);
    super.disable();
  }

  /**
   * Removes the patch and shuts down the `Client`, but only if this
   * instrumentation created it. A client you passed in is yours to shut down.
   */
  async shutdown(): Promise<void> {
    this.disable();
    if (this.ownedClient) {
      const owned = this.ownedClient;
      this.ownedClient = undefined;
      await owned.shutdown();
    }
  }
}
