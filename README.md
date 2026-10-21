# @genai-otel/core

OpenTelemetry tracing and metrics for AI agents, following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

The library records a span for each model call, embedding, tool call, retrieval, agent run, workflow run and agent creation, plus six GenAI histograms (operation duration, token usage, time to first token, tool calls per operation, tool execution duration, workflow duration). It writes through the standard OpenTelemetry API, so the data goes wherever your app's exporter sends it: Observe, Tempo, Honeycomb, Jaeger, Datadog, or any other OTLP backend.

The core entry point depends only on `@opentelemetry/api`. It does not register providers, open network connections, or start background work; your OpenTelemetry setup does that.

## Install

Requires Node.js 22 or later. The package ships both ESM and CommonJS.

```bash
pnpm add @genai-otel/core @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/instrumentation
```

If your app already sets up OpenTelemetry, skip `@opentelemetry/sdk-node` and add the instrumentations below to your existing setup.

## Quickstart

Auto-instrumentation traces your app without changing its code. Put the setup in a preload file:

```js
// preload.mjs
import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OpenAIInstrumentation } from '@genai-otel/core/openai/instrumentation';

// The loader hook must be registered before the app imports `openai`.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const sdk = new NodeSDK({
  serviceName: 'my-agent',
  instrumentations: [new OpenAIInstrumentation()],
});
sdk.start();

// Send what is still buffered when the process is about to exit.
process.once('beforeExit', () => sdk.shutdown());
```

Start the app with it. The app itself stays plain OpenAI SDK code:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-otlp-endpoint node --import ./preload.mjs app.mjs
```

```js
// app.mjs
import OpenAI from 'openai';

const openai = new OpenAI();
await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'What is OpenTelemetry?' }],
});
```

Each call becomes a `chat gpt-4o-mini` span, with token usage and duration metrics, sent over OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`. Set `OTEL_EXPORTER_OTLP_HEADERS` too if your backend needs an auth header.

- **Sending data to a backend and checking it arrives:** [docs/exporting.md](docs/exporting.md).
- **Prompts and completions are not recorded by default.** The default mode, `metadata_only`, keeps model, token usage, timing and error type, but no message content. To record content, see [Content capture](docs/integrations.md#content-capture).
- **Agent name, conversation id and user id:** run the code inside `withAgent(name, fn)`, `withConversationId(id, fn)` or `withUserId(id, fn)`, or set a default agent name and user id in the `Client` config. See [Identity](docs/integrations.md#identity).

## Supported frameworks

Add the instrumentation for each framework you use to the `instrumentations` list. Each framework package is an optional peer dependency.

| Framework | How to turn it on |
|---|---|
| [OpenAI SDK](docs/integrations.md#openai-sdk) | `new OpenAIInstrumentation()` from `@genai-otel/core/openai/instrumentation` |
| [OpenAI Agents SDK](docs/integrations.md#openai-agents-sdk) | `new OpenAIAgentsInstrumentation()` from `@genai-otel/core/openai-agents/instrumentation`, together with `OpenAIInstrumentation` for the model calls |
| [LangChain.js and LangGraph](docs/integrations.md#langchainjs--langgraph) | `new LangChainInstrumentation()` from `@genai-otel/core/langchain/instrumentation`. Under ESM, also call its `manuallyInstrument(...)` (see the link) |
| [Claude Agent SDK](docs/integrations.md#claude-agent-sdk) | `new ClaudeAgentSdkInstrumentation()` from `@genai-otel/core/claude-agent-sdk/instrumentation` |
| [Vercel AI SDK](docs/integrations.md#vercel-ai-sdk) | No instrumentation: call `registerTelemetry(genaiTelemetryIntegration(client))` once, from `@genai-otel/core/vercel-ai-sdk` |
| [Anthropic SDK](docs/integrations.md#anthropic-sdk) | No instrumentation: wrap the client with `wrapAnthropic(client, new Anthropic())` from `@genai-otel/core/anthropic` |

### Without auto-instrumentation

To trace only some calls, or to skip the loader hook, wrap a client instead: `wrapOpenAI(client, new OpenAI())` from `@genai-otel/core/openai` traces every call made through that client. See [docs/integrations.md](docs/integrations.md) for the wrapper of each framework.

For a model or framework without an integration, record each call with the `Client` directly: `client.startGeneration(...)`, then `rec.setResult(...)` and `rec.end()` (or `await using rec = ...`). [examples/basic-chat](examples/basic-chat/index.ts) shows the full pattern, and the other `Client` methods cover embeddings, tools, retrievals, agents and workflows.

A recorder started this way does not become the parent of spans started after it. To nest spans under an agent, use the callback form `client.invokeAgent(seed, async (rec) => { ... })`, or `rec.withActiveContext(fn)`. Nesting and the `with*` helpers need an OpenTelemetry context manager; `NodeSDK` and `NodeTracerProvider.register()` install one.

## Documentation

- [docs/integrations.md](docs/integrations.md): setting up each framework, and what each one records.
- [docs/semconv-mapping.md](docs/semconv-mapping.md): every span attribute, metric and span kind.
- [docs/content-retention.md](docs/content-retention.md): the `allow_list` mode, which keeps only a fixed set of reviewed attributes.
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
