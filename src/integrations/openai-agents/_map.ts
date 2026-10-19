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
 * Maps `@openai/agents` span payloads onto genai-otel shapes.
 *
 * Model inputs and outputs reach the processor in three formats:
 *  - the Agents protocol item list: `generation.output` on the AI SDK path and
 *    `response._input` on the Responses path;
 *  - an AI SDK provider prompt: `generation.input` on the AI SDK path;
 *  - a raw OpenAI `Response`: `response._response`, mapped by the openai integration.
 */

import type { ModelRef } from '../../models/generation.js';
import {
  type Message,
  type Part,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';
import type { TokenUsage } from '../../models/usage.js';
import { matchProvider } from '../_common/provider.js';
import type { SdkGenerationSpanData, SdkGenerationUsage } from './_sdk-types.js';

/**
 * True for a `generation` span from the AI SDK bridge (`aisdk(model)`). The bridge
 * stamps `model_config.model_impl = 'ai-sdk'`; the OpenAI Chat Completions model,
 * the only other source of `generation` spans, never does.
 */
export function isAiSdkGeneration(data: SdkGenerationSpanData): boolean {
  return data.model_config?.model_impl === 'ai-sdk';
}

/**
 * Splits the bridge's `"provider:modelId"` model string. The provider half is an
 * AI SDK provider id such as `anthropic.messages` or `amazon-bedrock`, so it is
 * mapped to its well-known `gen_ai.provider.name` value when one exists.
 */
export function aiSdkModelRef(model: string | undefined): ModelRef {
  const idx = model?.indexOf(':') ?? -1;
  if (!model || idx <= 0) return { provider: '', name: model ?? '' };
  const providerId = model.slice(0, idx);
  return {
    provider: matchProvider([providerId]) ?? providerId.split('.', 1)[0]!,
    name: model.slice(idx + 1),
  };
}

export function mapGenerationUsage(usage: SdkGenerationUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  };
}

/** Maps a Responses-path request input: a bare user string or Agents protocol items. */
export function mapResponseInput(
  input: string | Array<Record<string, unknown>> | undefined,
): Message[] {
  if (typeof input === 'string') return input ? [{ role: 'user', parts: [textPart(input)] }] : [];
  return mapAgentsItems(input);
}

/** `tool_call` when the model's last output asked for a tool, otherwise unknown. */
export function finishReasonFor(output: readonly Message[]): string | undefined {
  const called = output.some((m) => m.parts.some((p) => p.kind === 'tool_call'));
  return called ? 'tool_call' : undefined;
}

interface AgentsItem {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  callId?: string;
  arguments?: string;
  output?: unknown;
}

/** Maps Agents protocol items (`message`, `function_call`, `function_call_result`, `reasoning`). */
export function mapAgentsItems(items: Array<Record<string, unknown>> | undefined): Message[] {
  const out: Message[] = [];
  for (const item of (items ?? []) as AgentsItem[]) {
    switch (item.type ?? (item.role ? 'message' : '')) {
      case 'message':
        appendParts(out, messageRole(item.role), contentParts(item.content));
        break;
      case 'function_call':
        appendParts(out, 'assistant', [
          toolCallPart({ name: item.name ?? '', id: item.callId, inputJson: item.arguments }),
        ]);
        break;
      case 'function_call_result':
        appendParts(out, 'tool', [
          toolResultPart({ toolCallId: item.callId, name: item.name, content: resultText(item) }),
        ]);
        break;
      case 'reasoning': {
        const text = contentParts(item.content)
          .map((p) => p.text ?? '')
          .join('');
        if (text) appendParts(out, 'assistant', [thinkingPart(text)]);
        break;
      }
    }
  }
  return out;
}

function contentParts(content: unknown): Part[] {
  if (typeof content === 'string') return content ? [textPart(content)] : [];
  if (!Array.isArray(content)) return [];
  const text = content
    .map((part: { text?: string; refusal?: string }) => part.text ?? part.refusal ?? '')
    .join('');
  return text ? [textPart(text)] : [];
}

/** A tool result's `output` is `{ type: 'text', text }` or a plain string. */
function resultText(item: AgentsItem): string | undefined {
  const output = item.output as string | { text?: string } | undefined;
  return (typeof output === 'string' ? output : output?.text) || undefined;
}

function messageRole(role: string | undefined): Message['role'] {
  if (role === 'system' || role === 'developer') return 'system';
  return role === 'assistant' ? 'assistant' : 'user';
}

/** Merges into the trailing message when the role matches, so one turn stays one message. */
function appendParts(out: Message[], role: Message['role'], parts: Part[]): void {
  if (parts.length === 0) return;
  const last = out[out.length - 1];
  if (last?.role === role) last.parts.push(...parts);
  else out.push({ role, parts });
}
