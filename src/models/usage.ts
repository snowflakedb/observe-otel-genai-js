/**
 * Token-usage counters returned by an LLM call. All fields are integer counts;
 * zero means "not reported by the provider" and is suppressed from metric
 * emission (skip-on-zero rule).
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
}

/**
 * Returns a copy with `totalTokens` filled in when missing.
 */
export function normalizeUsage(usage: TokenUsage | undefined): TokenUsage {
  const u = usage ?? {};
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const total = u.totalTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total > 0 ? total : input + output,
    cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
    reasoningTokens: u.reasoningTokens ?? 0,
  };
}
