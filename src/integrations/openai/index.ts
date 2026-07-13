/**
 * OpenAI SDK adapter.
 *
 * Two entry points:
 *  - `wrapOpenAI(client, openai)` returns a Proxy around the OpenAI client
 *    that auto-instruments `chat.completions.create` and `embeddings.create`.
 *    Drop-in replacement for the OpenAI client.
 *  - Per-method helpers (`instrumentedChatCompletion`, `instrumentedEmbedding`)
 *    if you want to opt into instrumentation per call.
 *
 * Both helpers honor the same metadata options (`agentName`, `conversationId`,
 * etc.) you can pass through a `WeakMap`-keyed call site override.
 */

import type OpenAI from 'openai';

import type { Client } from '../../client.js';
import { ValidationError } from '../../errors.js';
import type { GenerationStart } from '../../models/generation.js';
import {
  type Message,
  type Part,
  textPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';
import { OP_CHAT } from '../../semconv.js';
import {
  type AdapterCallOptions,
  createMetadataAccessor,
  identityFieldsFromOptions,
} from '../_common/metadata.js';
import { wrapProviderStream } from '../_common/stream.js';

/** Per-call metadata that can be attached via `withMetadata(params, opts)`. */
export type OpenAIAdapterOptions = AdapterCallOptions;

const accessor = createMetadataAccessor<OpenAIAdapterOptions>('@genai-otel/openai-metadata');
export const withMetadata = accessor.withMetadata;
const readMetadata = accessor.readMetadata;
const stripMetadata = accessor.stripMetadata;
const resolveParams = accessor.resolveParams;

// -----------------------------------------------------------------------------
// chat.completions.create
// -----------------------------------------------------------------------------

type ChatCompletionsCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;
type ChatCompletionsResult = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Run a non-streaming chat completion inside a generation recorder.
 */
export async function instrumentedChatCompletion(
  client: Client,
  openai: OpenAI,
  params: ChatCompletionsCreateParams,
  options: OpenAIAdapterOptions = {},
): Promise<ChatCompletionsResult> {
  const resolved = resolveParams(params, options);
  // This helper returns a resolved ChatCompletion. Streaming params would make
  // the underlying call return a Stream instead, breaking the declared return
  // type — reject them and point callers at the streaming-aware proxy.
  if ((resolved.params as { stream?: boolean }).stream === true) {
    throw new ValidationError(
      'instrumentedChatCompletion does not support streaming params (stream: true). ' +
        'Use wrapOpenAI(client, openai) instead — it instruments the streamed chunks ' +
        '(TTFT, final usage) and returns the provider stream unchanged.',
    );
  }
  return runChatCompletion(
    client,
    openai,
    resolved.params,
    resolved.options,
  ) as Promise<ChatCompletionsResult>;
}

async function runChatCompletion(
  client: Client,
  openai: OpenAI,
  params: ChatCompletionsCreateParams,
  options: OpenAIAdapterOptions,
): Promise<unknown> {
  const isStream = (params as { stream?: boolean }).stream === true;

  const seed: GenerationStart = {
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

  if (isStream) {
    const rec = client.startStreamingGeneration(seed);
    rec.setResult({ input: mapOpenAIInput(params.messages) });
    let firstTokenSeen = false;
    let finalUsage: ChatUsageShape | undefined;
    let finalModel: string | undefined;
    let finalFinishReason: string | undefined;
    let finalId: string | undefined;
    let outputText = '';
    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = (await openai.chat.completions.create(
        params,
      )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    } catch (err) {
      rec.setCallError(err);
      await rec.end();
      throw err;
    }

    return wrapProviderStream<typeof stream, OpenAI.Chat.Completions.ChatCompletionChunk>(stream, {
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
    });
  }

  await using rec = client.startGeneration(seed);
  try {
    const result = (await openai.chat.completions.create(params)) as ChatCompletionsResult;
    rec.setResult({
      responseId: result.id,
      responseModel: result.model,
      stopReason: result.choices?.[0]?.finish_reason,
      usage: mapUsage(result.usage),
      input: mapOpenAIInput(params.messages),
      output: mapOpenAIOutputMessage(result.choices?.[0]?.message as OAMessage | undefined),
    });
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// embeddings.create
// -----------------------------------------------------------------------------

type EmbeddingCreateParams = OpenAI.Embeddings.EmbeddingCreateParams;
type EmbeddingResult = OpenAI.Embeddings.CreateEmbeddingResponse;

export async function instrumentedEmbedding(
  client: Client,
  openai: OpenAI,
  params: EmbeddingCreateParams,
  options: OpenAIAdapterOptions = {},
): Promise<EmbeddingResult> {
  await using rec = client.startEmbedding({
    model: { provider: 'openai', name: params.model },
    agentName: options.agentName,
    agentVersion: options.agentVersion,
    dimensions: params.dimensions,
    encodingFormat: params.encoding_format,
    tags: options.tags,
    metadata: options.metadata,
  });

  try {
    const result = await openai.embeddings.create(params);
    const inputs = Array.isArray(params.input)
      ? params.input.filter((v): v is string => typeof v === 'string')
      : typeof params.input === 'string'
        ? [params.input]
        : undefined;
    rec.setResult({
      inputCount: Array.isArray(params.input) ? params.input.length : 1,
      inputTokens: result.usage?.prompt_tokens,
      dimensions: result.data?.[0]?.embedding?.length,
      responseModel: result.model,
      inputTexts: inputs,
    });
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// wrapOpenAI(client) — auto-instrument proxy
// -----------------------------------------------------------------------------

/**
 * Returns a Proxy around `openai` that auto-instruments every chat/embedding
 * call. Methods we do not know about are passed through untouched.
 *
 * Per-call metadata can be attached with `withMetadata(params, options)`.
 */
export function wrapOpenAI<T extends OpenAI>(client: Client, openai: T): T {
  return new Proxy(openai, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'chat') return wrapChat(client, openai, value);
      if (prop === 'embeddings') return wrapEmbeddings(client, openai, value);
      return value;
    },
  });
}

function wrapChat(client: Client, openai: OpenAI, chat: unknown) {
  return new Proxy(chat as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'completions') return wrapCompletions(client, openai, value);
      return value;
    },
  });
}

function wrapCompletions(client: Client, openai: OpenAI, completions: unknown) {
  return new Proxy(completions as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create') {
        return (params: ChatCompletionsCreateParams) => {
          const options = readMetadata(params);
          stripMetadata(params);
          return runChatCompletion(client, openai, params, options);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapEmbeddings(client: Client, openai: OpenAI, embeddings: unknown) {
  return new Proxy(embeddings as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create') {
        return (params: EmbeddingCreateParams) => {
          const options = readMetadata(params);
          stripMetadata(params);
          return instrumentedEmbedding(client, openai, params, options);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
interface OAMessage {
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

function mapOpenAIInput(messages: unknown): Message[] {
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

function mapOpenAIOutputMessage(message: OAMessage | undefined): Message[] {
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
