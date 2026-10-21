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
 * Shared, framework-agnostic mapping helpers + duck-typed AI SDK v7 event
 * shapes for the Vercel adapter.
 *
 * These are consumed by both the (transitional) hook-bag API in `hooks.ts` and
 * the `Telemetry` integration in `integration.ts`. They read only the fields we
 * need off each AI SDK event and convert AI SDK message/content shapes into
 * genai-otel `Message` / `Part` values.
 *
 * Keeping them here (rather than in `hooks.ts`) means the integration does not
 * depend on the hook bags, so the hook-bag API can be removed in a later
 * breaking release without touching the integration.
 */

import type { ModelMessage } from 'ai';
import {
  type Message,
  type Part,
  type ToolResult,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';
import type { AiCallSettings } from './_model.js';

// ---------------------------------------------------------------------------
// Duck-typed AI SDK event shapes — we only read what we need
// ---------------------------------------------------------------------------

export interface AiCallbackModel {
  provider: string;
  modelId: string;
}

export interface AiContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export interface AiModelMessage {
  role: string;
  content: string | AiContentPart[];
}

/**
 * `onStepStart` event (AI SDK v7). Model info is flat (`provider`/`modelId`),
 * and the system prompt arrives as `instructions` (may be a string or
 * structured `SystemModelMessage`). Carries `callId` for correlation.
 */
export interface AiStepStartEvent {
  callId?: string;
  stepNumber: number;
  provider: string;
  modelId: string;
  messages: AiModelMessage[];
  instructions?: unknown;
}

export interface AiToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

/**
 * `onToolExecutionStart` event (AI SDK v7). Carries the tool call and the
 * messages that led to it; unlike v6 it does not expose `model` or `stepNumber`.
 * Carries `callId` for correlation.
 */
export interface AiToolExecutionStartEvent {
  callId?: string;
  toolCall: AiToolCall;
}

/**
 * `onToolExecutionEnd` event (AI SDK v7). Success/error is discriminated via
 * `toolOutput.type` (`'tool-result'` vs `'tool-error'`); duration is
 * `toolExecutionMs`. Carries `callId` for correlation.
 */
export interface AiToolExecutionEndEvent {
  callId?: string;
  toolCall: AiToolCall;
  toolExecutionMs?: number;
  toolOutput?: { type: 'tool-result'; output?: unknown } | { type: 'tool-error'; error?: unknown };
}

export interface AiToolResult {
  toolCallId: string;
  toolName: string;
  output?: unknown;
}

/**
 * `onStepEnd` event (AI SDK v7) — a `StepResult`. Carries `callId` and
 * `stepNumber` for correlation.
 */
export interface AiStepFinishEvent {
  callId?: string;
  stepNumber: number;
  model: AiCallbackModel;
  content: AiContentPart[];
  text: string;
  toolCalls: AiToolCall[];
  toolResults: AiToolResult[];
  finishReason: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    promptTokens?: number; // v5 compat
    completionTokens?: number; // v5 compat
  };
  response: {
    id?: string;
    modelId?: string;
  };
}

export interface AiChunkEvent {
  chunk: { type: string; text?: string };
}

/** `onLanguageModelCallStart` event (AI SDK v7), with the settings this model call uses. */
export interface AiLanguageModelCallStartEvent extends AiCallSettings {
  callId: string;
}

/** `onLanguageModelCallEnd` event (AI SDK v7): the step's model call is done, before its tools run. */
export interface AiLanguageModelCallEndEvent {
  callId: string;
}

/** `onError` event (AI SDK v7). The SDK types it as `unknown` but passes `{ callId, error }`. */
export interface AiErrorEvent {
  callId: string;
  error: unknown;
}

/**
 * `onStart` operation event (AI SDK v7). Carries `callId`, `operationId`, flat
 * model info, the initial prompt `messages`, `instructions`, and the
 * user-defined `runtimeContext`. Used to open the `invoke_agent` span.
 */
export interface AiOperationStartEvent extends AiCallSettings {
  callId: string;
  operationId?: string;
  provider?: string;
  modelId?: string;
  messages?: AiModelMessage[];
  instructions?: unknown;
  runtimeContext?: unknown;
}

/**
 * `onEnd` operation event (AI SDK v7). Carries `callId`, the aggregated
 * `content` across all steps, `finishReason`, and `usage`. Used to close the
 * `invoke_agent` span.
 */
export interface AiOperationEndEvent {
  callId: string;
  content?: AiContentPart[];
  text?: string;
  finishReason?: string;
  usage?: unknown;
  response?: { id?: string; modelId?: string };
  runtimeContext?: unknown;
}

/** `onAbort` event (AI SDK v7). */
export interface AiAbortEvent {
  callId: string;
  reason?: unknown;
}

/** Provider-format message (AI SDK `LanguageModelV4Message`). */
export interface AiProviderMessage {
  role: string;
  content: string | AiProviderPart[];
}

export interface AiProviderPart {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
}

/**
 * `onStepStart` event for `generateObject` (AI SDK v7). Model info is flat;
 * input arrives as `promptMessages` in provider format (`LanguageModelV4Prompt`),
 * distinct from the `messages` shape used by streamText/generateText.
 */
export interface AiObjectStepStartEvent {
  callId?: string;
  stepNumber?: number;
  provider: string;
  modelId: string;
  promptMessages?: AiProviderMessage[];
}

