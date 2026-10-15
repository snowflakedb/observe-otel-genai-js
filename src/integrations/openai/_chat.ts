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
 * OpenAI Chat Completions (`client.chat.completions.create`) instrumentation:
 * the recording core and the mapping from chat messages to genai-otel
 * `Message[]`. The entry points that call into it (`wrapOpenAI`, the per-call
 * helper, and the prototype patch) live in `index.ts`.
 */

import type OpenAI from 'openai';

import type { Client } from '../../client.js';
import type { GenerationStart } from '../../models/generation.js';
import {
  type Message,
  type Part,
  textPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';
import { OP_CHAT } from '../../semconv.js';
import { type ApiPromiseLike, instrumentApiPromise } from '../_common/api-promise.js';
import { type AdapterCallOptions, identityFieldsFromOptions } from '../_common/metadata.js';
import { type StreamWrapOptions, wrapProviderStream } from '../_common/stream.js';

type OpenAIAdapterOptions = AdapterCallOptions;

/** Recorder returned by {@link Client.startGeneration}. */
type ChatRecorder = ReturnType<Client['startGeneration']>;
/** Chat completion streamed chunk. */
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

type ChatCompletionsCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;
type ChatCompletionsResult = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Invokes the underlying (un-instrumented) `chat.completions.create`. The proxy
 * adapter binds this to `openai.chat.completions.create`; the OTel
 * instrumentation binds it to the original prototype method it patched, so the
 * shared {@link runChatCompletion} core never re-enters the patched path.
 */
export type ChatCompletionsInvoke = (params: ChatCompletionsCreateParams) => Promise<unknown>;

/**
 * Shared chat-completion instrumentation core.
 *
 * Instead of receiving the OpenAI client, it takes an `invoke` callback that
 * performs the actual network call. This lets the proxy adapter and the OTel
 * instrumentation share all the span/recorder logic while each supplies its own
 * (recursion-safe) way of reaching the real `create`.
 *
 * @internal exported for {@link file://./instrumentation.ts}; not part of the
 * stable public API.
 */
export async function runChatCompletion(
  client: Client,
  invoke: ChatCompletionsInvoke,
  params: ChatCompletionsCreateParams,
  options: OpenAIAdapterOptions,
): Promise<unknown> {
  const isStream = (params as { stream?: boolean }).stream === true;
  const seed = buildChatSeed(params, options);

  if (isStream) {
    const rec = client.startStreamingGeneration(seed);
    rec.setResult({ input: mapOpenAIInput(params.messages) });
    let stream: AsyncIterable<ChatChunk>;
    try {
      stream = (await invoke(params)) as AsyncIterable<ChatChunk>;
    } catch (err) {
      rec.setCallError(err);
      await rec.end();
      throw err;
    }
    return wrapProviderStream<typeof stream, ChatChunk>(stream, chatStreamHandlers(rec));
  }

  await using rec = client.startGeneration(seed);
  try {
    const result = (await invoke(params)) as ChatCompletionsResult;
    recordChatResult(rec, params, result);
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

/**
 * Instrument a `chat.completions.create` call while preserving the SDK's
 * `APIPromise`, so `.withResponse()` / `.asResponse()` — and helpers that rely
 * on them — keep working. See {@link instrumentApiPromise} for how the span is
 * ended for each way the caller can consume the result.
 *
 * @internal
 */
export function instrumentChatCompletionApiPromise(
  client: Client,
  apiPromise: ApiPromiseLike<unknown>,
  params: ChatCompletionsCreateParams,
  options: OpenAIAdapterOptions,
): unknown {
  const isStream = (params as { stream?: boolean }).stream === true;
  const seed = buildChatSeed(params, options);

  if (isStream) {
    const rec = client.startStreamingGeneration(seed);
    rec.setResult({ input: mapOpenAIInput(params.messages) });
    const handlers = chatStreamHandlers(rec);
    return instrumentApiPromise(apiPromise, rec, (stream) =>
      wrapProviderStream<AsyncIterable<ChatChunk>, ChatChunk>(
        stream as AsyncIterable<ChatChunk>,
        handlers,
      ),
    );
  }

  const rec = client.startGeneration(seed);
  return instrumentApiPromise(apiPromise, rec, (result) => {
    recordChatResult(rec, params, result as ChatCompletionsResult);
    void rec.end();
    return result;
  });
}

/** Builds the recorder seed (span attributes) from the chat request params. */
function buildChatSeed(
  params: ChatCompletionsCreateParams,
  options: OpenAIAdapterOptions,
): GenerationStart {
  return {
    model: { provider: 'openai', name: params.model },
    operationName: OP_CHAT,
    maxTokens:
      (params as { max_completion_tokens?: number }).max_completion_tokens ??
      (params as { max_tokens?: number }).max_tokens,
    temperature: params.temperature ?? undefined,
    topP: params.top_p ?? undefined,
    frequencyPenalty: params.frequency_penalty ?? undefined,
    presencePenalty: params.presence_penalty ?? undefined,
    stopSequences: normalizeStop(params.stop),
    seed: params.seed ?? undefined,
    choiceCount: params.n ?? undefined,
    toolChoice: typeof params.tool_choice === 'string' ? params.tool_choice : undefined,
    ...identityFieldsFromOptions(options),
    contentCapture: options.contentCapture,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  };
}

/** Records the result of a non-streaming chat completion onto the recorder. */
function recordChatResult(
  rec: ChatRecorder,
  params: ChatCompletionsCreateParams,
  result: ChatCompletionsResult,
): void {
  rec.setResult({
    responseId: result.id,
    responseModel: result.model,
    stopReason: result.choices?.[0]?.finish_reason,
    usage: mapUsage(result.usage),
    input: mapOpenAIInput(params.messages),
    output: mapOpenAIOutputMessage(result.choices?.[0]?.message as OAMessage | undefined),
  });
}

/**
 * Builds the streaming {@link StreamWrapOptions} for a chat completion: observes
 * chunks for TTFT, accumulated text/tool-calls, and final usage, then finalizes
 * the recorder on completion / error / abandonment.
 */
function chatStreamHandlers(rec: ChatRecorder): StreamWrapOptions<ChatChunk> {
  let firstTokenSeen = false;
  let finalUsage: ChatUsageShape | undefined;
  let finalModel: string | undefined;
  let finalFinishReason: string | undefined;
  let finalId: string | undefined;
  let outputText = '';
  const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();

  return {
    onChunk: (chunk) => {
      if (!firstTokenSeen) {
        firstTokenSeen = true;
        rec.setFirstTokenAt(Date.now());
      }
      if (chunk.usage) finalUsage = chunk.usage;
      if (chunk.model) finalModel = chunk.model;
      if (chunk.id) finalId = chunk.id;
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) finalFinishReason = finish;
      const delta = chunk.choices?.[0]?.delta as OAStreamDelta | undefined;
      if (delta) {
        if (typeof delta.content === 'string') outputText += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const entry = toolAcc.get(idx) ?? { args: '' };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') entry.args += tc.function.arguments;
            toolAcc.set(idx, entry);
          }
        }
      }
    },
    onComplete: async () => {
      rec.setResult({
        responseId: finalId,
        responseModel: finalModel,
        stopReason: finalFinishReason,
        usage: mapUsage(finalUsage),
        output: buildStreamOutputMessages(outputText, toolAcc),
      });
      await rec.end();
    },
    onError: async (err) => {
      rec.setCallError(err);
      await rec.end();
    },
    onAbandoned: async () => {
      rec.setCallError(new Error('openai stream was never consumed'));
      await rec.end();
    },
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface ChatUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function mapUsage(usage: ChatUsageShape | undefined) {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

function normalizeStop(stop: unknown): string[] | undefined {
  if (typeof stop === 'string') return [stop];
  if (Array.isArray(stop)) return stop.filter((s): s is string => typeof s === 'string');
  return undefined;
}

// -----------------------------------------------------------------------------
// Content mapping (chat messages -> genai-otel Message[])
//
// Note: OpenAI carries system instructions inline in the `messages` array (part
// of the chat history), so they map to `gen_ai.input.messages` with role
// `system` rather than to `gen_ai.system_instructions`. Non-text content parts
// (image/audio/file) are not modeled and are skipped.
// -----------------------------------------------------------------------------

interface OAContentPart {
  type?: string;
  text?: string;
}
interface OAToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
export interface OAMessage {
  role?: string;
  content?: string | OAContentPart[] | null;
  tool_calls?: OAToolCall[];
  tool_call_id?: string;
  name?: string;
}
interface OAStreamToolCall extends OAToolCall {
  index?: number;
}
interface OAStreamDelta {
  content?: string | null;
  tool_calls?: OAStreamToolCall[];
}

function normalizeOpenAIRole(role: string | undefined): Message['role'] {
  switch (role) {
    case 'system':
    case 'developer':
      return 'system';
    case 'assistant':
      return 'assistant';
    case 'tool':
    case 'function':
      return 'tool';
    default:
      return 'user';
  }
}

function contentToText(content: string | OAContentPart[] | null | undefined): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    let s = '';
    for (const p of content) if (p?.type === 'text' && typeof p.text === 'string') s += p.text;
    return s || undefined;
  }
  return undefined;
}

function messageBodyParts(raw: OAMessage): Part[] {
  const parts: Part[] = [];
  const text = contentToText(raw.content);
  if (text) parts.push(textPart(text));
  if (Array.isArray(raw.tool_calls)) {
    for (const tc of raw.tool_calls) {
      parts.push(
        toolCallPart({
          name: tc.function?.name ?? '',
          id: tc.id,
          inputJson: tc.function?.arguments,
        }),
      );
    }
  }
  return parts;
}

export function mapOpenAIInput(messages: unknown): Message[] {
  if (!Array.isArray(messages)) return [];
  const out: Message[] = [];
  for (const raw of messages as OAMessage[]) {
    if (!raw || typeof raw !== 'object') continue;
    const role = normalizeOpenAIRole(raw.role);
    if (role === 'tool') {
      out.push({
        role: 'tool',
        parts: [
          toolResultPart({ toolCallId: raw.tool_call_id, content: contentToText(raw.content) }),
        ],
      });
      continue;
    }
    const parts = messageBodyParts(raw);
    if (parts.length > 0) out.push(raw.name ? { role, parts, name: raw.name } : { role, parts });
  }
  return out;
}

export function mapOpenAIOutputMessage(message: OAMessage | undefined): Message[] {
  if (!message) return [];
  const parts = messageBodyParts(message);
  if (parts.length === 0) return [];
  return [{ role: 'assistant', parts }];
}

function buildStreamOutputMessages(
  text: string,
  toolAcc: Map<number, { id?: string; name?: string; args: string }>,
): Message[] {
  const parts: Part[] = [];
  if (text) parts.push(textPart(text));
  for (const [, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(toolCallPart({ name: tc.name ?? '', id: tc.id, inputJson: tc.args || undefined }));
  }
  if (parts.length === 0) return [];
  return [{ role: 'assistant', parts }];
}
