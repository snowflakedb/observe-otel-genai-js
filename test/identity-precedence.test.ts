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

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';

import type { ClientConfig } from '../src/config.js';
import { withAgent, withContext } from '../src/context.js';
import type { GenerationStart } from '../src/models/generation.js';
import {
  ATTR_AGENT_NAME,
  ATTR_AGENT_VERSION,
  ATTR_CONVERSATION_ID,
  ATTR_CONVERSATION_TITLE,
  ATTR_USER_ID,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

const MODEL = { provider: 'p', name: 'm' };

let h: Harness | undefined;
afterEach(async () => {
  await h?.shutdown();
  h = undefined;
});

/** Sets up the harness before a scope opens, since scopes need its context manager. */
function setUp(config?: ClientConfig) {
  // The conversation title is content, so metadata_only (the default) would drop it.
  h = createHarness({ contentCaptureMode: 'full', ...config });
}

async function recordGeneration(seed: Partial<GenerationStart>) {
  await h!.client.startGeneration({ model: MODEL, ...seed }).end();
  return h!.spans.getFinishedSpans()[0]!.attributes;
}

async function generation(seed: Partial<GenerationStart>, config?: ClientConfig) {
  setUp(config);
  return recordGeneration(seed);
}

function identity(attrs: ReadableSpan['attributes']) {
  return {
    agentName: attrs[ATTR_AGENT_NAME],
    agentVersion: attrs[ATTR_AGENT_VERSION],
    conversationId: attrs[ATTR_CONVERSATION_ID],
    conversationTitle: attrs[ATTR_CONVERSATION_TITLE],
    userId: attrs[ATTR_USER_ID],
  };
}

const level = (tag: string) => ({
  agentName: `${tag}-agent`,
  agentVersion: `${tag}-v`,
  conversationId: `${tag}-conv`,
  conversationTitle: `${tag}-title`,
  userId: `${tag}-user`,
});

const client = { agentName: 'client-agent', agentVersion: 'client-v', userId: 'client-user' };

describe('identity resolution order', () => {
  it("the span's own values beat the enclosing scope", async () => {
    setUp(client);
    const attrs = await withContext(level('scope'), () => recordGeneration(level('own')));
    expect(identity(attrs)).toEqual(level('own'));
  });

  it('the enclosing scope beats the client config', async () => {
    setUp(client);
    const attrs = await withContext(level('scope'), () => recordGeneration({}));
    expect(identity(attrs)).toEqual(level('scope'));
  });

  it('falls back to the client config', async () => {
    const attrs = await generation({}, client);
    expect(attrs[ATTR_AGENT_NAME]).toBe('client-agent');
    expect(attrs[ATTR_AGENT_VERSION]).toBe('client-v');
    expect(attrs[ATTR_USER_ID]).toBe('client-user');
  });

  it('emits no agent name when no source sets one', async () => {
    const attrs = await generation({});
    expect(attrs[ATTR_AGENT_NAME]).toBeUndefined();
  });

  it('skips empty values', async () => {
    setUp(client);
    const attrs = await withContext({ conversationId: 'scope-conv' }, () =>
      recordGeneration({ agentName: '', conversationId: '' }),
    );
    expect(attrs[ATTR_AGENT_NAME]).toBe('client-agent');
    expect(attrs[ATTR_CONVERSATION_ID]).toBe('scope-conv');
  });
});

describe('agent version follows the agent name', () => {
  it('takes the version from a later source that gives the same name', async () => {
    const fromConfig = await generation({ agentName: 'client-agent' }, client);
    expect(identity(fromConfig)).toMatchObject({
      agentName: 'client-agent',
      agentVersion: 'client-v',
    });
    await h?.shutdown();

    setUp();
    const fromScope = await withAgent('bot', '3', () => recordGeneration({ agentName: 'bot' }));
    expect(identity(fromScope)).toMatchObject({ agentName: 'bot', agentVersion: '3' });
  });

  it('prefers the version of the nearest source that gives the same name', async () => {
    setUp(client);
    const attrs = await withAgent('client-agent', 'scope-v', () =>
      recordGeneration({ agentName: 'client-agent', agentVersion: 'own-v' }),
    );
    expect(attrs[ATTR_AGENT_VERSION]).toBe('own-v');
  });

  it('never takes the version of a differently named agent', async () => {
    const fromConfig = await generation({ agentName: 'child' }, client);
    expect(fromConfig[ATTR_AGENT_NAME]).toBe('child');
    expect(fromConfig[ATTR_AGENT_VERSION]).toBeUndefined();
    await h?.shutdown();

    setUp();
    const fromScope = await withAgent('parent', '1.0', () =>
      recordGeneration({ agentName: 'child' }),
    );
    expect(fromScope[ATTR_AGENT_VERSION]).toBeUndefined();
  });

  it('records no version from a source that gives no name', async () => {
    const own = await generation({ agentVersion: '2' }, { agentName: 'bot' });
    expect(identity(own)).toMatchObject({ agentName: 'bot', agentVersion: undefined });
    await h?.shutdown();

    const config = await generation({}, { agentVersion: '2' });
    expect(config[ATTR_AGENT_VERSION]).toBeUndefined();
  });
});

describe('scopes set the agent name and version as a pair', () => {
  it('withAgent sets both', async () => {
    setUp(client);
    const attrs = await withAgent('scoped', '4', () => recordGeneration({}));
    expect(identity(attrs)).toMatchObject({ agentName: 'scoped', agentVersion: '4' });
  });

  it("an inner agent name clears the outer agent's version", async () => {
    setUp();
    const viaWithAgent = await withAgent('outer', '1', () =>
      withAgent('inner', () => recordGeneration({})),
    );
    expect(identity(viaWithAgent)).toMatchObject({ agentName: 'inner', agentVersion: undefined });
    await h?.shutdown();

    setUp();
    const viaContext = await withContext({ agentName: 'outer', agentVersion: '1' }, () =>
      withContext({ agentName: 'inner' }, () => recordGeneration({})),
    );
    expect(identity(viaContext)).toMatchObject({ agentName: 'inner', agentVersion: undefined });
  });

  it('ignores a version set without a name', async () => {
    setUp();
    const attrs = await withAgent('outer', '1', () =>
      withContext({ agentVersion: '2' }, () => recordGeneration({})),
    );
    expect(identity(attrs)).toMatchObject({ agentName: 'outer', agentVersion: '1' });
  });

  it('withAgent with an undefined version clears the outer version', async () => {
    setUp();
    const attrs = await withAgent('outer', '1', () =>
      withAgent('inner', undefined, () => recordGeneration({})),
    );
    expect(identity(attrs)).toMatchObject({ agentName: 'inner', agentVersion: undefined });
  });

  it('keeps the outer value when an inner scope sets a field empty', async () => {
    setUp(client);
    const attrs = await withAgent('outer', '1', () =>
      withContext({ agentName: undefined, userId: '', conversationId: 'c' }, () =>
        withContext({ userId: 'u' }, () =>
          withContext({ userId: undefined }, () => recordGeneration({})),
        ),
      ),
    );
    expect(identity(attrs)).toMatchObject({
      agentName: 'outer',
      agentVersion: '1',
      conversationId: 'c',
      userId: 'u',
    });
  });

  it('a scope that sets other fields keeps the outer agent', async () => {
    setUp();
    const attrs = await withAgent('outer', '1', () =>
      withContext({ conversationId: 'c' }, () => recordGeneration({})),
    );
    expect(identity(attrs)).toMatchObject({
      agentName: 'outer',
      agentVersion: '1',
      conversationId: 'c',
    });
  });
});

describe('invoke_agent', () => {
  async function agentSpan(config: ClientConfig, run: (h: Harness) => Promise<void>) {
    h = createHarness(config);
    await run(h);
    return h.spans.getFinishedSpans()[0]!;
  }

  it('takes the agent name from the enclosing scope', async () => {
    const span = await agentSpan({}, (h) =>
      withAgent('scoped', () => h.client.invokeAgent({}).end()),
    );
    expect(span.name).toBe('invoke_agent scoped');
    expect(span.attributes[ATTR_AGENT_NAME]).toBe('scoped');
  });

  it('takes the agent name and version from the client config', async () => {
    const span = await agentSpan(client, (h) => h.client.invokeAgent({}).end());
    expect(span.name).toBe('invoke_agent client-agent');
    expect(span.attributes[ATTR_AGENT_VERSION]).toBe('client-v');
  });

  it("takes the client's version for its own name only when the names match", async () => {
    const same = await agentSpan(client, (h) =>
      h.client.invokeAgent({ agentName: 'client-agent' }).end(),
    );
    expect(same.attributes[ATTR_AGENT_VERSION]).toBe('client-v');
    await h?.shutdown();

    const other = await agentSpan(client, (h) =>
      h.client.invokeAgent({ agentName: 'child' }).end(),
    );
    expect(other.attributes[ATTR_AGENT_VERSION]).toBeUndefined();
  });

  it('uses the bare span name when nothing names the agent', async () => {
    const span = await agentSpan({}, (h) => h.client.invokeAgent({}).end());
    expect(span.name).toBe('invoke_agent');
    expect(span.attributes[ATTR_AGENT_NAME]).toBeUndefined();
  });
});

describe('other span types follow the same rules', () => {
  it('tool spans take the scope identity and the matching version only', async () => {
    h = createHarness(client);
    await withAgent('client-agent', () => h!.client.startToolExecution({ toolName: 't' }).end());
    await withAgent('tool-agent', () => h!.client.startToolExecution({ toolName: 't' }).end());
    const [same, other] = h.spans.getFinishedSpans();
    expect(same!.attributes[ATTR_AGENT_VERSION]).toBe('client-v');
    expect(other!.attributes[ATTR_AGENT_NAME]).toBe('tool-agent');
    expect(other!.attributes[ATTR_AGENT_VERSION]).toBeUndefined();
  });
});
