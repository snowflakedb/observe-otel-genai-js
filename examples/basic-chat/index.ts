/**
 * Basic chat example.
 *
 * Wraps a (mock) provider call in `startGeneration`, sets the result, ends.
 * Emits one CLIENT span and the 4 GenAI client metrics. The console exporter
 * prints the span so you can see the attribute set without a backend.
 *
 * Run:
 *   pnpm exec tsx examples/basic-chat/index.ts
 */

import { Client, assistantTextMessage, userTextMessage } from '../../src/index.js';
import { setupOtel } from '../_setup.js';

const otel = setupOtel('basic-chat-example');

async function main() {
  const client = new Client();

  await using rec = client.startGeneration({
    model: { provider: 'openai', name: 'gpt-4o' },
    conversationId: 'demo-conv-1',
    agentName: 'planner',
    maxTokens: 256,
    temperature: 0.2,
  });

  // Pretend we call the provider.
  const fakeResp = await mockProviderCall();

  rec.setResult({
    input: [userTextMessage('What is OpenTelemetry?')],
    output: [assistantTextMessage(fakeResp.text)],
    usage: {
      inputTokens: fakeResp.promptTokens,
      outputTokens: fakeResp.completionTokens,
    },
    responseId: fakeResp.id,
    responseModel: 'gpt-4o-2024-08-06',
    stopReason: 'stop',
  });
}

async function mockProviderCall() {
  await new Promise((r) => setTimeout(r, 50));
  return {
    id: 'mock-resp-1',
    text: 'OpenTelemetry is an open standard for telemetry.',
    promptTokens: 8,
    completionTokens: 12,
  };
}

await main();
await otel.shutdown();
