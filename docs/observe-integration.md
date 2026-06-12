# Observe integration

This library is vendor-neutral, but the primary target during v0.1.0 was [Observe](https://observeinc.com). Any OTel-native backend works the same way; the only thing that changes is the OTLP endpoint and bearer token.

## Setup

1. Get your OTLP/HTTP endpoint from the Observe portal:
   - **Settings → Account → API Tokens** for the bearer token.
   - The endpoint URL is shown in the OTLP setup docs and looks like `https://<customer-id>.collect.observeinc.com/v2/otel`.

2. Configure env vars in your application's environment:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://<customer-id>.collect.observeinc.com/v2/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <observe-token>
OTEL_SERVICE_NAME=my-agent
OTEL_SERVICE_VERSION=0.1.0
OTEL_DEPLOYMENT_ENVIRONMENT_NAME=prod
```

3. Wire up OTel via `bootstrapOtel` (or your existing OTel setup) and create a `Client`:

```ts
import { Client } from '@genai-otel/core';
import { bootstrapOtel } from '@genai-otel/core/bootstrap';

const { tracerProvider, meterProvider } = bootstrapOtel({
  serviceName: 'my-agent',
});
const client = new Client();
```

## Smoke test

Run the integration test against your real Observe environment:

```bash
OBSERVE_OTLP_ENDPOINT=https://<customer-id>.collect.observeinc.com/v2/otel \
OBSERVE_OTLP_TOKEN=<observe-token> \
  pnpm exec vitest run test/integration/observe-smoke.test.ts
```

The test:

1. Calls `bootstrapOtel({ serviceName: 'genai-otel-smoke' })`.
2. Emits one chat span with input/output messages.
3. Force-flushes the providers and shuts down.

If the test passes, the OTLP/HTTP path is reachable. To confirm visibility, query Observe for:

- `service.name = "genai-otel-smoke"`
- `gen_ai.operation.name = "chat"`
- `gen_ai.conversation.id = "smoke-conv-1"`

A row should appear within seconds.

## Things to verify on first integration

- Per-attribute size limit (Observe's default is in the 64–256 KB range — confirm during integration). If your prompts exceed it, set `Client({ contentCapture: { maxContentLength: <smaller> } })` or configure a `BlobStore` adapter.
- Bucket boundaries on histograms: Observe should render the advisory boundaries correctly. If dashboards don't look right, see [`docs/semconv-mapping.md`](semconv-mapping.md) for the canonical bucket families.
- `service.name` routing: Observe groups data by service. Set `OTEL_SERVICE_NAME` per environment so dev/staging/prod stay separate.

## Resource detectors

For cloud / Kubernetes deployments, install `@opentelemetry/resource-detector-{aws,gcp,k8s}` and pass detected attributes into `bootstrapOtel`'s `extraResourceAttributes`. This auto-populates `cloud.provider`, `k8s.pod.name`, `host.name`, etc. on every span.
