# Semantic conventions mapping

Exhaustive list of every attribute, event, and metric this library emits. Names follow the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where applicable. Library-specific extensions live under the `genai.*` prefix to keep them visually separate from the standard `gen_ai.*` namespace.

## Span attributes

### Identity / routing

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.operation.name` | string | every span — one of `chat`, `text_completion`, `generate_content`, `embeddings`, `execute_tool`, `invoke_agent`, `invoke_workflow`, `create_agent`, `retrieval` |
| `gen_ai.conversation.id` | string | every span except `create_agent`, when set (see Identity resolution) |
| `genai.conversation.title` | string | when `conversationTitle` is set (see Identity resolution) |
| `genai.conversation.turn_index` | int | when `turnIndex` is set on the start |
| `genai.conversation.turn_role` | string | when `turnRole` is set on the start |
| `gen_ai.agent.name` | string | when `agentName` is set (see Identity resolution) |
| `gen_ai.agent.version` | string | with the agent name it belongs to (see Identity resolution) |
| `gen_ai.agent.id` | string | on `invoke_agent` and `create_agent` spans |
| `gen_ai.agent.description` | string | on `invoke_agent` and `create_agent` spans |
| `user.id` | string | every span except `create_agent`, when set (see Identity resolution) |
| `genai.sdk.name` | string | always `"genai-otel-ts"` |
| `genai.generation.id` | string | unique generation id, auto-generated if not supplied |
| `genai.parent_generation_ids` | string[] | fallback for multi-agent DAGs; native span links are also emitted |

### Identity resolution

`gen_ai.agent.name`, `gen_ai.conversation.id`, `genai.conversation.title` and `user.id` each take the first value set by these sources, in order. Empty strings count as unset.

1. **The span's own value**: a field passed to `startGeneration`, `invokeAgent` and the like, or what an integration reads for this one call, such as `withMetadata`.
2. **The enclosing scope**: `withAgent`, `withConversationId`, `withConversationTitle`, `withUserId` or `withContext`, or the span this one is started under (inside the `client.invokeAgent(seed, fn)` callback or a recorder's `withActiveContext(fn)`). The innermost scope that sets a value wins. Scopes live in the OpenTelemetry context, next to the active span, so code that saves and later restores a context restores the scope too. That span passes down only its own and inherited values, not the `Client` config; the span under it falls back to the `Client` on its own. `create_agent` hands nothing down.
3. **The `Client` config**: `agentName`, `agentVersion`, `userId`.

`gen_ai.agent.version` is used only from a place that also sets the agent name, and only if that is the name the span ends up with. So with `new Client({ agentName: 'shop-bot', agentVersion: '2' })`, a span whose agent name is `shop-bot` gets version `2`, and one whose agent name is `checkout` gets none. A scope that names an agent drops the outer scope's version, so `withAgent('inner', fn)` inside `withAgent('outer', '1', fn)` has no version. The same goes for a span that hands down an agent name: a sub-agent named `helper` inside agent `checkout` version `1` has no version, and the spans under it are `helper` with no version.

### Model

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.provider.name` | string | generation, embedding, tool, and agent (`invoke_agent` / `create_agent`) spans, when `requestProvider` is set |
| `gen_ai.request.model` | string | generation, embedding, and agent spans, when the model is known |
| `gen_ai.response.model` | string | generation, embedding spans (when known after the provider call) |
| `gen_ai.response.id` | string | generation spans (provider's response id) |
| `server.address` | string | generation and embedding spans, when `serverAddress` is set (provider endpoint host; the OpenAI integration takes it from the client's `baseURL`) |
| `server.port` | int | generation and embedding spans, when `serverPort` is set |

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
| `gen_ai.usage.cache_write.input_tokens` | int | AI SDK `cacheWrite` and Anthropic `cache_creation` both map here |
| `gen_ai.usage.reasoning.output_tokens` | int | |
| `gen_ai.response.time_to_first_chunk` | double (s) | streaming only; same value as the `gen_ai.client.time_to_first_token` metric |
| `gen_ai.request.reasoning.level` | string | Claude Agent SDK: the `effort` option |
| `gen_ai.conversation.compacted` | boolean | Claude Agent SDK: set after the CLI compacts the conversation |
| `genai.usage.cost_usd` | double | Claude Agent SDK: the run's estimated cost, on `invoke_agent` |
| `genai.usage.is_partial` | boolean | Claude Agent SDK: the call's usage is a mid-reply snapshot, not its final count |

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

### Retrieval-only

`retrieval` spans (span kind CLIENT) model a RAG context fetch from a vector database or search system. Span name is `retrieval {gen_ai.data_source.id}`.

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.data_source.id` | string | the data source / index / collection being queried, when known |
| `gen_ai.retrieval.top_k` | int | number of documents requested, when known |
| `gen_ai.retrieval.query.text` | string | Opt-In query text — subject to the content-capture config, stripped under `metadata_only` and `no_tool_content` |
| `gen_ai.retrieval.documents` | string (JSON, structured document array) | Opt-In retrieved documents (`{ id?, content?, score?, metadata? }`) — same size/truncation policy as `gen_ai.input.messages`, stripped under `metadata_only` and `no_tool_content` |

`gen_ai.provider.name` / `gen_ai.request.model` are emitted when the caller supplies them.

### Agent-invocation-only

`invoke_agent` spans carry the agent input and output as the standard structured content attributes (subject to the content-capture config, same size/truncation policy as generations):

| Attribute | Type |
|---|---|
| `gen_ai.input.messages` | string (JSON, structured message array — from `AgentInvocationStart.input` or `recorder.setInput(Message[])`) |
| `gen_ai.output.messages` | string (JSON, structured message array — from `recorder.setOutput(Message[])`) |

### OpenAI Agents workflow

Each OpenAI Agents run gets an `invoke_workflow <workflow name>` span, above the run's `invoke_agent <name>` spans. It has no `gen_ai.agent.name`.

| Attribute | Type | Notes |
|---|---|---|
| `gen_ai.operation.name` | string | `invoke_workflow`, whether the run uses one agent or several |
| `gen_ai.workflow.name` | string | The trace name (`RunConfig.workflowName`, or the `withTrace` name); for a run given none, the agent passed to `run()` |
| `gen_ai.conversation.id` | string | The `conversationId` passed to `run()`, else the SDK's `Trace.groupId` |
| `error.type` | string | When the run fails |
| `genai.metadata.<key>` | string / number / boolean | Custom; one per scalar entry in the SDK's `Trace.metadata` |

### Agent-creation-only

`create_agent` spans carry the agent-identity attributes (`gen_ai.agent.name`, `gen_ai.agent.id`, `gen_ai.agent.version`, `gen_ai.agent.description`), `gen_ai.provider.name` / `gen_ai.request.model` when set, and `gen_ai.operation.name = "create_agent"`. They do NOT carry `gen_ai.conversation.id` / `user.id` / input/output messages — those are per-invocation, not per-agent.

### Errors

| Attribute | Type | Values |
|---|---|---|
| `error.type` | string | `provider_call_error` / `mapping_error` / `tool_execution_error` / `validation_error`, or a framework-supplied error class name (see below) |
| `error.category` | string | `timeout` / `rate_limit` / `auth_error` / `server_error` / `client_error` / `sdk_error` |

By default a recorder reports a coarse category for its own kind of work. An integration holding a more precise name from the framework can override that through `recorder.setErrorType(...)`. The OpenAI Agents integration does, so an agent span reports the SDK's own error class (`InputGuardrailTripwireTriggered`, say) where it would otherwise report a flat `provider_call_error`. It overrides only with a class-like name ending in `Error`, `Exception`, or `TripwireTriggered`; otherwise the recorder's own category stands, so free-form error text can never become an unbounded metric label.

## Content capture (structured attributes)

Prompt/response content is emitted as structured span attributes following the OTel GenAI semconv 1.37+ message shape. Because OpenTelemetry JS does not support nested (complex) attribute values, the structured value is JSON-encoded into a string. Content is emitted whenever the resolved capture mode is not `metadata_only` or `allow_list`. The default mode is `metadata_only`, so content is off until you opt in with `no_tool_content` or `full`.

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.system_instructions` | string (JSON) | generation spans, when a system prompt is set |
| `gen_ai.input.messages` | string (JSON) | generation and `invoke_agent` spans |
| `gen_ai.output.messages` | string (JSON) | generation and `invoke_agent` spans |

Size policy: unbounded by default — matching OpenTelemetry's own default and deferring to `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` and the backend. When `ContentCapture.maxContentLength` is set to a finite value, the JSON is trimmed at the string-leaf level so it stays valid JSON (content-bearing keys only — `content` / `arguments` / `response` / `text`; structural keys like `role` / `type` / `id` are preserved), and `${attr}.truncated` / `${attr}.original_size_bytes` markers are added.

## Metrics (histograms)

| Name | Unit | Bucket family |
|---|---|---|
| `gen_ai.client.operation.duration` | s | powers-of-2 (10ms → ~82s) |
| `gen_ai.client.token.usage` | token | powers-of-4 (1 → 67M) |
| `gen_ai.client.time_to_first_token` | s | powers-of-2 (streaming only, from `setFirstTokenAt` or `setTimeToFirstToken`) |
| `gen_ai.client.tool_calls_per_operation` | count | default OTel buckets |
| `gen_ai.client.tool_execution.duration` | s | powers-of-2 (10ms → ~82s) — isolates `gen_ai.tool.name` cardinality |

`gen_ai.token.type` attribute values: `input`, `output`, `cache_read`, `cache_write`, `reasoning`. Spec well-known values are `input` / `output`; the cache and reasoning values are library extensions (permitted custom values).

`gen_ai.conversation.id` is off by default on metrics because it adds one time series per conversation. Turn it on with `new Client({ metricAttributes: { conversationId: true } })`. It is then added to every data point whose operation has a conversation ID: chat, embeddings, `invoke_agent`, `execute_tool`, and retrieval. `create_agent` has no conversation ID, so its data points never carry it.

`user.id` is also off by default, since it adds one time series per user. Turn it on with `new Client({ metricAttributes: { userId: true } })`. It is then added to chat, embeddings, `invoke_agent`, `execute_tool`, and retrieval data points that have a user ID. `create_agent` has no user ID, so its data points never carry it.

## Span kinds

| Operation | SpanKind |
|---|---|
| Non-streaming chat | `CLIENT` |
| Streaming chat | `CLIENT` |
| Embeddings | `CLIENT` |
| Retrieval | `CLIENT` |
| Tool execution | `INTERNAL` |
| Agent invocation | `INTERNAL` |
| Agent creation | `INTERNAL` |
| Workflow invocation (OpenAI Agents run) | `INTERNAL` |

## Instrumentation scope

Spans and metrics from a `Client` you create are emitted under the scope name `@genai-otel/core`. The OTel-native instrumentations use their own scope names, such as `@genai-otel/instrumentation-openai-agents`, unless you pass them a `client`.
