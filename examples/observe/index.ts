/**
 * Observe integration example.
 *
 * Uses `bootstrapOtel` to wire up OTLP/HTTP from env vars, then emits a
 * single generation that ships to whichever backend `OTEL_EXPORTER_OTLP_*`
 * points at — Observe is the documented primary, but anything OTel-native
 * works (Tempo, Honeycomb, Jaeger, ...).
 *
 * Setup:
 *   cp examples/observe/.env.example .env
 *   # fill in your endpoint + token
 *   set -o allexport && source .env && set +o allexport
 *   pnpm exec tsx examples/observe/index.ts
 */

import { bootstrapOtel } from '../../src/bootstrap/index.js';
import { Client, assistantTextMessage, userTextMessage } from '../../src/index.js';

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.error('OTEL_EXPORTER_OTLP_ENDPOINT is not set. See examples/observe/.env.example.');
  process.exit(1);
}

const { tracerProvider, meterProvider } = bootstrapOtel({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'genai-otel-example',
  serviceVersion: process.env.OTEL_SERVICE_VERSION,
  deploymentEnvironment: process.env.OTEL_DEPLOYMENT_ENVIRONMENT_NAME,
});

async function main() {
  const client = new Client();

  await using rec = client.startGeneration({
    model: { provider: 'openai', name: 'gpt-4o' },
    conversationId: 'observe-example-1',
    agentName: 'observe-demo',
    maxTokens: 256,
    temperature: 0.3,
  });

  rec.setResult({
    input: [userTextMessage('Tell me about Observe.')],
    output: [
      assistantTextMessage(
        'Observe is an OTel-native observability platform that ingests OTLP and renders traces, metrics, and logs in a unified workspace.',
      ),
    ],
    usage: { inputTokens: 8, outputTokens: 32 },
    responseId: 'obs-demo-1',
    responseModel: 'gpt-4o-2024-08-06',
    stopReason: 'stop',
  });
}

await main();
// Flush before exit so the background exporters get a chance to ship.
await tracerProvider.forceFlush();
await meterProvider.forceFlush();
await tracerProvider.shutdown();
await meterProvider.shutdown();
console.log('[example] flushed; check Observe for service.name = your OTEL_SERVICE_NAME');
