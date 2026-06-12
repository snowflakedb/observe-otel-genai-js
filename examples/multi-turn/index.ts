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
