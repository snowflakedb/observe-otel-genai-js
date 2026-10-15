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
 * Tests for the Anthropic adapter.
 *
 * Uses a fake Anthropic client to verify mapping of content blocks, stop
 * reasons, and cache-token usage onto our `Generation` shape.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  instrumentedMessageCreate,
  withMetadata,
  wrapAnthropic,
} from '../../src/integrations/anthropic/index.js';
import {
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

function makeFakeAnthropic(reply: () => Promise<unknown>): Anthropic {
  return {
    messages: {
      create: () => reply(),
    },
  } as unknown as Anthropic;
}

describe('Anthropic adapter — instrumentedMessageCreate', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('maps Anthropic usage including cache tokens onto Generation', async () => {
    const fake = makeFakeAnthropic(async () => ({
      id: 'msg_01abc',
      model: 'claude-3-5-sonnet-20241022',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi back' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
      },
    }));

    const out = (await instrumentedMessageCreate(h.client, fake, {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    })) as { id: string };

    expect(out.id).toBe('msg_01abc');
    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('anthropic');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('claude-3-5-sonnet-20241022');
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('claude-3-5-sonnet-20241022');
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('msg_01abc');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(10);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(4);
    expect(span?.attributes[ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(100);
    expect(span?.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(50);
    expect(span?.attributes['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
  });

  it('captures input + output messages as structured attributes', async () => {
    const fake = makeFakeAnthropic(async () => ({
      id: 'msg_content',
      model: 'claude',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi back' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    await instrumentedMessageCreate(
      h.client,
      fake,
      { model: 'claude', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      { contentCapture: 'no_tool_content' },
    );

    const [span] = h.spans.getFinishedSpans();
    const input = JSON.parse(span!.attributes['gen_ai.input.messages'] as string);
    expect(input[0].role).toBe('user');
    expect(input[0].parts[0].content).toBe('hi');
    const output = JSON.parse(span!.attributes['gen_ai.output.messages'] as string);
    expect(output[0].role).toBe('assistant');
    expect(output[0].parts[0].content).toBe('hi back');
  });

  it('captures system prompt from string', async () => {
    const fake = makeFakeAnthropic(async () => ({
      id: 'msg_sys',
      model: 'claude',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    await instrumentedMessageCreate(
      h.client,
      fake,
      {
        model: 'claude',
        max_tokens: 10,
        system: 'be helpful',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { contentCapture: 'no_tool_content' },
    );

    const [span] = h.spans.getFinishedSpans();
    const system = JSON.parse(span!.attributes['gen_ai.system_instructions'] as string);
    expect(system).toEqual([{ type: 'text', content: 'be helpful' }]);
  });
});

describe('Anthropic adapter — streaming', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'no_tool_content' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('captures TTFT + maps final usage from message_start/message_delta events', async () => {
    const fake = makeFakeAnthropic(async () => {
      async function* gen() {
        yield {
          type: 'message_start',
          message: {
            id: 'msg_stream_1',
            model: 'claude-stream',
            role: 'assistant',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 12, output_tokens: 0 },
          },
        };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } };
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        };
        yield { type: 'message_stop' };
      }
      return gen();
    });

    const wrapped = wrapAnthropic(h.client, fake);
    const stream = (await wrapped.messages.create({
      model: 'claude-stream',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    } as any)) as unknown as AsyncIterable<unknown>;

    for await (const _e of stream) {
      /* drain */
    }

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('claude-stream');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(12);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(1);
    expect(span?.attributes['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    const output = JSON.parse(span!.attributes['gen_ai.output.messages'] as string);
    expect(output[0].parts[0].content).toBe('hi');
  });
});

describe('Anthropic adapter — wrapAnthropic proxy + withMetadata', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('propagates agent + conversation metadata to the span', async () => {
    const fake = makeFakeAnthropic(async () => ({
      id: 'msg_meta',
      model: 'claude',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const wrapped = wrapAnthropic(h.client, fake);
    await wrapped.messages.create(
      withMetadata(
        {
          model: 'claude',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { agentName: 'responder', conversationId: 'conv-anthropic-1' },
      ),
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['gen_ai.agent.name']).toBe('responder');
    expect(span?.attributes['gen_ai.conversation.id']).toBe('conv-anthropic-1');
  });
});
