/**
 * Shared helpers for the Vercel AI SDK adapters (function wrappers in
 * `index.ts` and the callback hooks in `hooks.ts`).
 */

import type { ContentCaptureMode } from '../../content/capture.js';
import type { GenerationStart, ModelRef, ParentGenerationRef } from '../../models/generation.js';
import { identityFieldsFromOptions } from '../_common/metadata.js';

/**
 * Metadata applied to the recorder created by every wrapper / hook. All
 * fields are optional; identity defaults still fall through to
 * `withConversationId(...)` context, then to `ClientConfig` defaults.
 */
export interface VercelAdapterOptions {
  conversationId?: string;
  conversationTitle?: string;
  agentName?: string;
  agentVersion?: string;
  userId?: string;
  turnIndex?: number;
  turnRole?: string;
  contentCapture?: ContentCaptureMode;
  parentGenerationIds?: ParentGenerationRef[];
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
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
  // LanguageModelV2/V3 (AI SDK v6) expose `provider` and `modelId` properties.
  const m = model as { provider?: string; modelId?: string };
  return {
    provider: m?.provider ?? 'unknown',
    name: m?.modelId ?? 'unknown',
  };
}

export function embedModelRefFromAi(model: unknown): ModelRef {
  // EmbeddingModelV2/V3 has the same surface.
  return modelRefFromAi(model);
}

/**
 * Maps AI SDK usage (v5 or v6 top-level shape) to a partial `TokenUsage` object.
 * Handles both legacy `promptTokens`/`completionTokens` (v5) and
 * `inputTokens`/`outputTokens` (v6).
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
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: u.promptTokens ?? u.inputTokens,
    outputTokens: u.completionTokens ?? u.outputTokens,
    totalTokens: u.totalTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheCreationInputTokens: u.cacheCreationInputTokens,
    reasoningTokens: u.reasoningTokens,
  };
}
