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
 * Allowed message roles. Mirrors the OpenAI / Anthropic chat model.
 */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/**
 * Allowed message part kinds. Each `Part` carries one kind worth of payload.
 */
export type PartKind = 'text' | 'thinking' | 'tool_call' | 'tool_result';

/**
 * Tool-call payload attached to an assistant message.
 */
export interface ToolCall {
  /** Tool name (matches a `ToolDefinition.name`). */
  name: string;
  /** Provider-assigned tool-call id. */
  id?: string;
  /** Raw JSON-encoded arguments (UTF-8 bytes or string). */
  inputJson?: string;
}

/**
 * Tool-result payload attached to a `tool`-role message.
 */
export interface ToolResult {
  /** Correlates this result back to a `ToolCall.id`. */
  toolCallId?: string;
  /** Tool name (mirrors the call). */
  name?: string;
  /** Free-form textual content. */
  content?: string;
  /** Structured JSON content (alternative to `content`). */
  contentJson?: string;
  /** True when the tool execution failed; `content` may hold the error message. */
  isError?: boolean;
}

/**
 * Optional provider-specific metadata attached to a `Part`.
 */
export interface PartMetadata {
  providerType?: string;
}

/**
 * A single piece of a message. Exactly one of the payload fields is populated
 * depending on `kind`.
 */
export interface Part {
  kind: PartKind;
  text?: string;
  thinking?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  metadata?: PartMetadata;
}

/**
 * A normalized message — one logical turn in the conversation as the
 * application chose to present it to the model.
 */
export interface Message {
  role: MessageRole;
  parts: Part[];
  /** Optional message name (e.g. function name in OpenAI's older API). */
  name?: string;
  /** Optional stable application-assigned id (used for de-duplication). */
  id?: string;
}

// -----------------------------------------------------------------------------
// Builders — small helpers for constructing `Part` / `Message` values without
// hand-writing the discriminated-union shape.
// -----------------------------------------------------------------------------

export function textPart(text: string): Part {
  return { kind: 'text', text };
}

export function thinkingPart(thinking: string): Part {
  return { kind: 'thinking', thinking };
}

export function toolCallPart(toolCall: ToolCall): Part {
  return { kind: 'tool_call', toolCall };
}

export function toolResultPart(toolResult: ToolResult): Part {
  return { kind: 'tool_result', toolResult };
}

export function userTextMessage(text: string): Message {
  return { role: 'user', parts: [textPart(text)] };
}

export function assistantTextMessage(text: string): Message {
  return { role: 'assistant', parts: [textPart(text)] };
}

export function toolResultMessage(toolCallId: string, content: string): Message {
  return {
    role: 'tool',
    parts: [toolResultPart({ toolCallId, content })],
  };
}
