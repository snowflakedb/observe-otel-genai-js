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
 * Robustness tests for the shared adapter machinery.
 *
 * The guiding invariant: instrumentation must never break the user's actual
 * LLM call. A telemetry finalization error (recorder.end(), exporter flush)
 * must not surface through a consumed provider stream, and helpers must reject
 * cleanly on unsupported inputs rather than returning a wrong-typed value.
 */

import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('wrapProviderStream — watchdog for never-consumed streams', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onAbandoned exactly once when the stream is never iterated', async () => {
    let abandoned = 0;
    let completed = 0;
    async function* gen() {
      yield 1;
    }
    // Wrap but never iterate — the watchdog must end the recorder.
    wrapProviderStream(gen(), {
      watchdogMs: 1000,
      onAbandoned: () => {
        abandoned += 1;
      },
      onComplete: () => {
        completed += 1;
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(abandoned).toBe(1);
    expect(completed).toBe(0);

    // No second fire on further time.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abandoned).toBe(1);
  });

  it('cancels the watchdog once iteration starts (no false abandonment)', async () => {
    let abandoned = 0;
    async function* gen() {
      yield 1;
      yield 2;
    }
    const wrapped = wrapProviderStream(gen(), {
      watchdogMs: 1000,
      onAbandoned: () => {
        abandoned += 1;
      },
    });

    await drain(wrapped);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abandoned).toBe(0);
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
