# `bootstrapOtel(...)` helper

An optional one-call setup that creates an OTel `TracerProvider` and `MeterProvider` with OTLP/HTTP exporters and registers them globally. It lives in its own entry point, `@genai-otel/core/bootstrap`, so the core library has no runtime dependency on `@opentelemetry/sdk-*`.

## When to use it

Use `bootstrapOtel` when your app has no OTel setup yet and you want telemetry working with the least code.

Skip it when:

- Your app already sets up OTel (for example through `@vercel/otel`, Sentry or a Datadog SDK). Construct the `Client` directly and your existing providers export its spans and metrics.
- You need your own span processors, samplers, exporters or resource detectors. `bootstrapOtel` takes none of these; build the providers yourself.
- You do not want `@opentelemetry/sdk-*` in your runtime dependencies.

## Install

The bootstrap entry point needs these optional peer dependencies. Keep the versions as shown: OpenTelemetry's new major release (3.0, with 0.300 for the experimental packages) is not supported yet.

```bash
pnpm add @genai-otel/core \
  @opentelemetry/api@1.9.1 \
  @opentelemetry/context-async-hooks@2.12.0 \
  @opentelemetry/sdk-trace-node@2.12.0 \
  @opentelemetry/sdk-trace-base@2.12.0 \
  @opentelemetry/sdk-metrics@2.12.0 \
  @opentelemetry/exporter-trace-otlp-http@0.223.0 \
  @opentelemetry/exporter-metrics-otlp-http@0.223.0 \
  @opentelemetry/resources@2.12.0 \
  @opentelemetry/semantic-conventions@1.44.0
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

The trace provider is registered with `NodeTracerProvider.register()`, which also installs the async context manager that span parenting and the `withX(...)` scopes need.

## Options

```ts
interface BootstrapOptions {
  serviceName: string;
  serviceVersion?: string;
  deploymentEnvironment?: string;
  /** Reserved. Only OTLP/HTTP is supported. */
  exporterProtocol?: 'http';
  /** Extra resource attributes, merged over the service attributes. */
  extraResourceAttributes?: Record<string, string | number | boolean>;
  /** BatchSpanProcessor settings. */
  batchSpanProcessor?: {
    scheduledDelayMillis?: number;
    maxQueueSize?: number;
    maxExportBatchSize?: number;
  };
  /** How often metrics are exported. Default 30000 ms. */
  metricExportIntervalMillis?: number;
  /** Register even when a global meter provider is already set. Default false. */
  force?: boolean;
}
```

It returns `{ tracerProvider, meterProvider, registered }`. By default, if a global meter provider is already registered, `bootstrapOtel` registers neither of its providers and returns `registered: false`, leaving the existing setup in place. Pass `force: true` to replace it. An existing tracer provider on its own is not detected, so do not call `bootstrapOtel` if your app already sets one up.

The resource holds only `service.name`, `service.version`, `deployment.environment.name` and `extraResourceAttributes`. `OTEL_RESOURCE_ATTRIBUTES` is not read, and no resource detectors run. See [exporting.md](exporting.md#resource-detectors) to add detected attributes.

## Environment variables

The OTLP exporters read their own settings, so `bootstrapOtel` parses none of them:

| Var | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of the OTLP/HTTP endpoint. The exporters add `/v1/traces` and `/v1/metrics`. Default `http://localhost:4318`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` pairs, for example `Authorization=Bearer <token>` |

The other standard `OTEL_EXPORTER_OTLP_*` variables (per-signal endpoints, timeouts and so on) also apply.

`bootstrapOtel` itself reads three variables for the resource:

| Var | Effect |
|---|---|
| `OTEL_SERVICE_NAME` | Used only when `serviceName` is empty |
| `OTEL_SERVICE_VERSION` | Used only when `serviceVersion` is not set |
| `OTEL_DEPLOYMENT_ENVIRONMENT_NAME` | Overrides `deploymentEnvironment` when set |

## Shutdown order

1. Wait for your recorders to end. `client.shutdown()` does not wait for recorders still in flight.
2. Call `client.shutdown()`. New `startX` calls then throw `ClientShutdownError`.
3. Shut down the providers. This flushes whatever is still queued and exports it.

```ts
await client.shutdown();
await tracerProvider.shutdown();
await meterProvider.shutdown();
```

`await using client = new Client()` shuts the client down when the scope exits, but not the providers. Shut them down yourself, for example in a `process.on('beforeExit', ...)` handler.
