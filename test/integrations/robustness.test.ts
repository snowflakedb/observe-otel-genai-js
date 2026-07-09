/**
 * Robustness tests for the shared adapter machinery.
 *
 * The guiding invariant: instrumentation must never break the user's actual
 * LLM call. A telemetry finalization error (recorder.end(), exporter flush)
 * must not surface through a consumed provider stream, and helpers must reject
 * cleanly on unsupported inputs rather than returning a wrong-typed value.
 */

import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/errors.js';
import { wrapProviderStream } from '../../src/integrations/_common/stream.js';
import { instrumentedChatCompletion } from '../../src/integrations/openai/index.js';
import { type Harness, createHarness } from '../_harness.js';

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const chunk of stream) seen.push(chunk);
  return seen;
}

describe('wrapProviderStream — telemetry never breaks the consumer', () => {
  it('swallows a throwing onComplete so the stream drains cleanly', async () => {
    async function* gen() {
      yield 1;
      yield 2;
    }
    const wrapped = wrapProviderStream(gen(), {
      watchdogMs: 0,
      onComplete: () => {
        throw new Error('exporter flush boom');
      },
    });

    await expect(drain(wrapped)).resolves.toEqual([1, 2]);
  });

  it('propagates the original provider error, not the telemetry error', async () => {
    async function* gen() {
      yield 1;
      throw new Error('provider failure');
    }
    const wrapped = wrapProviderStream(gen(), {
      watchdogMs: 0,
      onError: () => {
        throw new Error('telemetry boom');
      },
    });

    await expect(drain(wrapped)).rejects.toThrow('provider failure');
  });

  it('routes an early break to onAbandoned, not onComplete', async () => {
    let abandoned = false;
    let completed = false;
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    const wrapped = wrapProviderStream(gen(), {
      watchdogMs: 0,
      onAbandoned: () => {
        abandoned = true;
      },
      onComplete: () => {
        completed = true;
      },
    });

    for await (const _chunk of wrapped) {
      break; // abandon after the first chunk
    }

    expect(abandoned).toBe(true);
    expect(completed).toBe(false);
  });

  it('calls onComplete (not onAbandoned) on a full drain', async () => {
    let abandoned = false;
    let completed = false;
    async function* gen() {
      yield 1;
      yield 2;
    }
    const wrapped = wrapProviderStream(gen(), {
      watchdogMs: 0,
      onAbandoned: () => {
        abandoned = true;
      },
      onComplete: () => {
        completed = true;
      },
    });

    await drain(wrapped);

    expect(completed).toBe(true);
    expect(abandoned).toBe(false);
  });
});

describe('instrumentedChatCompletion — streaming params rejected', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('throws ValidationError when called with stream: true', async () => {
    const fake = {
      chat: { completions: { create: async () => ({}) } },
    } as unknown as OpenAI;

    await expect(
      instrumentedChatCompletion(h.client, fake, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParams),
    ).rejects.toThrow(ValidationError);
  });
});
