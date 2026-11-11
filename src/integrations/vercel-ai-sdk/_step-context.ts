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
 * Runs each AI SDK step in its operation's `invoke_agent` context.
 *
 * The AI SDK publishes every operation, step, model call and tool call on the
 * `ai:telemetry` tracing channel, and runs the step's work inside that channel's
 * `start` stores. Binding the OTel context manager's storage to `start` lets us
 * choose the active context for a step: the agent span's, when the step belongs
 * to an operation with one. Spans started anywhere in the step then parent under
 * the agent, including a nested `generateText` in `repairToolCall` or `prepareStep`,
 * which the lifecycle callbacks alone cannot reach.
 *
 * Every integration shares one binding: Node keeps one transform per store, so a
 * second `bindStore` would replace the first. Integrations add a source while they
 * have operations open, and the binding is dropped when none are left, so the AI
 * SDK skips the channel again.
 *
 * Needs Node's diagnostics channel and an `AsyncLocalStorage`-based context manager
 * (see `GenaiContextManager`); otherwise this does nothing and spans parent as before.
 */

import type * as AsyncHooks from 'node:async_hooks';
import type * as DiagnosticsChannel from 'node:diagnostics_channel';
import { type Context, context } from '@opentelemetry/api';

/** The AI SDK's tracing channel (`AI_SDK_TELEMETRY_TRACING_CHANNEL` in `ai`). */
const AI_SDK_TRACING_CHANNEL = 'ai:telemetry';

/** Returns the context the operation's steps run in, or `undefined` for an unknown operation. */
export type StepContextSource = (callId: string) => Context | undefined;

type Storage = AsyncHooks.AsyncLocalStorage<Context>;
type StartChannel = DiagnosticsChannel.Channel<object, Context>;

interface ChannelMessage {
  type?: unknown;
  event?: { callId?: unknown };
}

const sources = new Set<StepContextSource>();
let binding: { storage: Storage; start: StartChannel } | undefined;

/**
 * Adds a source and binds the channel to the current context manager's storage.
 * Call it before an operation's first step; calling it again is cheap, and picks
 * up a context manager registered since.
 */
export function addStepContextSource(source: StepContextSource): void {
  sources.add(source);
  bind();
}

export function removeStepContextSource(source: StepContextSource): void {
  sources.delete(source);
  if (sources.size === 0) unbind();
}

function bind(): void {
  const storage = contextStorage();
  if (binding?.storage === storage) return;
  unbind();
  const diagnostics = builtin<typeof DiagnosticsChannel>('node:diagnostics_channel');
  const start = diagnostics?.tracingChannel?.<object, Context>(AI_SDK_TRACING_CHANNEL).start as
    | StartChannel
    | undefined;
  if (!storage || typeof start?.bindStore !== 'function') return;
  // Outside any context the store is undefined, which the context manager reads as ROOT_CONTEXT.
  start.bindStore(storage, (message) => stepContext(message) ?? (storage.getStore() as Context));
  binding = { storage, start };
}

function unbind(): void {
  binding?.start.unbindStore(binding.storage);
  binding = undefined;
}

function stepContext(message: unknown): Context | undefined {
  const { type, event } = (message ?? {}) as ChannelMessage;
  if (type !== 'step' || typeof event?.callId !== 'string') return undefined;
  for (const source of sources) {
    const ctx = source(event.callId);
    if (ctx) return ctx;
  }
  return undefined;
}

/**
 * The storage of the registered context manager: `GenaiContextManager` exposes it,
 * and a plain `AsyncLocalStorageContextManager` keeps it in a private field.
 */
function contextStorage(): Storage | undefined {
  const asyncHooks = builtin<typeof AsyncHooks>('node:async_hooks');
  const manager = (
    context as unknown as { _getContextManager?: () => unknown }
  )._getContextManager?.() as { asyncLocalStorage?: unknown; _asyncLocalStorage?: unknown };
  const storage = manager?.asyncLocalStorage ?? manager?._asyncLocalStorage;
  return asyncHooks && storage instanceof asyncHooks.AsyncLocalStorage
    ? (storage as Storage)
    : undefined;
}

/** Loads a Node builtin without a static import, so non-Node bundles still load this module. */
function builtin<T>(id: string): T | undefined {
  try {
    return (
      globalThis.process as { getBuiltinModule?: (id: string) => unknown } | undefined
    )?.getBuiltinModule?.(id) as T | undefined;
  } catch {
    return undefined;
  }
}
