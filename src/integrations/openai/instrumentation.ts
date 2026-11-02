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
 * OpenTelemetry instrumentation for the `openai` SDK.
 *
 * Registers like any other OTel instrumentation:
 *
 *   import { registerInstrumentations } from '@opentelemetry/instrumentation';
 *   import { OpenAIInstrumentation } from '@genai-otel/core/openai/instrumentation';
 *
 *   registerInstrumentations({ instrumentations: [new OpenAIInstrumentation()] });
 *
 * It patches three prototype methods (`chat.completions.create`,
 * `responses.create`, `embeddings.create`) so every OpenAI call in the process
 * is traced without the caller wrapping their client. This is the automatic
 * counterpart to `wrapOpenAI(client, openai)` and shares its mapping logic; only
 * the route the patch takes to `create` differs.
 *
 * ## Why the prototype statics
 *
 * The `openai` client class re-exports every resource class as a static:
 * `OpenAI.Chat.Completions`, `OpenAI.Responses`, `OpenAI.Embeddings`. An
 * identity check confirms these are the same class objects whose prototypes back
 * `client.chat.completions`, `client.responses`, and `client.embeddings`. So one
 * hook on the package's top-level exports reaches all three prototypes, the same
 * way under CJS and ESM, and it leans on the public exports alone: repackaging
 * the dist files cannot move the patch target.
 *
 * ## CJS vs ESM
 *
 *  - **CJS** auto-patches with zero code: once `registerInstrumentations` runs
 *    (before the app first `require`s `openai`), require-in-the-middle
 *    intercepts the module and we patch the statics.
 *  - **ESM** goes through {@link OpenAIInstrumentation.manuallyInstrument}:
 *    import the module namespace and hand it over once at startup. Needs no
 *    launch flags.
 *
 * ## Relationship to `wrapOpenAI`
 *
 * Install both at once and you get one span per call: the patch marks each
 * method it wraps, and the `wrapOpenAI` proxy passes marked methods straight
 * through. See `../_common/instrumented.ts`.
 */

import {
  InstrumentationBase,
  type InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
  isWrapped,
} from '@opentelemetry/instrumentation';

import { Client } from '../../client.js';
import type { IdentityFields } from '../../models/identity.js';
import { VERSION } from '../../version.js';
import { isInstrumented, markInstrumented } from '../_common/instrumented.js';
import {
  type OpenAIAdapterOptions,
  patchChatCompletionsCreate,
  patchEmbeddingsCreate,
  patchResponsesCreate,
} from './index.js';

/**
 * Covers `openai` v4 through v7. We verified the three resource statics, and
 * their identity with the instance prototypes, on v6 and v7. `Responses` appears
 * from the 4.x releases that introduced the Responses API onward; when a version
 * lacks one resource we skip that resource and patch the rest.
 *
 * v7 has to be in range: `@openai/agents-core` depends on `openai ^7.2.0`, so a
 * range stopping at v6 would decline to patch the copy the Agents SDK calls,
 * leaving agent runs with no model-call span.
 */
const SUPPORTED_VERSIONS = ['>=4.0.0 <8'];

/** What to tell someone whose `openai` prototypes another library patched first. */
const FOREIGN_PATCH_ADVICE = [
  'deferring to it so you do not get two spans per call.',
  'This library will not record these calls, and attributes it alone provides',
  '(including the conversation id and agent name that the OpenAI Agents',
  'integration bridges onto model calls) will be missing.',
  'To keep them, disable the other one. For auto-instrumentations:',
  "getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-openai': { enabled: false } }),",
  'or set OTEL_NODE_DISABLED_INSTRUMENTATIONS=openai. That variable takes a bare',
  'package-name suffix, so it ignores the full package name.',
].join(' ');

/** The `create` methods we patch, and where each one lives. */
type ResourceKey = 'chat.completions' | 'responses' | 'embeddings';

/** Shape of the `openai` module namespace we rely on. */
interface OpenAIModuleExports {
  OpenAI?: OpenAIClientClass;
  default?: OpenAIClientClass;
}

/** Minimal shape of a resource class: a constructor with a `create` prototype method. */
interface ResourceClass {
  prototype: { create?: (...args: unknown[]) => unknown };
}

/** The statics on the `OpenAI` client class that expose the resource classes. */
interface OpenAIClientClass {
  Chat?: { Completions?: ResourceClass };
  Responses?: ResourceClass;
  Embeddings?: ResourceClass;
}

/**
 * Config for {@link OpenAIInstrumentation}. Extends the OTel
 * `InstrumentationConfig` (e.g. `enabled`) and accepts the per-call metadata of
 * the adapter except identity. Values supplied here act as process-wide defaults;
 * a call can override them via `withMetadata(params, options)`. Identity comes
 * from `withMetadata`, the enclosing `withX(...)` scope, or the `Client`.
 */
