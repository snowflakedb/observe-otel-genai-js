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
import { OP_CHAT } from '../../semconv.js';
import {
  type AdapterCallOptions,
  createMetadataAccessor,
  identityFieldsFromOptions,
} from '../_common/metadata.js';
import { wrapProviderStream } from '../_common/stream.js';

export type AnthropicAdapterOptions = AdapterCallOptions;

const accessor = createMetadataAccessor<AnthropicAdapterOptions>('@genai-otel/anthropic-metadata');
export const withMetadata = accessor.withMetadata;
const readMetadata = accessor.readMetadata;
const stripMetadata = accessor.stripMetadata;

// -----------------------------------------------------------------------------
// messages.create
// -----------------------------------------------------------------------------

type MessageCreateParams = Anthropic.Messages.MessageCreateParams;
type AnthropicMessage = Anthropic.Messages.Message;

export async function instrumentedMessageCreate(
  client: Client,
  anthropic: Anthropic,
  params: MessageCreateParams,
  options: AnthropicAdapterOptions = {},
): Promise<AnthropicMessage | AsyncIterable<unknown>> {
  return runMessageCreate(client, anthropic, params, options);
}

async function runMessageCreate(
  client: Client,
  anthropic: Anthropic,
  params: MessageCreateParams,
  options: AnthropicAdapterOptions,
): Promise<AnthropicMessage | AsyncIterable<unknown>> {
  const isStream = (params as { stream?: boolean }).stream === true;
  const seed: GenerationStart = {
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
    ...identityFields(options),
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  };

  if (isStream) {
    const rec = client.startStreamingGeneration(seed);
    let firstTokenSeen = false;
    let finalUsage: AnthropicUsageShape | undefined;
    let finalModel: string | undefined;
    let finalStopReason: string | undefined;
    let finalId: string | undefined;

    let stream: AsyncIterable<Record<string, unknown>>;
    try {
      stream = (await anthropic.messages.create(params)) as AsyncIterable<Record<string, unknown>>;
    } catch (err) {
      rec.setCallError(err);
      await rec.end();
      throw err;
    }

    return wrapProviderStream<typeof stream, Record<string, unknown>>(stream, {
      onChunk: (event) => {
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          rec.setFirstTokenAt(Date.now());
        }
        const t = event.type as string | undefined;
        if (t === 'message_start') {
          const msg = (event as { message?: AnthropicMessage }).message;
          if (msg) {
            finalId = msg.id;
            finalModel = msg.model;
            finalUsage = msg.usage as unknown as AnthropicUsageShape;
          }
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
    });
  }

  await using rec = client.startGeneration(seed);
  try {
    const result = (await anthropic.messages.create(params)) as AnthropicMessage;
    rec.setResult({
      responseId: result.id,
      responseModel: result.model,
      stopReason: result.stop_reason ?? undefined,
      usage: mapAnthropicUsage(result.usage as unknown as AnthropicUsageShape),
    });
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
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
        return (params: MessageCreateParams) => {
          const options = readMetadata(params);
          stripMetadata(params);
          return runMessageCreate(client, anthropic, params, options);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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

function identityFields(
  options: AnthropicAdapterOptions,
): Pick<
  GenerationStart,
  | 'conversationId'
  | 'conversationTitle'
  | 'agentName'
  | 'agentVersion'
  | 'userId'
  | 'turnIndex'
  | 'turnRole'
> {
  return identityFieldsFromOptions(options);
}
