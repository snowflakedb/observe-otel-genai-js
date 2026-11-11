# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Vercel AI SDK: each step runs with its operation's `invoke_agent` span active,
  so spans the step starts outside a tool parent under the agent. A nested
  `generateText` in `repairToolCall`, or in `generateText`'s `prepareStep`, used to
  parent under whatever was active when the operation started, next to the agent
  rather than inside it, and its own `invoke_agent` span read as a second turn of
  the conversation. `streamText` runs `prepareStep` outside the step, so a call
  there still parents as before. The integration binds the context manager's
  `AsyncLocalStorage` to the AI SDK's `ai:telemetry` tracing channel while an
  operation with an `invoke_agent` span is open; it needs Node and an
  `AsyncLocalStorage` context manager, and otherwise does nothing.
- `GenaiContextManager` (`@snowflake/observe-otel-genai/context-manager`), an
  `AsyncLocalStorageContextManager` that exposes its storage. Register it in place
  of the default one (`new NodeSDK({ contextManager: new GenaiContextManager() })`);
  the integration also finds the default manager's storage, but only through its
  private field. It needs `@opentelemetry/context-async-hooks` 2.x or 3.x, a new
  optional peer dependency.

## [0.2.0] - 2026-11-10

### Added
- Support for OpenTelemetry JS SDK 3.x: the `@opentelemetry/instrumentation`
  peer range is now `>=0.200.0 <0.400.0`. Before, npm refused to install the
  package into an app that had `@opentelemetry/instrumentation` 0.300. CI runs
  the tests on both SDK 2.x and 3.x.

### Removed
- **Breaking:** the `@snowflake/observe-otel-genai/bootstrap` entry point and
  `bootstrapOtel()`. Start the standard OpenTelemetry SDK instead, for example
  `new NodeSDK({ serviceName: 'my-agent' }).start()` from
  `@opentelemetry/sdk-node` 0.209.0 or later. Earlier versions export only
  traces unless `OTEL_METRICS_EXPORTER=otlp` is set, and `bootstrapOtel()`
  always exported metrics, so do not pin an earlier version. `NodeSDK` reads
  the same `OTEL_EXPORTER_OTLP_*` variables, plus `OTEL_RESOURCE_ATTRIBUTES`
  and the resource detectors that `bootstrapOtel()` skipped. `bootstrapOtel()`
  also read `OTEL_SERVICE_VERSION` and `OTEL_DEPLOYMENT_ENVIRONMENT_NAME`,
  which are not standard; set
  `OTEL_RESOURCE_ATTRIBUTES=service.version=...,deployment.environment.name=...`
  instead.
- The optional peer dependencies only the bootstrap entry point used:
  `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-trace-base`,
  `@opentelemetry/sdk-metrics`, `@opentelemetry/resources`,
  `@opentelemetry/exporter-trace-otlp-http`,
  `@opentelemetry/exporter-metrics-otlp-http` and
  `@opentelemetry/semantic-conventions`, and `@opentelemetry/context-async-hooks`,
  which nothing used.

### Fixed
- OpenAI: `gen_ai.provider.name` comes from the client's base URL host, so an
  OpenAI client pointed at Snowflake Cortex, Azure, Bedrock, Groq, DeepSeek, xAI,
  Mistral or Gemini no longer reports `openai`. Unknown hosts still report
  `openai`.
- LangChain adapter: a `ChatOpenAI` built with a `configuration.baseURL` reports
  the provider of that host the same way.
- Claude Agent SDK: with no routing flag set, `gen_ai.provider.name` is the
  provider of `ANTHROPIC_BASE_URL`, such as `snowflake` for Snowflake Cortex.
- Vercel AI SDK: models from `createBedrockMantle` (`bedrock-mantle.*`) and
  `createBedrockAnthropic` (`bedrock.anthropic.messages`) report `aws.bedrock`
  instead of the raw AI SDK provider id.

## [0.1.0] - 2026-11-02

First release.

### Added
- Spans for model calls, embeddings, tool calls, retrievals, agent runs,
  workflow runs and agent creation, and six GenAI histograms, following the
  GenAI semantic conventions.
- Instrumentations for the OpenAI SDK, OpenAI Agents SDK, LangChain.js and
  LangGraph, Claude Agent SDK and Vercel AI SDK, and a client wrapper for the
  Anthropic SDK.
