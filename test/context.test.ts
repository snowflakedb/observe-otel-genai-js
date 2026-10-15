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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentNameFromContext,
  conversationIdFromContext,
  userIdFromContext,
  withAgentName,
  withContext,
  withConversationId,
  withUserId,
} from '../src/context.js';
import { ATTR_AGENT_NAME, ATTR_CONVERSATION_ID, ATTR_USER_ID } from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('context (AsyncLocalStorage helpers)', () => {
  it('getter returns undefined outside any scope', () => {
    expect(conversationIdFromContext()).toBeUndefined();
  });

  it('with* propagates synchronously inside the callback', () => {
    const captured = withConversationId('c1', () =>
      withUserId('u1', () => ({
        cid: conversationIdFromContext(),
        uid: userIdFromContext(),
      })),
    );
    expect(captured.cid).toBe('c1');
    expect(captured.uid).toBe('u1');
  });

  it('with* propagates across await boundaries', async () => {
    const got = await withConversationId('c2', async () => {
      await Promise.resolve();
      return conversationIdFromContext();
    });
    expect(got).toBe('c2');
  });

  it('withContext applies multiple values atomically', () => {
    const out = withContext({ conversationId: 'cA', userId: 'uA', agentName: 'planner' }, () => ({
      cid: conversationIdFromContext(),
      uid: userIdFromContext(),
      agent: agentNameFromContext(),
    }));
    expect(out).toEqual({ cid: 'cA', uid: 'uA', agent: 'planner' });
  });
});

describe('Client picks up context values when start fields are empty', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('inherits conversationId / userId / agentName from ambient context', async () => {
    await withConversationId('conv-ctx', async () => {
      await withUserId('user-ctx', async () => {
        await withAgentName('agent-ctx', async () => {
          const rec = h.client.startGeneration({
            model: { provider: 'p', name: 'm' },
          });
          rec.setResult({ usage: { inputTokens: 1, outputTokens: 1 } });
          await rec.end();
        });
      });
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span!.attributes[ATTR_CONVERSATION_ID]).toBe('conv-ctx');
    expect(span!.attributes[ATTR_USER_ID]).toBe('user-ctx');
    expect(span!.attributes[ATTR_AGENT_NAME]).toBe('agent-ctx');
  });

  it('per-call value overrides ambient context', async () => {
    await withConversationId('ambient', async () => {
      const rec = h.client.startGeneration({
        model: { provider: 'p', name: 'm' },
        conversationId: 'explicit',
      });
      rec.setResult({ usage: { inputTokens: 1, outputTokens: 1 } });
      await rec.end();
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span!.attributes[ATTR_CONVERSATION_ID]).toBe('explicit');
  });
});
