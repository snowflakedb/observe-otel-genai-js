/**
 * Vercel AI SDK adapter.
 *
 * Wraps `generateText` / `streamText` / `generateObject` / `embed` / `embedMany`
 * so each call runs inside an `@genai-otel/core` recorder and produces the
 * standard GenAI semconv span + metrics, on top of whatever the AI SDK
 * already emits via its own telemetry hooks.
 *
 * Usage:
 *   import { wrapGenerateText } from '@genai-otel/core/vercel-ai-sdk';
 *
 *   const result = await wrapGenerateText(client, {
 *     model: openai('gpt-4o'),
 *     prompt: 'Tell me about Observe.',
 *   }, { agentName: 'demo' });
 *
 * Note: targets AI SDK v6 (`ai ^6.0.0`). v5/v6 renamed several params
 * (e.g. `maxTokens` -> `maxOutputTokens`) and usage fields
 * (`promptTokens`/`completionTokens` -> `inputTokens`/`outputTokens`); the
 * wrapper duck-types both the legacy and current shapes so it stays tolerant.
 */

import {
  embed as aiEmbed,
  embedMany as aiEmbedMany,
  generateObject as aiGenerateObject,
  generateText as aiGenerateText,
  streamText as aiStreamText,
  type embed,
  type embedMany,
  type generateObject,
  type generateText,
  type streamText,
} from 'ai';

import type { Client } from '../../client.js';
import type { GenerationStart } from '../../models/generation.js';
import { OP_CHAT, OP_GENERATE_CONTENT } from '../../semconv.js';
import {
  type VercelAdapterOptions,
  embedModelRefFromAi,
  identityFields as identityFieldsFromAdapterOptions,
  modelRefFromAi,
} from './_model.js';

export type { VercelAdapterOptions };

// Re-export so the middleware ships under the same subpath entry.
export { genaiOtelMiddleware } from './middleware.js';

// -----------------------------------------------------------------------------
// generateText
// -----------------------------------------------------------------------------

type GenerateTextParams = Parameters<typeof generateText>[0];
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

