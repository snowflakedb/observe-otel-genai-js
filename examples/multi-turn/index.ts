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
 * Multi-turn conversation example.
 *
 * Three separate turns, each its own trace, all sharing the same
 * `gen_ai.conversation.id`. Uses `withConversationId(...)` to scope identity
 * to the handler so the seed object stays small.
 *
 * Run:
 *   pnpm exec tsx examples/multi-turn/index.ts
 */

import {
  Client,
  assistantTextMessage,
  userTextMessage,
  withConversationId,
  withUserId,
} from '../../src/index.js';
import { setupOtel } from '../_setup.js';

const otel = setupOtel('multi-turn-example');

const userMessages = [
  'Hi, can you help me debug a Postgres query?',
  "It's a slow JOIN — output below",
  'Got it — adding the index now.',
];

async function handleTurn(client: Client, turn: number, userText: string) {
  await using rec = client.startGeneration({
    model: { provider: 'openai', name: 'gpt-4o' },
    agentName: 'support-bot',
    turnIndex: turn,
    turnRole: 'assistant',
  });

  rec.setResult({
    input: [userTextMessage(userText)],
    output: [assistantTextMessage(`(turn ${turn} response)`)],
    usage: { inputTokens: 10, outputTokens: 8 },
  });
}

async function main() {
  const client = new Client();

  await withConversationId('conv-multi-1', async () => {
    await withUserId('user_abc', async () => {
      for (let i = 0; i < userMessages.length; i++) {
        await handleTurn(client, i, userMessages[i]!);
      }
    });
  });
}

await main();
await otel.shutdown();
