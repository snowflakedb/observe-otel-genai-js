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
 * OTLP export smoke test — gated by env vars.
 *
 * Posts a real OTLP/HTTP payload to whatever backend you point it at and
 * verifies the export does not throw. Does NOT query the backend to confirm
 * visibility; that step is documented in `docs/exporting.md` and is left to
 * the operator to run manually after seeing a passing smoke test.
 *
 * Gate:
 *   - OTLP_SMOKE_ENDPOINT — your backend's OTLP/HTTP endpoint URL
 *   - OTLP_SMOKE_TOKEN    — bearer token, if the backend requires auth
 *
 * Run with:
 *   OTLP_SMOKE_ENDPOINT=... OTLP_SMOKE_TOKEN=... \
 *     pnpm exec vitest run test/integration/otlp-export-smoke.test.ts
 */

import { describe, expect, it } from 'vitest';

const ENDPOINT = process.env.OTLP_SMOKE_ENDPOINT;
const TOKEN = process.env.OTLP_SMOKE_TOKEN;

const skip = !ENDPOINT || !TOKEN;

describe.skipIf(skip)('OTLP export smoke', () => {
  it('exports a chat span and a duration histogram over OTLP/HTTP', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT!;
    process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${TOKEN}`;

    const { metrics, trace } = await import('@opentelemetry/api');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { MeterProvider, PeriodicExportingMetricReader } = await import(
      '@opentelemetry/sdk-metrics'
    );
    const { BatchSpanProcessor, BasicTracerProvider } = await import(
      '@opentelemetry/sdk-trace-base'
    );
    const { Client } = await import('../../src/client.js');

    const resource = resourceFromAttributes({
      'service.name': 'observe-otel-genai-smoke',
      'service.version': '0.1.0',
      'deployment.environment.name': 'integration',
    });
    const tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    });
    const meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    metrics.setGlobalMeterProvider(meterProvider);

    const client = new Client();
    const rec = client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
      conversationId: 'smoke-conv-1',
      agentName: 'smoke-agent',
    });
    rec.setResult({ usage: { inputTokens: 10, outputTokens: 5 }, responseId: 'smoke' });
    await rec.end();

    await client.shutdown();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();

    expect(true).toBe(true);
  }, 30_000);
});
