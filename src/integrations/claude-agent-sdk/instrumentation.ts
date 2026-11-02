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
 * OpenTelemetry instrumentation for the Claude Agent SDK.
 *
 *   import { registerInstrumentations } from '@opentelemetry/instrumentation';
 *   import { ClaudeAgentSdkInstrumentation } from '@genai-otel/core/claude-agent-sdk/instrumentation';
 *
 *   registerInstrumentations({ instrumentations: [new ClaudeAgentSdkInstrumentation()] });
 *
 * It replaces the `query` and `startup` exports of the root entry and the `/core` entry
 * with traced wrappers, so every `query()` in the process is traced with no
 * per-call-site wiring.
 *
 * The SDK ships only an ESM build, and a native ESM namespace rejects writes, so the
 * patch needs the OpenTelemetry ESM loader hook registered before the SDK is first
 * imported (see `docs/integrations.md`). Without the hook, use `wrapQuery` from
 * `@genai-otel/core/claude-agent-sdk` at the call site instead.
 */

import {
  InstrumentationBase,
  type InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';

import { Client } from '../../client.js';
import type { IdentityFields } from '../../models/identity.js';
import { VERSION } from '../../version.js';
import { type ClaudeAgentSdkOptions, wrapQuery, wrapStartup } from './index.js';
import { isTracedQuery } from './traced-queries.js';
import type { AgentQueryFn, AgentStartupFn } from './types.js';

const MODULE_NAME = '@anthropic-ai/claude-agent-sdk';
// Pre-1.0, so a minor release can break the message shapes read here. Tested live on
// 0.3.142 (the first 0.3 release) through 0.3.278, each with its bundled CLI.
const SUPPORTED_VERSIONS = ['>=0.3.142 <0.4.0'];
/** The `/core` entry, a separate bundle from the root entry. Shipped since 0.3.282. */
const CORE_FILE = `${MODULE_NAME}/core.mjs`;

/** The subset of the SDK's module namespace this instrumentation touches. */
interface ClaudeAgentSdkModuleExports {
  query?: AgentQueryFn;
  startup?: AgentStartupFn;
}

/** Identity is set per call with `wrapQuery` options or a `withX(...)` scope, not here. */
export interface ClaudeAgentSdkInstrumentationConfig
  extends InstrumentationConfig,
    Omit<ClaudeAgentSdkOptions, keyof IdentityFields> {
  /** Reuse an existing `Client`. When omitted, one is created from the global providers. */
  client?: Client;
}

/**
 * Whether `query` can really be replaced. A native ESM namespace can report
 * `writable: true` and still reject the write, so probe instead of trusting the
 * property descriptor.
 */
function canAssign(moduleExports: ClaudeAgentSdkModuleExports, original: AgentQueryFn): boolean {
  const probe = new Proxy(original, {});
  if (!Reflect.set(moduleExports, 'query', probe) || moduleExports.query !== probe) return false;
  return Reflect.set(moduleExports, 'query', original);
}

export class ClaudeAgentSdkInstrumentation extends InstrumentationBase<ClaudeAgentSdkInstrumentationConfig> {
  /** The `Client` we created ourselves, so {@link shutdown} knows it owns it. */
  private ownedClient?: Client;
  /** Original exports per patched namespace, so {@link disable} can put them back. */
  private readonly originals = new Map<ClaudeAgentSdkModuleExports, ClaudeAgentSdkModuleExports>();

  constructor(config: ClaudeAgentSdkInstrumentationConfig = {}) {
    super('@genai-otel/instrumentation-claude-agent-sdk', VERSION, config);
  }

  protected init(): InstrumentationNodeModuleDefinition {
    const patch = (moduleExports: ClaudeAgentSdkModuleExports, moduleVersion?: string) =>
      this.patch(moduleExports, moduleVersion);
    const unpatch = (moduleExports?: ClaudeAgentSdkModuleExports) => this.unpatch(moduleExports);
    return new InstrumentationNodeModuleDefinition(
      MODULE_NAME,
      SUPPORTED_VERSIONS,
      patch,
      unpatch,
      [new InstrumentationNodeModuleFile(CORE_FILE, SUPPORTED_VERSIONS, patch, unpatch)],
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
  private adapterOptions(): Omit<ClaudeAgentSdkOptions, keyof IdentityFields> {
    const { client: _client, enabled: _enabled, ...options } = this.getConfig();
    return options;
  }

  private patch(
    moduleExports: ClaudeAgentSdkModuleExports,
    moduleVersion?: string,
  ): ClaudeAgentSdkModuleExports {
    const original = moduleExports.query;
    if (typeof original !== 'function') {
      this._diag.debug(`${MODULE_NAME} has no query export; skipping patch`);
      return moduleExports;
    }
    // Marked on the function, not the module: the loader hook's module object
    // silently drops properties it does not export.
    if (isTracedQuery(original)) {
      this._diag.debug(`${MODULE_NAME} already patched; skipping`);
      return moduleExports;
    }
    if (!canAssign(moduleExports, original)) {
      this._diag.warn(
        `cannot replace the query export on ${MODULE_NAME}: the module namespace rejects assignment. Register the OpenTelemetry ESM loader hook before the SDK is imported. If the app loads the SDK with require(), or the hook cannot be used, wrap the call site with wrapQuery(client, query, options) from @genai-otel/core/claude-agent-sdk.`,
      );
      return moduleExports;
    }

    this._diag.debug(`patching ${MODULE_NAME} query${moduleVersion ? ` (v${moduleVersion})` : ''}`);
    const client = this.resolveClient();
    const options = this.adapterOptions();
    Reflect.set(moduleExports, 'query', wrapQuery(client, original, options));
    // Same namespace as query, so the write that worked there works here.
    const startup = moduleExports.startup;
    if (typeof startup === 'function') {
      Reflect.set(moduleExports, 'startup', wrapStartup(client, startup, options));
    }
    this.originals.set(moduleExports, { query: original, startup });
    return moduleExports;
  }

  private unpatch(moduleExports?: ClaudeAgentSdkModuleExports): void {
    const original = moduleExports && this.originals.get(moduleExports);
    if (!moduleExports || !original) return;
    Reflect.set(moduleExports, 'query', original.query);
    if (original.startup) Reflect.set(moduleExports, 'startup', original.startup);
    this.originals.delete(moduleExports);
    this._diag.debug(`unpatched ${MODULE_NAME}`);
  }

  /**
   * Removes the patch. Unlike {@link shutdown} this does not flush a
   * self-created `Client`: rely on your `TracerProvider` shutdown, or call
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
