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

import { context } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '../src/client.js';
import type { ClientConfig } from '../src/config.js';
import { withAgent, withContext, withConversationId, withUserId } from '../src/context.js';
import {
  ATTR_AGENT_NAME,
  ATTR_AGENT_VERSION,
  ATTR_CONVERSATION_ID,
  ATTR_OPERATION_NAME,
  ATTR_USER_ID,
  METRIC_OPERATION_DURATION,
  METRIC_TOKEN_USAGE,
  METRIC_TOOL_EXECUTION_DURATION,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

const MODEL = { provider: 'openai', name: 'gpt-4o' };

const AGENT = {
  agentName: 'support-agent',
  agentVersion: '2',
  conversationId: 'conv-1',
  userId: 'user-1',
};

let h: Harness;
afterEach(async () => {
  await h.shutdown();
});

function setup(config?: ClientConfig) {
  h = createHarness(config);
  return h.client;
}

const spansOf = (op: string) =>
  h.spans.getFinishedSpans().filter((s) => s.attributes[ATTR_OPERATION_NAME] === op);

const chat = () => spansOf('chat')[0]!;

function identity(span: ReadableSpan) {
  return {
    agentName: span.attributes[ATTR_AGENT_NAME],
    agentVersion: span.attributes[ATTR_AGENT_VERSION],
    conversationId: span.attributes[ATTR_CONVERSATION_ID],
    userId: span.attributes[ATTR_USER_ID],
  };
}

async function startEveryKind(client: Client) {
  await client.startGeneration({ model: MODEL }).end();
  await client.startToolExecution({ toolName: 'lookup_order' }).end();
  await client.startRetrieval({ dataSourceId: 'orders' }).end();
  await client.startEmbedding({ model: MODEL }).end();
}

describe('identity handed down by the enclosing recorder', () => {
  it('reaches every kind of span started inside the invokeAgent callback', async () => {
    const client = setup();
    await client.invokeAgent(AGENT, () => startEveryKind(client));

    for (const op of ['chat', 'execute_tool', 'retrieval', 'embeddings']) {
      expect(identity(spansOf(op)[0]!), op).toEqual(AGENT);
    }
  });

  it('reaches spans started inside withActiveContext of a fluent recorder', async () => {
    const client = setup();
    const agent = client.invokeAgent(AGENT);
    const generation = agent.withActiveContext(() => client.startGeneration({ model: MODEL }));
    const tool = generation.withActiveContext(() =>
      client.startToolExecution({ toolName: 'lookup' }),
    );
    await tool.end();
    await generation.end();
    await agent.end();

    expect(identity(chat())).toEqual(AGENT);
    expect(identity(spansOf('execute_tool')[0]!)).toEqual(AGENT);
  });

  it('reaches spans from a different Client', async () => {
    const client = setup();
    const other = new Client();
    await client.invokeAgent(AGENT, () => other.startGeneration({ model: MODEL }).end());
    const tool = client.startToolExecution({ toolName: 'lookup', ...AGENT });
    await tool.withActiveContext(() => other.startRetrieval({ dataSourceId: 'orders' }).end());
    await tool.end();

    expect(identity(chat())).toEqual(AGENT);
    expect(identity(spansOf('retrieval')[0]!)).toEqual(AGENT);
  });

  it('labels child metrics with the handed-down agent name', async () => {
    const client = setup();
    await client.invokeAgent({ agentName: 'support-agent' }, async () => {
      const generation = client.startGeneration({ model: MODEL });
      generation.setResult({ usage: { inputTokens: 10, outputTokens: 2 } });
      await generation.end();
      await client.startToolExecution({ toolName: 'lookup' }).end();
    });

    const metrics = (await h.collectMetrics()).flatMap((rm) =>
      rm.scopeMetrics.flatMap((sm) => sm.metrics),
    );
    for (const name of [
      METRIC_TOKEN_USAGE,
      METRIC_OPERATION_DURATION,
      METRIC_TOOL_EXECUTION_DURATION,
    ]) {
      const labels = metrics
        .filter((m) => m.descriptor.name === name)
        .flatMap((m) => m.dataPoints.map((p) => p.attributes[ATTR_AGENT_NAME]));
      expect(new Set(labels), name).toEqual(new Set(['support-agent']));
    }
  });

  it('lets a value the child sets itself win', async () => {
    const client = setup();
    await client.invokeAgent(AGENT, () =>
      client
        .startGeneration({ model: MODEL, agentName: 'summarizer', conversationId: 'conv-2' })
        .end(),
    );

    expect(identity(chat())).toEqual({
      agentName: 'summarizer',
      agentVersion: undefined,
      conversationId: 'conv-2',
      userId: 'user-1',
    });
  });

  it('gives a delegated agent its own name, no outer version, and the outer conversation and user', async () => {
    const client = setup();
    await client.invokeAgent({ ...AGENT, agentName: 'coordinator' }, async () => {
      const tool = client.startToolExecution({ toolName: 'delegate' });
      await tool.withActiveContext(() =>
        client.invokeAgent({ agentName: 'specialist' }, () =>
          client.startGeneration({ model: MODEL }).end(),
        ),
      );
      await tool.end();
    });

    const specialist = spansOf('invoke_agent').find((s) => s.name === 'invoke_agent specialist')!;
    const expected = {
      agentName: 'specialist',
      agentVersion: undefined,
      conversationId: 'conv-1',
      userId: 'user-1',
    };
    expect(identity(specialist)).toEqual(expected);
    expect(identity(chat())).toEqual(expected);
  });

  it('gives an unnamed sub-agent the outer agent name and version', async () => {
    const client = setup();
    await client.invokeAgent({ agentName: 'outer', agentVersion: '1' }, () =>
      client.invokeAgent({}, () => client.startGeneration({ model: MODEL }).end()),
    );

    for (const span of [...spansOf('invoke_agent'), chat()]) {
      expect(span.attributes[ATTR_AGENT_NAME], span.name).toBe('outer');
      expect(span.attributes[ATTR_AGENT_VERSION], span.name).toBe('1');
    }
  });

  it('stops handing down once withActiveContext returns', async () => {
    const client = setup();
    const agent = client.invokeAgent(AGENT);
    await agent.withActiveContext(() => client.startGeneration({ model: MODEL })).end();
    await client.startGeneration({ model: MODEL }).end();
    await agent.end();

    const [inside, after] = spansOf('chat');
    expect(identity(inside!)).toEqual(AGENT);
    expect(identity(after!)).toEqual({
      agentName: undefined,
      agentVersion: undefined,
      conversationId: undefined,
      userId: undefined,
    });
  });

  it('replaces an outer agent version along with the name', async () => {
    const client = setup();
    await withContext({ agentName: 'outer', agentVersion: '9' }, () =>
      client.invokeAgent({ agentName: 'inner' }, () =>
        client.startGeneration({ model: MODEL }).end(),
      ),
    );

    expect(identity(chat())).toMatchObject({ agentName: 'inner', agentVersion: undefined });
  });

  it('keeps an outer withX(...) value the recorder does not have', async () => {
    const client = setup();
    const agent = client.invokeAgent({ agentName: 'support-agent' });
    await withConversationId('conv-outer', () =>
      agent.withActiveContext(() => client.startGeneration({ model: MODEL }).end()),
    );
    await agent.end();

    expect(identity(chat())).toMatchObject({
      agentName: 'support-agent',
      conversationId: 'conv-outer',
    });
  });

  it('does not hand down the Client config', async () => {
    const client = setup({ agentName: 'svc-agent', userId: 'svc-default' });
    const tool = client.startToolExecution({ toolName: 'lookup' });
    await withAgent('outer-agent', () =>
      withUserId('alice', () =>
        tool.withActiveContext(() => client.startGeneration({ model: MODEL }).end()),
      ),
    );
    await tool.end();

    expect(identity(chat())).toMatchObject({ agentName: 'outer-agent', userId: 'alice' });
  });

  it('hands down the conversation title', async () => {
    const client = setup({ contentCaptureMode: 'full' });
    const gen = client.startGeneration({ model: MODEL, conversationTitle: 'Billing' });
    await gen.withActiveContext(() => client.startToolExecution({ toolName: 'lookup' }).end());
    await gen.end();

    expect(spansOf('execute_tool')[0]!.attributes['genai.conversation.title']).toBe('Billing');
  });

  it('keeps the scope in a saved context and restores it later', async () => {
    const client = setup();
    const saved = withAgent('saved-agent', () => context.active());
    await context.with(saved, () => client.startGeneration({ model: MODEL }).end());

    expect(identity(chat())).toMatchObject({ agentName: 'saved-agent' });
  });

  it('keeps parallel invocations apart', async () => {
    const client = setup();
    const run = (name: string) =>
      client.invokeAgent({ agentName: name, conversationId: `${name}-conv` }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await client.startGeneration({ model: MODEL }).end();
      });
    await Promise.all([run('a'), run('b')]);

    const pairs = spansOf('chat').map((s) => [
      s.attributes[ATTR_AGENT_NAME],
      s.attributes[ATTR_CONVERSATION_ID],
    ]);
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map((p) => p.join('/')))).toEqual(new Set(['a/a-conv', 'b/b-conv']));
  });

  it('hands nothing down from create_agent', async () => {
    const client = setup();
    await client.createAgent({ agentName: 'builder', agentVersion: '1' }, () =>
      client.startGeneration({ model: MODEL }).end(),
    );
    await withAgent('outer-agent', () =>
      client.createAgent({ agentName: 'builder' }, (rec) =>
        rec.withActiveContext(() => client.startToolExecution({ toolName: 'register' }).end()),
      ),
    );

    expect(identity(chat())).toMatchObject({ agentName: undefined, agentVersion: undefined });
    expect(spansOf('execute_tool')[0]!.attributes[ATTR_AGENT_NAME]).toBe('outer-agent');
  });
});

describe('user id and conversation id on tool, retrieval and embedding spans', () => {
  it('takes the user id from the seed, the enclosing scope and the Client config', async () => {
    const client = setup({ userId: 'svc-default' });
    await client.startToolExecution({ toolName: 'lookup', userId: 'seed-user' }).end();
    await withUserId('scoped-user', () => client.startRetrieval({ dataSourceId: 'orders' }).end());
    await client.startEmbedding({ model: MODEL }).end();

    expect(spansOf('execute_tool')[0]!.attributes[ATTR_USER_ID]).toBe('seed-user');
    expect(spansOf('retrieval')[0]!.attributes[ATTR_USER_ID]).toBe('scoped-user');
    expect(spansOf('embeddings')[0]!.attributes[ATTR_USER_ID]).toBe('svc-default');
  });

  it('gives embedding spans a conversation id', async () => {
    const client = setup();
    await client.startEmbedding({ model: MODEL, conversationId: 'seed-conv' }).end();
    await withConversationId('scoped-conv', () => client.startEmbedding({ model: MODEL }).end());

    const ids = spansOf('embeddings').map((s) => s.attributes[ATTR_CONVERSATION_ID]);
    expect(ids).toEqual(['seed-conv', 'scoped-conv']);
  });
});
