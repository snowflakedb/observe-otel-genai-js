# Blueprint

The in-repo design record for this library. Captures the goal, locked-in decisions, scope, and the OTel surface so the codebase is self-describing.

## Goal

A lightweight, vendor-neutral OpenTelemetry wrapper for AI agents. Pure OTel emission with GenAI semantic-conventions support. No proprietary payloads, no library-owned network, no background threads.

## Decisions locked in v0.1.0

- **Language**: TypeScript-first, published as both ESM and CommonJS, Node 22+.
- **Sync/async story**: synchronous fluent recorder methods (`setResult`, `setCallError`, `setFirstTokenAt`); `Promise<void>` only on methods that can do I/O (`recorder.end()`, `client.flush()`, `client.shutdown()`). No separate `AsyncClient` class.
- **Resource management**: `await using recorder = ...` via `Symbol.asyncDispose`. Manual `try/finally` works too.
- **Distribution**: published as `@genai-otel/core` with a separate `@genai-otel/core/bootstrap` entry point so the core has zero `@opentelemetry/sdk-*` deps.
- **Span context activation**: `tracer.startSpan(...)` for fluent recorders (does NOT activate). `tracer.startActiveSpan(...)` for `invokeAgent(seed, async () => {...})` callback variant so nested calls auto-parent.
- **Multi-agent fan-in DAG**: OTel span links + fallback `genai.parent_generation_ids` attribute (the library maintains a bounded LRU + TTL map of generation_id → SpanContext for in-process resolution).
- **Long prompt/response content**: emitted as structured span attributes (`gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`); unbounded by default, with an optional finite `maxContentLength` that trims at the string-leaf level while keeping valid JSON.
- **Provider setup**: optional `bootstrapOtel(...)` helper in a separate submodule; core library has no `@opentelemetry/sdk-*` runtime dep.
- **Export target**: any OTLP/HTTP backend (Tempo, Honeycomb, Jaeger, Datadog, Observe, ...), endpoint + auth via standard `OTEL_EXPORTER_OTLP_*` env vars. No vendor-specific code.
- **Multi-turn correlation**: `gen_ai.conversation.id` attribute scoped via `withConversationId(...)` AsyncLocalStorage helper, plus first-class `turnIndex` / `turnRole` fields on `GenerationStart` emitted as `genai.conversation.turn_index` / `genai.conversation.turn_role` (library extensions; the spec only defines `gen_ai.conversation.id`).
- **Agent-task span hierarchy**: first-class `invokeAgent(...)` Client method + `AgentInvocationRecorder` matching OTel GenAI semconv `gen_ai.operation.name = "invoke_agent"`.
- **Operation naming**: method names stay ergonomic (`startGeneration`, `startStreamingGeneration`). The spec-aligned operation value rides on the span via `gen_ai.operation.name`, defaulting to `chat`. `text_completion` and `generate_content` are supported overrides.
- **Content capture**: OFF by default (`contentCaptureMode: 'metadata_only'` is the global default). Opt in with `no_tool_content` (prompts and completions, no tool content) or `full` (everything, including tool args/results); per-call override beats the client default.
- **PII / secret redaction**: user-owned, at the OpenTelemetry layer. Use `contentCaptureMode` (`metadata_only` / `no_tool_content`) as the coarse cross-span control, and register a redacting `SpanProcessor` at bootstrap for fine-grained scrubbing of any span attribute before export. The library ships no built-in redactor and no in-SDK sanitizer hook. See [exporting.md](exporting.md) for the recipe.

## Out of scope for v1

- Custom ingest / proto / Generation export pipeline.
- Workflow steps, hooks, ratings, or any other vendor-specific ingest subsystems.
- Image / audio / multi-modal operations.
- Go and Python ports.
- gRPC exporter — bootstrap helper ships OTLP/HTTP only; users can wire gRPC themselves.

## Shipped since v0.1.0

- Framework adapters: first-party OpenAI (`/openai`), Anthropic (`/anthropic`), LangChain / LangGraph (`/langchain`), and Vercel AI SDK (`/vercel-ai-sdk`) integrations, each behind an optional peer dependency.

## OTel API surface (~16 methods)

The library uses the following OTel API symbols. It does NOT import anything from `@opentelemetry/sdk-*` in its core entry point.

