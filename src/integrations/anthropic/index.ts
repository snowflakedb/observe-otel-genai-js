/**
 * Anthropic SDK adapter.
 *
 * Wraps `messages.create` (sync + streaming). Maps Anthropic-specific fields:
 *  - `usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens`
 *  - `stop_reason` / `stop_sequence`
 *  - Content blocks: `text`, `thinking`, `tool_use`, `tool_result`
 *
 * Mirrors the OpenAI adapter's two entry points: a proxy (`wrapAnthropic`) and
 * per-method helpers (`instrumentedMessageCreate`). Metadata attaches via the
 * `withMetadata(params, options)` helper.
 */

import type Anthropic from '@anthropic-ai/sdk';

import type { Client } from '../../client.js';
import type { GenerationStart } from '../../models/generation.js';
import type { Message, Part } from '../../models/message.js';
import { textPart, thinkingPart, toolCallPart } from '../../models/message.js';
import { OP_CHAT } from '../../semconv.js';
import {
  type AnthropicBlock as AntBlock,
  type AnthropicMessageParam as AntMessageParam,
  blockToParts,
} from '../_common/anthropic-blocks.js';
import {
  type ApiPromiseLike,
  finalizeSpanOnRequestError,
  isApiPromiseLike,
} from '../_common/api-promise.js';
import {
  type AdapterCallOptions,
  createMetadataAccessor,
  identityFieldsFromOptions,
} from '../_common/metadata.js';
import { type StreamWrapOptions, wrapProviderStream } from '../_common/stream.js';

export type AnthropicAdapterOptions = AdapterCallOptions;

const accessor = createMetadataAccessor<AnthropicAdapterOptions>('@genai-otel/anthropic-metadata');
export const withMetadata = accessor.withMetadata;
const readMetadata = accessor.readMetadata;
const stripMetadata = accessor.stripMetadata;
const resolveParams = accessor.resolveParams;

// -----------------------------------------------------------------------------
// messages.create
// -----------------------------------------------------------------------------

type MessageCreateParams = Anthropic.Messages.MessageCreateParams;
type AnthropicMessage = Anthropic.Messages.Message;

/** Recorder returned by the shared {@link Client} generation entry points. */
type GenerationRecorder = ReturnType<Client['startGeneration']>;

/**
 * Invokes the underlying (un-instrumented) `messages.create`. The proxy adapter
 * binds this to `anthropic.messages.create`; the OTel instrumentation binds it
 * to the original prototype method it patched, so the shared
 * {@link runMessageCreate} core never re-enters the patched path.
 */
export type MessageCreateInvoke = (
  params: MessageCreateParams,
) => Promise<AnthropicMessage | AsyncIterable<unknown>>;

export async function instrumentedMessageCreate(
  client: Client,
  anthropic: Anthropic,
  params: MessageCreateParams,
  options: AnthropicAdapterOptions = {},
): Promise<AnthropicMessage | AsyncIterable<unknown>> {
  const resolved = resolveParams(params, options);
  return runMessageCreate(
    client,
    (p) => anthropic.messages.create(p) as Promise<AnthropicMessage | AsyncIterable<unknown>>,
    resolved.params,
    resolved.options,
  );
}

/**
 * Shared message-create instrumentation core. Takes an `invoke` callback (rather
 * than the Anthropic client) so the proxy and the OTel instrumentation can share
 * all span/recorder logic while each supplies its own recursion-safe way of
 * reaching the real `create`.
 *
 * This path returns a plain `Promise`. Callers that need to preserve the SDK's
 * `APIPromise` (so `.withResponse()` and the `messages.stream()` helper keep
 * working) should use {@link instrumentMessageCreateApiPromise} instead; this
 * remains the fallback for non-`APIPromise` returns.
 *
 * @internal exported for {@link file://./instrumentation.ts}; not part of the
 * stable public API.
 */
