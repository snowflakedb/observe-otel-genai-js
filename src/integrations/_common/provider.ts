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
 * Maps a framework's provider hint to a well-known `gen_ai.provider.name` value.
 *
 * Order matters for two reasons. Hosting platforms come before the vendors they host,
 * because their names carry the hosted vendor's name too (`AzureChatOpenAI` contains
 * `openai`). And `vertex` must precede `xai`, because `vertexai` contains `xai`.
 */
const PROVIDER_MATCHES: readonly (readonly [readonly string[], string])[] = [
  [['snowflake'], 'snowflake'],
  [['azureai'], 'azure.ai.inference'],
  [['azure'], 'azure.ai.openai'],
  [['bedrock'], 'aws.bedrock'],
  [['openai'], 'openai'],
  [['vertex'], 'gcp.vertex_ai'],
  [['anthropic'], 'anthropic'],
  [['gemini', 'googlegenai', 'googlegenerativeai'], 'gcp.gemini'],
  [['google'], 'gcp.gen_ai'],
  [['mistral'], 'mistral_ai'],
  [['cohere'], 'cohere'],
  [['watsonx'], 'ibm.watsonx.ai'],
  [['perplexity'], 'perplexity'],
  [['deepseek'], 'deepseek'],
  [['moonshot'], 'moonshot_ai'],
  [['groq'], 'groq'],
  [['xai'], 'x_ai'],
  [['ollama'], 'ollama'],
];

/** Separators are ignored, because frameworks spell provider ids with `-`, `_` and `.`. */
export function matchProvider(hints: readonly string[]): string | undefined {
  const lc = hints.map((s) => s.toLowerCase().replace(/[-_.]/g, ''));
  for (const [needles, provider] of PROVIDER_MATCHES) {
    if (needles.some((needle) => lc.some((s) => s.includes(needle)))) return provider;
  }
  return undefined;
}

/**
 * Providers serving OpenAI's or Anthropic's API, by base URL host. Keep in sync with
 * `_PROVIDER_BY_HOST` in the Python SDK.
 */
const PROVIDER_BY_HOST: readonly (readonly [RegExp, string])[] = [
  [/(^|\.)snowflakecomputing\.com$/, 'snowflake'],
  [/\.openai\.azure\.com$/, 'azure.ai.openai'],
  [/\.(services|inference)\.ai\.azure\.com$/, 'azure.ai.inference'],
  [/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/, 'aws.bedrock'],
  [/^api\.groq\.com$/, 'groq'],
  [/^api\.deepseek\.com$/, 'deepseek'],
  [/^api\.x\.ai$/, 'x_ai'],
  [/^api\.mistral\.ai$/, 'mistral_ai'],
  [/^generativelanguage\.googleapis\.com$/, 'gcp.gemini'],
];

/** The provider serving `host`, or undefined for a host not in the table. */
export function providerOfHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return PROVIDER_BY_HOST.find(([pattern]) => pattern.test(host))?.[1];
}
