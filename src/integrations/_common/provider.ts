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
