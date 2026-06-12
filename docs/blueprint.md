# Blueprint

In-repo snapshot of the [Notion design doc](https://www.notion.so/35e770a806fc81a1ae29e780089785f4). Source-of-truth still lives in Notion; this file captures the version that shipped with v0.1.0 so the codebase is self-describing.

## Goal

A lightweight, vendor-neutral OpenTelemetry wrapper for AI agents. Pure OTel emission with GenAI semantic-conventions support. No proprietary payloads, no library-owned network, no background threads.

## Decisions locked in v0.1.0

- **Language**: TypeScript-first, ESM-only, Node 20+.
- **Sync/async story**: synchronous fluent recorder methods (`setResult`, `setCallError`, `setFirstTokenAt`); `Promise<void>` only on methods that can do I/O (`recorder.end()`, `client.flush()`, `client.shutdown()`). No separate `AsyncClient` class.
- **Resource management**: `await using recorder = ...` via `Symbol.asyncDispose`. Manual `try/finally` works too.
- **Distribution**: published as `@genai-otel/core` with a separate `@genai-otel/core/bootstrap` entry point so the core has zero `@opentelemetry/sdk-*` deps.
- **Span context activation**: `tracer.startSpan(...)` for fluent recorders (does NOT activate). `tracer.startActiveSpan(...)` for `invokeAgent(seed, async () => {...})` callback variant so nested calls auto-parent.
- **Multi-agent fan-in DAG**: OTel span links + fallback `genai.parent_generation_ids` attribute (the library maintains a bounded LRU + TTL map of generation_id → SpanContext for in-process resolution).
- **Long prompt/response content**: span events with middle-truncation at 32 KB, optional `BlobStore` offload (`gen_ai.content.uri` on the event).
- **Provider setup**: optional `bootstrapOtel(...)` helper in a separate submodule; core library has no `@opentelemetry/sdk-*` runtime dep.
- **Primary target**: Observe Inc., via OTLP/HTTP, endpoint + auth via env vars. No vendor-specific code.
- **Multi-turn correlation**: `gen_ai.conversation.id` attribute scoped via `withConversationId(...)` AsyncLocalStorage helper, plus first-class `turnIndex` / `turnRole` fields on `GenerationStart` emitted as `gen_ai.conversation.turn_index` / `gen_ai.conversation.turn_role`.
- **Agent-task span hierarchy**: first-class `invokeAgent(...)` Client method + `AgentInvocationRecorder` matching OTel GenAI semconv `gen_ai.operation.name = "invoke_agent"`.
- **Operation naming**: method names stay ergonomic (`startGeneration`, `startStreamingGeneration`). The spec-aligned operation value rides on the span via `gen_ai.operation.name`, defaulting to `chat`. `text_completion` and `generate_content` are supported overrides.
- **Tool content capture**: ON by default (`contentCaptureMode: 'no_tool_content'` is the global default — note: `no_tool_content` strips tool content, but `full` includes it; per-call override beats both).
- **PII / secret redaction**: user-owned. The library exposes a `generationSanitizer` hook on `ClientConfig` that runs on the merged `Generation` before emission; callers plug in their own redaction logic.
- **BlobStore adapters**: `BlobStore` Protocol + `LocalFsBlobStore` for v1. S3 / GCS deferred to v2.

## Out of scope for v1

- Custom ingest / proto / Generation export pipeline.
- Workflow steps, hooks, ratings, or any other vendor-specific ingest subsystems.
- Image / audio / multi-modal operations.
- Go and Python ports.
- Framework adapters (LangChain, LangGraph, etc.) — additive in v2.
- gRPC exporter — bootstrap helper ships OTLP/HTTP only; users can wire gRPC themselves.

## OTel API surface (~16 methods)

The library uses the following OTel API symbols. It does NOT import anything from `@opentelemetry/sdk-*` in its core entry point.

| Symbol | Where |
|---|---|
| `trace.getTracer(name)` | `Client.constructor` |
| `metrics.getMeter(name)` | `Client.constructor` |
| `Meter.createHistogram(name, opts)` | `GenAIMetrics.constructor` (4 calls) |
| `Tracer.startSpan(name, opts)` | per recorder start (fluent variant) |
| `Tracer.startActiveSpan(name, opts, fn)` | `invokeAgent(seed, fn)` callback variant |
| `Span.setAttribute(k, v)` | start + end |
| `Span.updateName(name)` | `recorder.end()` |
| `Span.addEvent(name, attrs)` | content capture path |
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

## Metric emission (4 histograms)

| Name | Unit | Bucket family | Labels |
|---|---|---|---|
| `gen_ai.client.operation.duration` | s | powers-of-2, 10ms → ~82s | operation, provider, request_model, agent, error.type, error.category |
| `gen_ai.client.token.usage` | token | powers-of-4, 1 → 67M | operation, provider, request_model, agent, **token.type** |
| `gen_ai.client.time_to_first_token` | s | powers-of-2, 10ms → ~82s | provider, request_model, agent (streaming only) |
| `gen_ai.client.tool_calls_per_operation` | count | default | provider, request_model, agent |

Skip-on-zero rule: token-usage records skip emission when `value === 0` so `cache_read=0` does not bloat time-series cardinality.

## Content capture

See [`docs/semconv-mapping.md`](semconv-mapping.md) for the exhaustive attribute list. Key behaviors:

- Modes: `default` → `full` → `no_tool_content` → `metadata_only`. Resolution order is per-call > context > client default; `default` falls through to `no_tool_content` so tool args/results stay off the wire unless explicitly opted in.
- Truncation: `middle` (default), `end`, `head_tail`. Truncation events carry `gen_ai.content.truncated=true`, `gen_ai.content.original_size_bytes`, `gen_ai.content.truncation_strategy`.
- Offload: when `ContentCapture.blobStore` is configured and a payload exceeds `maxContentLength`, the body is uploaded and the span event carries `gen_ai.content.uri` pointing at it.

## Multi-turn conversations

Each turn is its own trace; all turns share `gen_ai.conversation.id`. Cleanest ergonomic:

```ts
withConversationId(conversationId, async () => {
  await handleOneTurn(client, userMessage);
});
```

Per-turn ordering via first-class `turnIndex` (int) and `turnRole` (string) fields on `GenerationStart`. Backends group by `gen_ai.conversation.id` and order by timestamp (or `gen_ai.conversation.turn_index` if set).

## Multi-agent dependency DAG

`GenerationStart.parentGenerationIds` accepts either string IDs (looked up in the bounded in-memory map for in-process linkage) or `SpanContext`-like objects (for cross-process linkage via propagated `traceparent`). Resolved entries become OTel span links. The library ALSO emits a fallback `genai.parent_generation_ids` string-list attribute so backends without native span-link rendering can still join via attribute query.
