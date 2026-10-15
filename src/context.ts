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
 * Ambient identity helpers.
 *
 * Each `withX(value, fn)` runs `fn` inside an AsyncLocalStorage scope so any
 * recorder created during `fn` (directly or through awaited / non-awaited
 * children) inherits the value as its default. Use this to scope
 * `conversation_id` to a request handler without threading it through every
 * call site.
 *
 * The functions accept either sync or async `fn`. Awaited continuations
 * inherit the same store via Node's async hooks.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContentCaptureMode } from './content/capture.js';

interface ContextValues {
  conversationId?: string;
  conversationTitle?: string;
  userId?: string;
  agentName?: string;
  agentVersion?: string;
  contentCaptureMode?: ContentCaptureMode;
}

const storage = new AsyncLocalStorage<ContextValues>();

function runWith<T>(patch: ContextValues, fn: () => T): T {
  const current = storage.getStore() ?? {};
  return storage.run({ ...current, ...patch }, fn);
}

// -----------------------------------------------------------------------------
// `with*` helpers
// -----------------------------------------------------------------------------

export function withConversationId<T>(id: string, fn: () => T): T {
  return runWith({ conversationId: id }, fn);
}

export function withConversationTitle<T>(title: string, fn: () => T): T {
  return runWith({ conversationTitle: title }, fn);
}

export function withUserId<T>(id: string, fn: () => T): T {
  return runWith({ userId: id }, fn);
}

export function withAgentName<T>(name: string, fn: () => T): T {
  return runWith({ agentName: name }, fn);
}

export function withAgentVersion<T>(version: string, fn: () => T): T {
  return runWith({ agentVersion: version }, fn);
}

export function withContentCaptureMode<T>(mode: ContentCaptureMode, fn: () => T): T {
  return runWith({ contentCaptureMode: mode }, fn);
}

/**
 * Sets multiple ambient values at once.
 */
export function withContext<T>(values: ContextValues, fn: () => T): T {
  return runWith(values, fn);
}

// -----------------------------------------------------------------------------
// Getters
// -----------------------------------------------------------------------------

export function conversationIdFromContext(): string | undefined {
  return storage.getStore()?.conversationId;
}

export function conversationTitleFromContext(): string | undefined {
  return storage.getStore()?.conversationTitle;
}

export function userIdFromContext(): string | undefined {
  return storage.getStore()?.userId;
}

export function agentNameFromContext(): string | undefined {
  return storage.getStore()?.agentName;
}

export function agentVersionFromContext(): string | undefined {
  return storage.getStore()?.agentVersion;
}

export function contentCaptureModeFromContext(): ContentCaptureMode | undefined {
  return storage.getStore()?.contentCaptureMode;
}

/**
 * Resolution order helper: explicit > contextvar > clientDefault > empty.
 * Returns the first non-empty value among the three.
 */
export function resolveIdentity(
  explicit: string | undefined,
  fromContext: string | undefined,
  clientDefault: string,
): string {
  if (explicit && explicit.length > 0) return explicit;
  if (fromContext && fromContext.length > 0) return fromContext;
  return clientDefault;
}