export interface OpenAIInstrumentationConfig
  extends InstrumentationConfig,
    Omit<OpenAIAdapterOptions, keyof IdentityFields> {
  /**
   * Reuse an existing `Client`. When omitted, the instrumentation builds one on
   * first use from its own tracer/meter (the globally-registered providers).
   */
  client?: Client;
}

export class OpenAIInstrumentation extends InstrumentationBase<OpenAIInstrumentationConfig> {
  private clientInstance?: Client;
  /**
   * The `Client` we built ourselves (when the caller supplied none), so
   * {@link shutdown} knows it owns the lifecycle. We leave a caller-supplied
   * client alone; its owner shuts it down.
   */
  private ownedClient?: Client;
  /**
   * Every module this instance patched, so {@link disable} can unpatch them all.
   * OTel's hook remembers only the last copy of a module it loaded, and never sees
   * ones passed to {@link manuallyInstrument}.
   */
  private readonly patchedModules = new Set<OpenAIModuleExports>();
  /**
   * The wrappers this instance installed. Unpatching removes only these, never a
   * wrapper we deferred to (another library's, or another instance's).
   */
  private readonly ownWrappers = new WeakSet<object>();

  constructor(config: OpenAIInstrumentationConfig = {}) {
    super('@genai-otel/instrumentation-openai', VERSION, config);
  }

