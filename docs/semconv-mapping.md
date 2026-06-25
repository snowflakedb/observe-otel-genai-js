# Semantic conventions mapping

Exhaustive list of every attribute, event, and metric this library emits. Names follow the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where applicable. Library-specific extensions live under the `genai.*` prefix to keep them visually separate from the standard `gen_ai.*` namespace.

## Span attributes

### Identity / routing

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.operation.name` | string | every span — one of `chat`, `text_completion`, `generate_content`, `embeddings`, `execute_tool`, `invoke_agent`, `create_agent` |
| `gen_ai.conversation.id` | string | when set on `GenerationStart` or in `withConversationId(...)` context |
| `genai.conversation.title` | string | when `conversationTitle` is set |
| `genai.conversation.turn_index` | int | when `turnIndex` is set on the start |
| `genai.conversation.turn_role` | string | when `turnRole` is set on the start |
| `gen_ai.agent.name` | string | when `agentName` is set |
| `gen_ai.agent.version` | string | when `agentVersion` is set |
| `gen_ai.agent.id` | string | on `invoke_agent` and `create_agent` spans |
| `gen_ai.agent.description` | string | on `invoke_agent` and `create_agent` spans |
| `user.id` | string | when `userId` is set |
| `genai.sdk.name` | string | always `"genai-otel-ts"` |
| `genai.generation.id` | string | unique generation id, auto-generated if not supplied |
| `genai.parent_generation_ids` | string[] | fallback for multi-agent DAGs; native span links are also emitted |

### Model

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.provider.name` | string | generation, embedding, tool, and agent (`invoke_agent` / `create_agent`) spans, when `requestProvider` is set |
| `gen_ai.request.model` | string | generation, embedding, and agent spans, when the model is known |
| `gen_ai.response.model` | string | generation, embedding spans (when known after the provider call) |
| `gen_ai.response.id` | string | generation spans (provider's response id) |
| `server.address` | string | generation spans, when `serverAddress` is set (provider endpoint host) |
| `server.port` | int | generation spans, when `serverPort` is set |

### Request controls

| Attribute | Type | Notes |
|---|---|---|
| `gen_ai.request.max_tokens` | int | |
| `gen_ai.request.temperature` | float | |
| `gen_ai.request.top_p` | float | |
| `gen_ai.request.frequency_penalty` | float | |
| `gen_ai.request.presence_penalty` | float | |
| `gen_ai.request.stop_sequences` | string[] | |
| `gen_ai.request.seed` | int | |
| `gen_ai.request.choice.count` | int | the `n` parameter |
| `gen_ai.request.tool_choice` | string | |
| `gen_ai.request.thinking.enabled` | bool | |
| `gen_ai.request.thinking.budget_tokens` | int | |
| `gen_ai.request.encoding_formats` | string[] | embeddings only |
| `gen_ai.request.stream` | bool | set `true` on streaming generations (derived from `mode === 'STREAM'`) |
| `gen_ai.output.type` | string | requested output modality: `text`, `json`, `image`, `speech` |

### Response / usage

| Attribute | Type | Notes |
|---|---|---|
| `gen_ai.response.finish_reasons` | string[] | always a single-element list mirroring `Generation.stopReason` |
| `gen_ai.usage.input_tokens` | int | suppressed when zero |
| `gen_ai.usage.output_tokens` | int | suppressed when zero |
| `gen_ai.usage.cache_read.input_tokens` | int | |
| `gen_ai.usage.cache_creation.input_tokens` | int | AI SDK `cacheWrite` and Anthropic `cache_creation` both map here |
| `gen_ai.usage.reasoning.output_tokens` | int | |

### Embedding-only

| Attribute | Type |
|---|---|
| `gen_ai.embeddings.input_count` | int |
| `gen_ai.embeddings.input_texts` | string[] (sampled + truncated per `EmbeddingCaptureConfig`) |
| `gen_ai.embeddings.dimension.count` | int |

### Tool-execution-only

| Attribute | Type |
|---|---|
| `gen_ai.tool.name` | string |
| `gen_ai.tool.call.id` | string |
| `gen_ai.tool.type` | string |
| `gen_ai.tool.description` | string |
| `gen_ai.tool.call.arguments` | string (JSON) |
| `gen_ai.tool.call.result` | string (JSON) |

### Agent-invocation-only

`invoke_agent` spans carry the agent input and output as the standard structured content attributes (subject to the content-capture config, same size/truncation policy as generations):

| Attribute | Type |
|---|---|
| `gen_ai.input.messages` | string (JSON, structured message array — from `AgentInvocationStart.input`) |
| `gen_ai.output.messages` | string (JSON, structured message array — from `recorder.setOutput(Message[])`) |

### Agent-creation-only

`create_agent` spans carry the agent-identity attributes (`gen_ai.agent.name`, `gen_ai.agent.id`, `gen_ai.agent.version`, `gen_ai.agent.description`), `gen_ai.provider.name` / `gen_ai.request.model` when set, and `gen_ai.operation.name = "create_agent"`. They do NOT carry `gen_ai.conversation.id` / `user.id` / input/output messages — those are per-invocation, not per-agent.

### Errors

| Attribute | Type | Values |
|---|---|---|
| `error.type` | string | `provider_call_error` / `mapping_error` / `tool_execution_error` / `validation_error` |
| `error.category` | string | `timeout` / `rate_limit` / `auth_error` / `server_error` / `client_error` / `sdk_error` |

## Content capture (structured attributes)

Prompt/response content is emitted as structured span attributes following the OTel GenAI semconv 1.37+ message shape. Because OpenTelemetry JS does not support nested (complex) attribute values, the structured value is JSON-encoded into a string. Content is emitted whenever the resolved capture mode is not `metadata_only`.

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.system_instructions` | string (JSON) | generation spans, when a system prompt is set |
| `gen_ai.input.messages` | string (JSON) | generation and `invoke_agent` spans |
| `gen_ai.output.messages` | string (JSON) | generation and `invoke_agent` spans |

Size policy: unbounded by default — matching OpenTelemetry's own default and deferring to `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` and the backend. When `ContentCapture.maxContentLength` is set to a finite value, the JSON is trimmed at the string-leaf level so it stays valid JSON (content-bearing keys only — `content` / `arguments` / `result` / `text`; structural keys like `role` / `type` / `id` are preserved), and `${attr}.truncated` / `${attr}.original_size_bytes` markers are added.

## Metrics (histograms)

| Name | Unit | Bucket family |
|---|---|---|
| `gen_ai.client.operation.duration` | s | powers-of-2 (10ms → ~82s) |
| `gen_ai.client.token.usage` | token | powers-of-4 (1 → 67M) |
| `gen_ai.client.time_to_first_token` | s | powers-of-2 (streaming only, gated on `setFirstTokenAt`) |
| `gen_ai.client.tool_calls_per_operation` | count | default OTel buckets |

`gen_ai.token.type` attribute values: `input`, `output`, `cache_read`, `cache_creation`, `reasoning`. Spec well-known values are `input` / `output`; the cache and reasoning values are library extensions (permitted custom values).

## Span kinds

| Operation | SpanKind |
|---|---|
| Non-streaming chat | `CLIENT` |
| Streaming chat | `CLIENT` |
| Embeddings | `CLIENT` |
| Tool execution | `INTERNAL` |
| Agent invocation | `INTERNAL` |
| Agent creation | `INTERNAL` |

## Instrumentation scope

All spans + metrics are emitted under the OTel instrumentation scope name `@genai-otel/core`.
