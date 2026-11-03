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
 * Serializes the library's internal `Message[]` into the OpenTelemetry GenAI
 * semantic-conventions (1.37+) structured message shape used by the
 * `gen_ai.input.messages`, `gen_ai.output.messages`, and
 * `gen_ai.system_instructions` attributes.
 *
 * The output of these functions is the *structured* JS value (arrays + maps),
 * matching the published JSON schema:
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-input-messages.json
 *
 * It is intentionally NOT stringified here — `content/encode.ts` owns the
 * structured-vs-JSON-string decision so the serializer stays a pure
 * shape-mapper that's easy to unit-test and reuse.
 *
 * Part-kind mapping (observe-otel-genai `Part.kind` -> semconv part `type`):
 *   text        -> { type: 'text', content }
 *   thinking    -> { type: 'reasoning', content }
 *   tool_call   -> { type: 'tool_call', id?, name, arguments }
 *   tool_result -> { type: 'tool_call_response', id?, response }
 */

import type { Message, Part } from '../models/message.js';

/** A single part within a semconv message. */
export interface SemconvPart {
  type: 'text' | 'reasoning' | 'tool_call' | 'tool_call_response';
  content?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  response?: unknown;
}

/** A semconv input/output message. `finish_reason` is set on output choices. */
export interface SemconvMessage {
  role: string;
  parts: SemconvPart[];
  finish_reason?: string;
}

/** A semconv system-instructions entry (no role; flat list of text parts). */
export interface SemconvInstruction {
  type: 'text';
  content: string;
}

/**
 * Best-effort parse of a JSON string into a structured value. Returns the raw
 * string when it does not parse (the spec allows opaque content), so we never
 * throw while building telemetry.
 */
function parseJsonOrRaw(value: string | undefined): unknown {
  if (value == null || value === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function partToSemconv(part: Part): SemconvPart | undefined {
  switch (part.kind) {
    case 'text':
      if (!part.text) return undefined;
      return { type: 'text', content: part.text };
    case 'thinking':
      if (!part.thinking) return undefined;
      return { type: 'reasoning', content: part.thinking };
    case 'tool_call': {
      const call = part.toolCall;
      if (!call) return undefined;
      const out: SemconvPart = { type: 'tool_call', name: call.name };
      if (call.id) out.id = call.id;
      const args = parseJsonOrRaw(call.inputJson);
      if (args !== undefined) out.arguments = args;
      return out;
    }
    case 'tool_result': {
      const res = part.toolResult;
      if (!res) return undefined;
      // `response` is required on the semconv ToolCallResponsePart, so always
      // emit it — falling back to null when no result value is available.
      const out: SemconvPart = { type: 'tool_call_response', response: null };
      if (res.toolCallId) out.id = res.toolCallId;
      // Prefer structured content when present; fall back to free-form text.
      const result = res.contentJson != null ? parseJsonOrRaw(res.contentJson) : res.content;
      if (result !== undefined) out.response = result;
      return out;
    }
    default:
      return undefined;
  }
}

function messageToSemconv(message: Message): SemconvMessage | undefined {
  const parts = message.parts.map(partToSemconv).filter((p): p is SemconvPart => p !== undefined);
  if (parts.length === 0) return undefined;
  return { role: message.role, parts };
}

/**
 * Converts the input chat history into the `gen_ai.input.messages` shape.
 * Messages are emitted in order. Empty messages (no renderable parts) are
 * dropped.
 */
export function toSemconvInputMessages(messages: readonly Message[] | undefined): SemconvMessage[] {
  if (!messages || messages.length === 0) return [];
  return messages.map(messageToSemconv).filter((m): m is SemconvMessage => m !== undefined);
}

/**
 * Converts model output into the `gen_ai.output.messages` shape. Each message
 * is one choice/candidate. `finishReason` is required by the semconv on every
 * output message and is attached to all of them (the library models a single
 * stop reason per generation). Callers resolve it via `resolveFinishReason`.
 */
export function toSemconvOutputMessages(
  messages: readonly Message[] | undefined,
  finishReason: string,
): SemconvMessage[] {
  if (!messages || messages.length === 0) return [];
  const out: SemconvMessage[] = [];
  for (const m of messages) {
    const mapped = messageToSemconv(m);
    if (!mapped) continue;
    mapped.finish_reason = finishReason;
    out.push(mapped);
  }
  return out;
}

/**
 * Resolves the semconv `finish_reason`, which is required on every output
 * message. Uses the real provider reason when known; otherwise derives it from
 * error state — `error` when the operation failed, `stop` otherwise.
 */
export function resolveFinishReason(realReason: string | undefined, hadError: boolean): string {
  if (realReason && realReason.length > 0) return realReason;
  return hadError ? 'error' : 'stop';
}

/**
 * Converts a system prompt into the `gen_ai.system_instructions` shape — a flat
 * list of text parts (no role). Returns `[]` for an empty prompt.
 */
export function toSystemInstructions(systemPrompt: string | undefined): SemconvInstruction[] {
  if (!systemPrompt || systemPrompt.trim() === '') return [];
  return [{ type: 'text', content: systemPrompt }];
}
