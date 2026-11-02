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
 * Each `withX(value, fn)` runs `fn` in an OpenTelemetry context that carries the
 * value, so any recorder created during `fn` (directly or through awaited /
 * non-awaited children) inherits it. The values live in the same context as the
 * active span, so code that saves and restores a context restores both together.
 * Like span parenting, this needs a context manager registered
 * (`@opentelemetry/context-async-hooks`); without one, scopes do nothing.
 */

import { type Context, context, createContextKey } from '@opentelemetry/api';
import type { ContentCaptureMode } from './content/capture.js';
import type { IdentityFields } from './models/identity.js';

interface ContextValues extends IdentityFields {
  contentCaptureMode?: ContentCaptureMode;
}

/** What a span hands down to the spans started inside it. */
export interface HandedDown extends IdentityFields {
  /**
   * The default name of the agent the spans run in, set only by agent spans. It
   * names the spans inside that agent, but not another agent inside it.
   */
  fallbackAgentName?: string;
}

type Scope = ContextValues & HandedDown;

const SCOPE_KEY = createContextKey('@genai-otel/scope');

function getScope(ctx: Context = context.active()): Scope | undefined {
  return ctx.getValue(SCOPE_KEY) as Scope | undefined;
}

/**
 * Returns `ctx` with `patch` laid over its scope. Empty values keep the outer
 * value. An agent version is kept only with the agent name set in the same patch,
 * so naming an agent drops the outer agent's version. Agent spans always pass
 * `fallbackAgentName`, even empty, so each agent replaces the outer default; other
 * spans pass the default they started under, if any.
 */
export function setScope(ctx: Context, patch: Scope): Context {
  const { agentVersion, fallbackAgentName, ...rest } = patch;
  const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v)) as Scope;
  if (set.agentName) set.agentVersion = agentVersion || undefined;
  if ('fallbackAgentName' in patch) set.fallbackAgentName = fallbackAgentName || undefined;
  return ctx.setValue(SCOPE_KEY, { ...getScope(ctx), ...set });
}

function runWith<T>(patch: ContextValues, fn: () => T): T {
  return context.with(setScope(context.active(), patch), fn);
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
  return getScope()?.conversationId;
}

export function conversationTitleFromContext(): string | undefined {
  return getScope()?.conversationTitle;
}

export function userIdFromContext(): string | undefined {
  return getScope()?.userId;
}

export function agentNameFromContext(): string | undefined {
  return getScope()?.agentName;
}

export function agentVersionFromContext(): string | undefined {
  return getScope()?.agentVersion;
}

export function contentCaptureModeFromContext(): ContentCaptureMode | undefined {
  return getScope()?.contentCaptureMode;
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
 *
 * When none of these names the agent, the span takes the default name of the agent
 * it runs in. Agent spans use {@link resolveAgentIdentity} instead.
 */
export function resolveIdentity(
  own: IdentityFields,
  clientConfig: IdentityFields,
): { identity: IdentityFields; handedDown: HandedDown } {
  const scope = getScope();
  const identity = firstSet([own, scope, clientConfig]);
  identity.agentName ||= scope?.fallbackAgentName;
  const handedDown: HandedDown = firstSet([own, scope]);
  // Kept for spans started from this one outside the agent's context, such as a
  // tool's own calls.
  if (scope?.fallbackAgentName) handedDown.fallbackAgentName = scope.fallbackAgentName;
  return { identity, handedDown };
}

/**
 * {@link resolveIdentity} for an agent span. The enclosing agent's default name is
 * not this agent's name, so it is skipped; this agent's own `fallbackAgentName`
 * comes last instead. The spans inside take this agent's default, or none.
 */
export function resolveAgentIdentity(
  own: IdentityFields,
  clientConfig: IdentityFields,
  fallbackAgentName: string | undefined,
): { identity: IdentityFields; handedDown: HandedDown } {
  const scope = getScope();
  const identity = firstSet([own, scope, clientConfig]);
  const fallback = identity.agentName ? undefined : fallbackAgentName;
  identity.agentName ||= fallback;
  return { identity, handedDown: { ...firstSet([own, scope]), fallbackAgentName: fallback } };
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