export async function wrapGenerateText(
  client: Client,
  params: GenerateTextParams,
  options: VercelAdapterOptions = {},
): Promise<GenerateTextResult> {
  const model = modelRefFromAi(params.model);

  await using rec = client.startGeneration({
    model,
    operationName: OP_CHAT,
    ...identityFields(options),
    maxTokens: readMaxTokens(params),
    temperature: params.temperature,
    topP: params.topP,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stopSequences: normalizeStopSequences(params.stopSequences),
    seed: params.seed,
    systemPrompt: typeof params.system === 'string' ? params.system : undefined,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  });

  try {
    const result = (await aiGenerateText(
      params as unknown as Parameters<typeof aiGenerateText>[0],
    )) as GenerateTextResult;
    rec.setResult({
      responseId: result.response?.id,
      responseModel: result.response?.modelId,
      stopReason: result.finishReason,
      usage: mapAiUsage(result.usage),
    });
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// streamText
// -----------------------------------------------------------------------------

type StreamTextParams = Parameters<typeof streamText>[0];
type StreamTextResult = ReturnType<typeof streamText>;

/**
 * Wraps `streamText`. Calls `streamText` eagerly so the returned object is the
 * real `StreamTextResult` (synchronous `textStream` / `usage` accessors per
 * the AI SDK contract). The recorder ends inside `onFinish` / `onError`.
 */
export function wrapStreamText(
  client: Client,
  params: StreamTextParams,
  options: VercelAdapterOptions = {},
): StreamTextResult {
  const model = modelRefFromAi(params.model);

  const rec = client.startStreamingGeneration({
    model,
    operationName: OP_CHAT,
    ...identityFields(options),
    maxTokens: readMaxTokens(params),
    temperature: params.temperature,
    topP: params.topP,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stopSequences: normalizeStopSequences(params.stopSequences),
    seed: params.seed,
    systemPrompt: typeof params.system === 'string' ? params.system : undefined,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  });

  let firstTokenRecorded = false;
  const userOnChunk = params.onChunk;
  const userOnFinish = params.onFinish;
  const userOnError = params.onError;

  return aiStreamText({
    ...params,
    onChunk: (...args) => {
      if (!firstTokenRecorded) {
        firstTokenRecorded = true;
        rec.setFirstTokenAt(Date.now());
      }
      return userOnChunk?.(...args);
    },
    onError: async (event) => {
      rec.setCallError((event as { error: unknown }).error);
      try {
        await rec.end();
      } catch {
        /* ignore */
      }
      return userOnError?.(event);
    },
    onFinish: async (event) => {
      rec.setResult({
        responseId: event.response?.id,
        responseModel: event.response?.modelId,
        stopReason: event.finishReason,
        usage: mapAiUsage(event.usage),
      });
      try {
        await rec.end();
      } catch {
        /* ignore */
      }
      return userOnFinish?.(event);
    },
  } as StreamTextParams);
}

// -----------------------------------------------------------------------------
// generateObject
// -----------------------------------------------------------------------------

type GenerateObjectParams = Parameters<typeof generateObject>[0];
type GenerateObjectResult = Awaited<ReturnType<typeof generateObject>>;

export async function wrapGenerateObject(
  client: Client,
  params: GenerateObjectParams,
  options: VercelAdapterOptions = {},
): Promise<GenerateObjectResult> {
  const model = modelRefFromAi(params.model);

  await using rec = client.startGeneration({
    model,
    operationName: OP_GENERATE_CONTENT,
    ...identityFields(options),
    maxTokens: readMaxTokens(params as unknown as { maxTokens?: number; maxOutputTokens?: number }),
    temperature: (params as { temperature?: number }).temperature,
    topP: (params as { topP?: number }).topP,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  });

  try {
    const result = (await aiGenerateObject(
      params as Parameters<typeof aiGenerateObject>[0],
    )) as GenerateObjectResult;
    rec.setResult({
      responseId: result.response?.id,
      responseModel: result.response?.modelId,
      stopReason: result.finishReason,
      usage: mapAiUsage(result.usage),
    });
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// embed / embedMany
// -----------------------------------------------------------------------------

type EmbedParams = Parameters<typeof embed>[0];
type EmbedResult = Awaited<ReturnType<typeof embed>>;
type EmbedManyParams = Parameters<typeof embedMany>[0];
type EmbedManyResult = Awaited<ReturnType<typeof embedMany>>;

export async function wrapEmbed(
  client: Client,
  params: EmbedParams,
  options: VercelAdapterOptions = {},
): Promise<EmbedResult> {
  const model = embedModelRefFromAi(params.model);

  await using rec = client.startEmbedding({
    model,
    agentName: options.agentName,
    agentVersion: options.agentVersion,
    tags: options.tags,
    metadata: options.metadata,
  });

  try {
    const result = (await aiEmbed(params)) as EmbedResult;
    const inputTexts = typeof params.value === 'string' ? [params.value] : undefined;
    rec.setResult({
      inputCount: inputTexts?.length ?? 1,
      inputTokens: result.usage?.tokens,
      dimensions: Array.isArray(result.embedding) ? result.embedding.length : undefined,
      inputTexts,
    });
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

export async function wrapEmbedMany(
  client: Client,
  params: EmbedManyParams,
  options: VercelAdapterOptions = {},
): Promise<EmbedManyResult> {
  const model = embedModelRefFromAi(params.model);

  await using rec = client.startEmbedding({
    model,
    agentName: options.agentName,
    agentVersion: options.agentVersion,
    tags: options.tags,
    metadata: options.metadata,
  });

  try {
    const result = (await aiEmbedMany(
      params as Parameters<typeof aiEmbedMany>[0],
    )) as EmbedManyResult;
    rec.setResult({
      inputCount: Array.isArray(params.values) ? params.values.length : undefined,
      inputTokens: result.usage?.tokens,
      dimensions: Array.isArray(result.embeddings[0]) ? result.embeddings[0]?.length : undefined,
      inputTexts: (params.values as string[] | undefined)?.filter(
        (v): v is string => typeof v === 'string',
      ),
    });
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function identityFields(
  options: VercelAdapterOptions,
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
  return identityFieldsFromAdapterOptions(options);
}

function mapAiUsage(usage: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: u.promptTokens ?? u.inputTokens,
    outputTokens: u.completionTokens ?? u.outputTokens,
    totalTokens: u.totalTokens,
  };
}

function normalizeStopSequences(s: unknown): string[] | undefined {
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
  return undefined;
}

/** Reads `maxOutputTokens` (AI SDK v6) or legacy `maxTokens`. */
function readMaxTokens(p: { maxTokens?: number; maxOutputTokens?: number }): number | undefined {
  return p.maxTokens ?? p.maxOutputTokens;
}
