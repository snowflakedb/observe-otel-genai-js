# Blueprint

The maintainer's design record: the goal, the decisions that hold today, the scope, and the OpenTelemetry surface. Release history is in [CHANGELOG.md](../CHANGELOG.md). Every attribute and metric is listed in [semconv-mapping.md](semconv-mapping.md).

## Goal

A lightweight, vendor-neutral OpenTelemetry wrapper for AI agents. Pure OTel emission with GenAI semantic-conventions support. No proprietary payloads, no library-owned network, no background threads.

## Decisions

- **Language**: TypeScript-first, published as both ESM and CommonJS, Node 22+.
- **Sync and async**: recorder setters (`setResult`, `setCallError`, `setFirstTokenAt`, ...) are synchronous. Only `recorder.end()`, `client.flush()` and `client.shutdown()` return a `Promise`. There is no separate async client.
- **Cleanup**: recorders and the `Client` support `await using` through `Symbol.asyncDispose`. A manual `try/finally` works too.
- **Packaging**: one package, `@genai-otel/core`. Each integration has its own subpath export (`/openai`, `/langchain`, ...) behind an optional peer dependency. The OTel SDK setup lives in `/bootstrap`, so the core entry point depends only on `@opentelemetry/api`.
- **Span parenting**: the fluent `startX(...)` methods start a span without making it active. The callback variants, `invokeAgent(seed, fn)`, `invokeWorkflow(seed, fn)` and `createAgent(seed, fn)`, make their span active for `fn`, so spans started inside nest under it. A fluent recorder can do the same with `recorder.withActiveContext(fn)`.
- **Identity**: agent name and version, conversation id, conversation title and user id each take the first value set by the span itself, then the enclosing scope (a `withX(...)` helper or the span it was started under), then the `Client` default. The version only travels with its agent name. Scopes live in the OpenTelemetry context next to the active span. Integration instrumentations take no identity options. Full rules: [integrations.md](integrations.md#identity).
- **Operation naming**: method names stay ergonomic (`startGeneration`, `startStreamingGeneration`). The spec value goes on the span as `gen_ai.operation.name`, `chat` by default, with `text_completion` and `generate_content` as overrides.
- **Agent hierarchy**: `invokeAgent(...)`, `invokeWorkflow(...)` and `createAgent(...)` map to the spec's `invoke_agent`, `invoke_workflow` and `create_agent` operations. The OpenAI Agents integration records each run as an `invoke_workflow` span, with the agents, tools and model calls under it.
- **Multi-turn correlation**: `gen_ai.conversation.id`, set per call or with `withConversationId(...)`. `turnIndex` and `turnRole` on `GenerationStart` become `genai.conversation.turn_index` and `genai.conversation.turn_role` (library extensions; the spec defines only the conversation id).
- **Multi-agent fan-in**: OTel span links, plus a fallback `genai.parent_generation_ids` attribute. A bounded in-memory map (LRU with TTL) resolves generation ids to span contexts within one process.
- **Content capture**: off by default. The client default mode is `metadata_only`. Callers opt in with `no_tool_content` (prompts and completions, no tool content) or `full` (everything). `allow_list` drops content and also every attribute not on a fixed, reviewed list. The mode resolves per call, then from a `withContentCaptureMode` scope, then from the client default. The scope is read when the span starts.
- **Content format and size**: content is emitted as structured span attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`), JSON-encoded. Unbounded by default. A finite `maxContentLength` trims at the string-leaf level and keeps the JSON valid.
- **Redaction**: owned by the user, at the OTel layer. `contentCaptureMode` is the coarse control. For field-level scrubbing, register a redacting `SpanProcessor` (recipe in [exporting.md](exporting.md#redacting-content)). The library has no built-in redactor and no sanitizer hook.
- **Export target**: any OTLP backend. Endpoint and auth come from the standard `OTEL_EXPORTER_OTLP_*` env vars. No vendor-specific code.

## Scope

In scope: generations (sync and streaming), embeddings, tool execution, retrieval, agent invocation and creation, and first-party integrations for the Vercel AI SDK, OpenAI, OpenAI Agents SDK, Anthropic, LangChain / LangGraph and the Claude Agent SDK. Planned integration work is listed in [integrations.md](integrations.md#not-covered-yet).

Out of scope:

- A custom ingest, proto or export pipeline, or any vendor-specific ingest feature.
- Image, audio and other multi-modal operations.
- Ports to other languages.
- A gRPC exporter in `bootstrapOtel`. It ships OTLP/HTTP only; users can wire gRPC themselves.

## Public API

Exported from `@genai-otel/core` (see `src/index.ts`):

- `Client`: `startGeneration`, `startStreamingGeneration`, `startEmbedding`, `startToolExecution`, `startRetrieval`, `invokeAgent` (fluent or callback), `invokeWorkflow` (fluent or callback), `createAgent` (fluent or callback), `flush`, `shutdown`.
- Scope helpers: `withAgent`, `withConversationId`, `withConversationTitle`, `withUserId`, `withContentCaptureMode`, `withContext`, and a matching `...FromContext()` getter for each value.
- Message builders (`userTextMessage`, `toolCallPart`, ...), content helpers (`truncate`, `toSemconvInputMessages`, `CONTENT_ALLOW_LIST`, ...), `classifyError`, error classes, and semconv constants.
- Recorder and model types. Recorder classes are not exported as values; callers get instances from the `Client`.

## OTel API usage

The core uses only `@opentelemetry/api`:

- `trace.getTracer` and `metrics.getMeter` once, in the `Client` constructor. `Meter.createHistogram` six times, for the histograms below.
- `Tracer.startSpan` for every span. The callback variants make the span active with `context.with(trace.setSpan(...))`.
- `Span` methods: `setAttribute`, `setAttributes`, `updateName`, `recordException`, `setStatus`, `spanContext`, `end`. `Histogram.record` when a recorder ends.
- `client.flush()` and `client.shutdown()` call `forceFlush` on the global tracer and meter providers when they have one. The check is duck-typed, so the core never imports `@opentelemetry/sdk-*`.

## Spans and metrics

Each `Client` method starts one kind of span: `startGeneration` and `startStreamingGeneration` start `chat` (or `text_completion` / `generate_content`), and `startEmbedding`, `startRetrieval`, `startToolExecution`, `invokeAgent`, `invokeWorkflow` and `createAgent` start `embeddings`, `retrieval`, `execute_tool`, `invoke_agent`, `invoke_workflow` and `create_agent`. The OpenAI Agents integration adds one `invoke_workflow` span per run. Names and span kinds are in [semconv-mapping.md](semconv-mapping.md#span-kinds-and-names).

Six histograms are recorded when a recorder ends; the list, buckets and labels are in [semconv-mapping.md](semconv-mapping.md#metrics). Labels stay low-cardinality: conversation id and user id are opt-in through `metricAttributes`, zero token counts are skipped, and tool duration is its own histogram so `gen_ai.tool.name` does not multiply the other series.

## Content capture

User-facing modes and settings are in [integrations.md](integrations.md#content-capture); the `allow_list` mode is in [content-retention.md](content-retention.md); every content attribute is in [semconv-mapping.md](semconv-mapping.md#content-capture). Design points:

- Modes: `full`, `no_tool_content`, `metadata_only` (default), `allow_list`, and `default`, which defers to the next level. A `default` that reaches the client resolves to `metadata_only`.
- Truncation of plain strings: `middle` (default), `end`, `head_tail`. Structured message attributes are trimmed at the string-leaf level. A trimmed attribute gets `<attr>.truncated` and `<attr>.original_size_bytes` markers.

## Multi-turn conversations

Each turn is its own trace; all turns share `gen_ai.conversation.id`:

```ts
await withConversationId(conversationId, async () => {
  await handleOneTurn(client, userMessage);
});
```

`turnIndex` and `turnRole` on `GenerationStart` order the turns. Backends group by `gen_ai.conversation.id` and order by timestamp, or by `genai.conversation.turn_index` when set.

## Multi-agent dependency DAG

`parentGenerationIds` (on `GenerationStart` and `AgentInvocationStart`) accepts generation id strings, looked up in the in-memory map for in-process links, or `SpanContext`-like objects, for links across processes via a propagated `traceparent`. Resolved entries become OTel span links. The library also emits the `genai.parent_generation_ids` attribute, so backends that do not render span links can still join on it.
