/**
 * AI SDK v7 type-contract pin.
 *
 * The Vercel adapter (`hooks.ts` / `_model.ts`) deliberately duck-types the AI
 * SDK's callback events through its own local interfaces, so the adapter is
 * decoupled from `ai`'s exact callback types. The risk of that decoupling: a
 * breaking field rename in a future `ai` release would silently drop telemetry
 * with no compile error.
 *
 * These compile-time assertions are the tripwire. They reference the exact `ai`
 * types + fields the adapter reads (`mapAiUsage`, `modelRefFromAi`, the
 * onStepEnd StepResult path). If `ai` renames or removes any of them, this file
 * fails `pnpm typecheck` — surfacing the break at build time instead of as
 * missing spans in production.
 */

import type { LanguageModelUsage, StepResult, ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';

// --- Usage: mapAiUsage() reads inputTokens/outputTokens (v7 names). ----------
type _UsageInputTokens = LanguageModelUsage['inputTokens'];
type _UsageOutputTokens = LanguageModelUsage['outputTokens'];
type _UsageTotalTokens = LanguageModelUsage['totalTokens'];

// --- StepResult: onStepEnd reads content / finishReason / usage / response. --
type Step = StepResult<ToolSet>;
type _StepContent = Step['content'];
type _StepFinishReason = Step['finishReason'];
type _StepUsage = Step['usage'];
type _StepResponse = Step['response'];

// Assert the aliases resolve to usable types (fails to compile if a field is
// removed/renamed upstream). The `void` casts keep noUnusedLocals happy.
type _Assert =
  | _UsageInputTokens
  | _UsageOutputTokens
  | _UsageTotalTokens
  | _StepContent
  | _StepFinishReason
  | _StepUsage
  | _StepResponse;

describe('AI SDK v7 type contract', () => {
  it('pins the fields the Vercel adapter depends on (enforced at typecheck)', () => {
    // The real enforcement is the compile-time aliases above; this keeps the
    // file a runnable test so it appears in the suite.
    const _use: _Assert | undefined = undefined;
    expect(_use).toBeUndefined();
  });
});
