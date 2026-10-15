# Exporting telemetry

This library is vendor-neutral: it emits pure OpenTelemetry spans and metrics and ships them through whatever OTLP exporter your app configures. Any OTel-native backend works — Tempo, Honeycomb, Jaeger, Datadog, Observe, and others. The only thing that changes between backends is the OTLP endpoint and (optionally) an auth header.

## Setup

1. Get your OTLP/HTTP endpoint and auth header (if required) from your backend's OTLP setup guide. Endpoint URLs and header formats are backend-specific; for example, a hosted backend might look like `https://<account>.<vendor>.com/v1/otel` with `Authorization=Bearer <token>`.

2. Configure env vars in your application's environment:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-otlp-endpoint.example.com/v1/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <your-token>
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

> The library never owns the exporter or any vendor-specific network code — `bootstrapOtel` is a thin convenience wrapper over the standard `@opentelemetry/sdk-*` OTLP/HTTP exporters driven entirely by `OTEL_EXPORTER_OTLP_*` env vars. If you already configure OTel in your app, skip `bootstrapOtel` and just construct a `Client`.

## Smoke test

Run the gated integration test against your real backend:

```bash
OTLP_SMOKE_ENDPOINT=https://your-otlp-endpoint.example.com/v1/otel \
OTLP_SMOKE_TOKEN=<your-token> \
  pnpm exec vitest run test/integration/otlp-export-smoke.test.ts
```

The test:

1. Calls `bootstrapOtel({ serviceName: 'genai-otel-smoke' })`.
2. Emits one chat span with token usage and no messages.
3. Force-flushes the providers and shuts down.

If the test passes, the OTLP/HTTP path is reachable. To confirm visibility, query your backend for:

- `service.name = "genai-otel-smoke"`
- `gen_ai.operation.name = "chat"`
- `gen_ai.conversation.id = "smoke-conv-1"`

A row should appear within seconds.

## Things to verify on first integration

- **Per-attribute size limit:** backends cap attribute size (commonly in the 64–256 KB range). If your prompts exceed it, lower `Client({ contentCapture: { maxContentLength: <smaller> } })`.
- **Bucket boundaries on histograms:** your backend should render the advisory boundaries correctly. If dashboards don't look right, see [`docs/semconv-mapping.md`](semconv-mapping.md) for the canonical bucket families.
- **`service.name` routing:** most backends group data by service. Set `OTEL_SERVICE_NAME` per environment so dev/staging/prod stay separate.

## Redacting content

The library captures no prompt/completion content by default (see
[integrations.md](integrations.md#content-capture)). There are two layers of
control:

1. **Coarse, built-in:** `contentCaptureMode`. `metadata_only` (the default)
   drops all content across every span type (generation, agent, tool, embedding,
   retrieval); `no_tool_content` keeps prompts/completions but strips tool
   args/results and retrieval content; `full` keeps everything. Set
   `allow_list` to drop content and also every attribute not on a fixed,
   reviewed list (see [content-retention.md](content-retention.md)). This needs
   no extra code.

2. **Fine-grained:** a redacting `SpanProcessor`. Because content is emitted as
   standard span attributes, a processor can scrub or drop it uniformly for
   every span type before export — the OTel-native place for field-level
   redaction. The library intentionally ships no in-SDK redaction hook.

```ts
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

// Every attribute the library uses for content or user free text.
const CONTENT_ATTRS = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.embeddings.input_texts',
  'gen_ai.retrieval.query.text',
  'gen_ai.retrieval.documents',
  'gen_ai.request.stop_sequences',
  'genai.conversation.title',
];

/**
 * Scrubs content attributes in place before the batch exporter serializes them.
 * Most content is JSON-encoded, so `redact` runs over the encoded string — good
 * for pattern-based scrubbing (emails, card numbers, tokens). Embedding input
 * texts and stop sequences are string arrays, so each item is scrubbed. Register
 * this BEFORE the exporting processor so the mutation is visible at export time.
 */
class RedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly redact: (value: string) => string) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of CONTENT_ATTRS) {
      const value = attrs[key];
      if (typeof value === 'string') {
        attrs[key] = this.redact(value);
      } else if (Array.isArray(value)) {
        attrs[key] = value.map((item) => (typeof item === 'string' ? this.redact(item) : item));
      }
    }
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

// Example: strip anything that looks like an email or a 16-digit card number.
const redactor = new RedactingSpanProcessor((v) =>
  v
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]')
    .replace(/\b\d{16}\b/g, '[redacted-card]'),
);
// Register `redactor` on your NodeTracerProvider ahead of the OTLP exporting
// processor (BatchSpanProcessor).
```

## Resource detectors

For cloud / Kubernetes deployments, install `@opentelemetry/resource-detector-{aws,gcp,k8s}` and pass detected attributes into `bootstrapOtel`'s `extraResourceAttributes`. This auto-populates `cloud.provider`, `k8s.pod.name`, `host.name`, etc. on every span.
