import { describe, expect, it } from 'vitest';

import {
  embedModelRefFromAi,
  mapAiUsage,
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

describe('mapAiUsage', () => {
  it('maps AI SDK v7 nested token details', () => {
    expect(
      mapAiUsage({
        inputTokens: 12,
        inputTokenDetails: {
          noCacheTokens: 5,
          cacheReadTokens: 4,
          cacheWriteTokens: 3,
        },
        outputTokens: 7,
        outputTokenDetails: { textTokens: 5, reasoningTokens: 2 },
        totalTokens: 19,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it('retains legacy top-level usage compatibility', () => {
    expect(
      mapAiUsage({
        promptTokens: 8,
        completionTokens: 3,
        totalTokens: 11,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        reasoningTokens: 4,
      }),
    ).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      reasoningTokens: 4,
    });
  });
});
