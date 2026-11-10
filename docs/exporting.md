# Exporting telemetry

This library emits plain OpenTelemetry spans and metrics and sends them through whatever OTLP exporter your app sets up. Any backend that accepts OTLP works. Only the endpoint and, if needed, an auth header change between backends.

## Setup

1. Get the OTLP/HTTP endpoint and auth header from your backend's OTLP setup guide.

2. Set the standard OTel env vars in your app's environment:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <your-token>
OTEL_SERVICE_NAME=my-agent
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=prod
```

`OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL: the OTLP/HTTP exporters add `/v1/traces` and `/v1/metrics` to it. To give a full per-signal URL instead, use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`.

3. Start the OpenTelemetry SDK, then create a `Client`:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Client } from '@snowflake/observe-otel-genai';

const sdk = new NodeSDK();
sdk.start();
const client = new Client();

// On exit, flush what is left:
await sdk.shutdown();
```

`NodeSDK` from `@opentelemetry/sdk-node` reads the variables above and exports traces and metrics over OTLP. Versions before 0.209.0 export only traces unless you also set `OTEL_METRICS_EXPORTER=otlp`. If your app already sets up OpenTelemetry, skip this step and just construct a `Client`.

## Smoke test

Run the gated integration test against your backend. The default test config skips `test/integration/`, so pass `--config /dev/null` to run it on its own:

```bash
OTLP_SMOKE_ENDPOINT=https://otlp.example.com \
OTLP_SMOKE_TOKEN=<your-token> \
  pnpm exec vitest run --config /dev/null test/integration/otlp-export-smoke.test.ts
```

Both variables are required; without them the test is skipped. `OTLP_SMOKE_ENDPOINT` becomes `OTEL_EXPORTER_OTLP_ENDPOINT`, and the token is sent as `Authorization=Bearer <token>`.

The test:

1. Sets up OTLP/HTTP trace and metric export with `service.name = "observe-otel-genai-smoke"`.
2. Emits one `chat` span with token usage and no messages.
3. Shuts down the providers, which flushes the spans and metrics. An export error fails the test.

A pass means the endpoint accepted the export. The test does not query the backend, so check there for a span with:

- `service.name = "observe-otel-genai-smoke"`
- `gen_ai.operation.name = "chat"`
- `gen_ai.conversation.id = "smoke-conv-1"`

## Things to verify on first integration

- **Attribute size limits:** many backends cap the size of one attribute. Content is unbounded by default, so if your prompts are larger than your backend's limit, set `new Client({ contentCapture: { maxContentLength: <limit> } })`.
- **Histogram buckets:** the histograms suggest bucket boundaries to the SDK. If dashboards look wrong, compare with the bucket families in [semconv-mapping.md](semconv-mapping.md#metrics).
- **`service.name`:** most backends group data by service. Set `OTEL_SERVICE_NAME`, and `deployment.environment.name` in `OTEL_RESOURCE_ATTRIBUTES`, so dev, staging and prod stay separate.

## Redacting content

No prompt or completion content is captured by default. The capture modes, including `allow_list`, are covered in [integrations.md](integrations.md#content-capture) and [content-retention.md](content-retention.md).

To scrub specific fields before they leave the process, add a redacting `SpanProcessor` ahead of the exporting one. It also covers spans from other libraries, which the capture modes do not:

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

// Attributes the library uses for content or user free text.
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
 * Rewrites content attributes in place before the batch exporter sends them.
 * Most content is a JSON string, so `redact` runs over the encoded string.
 * Embedding input texts and stop sequences are string arrays, so each item is
 * scrubbed.
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

new NodeTracerProvider({
  spanProcessors: [redactor, new BatchSpanProcessor(new OTLPTraceExporter())],
}).register();
```

## Resource detectors

The resource comes from your SDK setup. `NodeSDK` reads `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`, and runs the host, process and environment detectors by default. To add cloud attributes, pass detectors such as those in `@opentelemetry/resource-detector-aws` or `@opentelemetry/resource-detector-gcp` through its `resourceDetectors` option.
