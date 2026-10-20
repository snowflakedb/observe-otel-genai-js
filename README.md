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

// Records metadata only; see "Content capture and privacy" to export messages.
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

Prompt and completion **content is not captured by default.** The client
default mode is `metadata_only`: every span keeps its structured metadata
(model, token usage, timing, error type) but carries no prompts, completions,
system instructions, tool definitions, tool arguments or results, conversation
title, or retrieval and embedding text. The exception events the library
records and raw error messages are left off too, since they can quote the
input that caused them.

To capture content, opt in:

- **Prompts and completions:** `new Client({ contentCaptureMode: 'no_tool_content' })` —
  emits the input/output messages as structured `gen_ai.input.messages` /
  `gen_ai.output.messages` span attributes, but keeps tool arguments/results and
  retrieval query/documents off.
- **Everything:** `new Client({ contentCaptureMode: 'full' })` — also emits tool
  arguments/results, full tool definitions, and retrieval query/documents.

Both are also settable per call (`contentCapture`) and ambiently
(`withContentCaptureMode`). Embedding input texts stay off in every mode until
you also set `embeddingCapture.captureInput: true`. Once content is on, it
leaves your process on every span.

To restrict what is exported:

- **Keep only reviewed attributes:** `contentCaptureMode: 'allow_list'` — no
  content, and every span keeps only attributes on a fixed allowlist, so a new
  or unknown attribute is dropped. See
  [`docs/content-retention.md`](docs/content-retention.md).
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

// OpenAI SDK: one-line proxy, or OTel auto-instrumentation
import { wrapOpenAI } from '@genai-otel/core/openai';
import { OpenAIInstrumentation } from '@genai-otel/core/openai/instrumentation';

// OpenAI Agents SDK: register alongside OpenAIInstrumentation
import { OpenAIAgentsInstrumentation } from '@genai-otel/core/openai-agents/instrumentation';

// Anthropic SDK
import { wrapAnthropic } from '@genai-otel/core/anthropic';

// Claude Agent SDK (an OTel instrumentation; needs the ESM loader hook in a preload,
// see docs/integrations.md#claude-agent-sdk)
import { ClaudeAgentSdkInstrumentation } from '@genai-otel/core/claude-agent-sdk/instrumentation';

// LangChain.js (and LangGraph)
import { GenAIOtelCallbackHandler } from '@genai-otel/core/langchain';
```

See [`docs/integrations.md`](docs/integrations.md) for the per-adapter usage guide, mapping tables, streaming notes, and where each adapter takes the agent name, conversation id and user id from.

### Notes

- **Vercel AI SDK version**: the `vercel-ai-sdk` adapter targets AI SDK v7 (`ai ^7.0.0`). v7 uses `maxOutputTokens` and `inputTokens`/`outputTokens` usage fields, and the final stream callback is `onEnd` (v6's `onFinish`); the wrapper duck-types the legacy `maxTokens` and `promptTokens`/`completionTokens` names too, so it stays tolerant of older shapes.
- **OpenAI Agents SDK**: register `OpenAIAgentsInstrumentation` and `OpenAIInstrumentation` together. The agents instrumentation emits the orchestration spans (`invoke_agent`, `execute_tool`) and activates OTel context around the model call; the OpenAI instrumentation emits the `chat` span, where time-to-first-token and the server address are visible. Register only the first and agent runs on the default (Responses) path come out with no model-call span.
- **Fluent-mode parenting**: `withConversationId(id)` and friends set values in the OpenTelemetry context, but they do NOT start a span. Like span parenting, they need a context manager; `bootstrapOtel` and `NodeTracerProvider.register()` install one. A fluent-mode generation inside a `tracer.startActiveSpan(...)` block will auto-parent under that span (because OTel context is active), but two sibling fluent generations inside a bare `withConversationId(...)` block are siblings of the trace root, not of each other. Use the callback variant of `client.invokeAgent(seed, async (rec) => { ... })` when you need explicit parenting (or `rec.withActiveContext(fn)` on a fluent recorder); spans started inside it also take the agent's identity, unless they set their own.

## Status

Pre-1.0. APIs may change. See [`docs/blueprint.md`](docs/blueprint.md) for the design rationale and [`docs/semconv-mapping.md`](docs/semconv-mapping.md) for the exhaustive attribute list.

## License

Copyright (c) Snowflake Inc. All rights reserved.

Licensed under the Apache 2.0 license.
