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
 * Shared helpers for the Vercel AI SDK adapters (function wrappers in
 * `index.ts` and the callback hooks in `hooks.ts`).
 */

import type { GenerationStart, ModelRef } from '../../models/generation.js';
import { type AdapterCallOptions, identityFieldsFromOptions } from '../_common/metadata.js';

/**
 * Metadata applied to the recorder created by every wrapper / hook. Identical
 * to the shared {@link AdapterCallOptions} — aliased so the Vercel adapter has
 * a stable local name without a second source of truth to keep in sync.
 */
export type VercelAdapterOptions = AdapterCallOptions;

const AI_SDK_PROVIDER_MAPPINGS: readonly (readonly [prefix: string, provider: string])[] = [
  ['google.generative-ai', 'gcp.gemini'],
  ['azure.ai.openai', 'azure.ai.openai'],
  ['amazon-bedrock', 'aws.bedrock'],
  ['google.vertex', 'gcp.vertex_ai'],
  ['google-vertex', 'gcp.vertex_ai'],
  ['gcp.vertex_ai', 'gcp.vertex_ai'],
  ['azure.openai', 'azure.ai.openai'],
  ['aws.bedrock', 'aws.bedrock'],
  ['gcp.gemini', 'gcp.gemini'],
  ['anthropic', 'anthropic'],
  ['snowflake', 'snowflake'],
  ['openai', 'openai'],
  ['vertex', 'gcp.vertex_ai'],
  ['azure', 'azure.ai.openai'],
];

/** Maps AI SDK provider/API identifiers to OTel semantic provider names. */
export function normalizeAiSdkProviderName(provider: string): string {
  const normalized = provider.toLowerCase();
  for (const [prefix, semanticProvider] of AI_SDK_PROVIDER_MAPPINGS) {
    if (normalized === prefix || normalized.startsWith(`${prefix}.`)) return semanticProvider;
  }
  return provider;
}

export function identityFields(
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
  return identityFieldsFromOptions(options);
}

export function modelRefFromAi(model: unknown): ModelRef {
  // LanguageModelV3 (AI SDK v7) exposes `provider` and `modelId` properties.
  const m = model as { provider?: string; modelId?: string };
  return {
    provider: normalizeAiSdkProviderName(m?.provider ?? 'unknown'),
    name: m?.modelId ?? 'unknown',
  };
}

export function embedModelRefFromAi(model: unknown): ModelRef {
  // EmbeddingModelV3 (AI SDK v7) has the same surface.
  return modelRefFromAi(model);
}

/**
 * Maps AI SDK usage (v7 top-level shape) to a partial `TokenUsage` object.
 * Handles both the legacy `promptTokens`/`completionTokens` (v5) and
 * current `inputTokens`/`outputTokens` (v6/v7) names.
 */
export function mapAiUsage(usage: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
      reasoningTokens?: number;
    }
  | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: u.promptTokens ?? u.inputTokens,
    outputTokens: u.completionTokens ?? u.outputTokens,
    totalTokens: u.totalTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheWriteInputTokens: u.cacheCreationInputTokens,
    reasoningTokens: u.reasoningTokens,
  };
}

/** The AI SDK call settings a model call's span records. */
export interface AiCallSettings {
  maxOutputTokens?: number;
  /** Before AI SDK v7. */
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: unknown;
  seed?: number;
}

/** A generation's request parameters. */
export type RequestParams = Pick<
  GenerationStart,
  | 'maxTokens'
  | 'temperature'
  | 'topP'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'stopSequences'
  | 'seed'
>;

/** Maps AI SDK call settings to a generation's request parameters. */
export function requestParams(settings: AiCallSettings): RequestParams {
  return {
    maxTokens: settings.maxOutputTokens ?? settings.maxTokens,
    temperature: settings.temperature,
    topP: settings.topP,
    frequencyPenalty: settings.frequencyPenalty,
    presencePenalty: settings.presencePenalty,
    stopSequences: Array.isArray(settings.stopSequences)
      ? settings.stopSequences.filter((x): x is string => typeof x === 'string')
      : undefined,
    seed: settings.seed,
  };
}
