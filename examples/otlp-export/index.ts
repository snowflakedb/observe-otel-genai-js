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
 * OTLP export example.
 *
 * Uses `bootstrapOtel` to wire up OTLP/HTTP from env vars, then emits a
 * single generation that ships to whichever backend `OTEL_EXPORTER_OTLP_*`
 * points at — any OTel-native backend works (Tempo, Honeycomb, Jaeger,
 * Datadog, Observe, ...).
 *
 * Setup:
 *   cp examples/otlp-export/.env.example .env
 *   # fill in your endpoint + auth header
 *   set -o allexport && source .env && set +o allexport
 *   pnpm exec tsx examples/otlp-export/index.ts
 */

import { bootstrapOtel } from '../../src/bootstrap/index.js';
import { Client, assistantTextMessage, userTextMessage } from '../../src/index.js';

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.error('OTEL_EXPORTER_OTLP_ENDPOINT is not set. See examples/otlp-export/.env.example.');
  process.exit(1);
}

const { tracerProvider, meterProvider } = bootstrapOtel({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'observe-otel-genai-example',
  serviceVersion: process.env.OTEL_SERVICE_VERSION,
  deploymentEnvironment: process.env.OTEL_DEPLOYMENT_ENVIRONMENT_NAME,
});

async function main() {
  const client = new Client();

  await using rec = client.startGeneration({
    model: { provider: 'openai', name: 'gpt-4o' },
    conversationId: 'otlp-export-example-1',
    agentName: 'otlp-demo',
    maxTokens: 256,
    temperature: 0.3,
  });

  rec.setResult({
    input: [userTextMessage('What does OpenTelemetry give me for free?')],
    output: [
      assistantTextMessage(
        'OTLP lets you ship traces, metrics, and logs to any OTel-native backend without vendor lock-in.',
      ),
    ],
    usage: { inputTokens: 8, outputTokens: 32 },
    responseId: 'otlp-demo-1',
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
console.log('[example] flushed; check your backend for service.name = your OTEL_SERVICE_NAME');
