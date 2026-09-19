# @genai-otel/core

A lightweight, vendor-neutral OpenTelemetry wrapper for AI agents. Pure OTel emission with [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) support. The core has no proprietary payloads, no library-owned network, and no background threads (the optional `bootstrap` submodule does run the standard OTel batch processors).

> Design rationale and decisions: [`docs/blueprint.md`](docs/blueprint.md).

## What it is

A thin recorder/lifecycle layer that emits **6 span kinds + 5 histograms** with the GenAI semantic-conventions attribute set. Drop it into any app that already uses OpenTelemetry and ship the resulting telemetry to whichever backend the host app's OTLP exporter targets (Observe, Tempo, Honeycomb, Jaeger, Datadog, ...).

The library does **not**:

- Import from `@opentelemetry/sdk-*` in its core entry point.
- Own a transport, queue, batch thread, or proto.
- Register tracer/meter providers (the host app does that).
- Enforce policies, ship custom payloads, or send anything to a proprietary ingest server.

## Quickstart

```bash
pnpm add @genai-otel/core @opentelemetry/api @opentelemetry/context-async-hooks
```

If you want the library to set up OTel providers for you (recommended for getting started):

```bash
pnpm add @genai-otel/core \
  @opentelemetry/api \
  @opentelemetry/context-async-hooks \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

```ts
import { Client } from '@genai-otel/core';
import { bootstrapOtel } from '@genai-otel/core/bootstrap';

// Set up OTel providers from OTEL_EXPORTER_OTLP_* env vars.
const { tracerProvider, meterProvider } = bootstrapOtel({ serviceName: 'my-agent' });

await using client = new Client();

await using rec = client.startGeneration({
  model: { provider: 'openai', name: 'gpt-4o' },
  conversationId: 'conv-1',
  agentName: 'planner',
  maxTokens: 512,
  temperature: 0.2,
});

const resp = await openai.chat.completions.create({ /* ... */ });

rec.setResult({
  input: inputMessages,
  output: outputMessages,
  usage: {
    inputTokens: resp.usage?.prompt_tokens ?? 0,
    outputTokens: resp.usage?.completion_tokens ?? 0,
  },
  responseId: resp.id,
  responseModel: resp.model,
  stopReason: resp.choices[0]?.finish_reason ?? '',
});

// `await using` calls end() automatically on scope exit.
```

## Environment

Configured via standard OpenTelemetry env vars:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-otlp-gateway>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
OTEL_SERVICE_NAME=my-agent
OTEL_SERVICE_VERSION=0.1.0
OTEL_DEPLOYMENT_ENVIRONMENT_NAME=dev
```

For backend setup (endpoint, auth, smoke test), see [`docs/exporting.md`](docs/exporting.md).

## Content capture and privacy

Prompt and completion **content is captured by default** — the input/output
messages are emitted as structured `gen_ai.input.messages` /
`gen_ai.output.messages` span attributes (client default mode
`no_tool_content`: prompts and completions on, tool args/results off). This
matches OpenTelemetry's own unbounded-attribute default and keeps traces useful
out of the box, but it means conversation content leaves your process on every
span.

To restrict what is captured:

- **Turn content off:** `new Client({ contentCaptureMode: 'metadata_only' })` —
  strips content from every span type (generation, agent, tool, embedding).
  Also settable per call (`contentCapture`) and ambiently
  (`withContentCaptureMode`).
- **Cap size:** `new Client({ contentCapture: { maxContentLength: 8192 } })` —
  trims long content while keeping the emitted JSON valid.
- **Redact fields:** register a redacting `SpanProcessor` at bootstrap. Content
  is user-owned and redacted at the OTel layer — the library ships no in-SDK
  sanitizer. See the recipe in [`docs/exporting.md`](docs/exporting.md#redacting-content).

## Framework integrations

First-party adapters live at their own subpath exports. Each peer dep is optional.

```ts
// Vercel AI SDK
import { wrapGenerateText, wrapStreamText } from '@genai-otel/core/vercel-ai-sdk';

// OpenAI SDK
import { wrapOpenAI } from '@genai-otel/core/openai';

// Anthropic SDK
import { wrapAnthropic } from '@genai-otel/core/anthropic';

// Claude Agent SDK (registered as an OTel instrumentation)
import { ClaudeAgentSdkInstrumentation } from '@genai-otel/core/claude-agent-sdk/instrumentation';

// LangChain.js (and LangGraph)
import { GenAIOtelCallbackHandler } from '@genai-otel/core/langchain';
```

See [`docs/integrations.md`](docs/integrations.md) for the per-adapter usage guide, mapping tables, and streaming notes.

### Notes

- **Vercel AI SDK version**: the `vercel-ai-sdk` adapter targets AI SDK v7 (`ai ^7.0.0`). v7 uses `maxOutputTokens` and `inputTokens`/`outputTokens` usage fields, and the final stream callback is `onEnd` (v6's `onFinish`); the wrapper duck-types the legacy `maxTokens` and `promptTokens`/`completionTokens` names too, so it stays tolerant of older shapes.
- **Fluent-mode parenting**: `withConversationId(id)` and friends only set values on the library's own AsyncLocalStorage; they do NOT install an OTel context. A fluent-mode generation inside a `tracer.startActiveSpan(...)` block will auto-parent under that span (because OTel context is active), but two sibling fluent generations inside a bare `withConversationId(...)` block are siblings of the trace root, not of each other. Use the callback variant of `client.invokeAgent(seed, async (rec) => { ... })` when you need explicit parenting.

## Status

Pre-1.0. APIs may change. See [`docs/blueprint.md`](docs/blueprint.md) for the design rationale and [`docs/semconv-mapping.md`](docs/semconv-mapping.md) for the exhaustive attribute list.

## License

MIT
