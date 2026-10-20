# @genai-otel/core

OpenTelemetry tracing and metrics for AI agents, following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

The library records a span for each model call, embedding, tool call, retrieval, agent run and agent creation, plus five GenAI histograms (operation duration, token usage, time to first token, tool calls per operation, tool execution duration). It writes through the standard OpenTelemetry API, so the data goes wherever your app's exporter sends it: Observe, Tempo, Honeycomb, Jaeger, Datadog, or any other OTLP backend.

The core entry point depends only on `@opentelemetry/api`. It does not register providers, open network connections, or start background work; your OpenTelemetry setup does that. If you have no setup yet, the optional `@genai-otel/core/bootstrap` helper creates one for you.

## Install

Requires Node.js 22 or later. The package ships both ESM and CommonJS.

If your app already sets up OpenTelemetry:

```bash
pnpm add @genai-otel/core @opentelemetry/api
```

If you want the library to set up OpenTelemetry for you (easiest way to start), also add the SDK packages the bootstrap helper uses:

```bash
pnpm add @genai-otel/core \
  @opentelemetry/api \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

## Quickstart

This traces OpenAI SDK calls (`pnpm add openai` first) and sends them over OTLP.

```ts
import { Client } from '@genai-otel/core';
import { bootstrapOtel } from '@genai-otel/core/bootstrap';
import { wrapOpenAI } from '@genai-otel/core/openai';
import OpenAI from 'openai';

// Sends traces and metrics to OTEL_EXPORTER_OTLP_ENDPOINT.
const { tracerProvider, meterProvider } = bootstrapOtel({ serviceName: 'my-agent' });

const client = new Client();
const openai = wrapOpenAI(client, new OpenAI());

const resp = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'What is OpenTelemetry?' }],
});
console.log(resp.choices[0]?.message.content);

// Export what is still buffered before the process exits.
await tracerProvider.shutdown();
await meterProvider.shutdown();
```

Run it with `OTEL_EXPORTER_OTLP_ENDPOINT` set to your backend's OTLP/HTTP endpoint, and `OTEL_EXPORTER_OTLP_HEADERS` if the backend needs an auth header. Each call becomes a `chat gpt-4o-mini` span.

- **Setup options and env vars:** [docs/bootstrap.md](docs/bootstrap.md).
- **Sending data to a backend and checking it arrives:** [docs/exporting.md](docs/exporting.md).
- **Prompts and completions are not recorded by default.** The default mode, `metadata_only`, keeps model, token usage, timing and error type, but no message content. To record content, see [Content capture](docs/integrations.md#content-capture).
- **Agent name, conversation id and user id:** run the code inside `withAgent(name, fn)`, `withConversationId(id, fn)` or `withUserId(id, fn)`, or set a default agent name and user id in the `Client` config. See [Identity](docs/integrations.md#identity).

### Recording calls yourself

For a model or framework without an integration, record each call with the `Client` directly: `client.startGeneration(...)`, then `rec.setResult(...)` and `rec.end()` (or `await using rec = ...`). [examples/basic-chat](examples/basic-chat/index.ts) shows the full pattern, and the other `Client` methods cover embeddings, tools, retrievals and agents.

A recorder started this way does not become the parent of spans started after it. To nest spans under an agent, use the callback form `client.invokeAgent(seed, async (rec) => { ... })`, or `rec.withActiveContext(fn)`. Nesting and the `with*` helpers need an OpenTelemetry context manager; `bootstrapOtel` and `NodeTracerProvider.register()` install one.

## Supported frameworks

Each integration has its own import path, and its framework package is an optional peer dependency.

- [Vercel AI SDK](docs/integrations.md#vercel-ai-sdk) (`@genai-otel/core/vercel-ai-sdk`)
- [OpenAI SDK](docs/integrations.md#openai-sdk) (`@genai-otel/core/openai`, `@genai-otel/core/openai/instrumentation`)
- [OpenAI Agents SDK](docs/integrations.md#openai-agents-sdk) (`@genai-otel/core/openai-agents/instrumentation`)
- [Anthropic SDK](docs/integrations.md#anthropic-sdk) (`@genai-otel/core/anthropic`)
- [LangChain.js and LangGraph](docs/integrations.md#langchainjs--langgraph) (`@genai-otel/core/langchain`, `@genai-otel/core/langchain/instrumentation`)
- [Claude Agent SDK](docs/integrations.md#claude-agent-sdk) (`@genai-otel/core/claude-agent-sdk/instrumentation`, `@genai-otel/core/claude-agent-sdk`)

## Documentation

- [docs/integrations.md](docs/integrations.md): setting up each framework, and what each one records.
- [docs/semconv-mapping.md](docs/semconv-mapping.md): every span attribute, metric and span kind.
- [docs/content-retention.md](docs/content-retention.md): the `allow_list` mode, which keeps only a fixed set of reviewed attributes.
- [docs/bootstrap.md](docs/bootstrap.md): the `bootstrapOtel` helper.
- [docs/exporting.md](docs/exporting.md): exporter setup, smoke test, redacting content, resource detectors.
- [docs/blueprint.md](docs/blueprint.md): design goals and decisions.
- [examples/](examples/README.md): runnable examples.
- [CHANGELOG.md](CHANGELOG.md): changes in each release.
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup and tests.

## Status

Pre-1.0. APIs may change; check [CHANGELOG.md](CHANGELOG.md) before upgrading.

## License

Copyright (c) Snowflake Inc. All rights reserved.

Licensed under the [Apache 2.0 license](LICENSE).