export async function runMessageCreate(
  client: Client,
  invoke: MessageCreateInvoke,
  params: MessageCreateParams,
  options: AnthropicAdapterOptions,
): Promise<AnthropicMessage | AsyncIterable<unknown>> {
  const isStream = (params as { stream?: boolean }).stream === true;
  const seed = buildGenerationSeed(params, options);

  if (isStream) {
    const rec = client.startStreamingGeneration(seed);
    rec.setResult({ input: mapAnthropicInput(params.messages) });
    let stream: AsyncIterable<Record<string, unknown>>;
    try {
      stream = (await invoke(params)) as AsyncIterable<Record<string, unknown>>;
    } catch (err) {
      rec.setCallError(err);
      await rec.end();
      throw err;
    }
    return wrapProviderStream<typeof stream, Record<string, unknown>>(
      stream,
      anthropicStreamHandlers(rec),
    );
  }

  await using rec = client.startGeneration(seed);
  try {
    const result = (await invoke(params)) as AnthropicMessage;
    recordNonStreamResult(rec, params, result);
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

/**
 * Instrument a `messages.create` call while preserving the SDK's `APIPromise`,
 * so `.withResponse()` / `.asResponse()` — and `messages.stream()`, which calls
 * `create(...).withResponse()` internally — keep working. Recording happens in
 * the `_thenUnwrap` transform (which runs when the caller consumes the result);
 * request failures are finalized separately via {@link endSpanOnRequestError},
 * since the transform only runs on success.
 *
 * @internal
 */
export function instrumentMessageCreateApiPromise(
  client: Client,
  apiPromise: ApiPromiseLike<unknown>,
  params: MessageCreateParams,
  options: AnthropicAdapterOptions,
): unknown {
  const isStream = (params as { stream?: boolean }).stream === true;
  const seed = buildGenerationSeed(params, options);

  if (isStream) {
    const rec = client.startStreamingGeneration(seed);
    rec.setResult({ input: mapAnthropicInput(params.messages) });
    const handlers = anthropicStreamHandlers(rec);
    finalizeSpanOnRequestError(apiPromise, rec);
    return apiPromise._thenUnwrap((stream) =>
      wrapProviderStream<AsyncIterable<Record<string, unknown>>, Record<string, unknown>>(
        stream as AsyncIterable<Record<string, unknown>>,
        handlers,
      ),
    );
  }

  const rec = client.startGeneration(seed);
  finalizeSpanOnRequestError(apiPromise, rec);
  return apiPromise._thenUnwrap((result) => {
    recordNonStreamResult(rec, params, result as AnthropicMessage);
    void rec.end();
    return result;
  });
}

/** Builds the recorder seed (span attributes) from the request params. */
function buildGenerationSeed(
  params: MessageCreateParams,
  options: AnthropicAdapterOptions,
): GenerationStart {
  return {
    model: { provider: 'anthropic', name: params.model },
    operationName: OP_CHAT,
    maxTokens: params.max_tokens,
    temperature: params.temperature ?? undefined,
    topP: params.top_p ?? undefined,
    stopSequences: params.stop_sequences,
    systemPrompt:
      typeof params.system === 'string'
        ? params.system
        : extractSystemText(params.system as unknown[]),
    ...identityFieldsFromOptions(options),
    contentCapture: options.contentCapture,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  };
}

/** Records the result of a non-streaming message onto the recorder. */
function recordNonStreamResult(
  rec: GenerationRecorder,
  params: MessageCreateParams,
  result: AnthropicMessage,
): void {
  rec.setResult({
    responseId: result.id,
    responseModel: result.model,
    stopReason: result.stop_reason ?? undefined,
    usage: mapAnthropicUsage(result.usage as unknown as AnthropicUsageShape),
    input: mapAnthropicInput(params.messages),
    output: mapAnthropicOutput((result as { content?: unknown }).content),
  });
}

/**
 * Builds the streaming {@link StreamWrapOptions} for a message stream: observes
 * chunks to record TTFT, accumulate content blocks, and capture streamed usage,
 * then finalizes the recorder on completion / error / abandonment.
 */
function anthropicStreamHandlers(
  rec: GenerationRecorder,
): StreamWrapOptions<Record<string, unknown>> {
  let firstTokenSeen = false;
  let finalUsage: AnthropicUsageShape | undefined;
  let finalModel: string | undefined;
  let finalStopReason: string | undefined;
  let finalId: string | undefined;
  const blockAcc = new Map<number, AntBlockAcc>();

  return {
    onChunk: (event) => {
      const t = event.type as string | undefined;
      // TTFT = first content token, not the `message_start` metadata event.
      if (!firstTokenSeen && (t === 'content_block_start' || t === 'content_block_delta')) {
        firstTokenSeen = true;
        rec.setFirstTokenAt(Date.now());
      }
      if (t === 'message_start') {
        const msg = (event as { message?: AnthropicMessage }).message;
        if (msg) {
          finalId = msg.id;
          finalModel = msg.model;
          finalUsage = msg.usage as unknown as AnthropicUsageShape;
        }
      }
      if (t === 'content_block_start') {
        const idx = (event as { index?: number }).index ?? 0;
        const cb = (event as { content_block?: AntBlock }).content_block;
        blockAcc.set(idx, {
          type: cb?.type,
          text: '',
          thinking: '',
          toolId: cb?.id,
          toolName: cb?.name,
          toolJson: '',
        });
      }
      if (t === 'content_block_delta') {
        const idx = (event as { index?: number }).index ?? 0;
        const d = (event as { delta?: AntStreamDelta }).delta;
        const entry = blockAcc.get(idx) ?? { text: '', thinking: '', toolJson: '' };
        if (d?.type === 'text_delta' && typeof d.text === 'string') {
          entry.text += d.text;
          entry.type ??= 'text';
        } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          entry.toolJson += d.partial_json;
          entry.type ??= 'tool_use';
        } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
          entry.thinking += d.thinking;
          entry.type ??= 'thinking';
        }
        blockAcc.set(idx, entry);
      }
      if (t === 'message_delta') {
        const delta = (event as { delta?: { stop_reason?: string } }).delta;
        if (delta?.stop_reason) finalStopReason = delta.stop_reason;
        const usage = (event as { usage?: AnthropicUsageShape }).usage;
        if (usage) finalUsage = { ...finalUsage, ...usage };
      }
    },
    onComplete: async () => {
      rec.setResult({
        responseId: finalId,
        responseModel: finalModel,
        stopReason: finalStopReason,
        usage: mapAnthropicUsage(finalUsage),
        output: buildAnthropicStreamOutput(blockAcc),
      });
      await rec.end();
    },
    onError: async (err) => {
      rec.setCallError(err);
      await rec.end();
    },
    onAbandoned: async () => {
      rec.setCallError(new Error('anthropic stream was never consumed'));
      await rec.end();
    },
  };
}