/** `onStepEnd` event for `generateObject` (AI SDK v7). */
export interface AiObjectStepEndEvent {
  callId?: string;
  provider?: string;
  modelId?: string;
  objectText?: string;
  finishReason?: string;
  usage?: unknown;
  response?: { id?: string; modelId?: string };
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * Converts AI SDK `ModelMessage[]` (step input) to genai-otel `Message[]`.
 * System messages are skipped — they ride on the generation seed's `systemPrompt`.
 */
export function mapModelMessages(messages: AiModelMessage[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const role = normalizeRole(msg.role);
    if (typeof msg.content === 'string') {
      result.push({ role, parts: [textPart(msg.content)] });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    const parts = mapContentParts(msg.content);
    if (parts.length > 0) result.push({ role, parts });
  }
  return result;
}

/**
 * Maps AI SDK `ModelMessage[]` (the `streamText` / `generateText` input shape)
 * to genai-otel `Message[]`, suitable for `AgentInvocationStart.input` /
 * `gen_ai.input.messages` on an `invoke_agent` span. System messages are
 * skipped — they belong on the agent/generation `systemPrompt`, not
 * `input.messages`, per the GenAI semantic conventions.
 */
export function toAgentInputMessages(messages: ModelMessage[]): Message[] {
  return mapModelMessages(messages as unknown as AiModelMessage[]);
}

/**
 * Converts `AiContentPart[]` (from a message's content array) to genai-otel `Part[]`.
 */
export function mapContentParts(content: AiContentPart[]): Part[] {
  const parts: Part[] = [];
  for (const c of content) {
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') parts.push(textPart(c.text));
        break;
      case 'reasoning':
        if (typeof c.text === 'string') parts.push(thinkingPart(c.text));
        break;
      case 'tool-call':
        parts.push(
          toolCallPart({
            name: c.toolName ?? '',
            id: c.toolCallId,
            inputJson: jsonString(c.input),
          }),
        );
        break;
      case 'tool-result':
        parts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            ...unwrapToolOutput(c.output),
          }),
        );
        break;
    }
  }
  return parts;
}

/**
 * Converts `StepResult.content[]` to genai-otel output `Message[]`.
 * Assembles assistant parts (text + reasoning + tool-calls) and tool-role parts
 * (results + errors). A step's `tool-result.output` is what the tool returned,
 * not the `{ type, value }` wrapper model messages use, so it is recorded as is.
 */
export function mapStepContent(content: AiContentPart[]): Message[] {
  const assistantParts: Part[] = [];
  const toolParts: Part[] = [];

  for (const c of content) {
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') assistantParts.push(textPart(c.text));
        break;
      case 'reasoning':
        if (typeof c.text === 'string') assistantParts.push(thinkingPart(c.text));
        break;
      case 'tool-call':
        assistantParts.push(
          toolCallPart({
            name: c.toolName ?? '',
            id: c.toolCallId,
            inputJson: jsonString(c.input),
          }),
        );
        break;
      case 'tool-result':
        toolParts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            contentJson: jsonString(c.output),
          }),
        );
        break;
      case 'tool-error':
        toolParts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            contentJson: jsonString(c.error),
            isError: true,
          }),
        );
        break;
    }
  }

  const messages: Message[] = [];
  if (assistantParts.length > 0) messages.push({ role: 'assistant', parts: assistantParts });
  if (toolParts.length > 0) messages.push({ role: 'tool', parts: toolParts });
  return messages;
}

/**
 * Converts an AI SDK provider-format prompt (`LanguageModelV4Prompt`, used by
 * generateObject step events) to genai-otel `Message[]` + `systemPrompt`.
 * The `system` role carries a plain string (returned separately so it rides on
 * the seed's `systemPrompt`); other roles carry provider part arrays.
 */
export function mapProviderPrompt(prompt: AiProviderMessage[]): {
  messages: Message[];
  systemPrompt?: string;
} {
  const messages: Message[] = [];
  const systemChunks: string[] = [];
  for (const msg of prompt) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') systemChunks.push(msg.content);
      continue;
    }
    const role = normalizeRole(msg.role);
    if (typeof msg.content === 'string') {
      messages.push({ role, parts: [textPart(msg.content)] });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    const parts = mapProviderParts(msg.content);
    if (parts.length > 0) messages.push({ role, parts });
  }
  return {
    messages,
    systemPrompt: systemChunks.length > 0 ? systemChunks.join('\n\n') : undefined,
  };
}

/** Converts provider-format content parts to genai-otel `Part[]`. */
export function mapProviderParts(content: AiProviderPart[]): Part[] {
  const parts: Part[] = [];
  for (const c of content) {
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') parts.push(textPart(c.text));
        break;
      case 'reasoning':
        if (typeof c.text === 'string') parts.push(thinkingPart(c.text));
        break;
      case 'tool-call':
        parts.push(
          toolCallPart({
            name: c.toolName ?? '',
            id: c.toolCallId,
            inputJson: jsonString(c.input),
          }),
        );
        break;
      case 'tool-result':
        parts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            ...unwrapToolOutput(c.output),
          }),
        );
        break;
    }
  }
  return parts;
}

export function normalizeRole(role: string): Message['role'] {
  if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
  return 'user';
}

/**
 * Model messages and prompts wrap a tool's output as `{ type, value }`. Records
 * `value`, the output as the tool returned it. Anything else, such as a denied
 * execution, is recorded as is.
 */
function unwrapToolOutput(
  output: unknown,
): Pick<ToolResult, 'content' | 'contentJson' | 'isError'> {
  const { type, value } = (output ?? {}) as { type?: unknown; value?: unknown };
  switch (type) {
    case 'text':
      return { content: jsonString(value) };
    case 'error-text':
      return { content: jsonString(value), isError: true };
    // Always encoded, so a JSON string value stays a string rather than being parsed.
    case 'json':
    case 'content':
      return { contentJson: JSON.stringify(value) };
    case 'error-json':
      return { contentJson: JSON.stringify(value), isError: true };
    default:
      return { contentJson: jsonString(output) };
  }
}

export function jsonString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
