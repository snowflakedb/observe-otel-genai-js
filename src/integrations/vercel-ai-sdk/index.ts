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
 *    the process then emits observe-otel-genai spans (`invoke_agent`, with `chat` and
 *    `execute_tool` spans under it) with no per-call-site wiring.
 *
 * 2. **Function wrappers** — `wrapGenerateText` / `wrapStreamText` / etc. wrap a
 *    single top-level AI SDK call and emit one generation span per invocation,
 *    without global registration.
 *
 * `VercelAiSdkInstrumentation` (`./instrumentation`) registers the integration for
 * setups that list their OpenTelemetry instrumentations in one place.
 *
 * Usage (integration):
 *   import { registerTelemetry } from 'ai';
 *   import { genaiTelemetryIntegration } from '@snowflake/observe-otel-genai/vercel-ai-sdk';
 *
 *   registerTelemetry(genaiTelemetryIntegration(client, { deriveOptions }));
 *
 * Note: targets AI SDK v7 (`ai ^7.0.0`). v7 uses `maxOutputTokens` and
 * `inputTokens`/`outputTokens` usage fields, and renamed the final lifecycle
 * callback `onFinish` -> `onEnd`; the adapters still duck-type the legacy
 * (`maxTokens`, `promptTokens`/`completionTokens`) shapes so they stay tolerant.
 */

import {
  type TextStreamPart,
  type ToolSet,
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
import { mapCallPrompt, mapStepOutput, toAgentInputMessages } from './_map.js';
import {
  type VercelAdapterOptions,
  embedModelRefFromAi,
  identityFields,
  mapAiUsage,
  modelRefFromAi,
  requestParams,
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

// Public mapper: AI SDK `ModelMessage[]` -> observe-otel-genai `Message[]` (for callers
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
    ...requestParams(params),
    systemPrompt: recording(params).inputs ? systemPromptOf(params) : undefined,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  });
  if (recording(params).inputs) rec.setResult({ input: mapCallPrompt(params) });

  try {
    const result = (await aiGenerateText(
      params as unknown as Parameters<typeof aiGenerateText>[0],
    )) as GenerateTextResult;
    rec.setResult({
      output: recording(params).outputs ? finalReply(result.steps) : undefined,
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
    ...requestParams(params),
    systemPrompt: recording(params).inputs ? systemPromptOf(params) : undefined,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  });

  if (recording(params).inputs) rec.setResult({ input: mapCallPrompt(params) });

  let firstTokenRecorded = false;
  const userOnChunk = params.onChunk;
  const userOnEnd = params.onEnd;
  const userOnError = params.onError;

  return aiStreamText({
    ...params,
    onChunk: (...args) => {
      if (!firstTokenRecorded && isOutputChunk(args[0].chunk)) {
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
        output: recording(params).outputs ? finalReply(event.steps) : undefined,
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
    ...requestParams(params),
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

/** The AI SDK's per-call `recordInputs` / `recordOutputs` switches, on by default. */
function recording(params: GenerateTextParams | StreamTextParams): {
  inputs: boolean;
  outputs: boolean;
} {
  const telemetry = params.telemetry ?? params.experimental_telemetry;
  return {
    inputs: telemetry?.recordInputs !== false,
    outputs: telemetry?.recordOutputs !== false,
  };
}

/** The call's system prompt, from `instructions` (AI SDK v7) or `system`, when it is text. */
function systemPromptOf(params: GenerateTextParams | StreamTextParams): string | undefined {
  const system = params.instructions ?? params.system;
  return typeof system === 'string' ? system : undefined;
}

/** The reply of the call's last step; earlier steps' tool calls led up to it. */
function finalReply(steps: ReadonlyArray<{ content: Parameters<typeof mapStepOutput>[0] }>) {
  return mapStepOutput(steps.at(-1)?.content ?? []);
}

/**
 * Whether a stream chunk carries output, as the AI SDK counts it for its own time
 * to first output. The stream opens with chunks such as `start` that carry none.
 */
function isOutputChunk(chunk: TextStreamPart<ToolSet>): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.length > 0;
    case 'tool-input-delta':
      return chunk.delta.length > 0;
    case 'file':
    case 'reasoning-file':
    case 'tool-call':
      return true;
    default:
      return false;
  }
}
