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