// -----------------------------------------------------------------------------
// wrapAnthropic(client) — auto-instrument proxy
// -----------------------------------------------------------------------------

/**
 * Returns a Proxy around `anthropic` that auto-instruments `messages.create`.
 */
export function wrapAnthropic<T extends Anthropic>(client: Client, anthropic: T): T {
  return new Proxy(anthropic, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'messages') return wrapMessages(client, anthropic, value);
      return value;
    },
  });
}

function wrapMessages(client: Client, anthropic: Anthropic, messages: unknown) {
  return new Proxy(messages as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create') {
        return (params: MessageCreateParams, ...rest: unknown[]) => {
          const options = readMetadata(params);
          stripMetadata(params);
          const create = anthropic.messages.create as (...a: unknown[]) => unknown;
          const raw = create.call(anthropic.messages, params, ...rest);
          if (isApiPromiseLike(raw)) {
            return instrumentMessageCreateApiPromise(client, raw, params, options);
          }
          return runMessageCreate(
            client,
            () => Promise.resolve(raw) as Promise<AnthropicMessage | AsyncIterable<unknown>>,
            params,
            options,
          );
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// -----------------------------------------------------------------------------
// Prototype-patch entry point (used by AnthropicInstrumentation)
// -----------------------------------------------------------------------------

/**
 * Builds a shimmer-style wrapper for `Messages.prototype.create`. The
 * instrumentation applies this to the SDK's prototype method; `original` is the
 * un-instrumented `create`. We read any per-call metadata attached via
 * {@link withMetadata}, strip it before it hits the wire, and drive the shared
 * {@link runMessageCreate} core with an `invoke` that calls `original` on the
 * resource instance — so we never recurse back into the patched method.
 *
 * `Messages.prototype.parse` calls the (now patched) `this.create`, so parsed
 * requests are instrumented too; `original` short-circuits any recursion.
 *
 * @internal
 */
export function patchMessagesCreate(
  client: Client,
  defaults: AnthropicAdapterOptions = {},
): (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown {
  return (original) =>
    function patchedCreate(this: unknown, ...args: unknown[]): unknown {
      const params = args[0] as MessageCreateParams;
      const rest = args.slice(1);
      const options = { ...defaults, ...readMetadata(params) };
      stripMetadata(params);
      const raw = original.apply(this, [params, ...rest]);
      if (isApiPromiseLike(raw)) {
        return instrumentMessageCreateApiPromise(client, raw, params, options);
      }
      // Fallback for non-`APIPromise` returns (unusual SDK shapes): the
      // `APIPromise` helpers are lost, but the span is still recorded.
      return runMessageCreate(
        client,
        () => Promise.resolve(raw) as Promise<AnthropicMessage | AsyncIterable<unknown>>,
        params,
        options,
      );
    };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface AnthropicUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function mapAnthropicUsage(usage: AnthropicUsageShape | undefined) {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
  };
}

function extractSystemText(blocks: unknown[] | undefined): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const out: string[] = [];
  for (const b of blocks) {
    if (b && typeof b === 'object') {
      const block = b as { type?: string; text?: string };
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text);
    }
  }
  return out.length ? out.join('\n') : undefined;
}

// -----------------------------------------------------------------------------
// Content mapping (Anthropic messages/blocks -> genai-otel Message[])
//
// System instructions ride on the separate `system` param (-> systemPrompt ->
// gen_ai.system_instructions), so they are not part of this message mapping.
// Image/document blocks are not modeled and are skipped.
// -----------------------------------------------------------------------------

interface AntStreamDelta {
  type?: string;
  text?: string;
  partial_json?: string;
  thinking?: string;
}
interface AntBlockAcc {
  type?: string;
  text: string;
  thinking: string;
  toolId?: string;
  toolName?: string;
  toolJson: string;
}

/** Maps an Anthropic `messages` array (request side) to `Message[]`. */
function mapAnthropicInput(messages: unknown): Message[] {
  if (!Array.isArray(messages)) return [];
  const out: Message[] = [];
  for (const raw of messages as AntMessageParam[]) {
    if (!raw || typeof raw !== 'object') continue;
    const role = raw.role === 'assistant' ? 'assistant' : 'user';
    const parts: Part[] = [];
    if (typeof raw.content === 'string') {
      if (raw.content) parts.push(textPart(raw.content));
    } else if (Array.isArray(raw.content)) {
      for (const b of raw.content) parts.push(...blockToParts(b));
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

/** Maps an Anthropic response `content` array to a single assistant `Message`. */
function mapAnthropicOutput(content: unknown): Message[] {
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const b of content as AntBlock[]) parts.push(...blockToParts(b));
  if (parts.length === 0) return [];
  return [{ role: 'assistant', parts }];
}

function buildAnthropicStreamOutput(blocks: Map<number, AntBlockAcc>): Message[] {
  const parts: Part[] = [];
  for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
    if (b.type === 'text' && b.text) parts.push(textPart(b.text));
    else if (b.type === 'thinking' && b.thinking) parts.push(thinkingPart(b.thinking));
    else if (b.type === 'tool_use')
      parts.push(
        toolCallPart({ name: b.toolName ?? '', id: b.toolId, inputJson: b.toolJson || undefined }),
      );
  }
  if (parts.length === 0) return [];
  return [{ role: 'assistant', parts }];
}
