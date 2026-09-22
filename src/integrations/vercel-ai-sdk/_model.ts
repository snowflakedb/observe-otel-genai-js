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
 * Maps AI SDK usage to a partial `TokenUsage` object.
 * Handles both the legacy `promptTokens`/`completionTokens` (v5) and
 * current `inputTokens`/`outputTokens` names, including v7 token details.
 */
export function mapAiUsage(usage: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningTokens?: number;
    }
  | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const inputDetails =
    u.inputTokenDetails && typeof u.inputTokenDetails === 'object'
      ? (u.inputTokenDetails as Record<string, unknown>)
      : undefined;
  const outputDetails =
    u.outputTokenDetails && typeof u.outputTokenDetails === 'object'
      ? (u.outputTokenDetails as Record<string, unknown>)
      : undefined;
  return {
    inputTokens: (u.promptTokens ?? u.inputTokens) as number | undefined,
    outputTokens: (u.completionTokens ?? u.outputTokens) as number | undefined,
    totalTokens: u.totalTokens as number | undefined,
    cacheReadInputTokens: (inputDetails?.cacheReadTokens ?? u.cacheReadInputTokens) as
      | number
      | undefined,
    cacheCreationInputTokens: (inputDetails?.cacheWriteTokens ?? u.cacheCreationInputTokens) as
      | number
      | undefined,
    reasoningTokens: (outputDetails?.reasoningTokens ?? u.reasoningTokens) as number | undefined,
  };
}