| Symbol | Where |
|---|---|
| `trace.getTracer(name)` | `Client.constructor` |
| `metrics.getMeter(name)` | `Client.constructor` |
| `Meter.createHistogram(name, opts)` | `GenAIMetrics.constructor` (5 calls) |
| `Tracer.startSpan(name, opts)` | per recorder start (fluent variant) |
| `Tracer.startActiveSpan(name, opts, fn)` | `invokeAgent(seed, fn)` callback variant |
| `Span.setAttribute(k, v)` | start + end |
| `Span.updateName(name)` | `recorder.end()` |
| `Span.recordException(err)` | `recorder.end()` on error |
| `Span.setStatus({ code, message })` | `recorder.end()` |
| `Span.end(endTime)` | `recorder.end()` |
| `Span.spanContext()` | `recorder.end()` (read trace/span ids for `Generation`) |
| `Histogram.record(value, attrs)` | `recorder.end()` (1–6 calls) |
| `trace.getTracerProvider()` | `Client.flush()` / `shutdown()` |
| `metrics.getMeterProvider()` | `Client.flush()` / `shutdown()` |
| `TracerProvider.forceFlush?(timeout)` | `Client.flush()` / `shutdown()` (duck-typed) |
| `MeterProvider.forceFlush?(timeout)` | `Client.flush()` / `shutdown()` (duck-typed) |

## Span emission matrix

| Operation | Span name | Kind | `gen_ai.operation.name` |
|---|---|---|---|
| Non-stream generation | `chat <model>` (default) | CLIENT | `chat` / `text_completion` / `generate_content` |
| Streaming generation | `chat <model>` (default) | CLIENT | same |
| Embedding | `embeddings <model>` | CLIENT | `embeddings` |
| Tool execution | `execute_tool <tool>` | INTERNAL | `execute_tool` |
| Agent invocation | `invoke_agent <agent>` | INTERNAL | `invoke_agent` |
| Agent creation | `create_agent <agent>` | INTERNAL | `create_agent` |

## Metric emission (5 histograms)

| Name | Unit | Bucket family | Labels |
|---|---|---|---|
| `gen_ai.client.operation.duration` | s | powers-of-2, 10ms → ~82s | operation, provider, request_model, agent, error.type, error.category |
| `gen_ai.client.token.usage` | token | powers-of-4, 1 → 67M | operation, provider, request_model, agent, **token.type** |
| `gen_ai.client.time_to_first_token` | s | powers-of-2, 10ms → ~82s | provider, request_model, agent (streaming only) |
| `gen_ai.client.tool_calls_per_operation` | count | default | provider, request_model, agent |
| `gen_ai.client.tool_execution.duration` | s | powers-of-2, 10ms → ~82s | provider, request_model, **tool**, agent, error.type, error.category |

Skip-on-zero rule: token-usage records skip emission when `value === 0` so `cache_read=0` does not bloat time-series cardinality.

## Content capture

See [`docs/semconv-mapping.md`](semconv-mapping.md) for the exhaustive attribute list. Key behaviors:

- Modes: `full`, `no_tool_content`, `metadata_only` (the default), and `allow_list`, plus `default`, which defers to the next level. Resolution order is per-call > context > client default; a `default` that reaches the client resolves to `metadata_only`, so no content goes on the wire unless explicitly opted in.
- Truncation: `middle` (default), `end`, `head_tail` for plain string attributes. Structured message attributes are trimmed at the string-leaf level; when trimmed, `${attr}.truncated` / `${attr}.original_size_bytes` markers are added.

## Multi-turn conversations

Each turn is its own trace; all turns share `gen_ai.conversation.id`. Cleanest ergonomic:

```ts
withConversationId(conversationId, async () => {
  await handleOneTurn(client, userMessage);
});
```

Per-turn ordering via first-class `turnIndex` (int) and `turnRole` (string) fields on `GenerationStart`. Backends group by `gen_ai.conversation.id` and order by timestamp (or `genai.conversation.turn_index` if set).

## Multi-agent dependency DAG

`GenerationStart.parentGenerationIds` accepts either string IDs (looked up in the bounded in-memory map for in-process linkage) or `SpanContext`-like objects (for cross-process linkage via propagated `traceparent`). Resolved entries become OTel span links. The library ALSO emits a fallback `genai.parent_generation_ids` string-list attribute so backends without native span-link rendering can still join via attribute query.
