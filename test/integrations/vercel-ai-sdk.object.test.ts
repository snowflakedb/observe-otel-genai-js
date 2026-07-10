import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateObjectHooks } from '../../src/integrations/vercel-ai-sdk/index.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_SYSTEM_INSTRUCTIONS,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  OP_GENERATE_CONTENT,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

// ---------------------------------------------------------------------------
// AI SDK v7 generateObject event builders (provider-format promptMessages)
// ---------------------------------------------------------------------------

function objectStepStart(opts: {
  provider?: string;
  modelId?: string;
  system?: string;
  userText?: string;
}) {
  return {
    stepNumber: 0 as const,
    provider: opts.provider ?? 'openai',
    modelId: opts.modelId ?? 'gpt-4o',
    promptMessages: [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: opts.userText ?? 'hi' }],
      },
    ],
  };
}

function objectStepEnd(opts: {
  objectText?: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  responseId?: string;
}) {
  return {
    stepNumber: 0 as const,
    provider: 'openai',
    modelId: 'gpt-4o',
    finishReason: opts.finishReason ?? 'stop',
    usage: { inputTokens: opts.inputTokens ?? 11, outputTokens: opts.outputTokens ?? 6 },
    objectText: opts.objectText ?? '{"ok":true}',
    response: { id: opts.responseId ?? 'obj-resp-1', modelId: 'gpt-4o-served' },
  };
}

describe('generateObjectHooks', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('captures input messages, system prompt, output, and usage on a generate_content span', async () => {
    const hooks = generateObjectHooks(h.client, { agentName: 'query-card' });

    hooks.onStepStart?.(
      objectStepStart({
        provider: 'anthropic',
        modelId: 'claude-3-5',
        system: 'You generate query cards.',
        userText: 'show me errors by service',
      }),
    );
    await hooks.onStepEnd?.(
      objectStepEnd({ objectText: '{"query":"..."}', inputTokens: 20, outputTokens: 8 }),
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_GENERATE_CONTENT);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('anthropic');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('claude-3-5');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('obj-resp-1');
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-4o-served');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(20);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(8);

    // System prompt rides on system_instructions, not input.messages.
    const sys = span?.attributes[ATTR_SYSTEM_INSTRUCTIONS] as string | undefined;
    expect(sys).toBeDefined();
    expect(sys).toContain('You generate query cards.');

    // Input user message captured from provider-format promptMessages.
    const rawIn = span?.attributes[ATTR_INPUT_MESSAGES] as string | undefined;
    expect(rawIn).toBeDefined();
    const input = JSON.parse(rawIn as string) as Array<{
      role: string;
      parts: Array<{ type: string; content?: string }>;
    }>;
    const user = input.find((m) => m.role === 'user');
    expect(user?.parts.find((p) => p.type === 'text')?.content).toBe('show me errors by service');
    // system messages are not duplicated into input
    expect(input.find((m) => m.role === 'system')).toBeUndefined();
  });

  it('emits nothing until onStepEnd (single-step lifecycle) and is a no-op if end fires alone', async () => {
    const hooks = generateObjectHooks(h.client);
    // onStepEnd without onStepStart must not throw and must not emit a span.
    await hooks.onStepEnd?.(objectStepEnd({}));
    expect(h.spans.getFinishedSpans().length).toBe(0);
  });
});
