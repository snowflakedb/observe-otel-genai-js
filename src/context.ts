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
import type { IdentityFields } from './models/identity.js';

interface ContextValues extends IdentityFields {
  contentCaptureMode?: ContentCaptureMode;
}

const storage = new AsyncLocalStorage<ContextValues>();

/**
 * Opens a scope over the current one. Empty values keep the outer value. An agent
 * version is kept only with the agent name set in the same call, so naming an
 * agent drops the outer agent's version.
 */
function runWith<T>(patch: ContextValues, fn: () => T): T {
  const { agentVersion, ...rest } = patch;
  const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v)) as ContextValues;
  if (set.agentName) set.agentVersion = agentVersion || undefined;
  return storage.run({ ...storage.getStore(), ...set }, fn);
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

/** Names the agent for spans started in `fn`, with its version if given. */
export function withAgent<T>(name: string, fn: () => T): T;
export function withAgent<T>(name: string, version: string | undefined, fn: () => T): T;
export function withAgent<T>(
  name: string,
  ...args: [fn: () => T] | [version: string | undefined, fn: () => T]
): T {
  const [agentVersion, fn] = args.length === 1 ? [undefined, args[0]] : args;
  return runWith({ agentName: name, agentVersion }, fn);
}

export function withContentCaptureMode<T>(mode: ContentCaptureMode, fn: () => T): T {
  return runWith({ contentCaptureMode: mode }, fn);
}

/**
 * Sets multiple ambient values at once. `agentVersion` is used only together with
 * `agentName`; setting `agentName` alone drops the outer agent's version.
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
 * Resolves a span's identity from its own values (`own`), the enclosing scope,
 * then the client config. Each field takes the first non-empty value. The agent
 * version comes from the first source that gives the chosen agent name together
 * with a version, so one agent's version never lands on another.
 *
 * `handedDown` is the same without the client config: what spans started inside
 * this one inherit (see `RecorderBase.withActiveContext`). They fall back to the
 * client config themselves.
 */
export function resolveIdentity(
  own: IdentityFields,
  clientConfig: IdentityFields,
): { identity: IdentityFields; handedDown: IdentityFields } {
  const scope = storage.getStore();
  return {
    identity: firstSet([own, scope, clientConfig]),
    handedDown: firstSet([own, scope]),
  };
}

function firstSet(sources: (IdentityFields | undefined)[]): IdentityFields {
  const pick = (key: keyof IdentityFields) => sources.find((s) => s?.[key])?.[key];
  const agentName = pick('agentName');
  return {
    agentName,
    agentVersion: agentName
      ? sources.find((s) => s?.agentName === agentName && s.agentVersion)?.agentVersion
      : undefined,
    conversationId: pick('conversationId'),
    conversationTitle: pick('conversationTitle'),
    userId: pick('userId'),
  };
}
