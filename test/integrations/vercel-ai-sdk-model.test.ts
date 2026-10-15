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

import { describe, expect, it } from 'vitest';

import {
  embedModelRefFromAi,
  modelRefFromAi,
  normalizeAiSdkProviderName,
} from '../../src/integrations/vercel-ai-sdk/_model.js';

describe('normalizeAiSdkProviderName', () => {
  it.each([
    ['snowflake', 'snowflake'],
    ['snowflake.chat', 'snowflake'],
    ['snowflake.completion', 'snowflake'],
    ['openai.chat', 'openai'],
    ['openai.responses', 'openai'],
    ['anthropic.messages', 'anthropic'],
    ['amazon-bedrock.chat', 'aws.bedrock'],
    ['aws.bedrock', 'aws.bedrock'],
    ['aws.bedrock.converse', 'aws.bedrock'],
    ['google.vertex.chat', 'gcp.vertex_ai'],
    ['google-vertex.chat', 'gcp.vertex_ai'],
    ['gcp.vertex_ai', 'gcp.vertex_ai'],
    ['google.generative-ai.chat', 'gcp.gemini'],
    ['gcp.gemini', 'gcp.gemini'],
    ['azure.openai.responses', 'azure.ai.openai'],
    ['azure.ai.openai', 'azure.ai.openai'],
    ['OpenAI.Responses', 'openai'],
    ['AWS.BEDROCK.Converse', 'aws.bedrock'],
    ['acme.custom-api', 'acme.custom-api'],
    ['Acme.Custom-API', 'Acme.Custom-API'],
  ])('maps %s to %s', (provider, expected) => {
    expect(normalizeAiSdkProviderName(provider)).toBe(expected);
  });

  it('uses the longest matching known provider prefix', () => {
    expect(normalizeAiSdkProviderName('azure.ai.openai.responses')).toBe('azure.ai.openai');
  });
});

describe('Vercel AI SDK model references', () => {
  it('normalizes generation and embedding providers identically', () => {
    const model = { provider: 'snowflake.chat', modelId: 'snowflake-arctic' };
    const expected = { provider: 'snowflake', name: 'snowflake-arctic' };

    expect(modelRefFromAi(model)).toEqual(expected);
    expect(embedModelRefFromAi(model)).toEqual(expected);
  });

  it('uses unknown fallbacks for missing model fields', () => {
    expect(modelRefFromAi(undefined)).toEqual({ provider: 'unknown', name: 'unknown' });
    expect(embedModelRefFromAi({})).toEqual({ provider: 'unknown', name: 'unknown' });
  });
});
