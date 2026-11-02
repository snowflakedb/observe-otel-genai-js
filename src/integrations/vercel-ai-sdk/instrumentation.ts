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
 * OpenTelemetry instrumentation for the Vercel AI SDK.
 *
 *   import { registerInstrumentations } from '@opentelemetry/instrumentation';
 *   import { VercelAiSdkInstrumentation } from '@genai-otel/core/vercel-ai-sdk/instrumentation';
 *
 *   registerInstrumentations({ instrumentations: [new VercelAiSdkInstrumentation()] });
 *
 * Nothing is patched. The AI SDK (v7) sends every call's events to the telemetry
 * integrations on its global list, which `registerTelemetry` adds to. Enabling the
 * instrumentation puts `genaiTelemetryIntegration` on that list, and disabling it
 * takes it off again, which `registerTelemetry` cannot do. The SDK reads the list on
 * every call, so this works the same under CommonJS and ESM, whenever `ai` is loaded.
 *
 * The options are read when the instrumentation is enabled, and its own `Client` is
 * built on the first AI SDK call, from the tracer and meter it has by then.
 */

import { InstrumentationBase, type InstrumentationConfig } from '@opentelemetry/instrumentation';
import type { Telemetry } from 'ai';

import { Client } from '../../client.js';
import { VERSION } from '../../version.js';
import { type GenaiTelemetryOptions, lazyTelemetryIntegration } from './integration.js';

export interface VercelAiSdkInstrumentationConfig
  extends InstrumentationConfig,
    GenaiTelemetryOptions {
  /** Reuse an existing `Client`. Otherwise one is created from this instrumentation's tracer and meter. */
  client?: Client;
}

/** The AI SDK's list of registered telemetry integrations (`registerTelemetry` adds to it). */
interface AiSdkGlobal {
  AI_SDK_TELEMETRY_INTEGRATIONS?: Telemetry[];
}

export class VercelAiSdkInstrumentation extends InstrumentationBase<VercelAiSdkInstrumentationConfig> {
  /**
   * The integration this instrumentation put on the AI SDK's list, while enabled.
   * Not initialized: the base constructor calls enable(), and an initializer would
   * then clear it.
   */
  private declare registered?: Telemetry;
  /** The `Client` we created ourselves, so {@link shutdown} knows it owns it. */
  private ownedClient?: Client;

  constructor(config: VercelAiSdkInstrumentationConfig = {}) {
    super('@genai-otel/instrumentation-vercel-ai-sdk', VERSION, config);
  }

  /** No module to patch: the AI SDK finds the integration on its global list. */
  protected init(): [] {
    return [];
  }

  override enable(): void {
    super.enable();
    if (this.registered) return;
    const { client: _client, enabled: _enabled, ...options } = this.getConfig();
    // The Client is built on the first event, after registerInstrumentations has
    // handed over its tracer and meter providers.
    this.registered = lazyTelemetryIntegration(() => this.resolveClient(), options);
    const sdk = globalThis as AiSdkGlobal;
    sdk.AI_SDK_TELEMETRY_INTEGRATIONS ??= [];
    sdk.AI_SDK_TELEMETRY_INTEGRATIONS.push(this.registered);
  }

  /**
   * Takes the integration off the AI SDK's list. Unlike {@link shutdown} this does
   * not flush a self-created `Client`: rely on your `TracerProvider` shutdown, or
   * call `shutdown()` instead.
   */
  override disable(): void {
    const sdk = globalThis as AiSdkGlobal;
    sdk.AI_SDK_TELEMETRY_INTEGRATIONS = sdk.AI_SDK_TELEMETRY_INTEGRATIONS?.filter(
      (t) => t !== this.registered,
    );
    this.registered = undefined;
    super.disable();
  }

  /**
   * Disables the instrumentation and shuts down the `Client`, but only if this
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

  private resolveClient(): Client {
    const { client } = this.getConfig();
    if (client) return client;
    this.ownedClient ??= new Client({ tracer: this.tracer, meter: this.meter });
    return this.ownedClient;
  }
}
