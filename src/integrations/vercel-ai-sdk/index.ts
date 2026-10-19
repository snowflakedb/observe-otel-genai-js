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
 * Vercel AI SDK adapter.
 *
 * Provides two integration styles:
 *
 * 1. **Telemetry integration** (recommended) — `genaiTelemetryIntegration(client)`
 *    registered once via the AI SDK's `registerTelemetry(...)`. Every
 *    `generateText` / `streamText` / `ToolLoopAgent` / `generateObject` call in
 *    the process then emits genai-otel spans (`invoke_agent` → `chat` →
 *    `execute_tool`) with no per-call-site wiring.
 *
 * 2. **Function wrappers** — `wrapGenerateText` / `wrapStreamText` / etc. wrap a
 *    single top-level AI SDK call and emit one generation span per invocation,
 *    without global registration.
 *
 * Usage (integration):
 *   import { registerTelemetry } from 'ai';
 *   import { genaiTelemetryIntegration } from '@genai-otel/core/vercel-ai-sdk';
 *
 *   registerTelemetry(genaiTelemetryIntegration(client, { deriveOptions }));
 *
 * Note: targets AI SDK v7 (`ai ^7.0.0`). v7 uses `maxOutputTokens` and
 * `inputTokens`/`outputTokens` usage fields, and renamed the final lifecycle
 * callback `onFinish` -> `onEnd`; the adapters still duck-type the legacy
 * (`maxTokens`, `promptTokens`/`completionTokens`) shapes so they stay tolerant.
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
import { OP_CHAT, OP_GENERATE_CONTENT } from '../../semconv.js';
import { toAgentInputMessages } from './_map.js';
import {
  type VercelAdapterOptions,
  embedModelRefFromAi,
  identityFields,
  mapAiUsage,
  modelRefFromAi,
} from './_model.js';

export type { VercelAdapterOptions };

// Re-export the v7 Telemetry integration (register once via registerTelemetry).
export {
  type DeriveOptions,
  type DeriveOptionsEvent,
  type GenaiTelemetryOptions,
  defaultDeriveOptions,
  genaiTelemetryIntegration,
} from './integration.js';

// Public mapper: AI SDK `ModelMessage[]` -> genai-otel `Message[]` (for callers
// authoring their own `invoke_agent` spans / `gen_ai.input.messages`).
export { toAgentInputMessages };

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
 * the AI SDK contract). The recorder ends inside `onEnd` / `onError`.
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
  const userOnEnd = params.onEnd;
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
    onEnd: async (event) => {
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
      return userOnEnd?.(event);
    },
  } as StreamTextParams);
}

// -----------------------------------------------------------------------------
// generateObject
// -----------------------------------------------------------------------------

type GenerateObjectParams = Parameters<typeof generateObject>[0];
type GenerateObjectResult = Awaited<ReturnType<typeof generateObject>>;

/**
 * Wraps `generateObject`.
 *
 * Note: AI SDK deprecates `generateObject`/`streamObject` in favor of
 * `generateText`/`streamText` with the `Output` structured-output API. This
 * wrapper remains for callers still on `generateObject`; prefer
 * {@link wrapGenerateText} + `Output` for new code.
 */
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
    conversationId: options.conversationId,
    userId: options.userId,
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
    conversationId: options.conversationId,
    userId: options.userId,
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

function normalizeStopSequences(s: unknown): string[] | undefined {
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
  return undefined;
}

/** Reads `maxOutputTokens` (AI SDK v7) or legacy `maxTokens`. */
function readMaxTokens(p: {
  maxTokens?: number;
  maxOutputTokens?: number;
}): number | undefined {
  return p.maxOutputTokens ?? p.maxTokens;
}
