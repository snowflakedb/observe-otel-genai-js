# `bootstrapOtel(...)` helper

Optional one-liner that wires up an OTel `TracerProvider` + `MeterProvider` with OTLP/HTTP exporters from `OTEL_EXPORTER_OTLP_*` env vars. Lives in a separate package entry point — `@genai-otel/core/bootstrap` — so the core library has no runtime dependency on `@opentelemetry/sdk-*`.

## When to use it

Use `bootstrapOtel` when:

- You are starting fresh and just want telemetry to work.
- Your app does not already have OTel providers configured.
- You are willing to depend on the OTel SDK packages (`@opentelemetry/sdk-*`, `@opentelemetry/exporter-*-otlp-http`).

DO NOT use `bootstrapOtel` when:

- Your app already registers OTel providers (e.g. via `@vercel/otel`, `Sentry`, or a Datadog SDK).
- You need granular control over span processors, samplers, or exporters.
- You want to avoid adding `@opentelemetry/sdk-*` to your runtime deps.

In those cases, construct the `Client` directly and let the user's existing providers handle export.

## Install

The bootstrap submodule has optional peer deps:

```bash
pnpm add @genai-otel/core \
  @opentelemetry/api \
  @opentelemetry/context-async-hooks \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

## Usage

```ts
import { Client } from '@genai-otel/core';
import { bootstrapOtel } from '@genai-otel/core/bootstrap';

const { tracerProvider, meterProvider } = bootstrapOtel({
  serviceName: 'my-agent',
  serviceVersion: '0.1.0',
  deploymentEnvironment: 'prod',
});

const client = new Client();

// ... do work ...

await client.shutdown();
await tracerProvider.shutdown();
await meterProvider.shutdown();
```

## Required env vars

The OTel exporters read these automatically — no custom env-parsing in `bootstrapOtel`.

| Var | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP endpoint URL |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `Key=Value` pairs (e.g. `Authorization=Bearer <token>`) |
| `OTEL_SERVICE_NAME` | Overrides `serviceName` if set |
| `OTEL_SERVICE_VERSION` | Overrides `serviceVersion` if set |
| `OTEL_DEPLOYMENT_ENVIRONMENT_NAME` | Overrides `deploymentEnvironment` if set |

## Options

```ts
interface BootstrapOptions {
  serviceName: string;
  serviceVersion?: string;
  deploymentEnvironment?: string;
  /** Reserved — only OTLP/HTTP today. */
  exporterProtocol?: 'http';
  /** Extra resource attributes merged into the resource. */
  extraResourceAttributes?: Record<string, string | number | boolean>;
  /** BatchSpanProcessor overrides. */
  batchSpanProcessor?: {
    scheduledDelayMillis?: number;
    maxQueueSize?: number;
    maxExportBatchSize?: number;
  };
  /** PeriodicExportingMetricReader interval. */
  metricExportIntervalMillis?: number;
}
```

## Shutdown order

Shutdown the genai-otel client first (so any pending `await rec.end()` work completes), then the OTel providers:

```ts
await client.shutdown();
await tracerProvider.shutdown();
await meterProvider.shutdown();
```

If you use `await using client = new Client(...)`, the client shuts down automatically on scope exit — but the providers do not. Either shut them down explicitly or use `process.on('beforeExit', ...)` to register cleanup hooks.
