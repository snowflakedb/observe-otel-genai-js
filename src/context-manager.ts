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
 * An `AsyncLocalStorageContextManager` that exposes its storage.
 *
 *   import { GenaiContextManager } from '@snowflake/observe-otel-genai/context-manager';
 *
 *   new NodeSDK({ contextManager: new GenaiContextManager(), ... }).start();
 *   // or: tracerProvider.register({ contextManager: new GenaiContextManager() });
 *
 * The Vercel AI SDK integration binds this storage to the AI SDK's tracing channel,
 * so work started inside a step (a nested `generateText` in `repairToolCall` or
 * `prepareStep`, a provider HTTP call) runs under the step's `invoke_agent` span.
 * The integration also finds the storage of a plain `AsyncLocalStorageContextManager`,
 * the one `NodeTracerProvider.register()` installs, but only through its private
 * field; registering this class keeps that working across OTel releases.
 */

import type { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

export class GenaiContextManager extends AsyncLocalStorageContextManager {
  /** The storage holding the active OTel context. */
  get asyncLocalStorage(): AsyncLocalStorage<Context> {
    return (this as unknown as { _asyncLocalStorage: AsyncLocalStorage<Context> })
      ._asyncLocalStorage;
  }
}
