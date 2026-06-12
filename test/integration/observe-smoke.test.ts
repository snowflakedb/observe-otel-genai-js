/**
 * Observe smoke test — gated by env vars.
 *
 * Posts a real OTLP/HTTP payload to Observe and verifies the export does
 * not throw. Does NOT query Observe back to confirm visibility; that
 * step is documented in `docs/observe-integration.md` and is left to the
 * operator to run manually after seeing a passing smoke test.
 *
 * Gate:
 *   - OBSERVE_OTLP_ENDPOINT — e.g. `https://<customer>.collect.observeinc.com/v2/otel`
 *   - OBSERVE_OTLP_TOKEN    — bearer token from the Observe portal
 *
 * Run with:
 *   OBSERVE_OTLP_ENDPOINT=... OBSERVE_OTLP_TOKEN=... \
 *     pnpm exec vitest run test/integration/observe-smoke.test.ts
 */

import { describe, expect, it } from 'vitest';

const ENDPOINT = process.env.OBSERVE_OTLP_ENDPOINT;
const TOKEN = process.env.OBSERVE_OTLP_TOKEN;

const skip = !ENDPOINT || !TOKEN;

describe.skipIf(skip)('Observe smoke', () => {
  it('exports a chat span and a duration histogram to Observe over OTLP/HTTP', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT!;
    process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${TOKEN}`;

    const { bootstrapOtel } = await import('../../src/bootstrap/index.js');
    const { Client } = await import('../../src/client.js');

    const { tracerProvider, meterProvider } = bootstrapOtel({
      serviceName: 'genai-otel-smoke',
      serviceVersion: '0.1.0',
      deploymentEnvironment: 'integration',
      metricExportIntervalMillis: 5_000,
    });

    const client = new Client();
    const rec = client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
      conversationId: 'smoke-conv-1',
      agentName: 'smoke-agent',
    });
    rec.setResult({ usage: { inputTokens: 10, outputTokens: 5 }, responseId: 'smoke' });
    await rec.end();

    await client.shutdown();
    await tracerProvider.forceFlush();
    await meterProvider.forceFlush();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();

    expect(true).toBe(true);
  }, 30_000);
});
