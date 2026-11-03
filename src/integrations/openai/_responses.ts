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
 * OpenAI Responses API (`client.responses.create`) instrumentation.
 *
 * Split out from `index.ts` because the Responses request/response shape shares
 * almost nothing with Chat Completions: input is a list of typed *items* where
 * Chat Completions has messages, output is a list of typed items where it has
 * choices, and the streaming protocol is a union of ~50 named events where it has
 * token deltas.
 *
 * The OpenAI Agents SDK defaults to the Responses API
 * (`DEFAULT_OPENAI_API = 'responses'`), so without this file the `openai-agents`
 * instrumentation would have no chat span to nest under `invoke_agent` for most
 * users.
 */

import type OpenAI from 'openai';

import type { Client } from '../../client.js';
import type { GenerationStart, ToolDefinition } from '../../models/generation.js';
import {
  type Message,
  type Part,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';
import type { TokenUsage } from '../../models/usage.js';
import { ATTR_USAGE_IS_PARTIAL, OP_CHAT } from '../../semconv.js';
import { type ApiPromiseLike, instrumentApiPromise } from '../_common/api-promise.js';
import type { AdapterCallOptions } from '../_common/metadata.js';
import { identityFieldsFromOptions } from '../_common/metadata.js';
import { providerOfHost } from '../_common/provider.js';
import { outputTypeOf, serverOf } from '../_common/request.js';
import { type StreamWrapOptions, wrapProviderStream } from '../_common/stream.js';

type ResponseCreateParams = OpenAI.Responses.ResponseCreateParams;
type ResponseResult = OpenAI.Responses.Response;
type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;
type GenerationRecorder = ReturnType<Client['startGeneration']>;

/**
 * Instrument a `responses.create` call while preserving the SDK's `APIPromise`,
 * so `.withResponse()`, `.asResponse()`, and the `.stream()` helper built on them
 * keep working. A real client takes this path. Mirrors
 * `instrumentChatCompletionApiPromise`.
 *
 * @internal
 */
export function instrumentResponseApiPromise(
  client: Client,
  apiPromise: ApiPromiseLike<unknown>,
  params: ResponseCreateParams,
  options: AdapterCallOptions,
  baseURL?: string,
): unknown {
  const seed = buildResponsesSeed(params, options, baseURL);

  if (isStreaming(params)) {
    const rec = client.startStreamingGeneration(seed);
    rec.setResult({ input: mapResponsesInput(params) });
    const handlers = responsesStreamHandlers(rec);
    return instrumentApiPromise(apiPromise, rec, (stream) =>
      wrapProviderStream<AsyncIterable<ResponseStreamEvent>, ResponseStreamEvent>(
        stream as AsyncIterable<ResponseStreamEvent>,
        handlers,
      ),
    );
  }

  const rec = client.startGeneration(seed);
  rec.setResult({ input: mapResponsesInput(params) });
  return instrumentApiPromise(apiPromise, rec, (result) => {
    recordResponseResult(rec, result as ResponseResult);
    void rec.end();
    return result;
  });
}

function isStreaming(params: ResponseCreateParams): boolean {
  return (params as { stream?: boolean }).stream === true;
}

/** Builds the recorder seed (span attributes) from the Responses request. */
function buildResponsesSeed(
  params: ResponseCreateParams,
  options: AdapterCallOptions,
  baseURL: string | undefined,
): GenerationStart {
  const p = params as ResponseCreateParams & {
    max_output_tokens?: number | null;
    temperature?: number | null;
    top_p?: number | null;
    instructions?: string | null;
    tool_choice?: unknown;
    text?: { format?: { type?: string } };
    conversation?: string | { id?: string } | null;
  };
  const server = serverOf(baseURL);
  return {
    model: {
      provider: providerOfHost(server.serverAddress) ?? 'openai',
      name: typeof p.model === 'string' ? p.model : '',
    },
    operationName: OP_CHAT,
    maxTokens: p.max_output_tokens ?? undefined,
    temperature: p.temperature ?? undefined,
    topP: p.top_p ?? undefined,
    toolChoice: typeof p.tool_choice === 'string' ? p.tool_choice : undefined,
    // Responses carries the system prompt out of band in `instructions`, which is
    // what `gen_ai.system_instructions` is for. Chat Completions instead rides it
    // inline in `messages` as a system-role turn.
    systemPrompt: p.instructions ?? undefined,
    outputType: outputTypeOf(p.text?.format?.type),
    tools: mapResponsesTools(p.tools),
    ...server,
    ...identityFieldsFromOptions(options),
    // The request's own conversation, unless withMetadata names one.
    conversationId:
      options.conversationId ||
      (typeof p.conversation === 'string' ? p.conversation : p.conversation?.id),
    contentCapture: options.contentCapture,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  };
}

/** Records a final Responses result onto the recorder, streamed or not. */
function recordResponseResult(rec: GenerationRecorder, result: ResponseResult): void {
  rec.setResult({
    responseId: result.id,
    responseModel: result.model,
    stopReason: responsesStopReason(result),
    usage: mapResponsesUsage(result.usage),
    output: mapResponsesOutput(result.output),
  });
  if (result.status === 'failed' || result.error) {
    rec.setCallError(responsesError(result.error?.code, result.error?.message));
  }
}

/**
 * Builds the error for a failure the Responses API reports inside a 200 (a stream
 * `error` event, or a response with `status: "failed"`). With no HTTP status to
 * classify by, `status` is derived from the error code: 429 for rate limits and
 * exhausted quota, 500 for server errors or a missing code, and 400 for the rest,
 * which are all problems with the input (bad image, invalid prompt, content policy).
 */
function responsesError(code: string | null | undefined, message: string | undefined): Error {
  const err = new Error([code, message].filter(Boolean).join(': ') || 'response failed');
  return Object.assign(err, { code, status: responsesErrorStatus(code) });
}

function responsesErrorStatus(code: string | null | undefined): number {
  if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') return 429;
  if (!code || code === 'server_error') return 500;
  return 400;
}

/**
 * Streaming handlers. The Responses stream is a union of named events, and these
 * handlers watch for three of them:
 *  - the first `*.delta` (text, reasoning, or tool-call arguments), which marks
 *    TTFT,
 *  - `error`, a failure reported mid-stream. The SDK only throws for a top-level
 *    `error` field, which this event lacks, so it arrives as an ordinary chunk,
 *  - `response.completed` / `.incomplete` / `.failed`, which carry the full
 *    `Response` object and so hand over output items and usage with no
 *    accumulation.
 *
 * That last point keeps this shorter than the Chat Completions streaming
 * handler: OpenAI assembles the response for us, so there is nothing to stitch
 * together from deltas.
 */
function responsesStreamHandlers(rec: GenerationRecorder): StreamWrapOptions<ResponseStreamEvent> {
  let firstTokenSeen = false;
  let finalResponse: ResponseResult | undefined;
  let streamError: Error | undefined;

  const finish = async ({ abandoned = false, error }: { abandoned?: boolean; error?: unknown }) => {
    if (finalResponse) recordResponseResult(rec, finalResponse);
    // The most specific cause wins: the final response's own error, then the
    // `error` event, then a transport error.
    const cause = streamError ?? error;
    if (cause && !finalResponse?.error) rec.setCallError(cause);
    if (abandoned) {
      rec.setCallError(new Error('openai responses stream was never consumed'));
    } else if (!finalResponse && !cause) {
      // The caller stopped reading before the final response, which carries the usage.
      rec.setAttributes({ [ATTR_USAGE_IS_PARTIAL]: true });
    }
    await rec.end();
  };

  return {
    onChunk: (event) => {
      const type = (event as { type?: string }).type ?? '';
      if (type === 'error') {
        const { code, message } = event as { code?: string | null; message?: string };
        streamError = responsesError(code, message);
      }
      if (!firstTokenSeen && type.endsWith('.delta')) {
        firstTokenSeen = true;
        rec.setFirstTokenAt(Date.now());
      }
      const withResponse = event as { response?: ResponseResult };
      if (
        withResponse.response &&
        (type === 'response.completed' ||
          type === 'response.incomplete' ||
          type === 'response.failed')
      ) {
        finalResponse = withResponse.response;
      }
    },
    onComplete: () => finish({}),
    onError: (err) => finish({ error: err }),
    onAbandoned: () => finish({ abandoned: true }),
  };
}

// -----------------------------------------------------------------------------
// Usage
// -----------------------------------------------------------------------------

interface ResponsesUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function mapResponsesUsage(usage: ResponsesUsageShape | undefined | null): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  };
}