  protected init(): InstrumentationNodeModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      'openai',
      SUPPORTED_VERSIONS,
      (moduleExports: OpenAIModuleExports, moduleVersion?: string) =>
        this.patchModule(moduleExports, moduleVersion),
      (moduleExports?: OpenAIModuleExports) => this.unpatchModule(moduleExports),
    );
  }

  /**
   * Patch an `openai` module namespace directly.
   *
   * Use this when the automatic require/import hook cannot fire, as in an ESM
   * project started without the OpenTelemetry loader hook. Import the module and
   * hand it over once, before any client makes a call:
   *
   *   import * as OpenAIModule from 'openai';
   *   instrumentation.manuallyInstrument(OpenAIModule);
   *
   * Idempotent: patching the same module twice is a no-op.
   */
  manuallyInstrument(moduleExports: object): void {
    this._diag.debug('manually instrumenting openai');
    this.patchModule(moduleExports as OpenAIModuleExports);
  }

  /**
   * The `Client` this instrumentation records through. Config can supply one;
   * otherwise this getter builds it on first use from the instrumentation's own
   * tracer/meter.
   */
  get client(): Client {
    if (!this.clientInstance) {
      const { client } = this.getConfig();
      if (client) {
        this.clientInstance = client;
      } else {
        this.clientInstance = new Client({ tracer: this.tracer, meter: this.meter });
        this.ownedClient = this.clientInstance;
      }
    }
    return this.clientInstance;
  }

  /** The per-call metadata defaults from config, minus instrumentation-only keys. */
  private adapterDefaults(): Omit<OpenAIAdapterOptions, keyof IdentityFields> {
    const { client: _client, enabled: _enabled, ...defaults } = this.getConfig();
    return defaults;
  }

  private patchModule(
    moduleExports: OpenAIModuleExports,
    moduleVersion?: string,
  ): OpenAIModuleExports {
    const OpenAIClass = moduleExports?.OpenAI ?? moduleExports?.default;
    if (!OpenAIClass) {
      this._diag.debug('openai module has no OpenAI export; skipping patch');
      return moduleExports;
    }
    this._diag.debug(`patching openai${moduleVersion ? ` (v${moduleVersion})` : ''}`);
    for (const key of ['chat.completions', 'responses', 'embeddings'] as ResourceKey[]) {
      this.patchResource(OpenAIClass, key);
    }
    this.patchedModules.add(moduleExports);
    return moduleExports;
  }

  private patchResource(OpenAIClass: OpenAIClientClass, key: ResourceKey): void {
    const resource = resolveResource(OpenAIClass, key);
    if (!resource) {
      // A version that predates this resource, or a repackaging that moved the
      // static. The other two are worth patching either way.
      this._diag.debug(`openai resource ${key} not found; skipping`);
      return;
    }
    if (isWrapped(resource.prototype.create)) {
      if (isInstrumented(resource.prototype.create)) {
        // Our own earlier patch, e.g. auto-patch followed by `manuallyInstrument`.
        // Idempotent by design, so this stays at debug level.
        this._diag.debug(`openai ${key}.create already patched by us; skipping`);
      } else {
        // Another library's instrumentation got here first, likely
        // `@opentelemetry/instrumentation-openai`, which
        // `@opentelemetry/auto-instrumentations-node` enables by default and which
        // patches these same prototypes. Deferring holds us to one span per call,
        // at the cost of everything this library alone adds: their span carries no
        // `gen_ai.conversation.id` or `gen_ai.agent.name`, the two the OpenAI
        // Agents integration bridges onto model calls. That loss earns a warning.
        this._diag.warn(
          `openai ${key}.create was already instrumented by another library; ${FOREIGN_PATCH_ADVICE}`,
        );
      }
      return;
    }
    const wrapper = this.createWrapper(key);
    this._wrap(resource.prototype, 'create', wrapper);
    const patched = resource.prototype.create;
    if (patched) {
      markInstrumented(patched);
      this.ownWrappers.add(patched);
    }
  }

  /**
   * Returns the shimmer wrapper for one resource. The bodies live in `./index.ts`
   * so the proxy adapter and this instrumentation share one mapping
   * implementation, and the factories reach the `Client` through a getter, so
   * nothing builds a `Client` until a call happens.
   */
  private createWrapper(
    key: ResourceKey,
  ): (original?: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown {
    const instrumentation = this;
    return (original) => {
      // `resolveResource` checked that `create` is a function; this guard exists
      // to satisfy shimmer's optional-original signature.
      if (!original) throw new TypeError('openai create method missing');
      // Resolve the recorder factory on every call: `getConfig()` can change
      // through `setConfig()` after the patch is installed, and building the
      // `Client` at patch time would capture whatever providers were registered
      // when `openai` first loaded.
      return function patched(this: unknown, ...args: unknown[]): unknown {
        let build: ReturnType<typeof patchChatCompletionsCreate>;
        try {
          const client = instrumentation.client;
          const defaults = instrumentation.adapterDefaults();
          build =
            key === 'chat.completions'
              ? patchChatCompletionsCreate(client, defaults)
              : key === 'responses'
                ? patchResponsesCreate(client, defaults)
                : patchEmbeddingsCreate(client, defaults);
        } catch (err) {
          // Telemetry setup failed (e.g. `Client` construction threw). Run the
          // caller's request untouched: telemetry wiring must never break the
          // user's call.
          instrumentation._diag.error(
            `failed to set up genai-otel instrumentation for openai ${key}; continuing untraced`,
            err instanceof Error ? err.message : String(err),
          );
          return original.apply(this, args);
        }
        return build(original).apply(this, args);
      };
    };
  }

  private unpatchModule(moduleExports?: OpenAIModuleExports): void {
    const OpenAIClass = moduleExports?.OpenAI ?? moduleExports?.default;
    if (!OpenAIClass) return;
    for (const key of ['chat.completions', 'responses', 'embeddings'] as ResourceKey[]) {
      const resource = resolveResource(OpenAIClass, key);
      const create = resource?.prototype.create;
      if (resource && create && this.ownWrappers.has(create)) {
        this._diag.debug(`unpatching openai ${key}.create`);
        this._unwrap(resource.prototype, 'create');
      }
    }
  }

  /**
   * Removes the require/import hooks and undoes every patch this instance made.
   * Synchronous to satisfy the OTel `Instrumentation` contract. Calls in flight
   * finish and emit their spans.
   */
  override disable(): void {
    super.disable();
    for (const mod of this.patchedModules) this.unpatchModule(mod);
    this.patchedModules.clear();
  }

  /**
   * Awaitable teardown. Unpatches first, so calls made afterwards go straight to
   * the SDK. Then, when this instrumentation built its own `Client` (config
   * supplied none), shuts that client down so its provider flush runs. It leaves
   * a caller-supplied client alone; you own that shutdown.
   *
   * `disable()` alone does not shut down a self-created client. If you rely on
   * auto-patching without your own `Client`, call `await
   * instrumentation.shutdown()` (or shut down your global TracerProvider) to
   * flush trailing spans.
   */
  async shutdown(): Promise<void> {
    this.disable();
    if (this.ownedClient) {
      try {
        await this.ownedClient.shutdown();
      } catch (err) {
        this._diag.error(
          'failed to shut down genai-otel Client on shutdown',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

/** Walks the `OpenAI` class statics to the resource class backing `key`. */
function resolveResource(
  OpenAIClass: OpenAIClientClass,
  key: ResourceKey,
): ResourceClass | undefined {
  const resource =
    key === 'chat.completions'
      ? OpenAIClass.Chat?.Completions
      : key === 'responses'
        ? OpenAIClass.Responses
        : OpenAIClass.Embeddings;
  if (!resource || typeof resource.prototype?.create !== 'function') return undefined;
  return resource;
}