/**
 * Derives a finish reason. Responses reports `status` plus, when truncated, an
 * `incomplete_details.reason`; the latter is the more specific of the two, so it
 * wins.
 */
function responsesStopReason(result: ResponseResult): string | undefined {
  const incomplete = (result as { incomplete_details?: { reason?: string } }).incomplete_details;
  if (incomplete?.reason) return incomplete.reason;
  return result.status ?? undefined;
}

// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------

/**
 * Maps request `tools` to our `ToolDefinition` shape. Responses tools are a
 * union: function tools carry `name`/`parameters` at the top level, where Chat
 * Completions nests them under `function`, while hosted tools (`web_search`,
 * `file_search`, `code_interpreter`, …) carry a `type` alone.
 */
function mapResponsesTools(tools: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: ToolDefinition[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as {
      type?: string;
      name?: string;
      description?: string;
      parameters?: unknown;
    };
    const name = t.name ?? t.type;
    if (!name) continue;
    out.push({
      name,
      type: t.type,
      description: t.description,
      inputSchemaJson: t.parameters != null ? safeJson(t.parameters) : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

// -----------------------------------------------------------------------------
// Content mapping
//
// Responses models the conversation as a flat list of typed items. `input`
// accepts either a bare string (shorthand for a single user turn) or that item
// list; `output` is the item list. We fold both into our `Message[]` shape,
// coalescing consecutive items that share a role so a tool-call turn and its
// text stay in one assistant message.
// -----------------------------------------------------------------------------

/** Maps the request's `input` (plus `instructions` handling done in the seed). */
function mapResponsesInput(params: ResponseCreateParams): Message[] {
  const input = (params as { input?: unknown }).input;
  if (typeof input === 'string') {
    return input === '' ? [] : [{ role: 'user', parts: [textPart(input)] }];
  }
  if (!Array.isArray(input)) return [];
  return mapResponsesItems(input);
}

/** Maps a response's `output` item list. */
export function mapResponsesOutput(output: unknown): Message[] {
  if (!Array.isArray(output)) return [];
  return mapResponsesItems(output);
}

interface ResponsesItem {
  type?: string;
  role?: string;
  content?: unknown;
  // function_call
  name?: string;
  call_id?: string;
  arguments?: string;
  // function_call_output
  output?: unknown;
  // reasoning
  summary?: Array<{ text?: string }>;
}

function mapResponsesItems(items: unknown[]): Message[] {
  const out: Message[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as ResponsesItem;
    // An item with a `role` but no `type` is the "message" shorthand callers
    // write by hand; `type: 'message'` is what the API returns.
    const type = item.type ?? (item.role ? 'message' : '');

    switch (type) {
      case 'message': {
        const role = normalizeResponsesRole(item.role);
        const parts = itemContentParts(item.content);
        if (parts.length > 0) appendParts(out, role, parts);
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        appendParts(out, 'assistant', [
          toolCallPart({
            name: item.name ?? '',
            id: item.call_id,
            inputJson: typeof item.arguments === 'string' ? item.arguments : undefined,
          }),
        ]);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        appendParts(out, 'tool', [
          toolResultPart({
            toolCallId: item.call_id,
            name: item.name,
            content: outputToText(item.output),
          }),
        ]);
        break;
      }
      case 'reasoning': {
        // Reasoning items expose a redacted summary unless the caller opted into
        // encrypted content, so the summary is all we can read.
        const text = Array.isArray(item.summary)
          ? item.summary
              .map((s) => s?.text ?? '')
              .filter(Boolean)
              .join('\n')
          : '';
        if (text) appendParts(out, 'assistant', [thinkingPart(text)]);
        break;
      }
      default:
        // Hosted-tool calls (web_search_call, file_search_call, …) and any item
        // type added after this was written. We skip what we cannot map.
        break;
    }
  }
  return out;
}

/**
 * Appends parts to the trailing message when it already has this role, so an
 * assistant turn that emitted text and then a tool call stays one message.
 */
function appendParts(out: Message[], role: Message['role'], parts: Part[]): void {
  const last = out[out.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
    return;
  }
  out.push({ role, parts });
}

function normalizeResponsesRole(role: string | undefined): Message['role'] {
  switch (role) {
    case 'system':
    case 'developer':
      return 'system';
    case 'assistant':
      return 'assistant';
    default:
      return 'user';
  }
}

/**
 * Flattens an item's `content` into parts. Content is either a bare string or a
 * list of typed parts (`input_text`, `output_text`, `refusal`, `input_image`,
 * …). We model the textual kinds only.
 */
function itemContentParts(content: unknown): Part[] {
  if (typeof content === 'string') return content === '' ? [] : [textPart(content)];
  if (!Array.isArray(content)) return [];
  let text = '';
  for (const raw of content) {
    if (typeof raw === 'string') {
      text += raw;
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as { type?: string; text?: string; refusal?: string };
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text === 'string') text += part.text;
    } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
      text += part.refusal;
    }
  }
  return text === '' ? [] : [textPart(text)];
}

/** `function_call_output.output` is a string in practice but typed as unknown. */
function outputToText(output: unknown): string | undefined {
  if (output == null) return undefined;
  if (typeof output === 'string') return output || undefined;
  return safeJson(output);
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
