# Semantic conventions mapping

Every span attribute, event, and metric this library emits, and when each is set. Names follow the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where they exist. Library-specific attributes use the `genai.*` prefix, kept apart from the standard `gen_ai.*` namespace.

"Generation spans" below means `chat`, `text_completion`, and `generate_content` spans. Empty strings are never written, unless a row says otherwise.

## Span attributes

### Identity / routing

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.operation.name` | string | every span: `chat`, `text_completion`, `generate_content`, `embeddings`, `execute_tool`, `invoke_agent`, `invoke_workflow`, `create_agent`, or `retrieval` |
| `genai.sdk.name` | string | every span, always `"genai-otel-ts"` |
| `gen_ai.conversation.id` | string | every span except `create_agent`, when set (see [Identity resolution](#identity-resolution)) |
| `genai.conversation.title` | string | generation and `execute_tool` spans, when set. Under `metadata_only` it is written as an empty string. |
| `genai.conversation.turn_index` | int | generation spans, when `turnIndex` is set |
| `genai.conversation.turn_role` | string | generation spans, when `turnRole` is set |
| `gen_ai.agent.name` | string | every span except `invoke_workflow`, when set |
| `gen_ai.agent.version` | string | with the agent name it belongs to |
| `gen_ai.agent.id` | string | `invoke_agent` and `create_agent` spans, when set |
| `gen_ai.agent.description` | string | `invoke_agent` and `create_agent` spans, when set |
| `user.id` | string | every span except `create_agent` and `invoke_workflow`, when set |
| `genai.generation.id` | string | generation spans; generated when the caller does not supply one |
| `genai.parent_generation_ids` | string[] | generation and `invoke_agent` spans, when `parentGenerationIds` is set. Span links are also added (see [Span links](#span-links)). |

### Identity resolution

The agent name, conversation id, conversation title, and user id each take the first value set by: the span's own value, then the enclosing scope (a `withX(...)` helper, or the span it runs under), then the `Client` config. The agent version comes only with the agent name it belongs to. The full rules, and where each integration reads these values, are in [Identity](integrations.md#identity).

### Model

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.provider.name` | string | generation, `embeddings`, `execute_tool`, `retrieval`, `invoke_agent`, and `create_agent` spans, when the provider is known |
| `gen_ai.request.model` | string | the same spans, when the model is known |
| `gen_ai.response.model` | string | generation and `embeddings` spans, when the provider reports it |
| `gen_ai.response.id` | string | generation spans, when the provider reports it |
| `server.address` | string | generation and `embeddings` spans, when `serverAddress` is set. The OpenAI integration (Chat Completions, Responses, embeddings) takes it from the client's `baseURL`. |
| `server.port` | int | generation and `embeddings` spans, when `serverPort` is set. The OpenAI integration uses the `baseURL` port, else 443 for `https` and 80 for `http`. |

### Request controls

On generation spans, when the call sets them, unless noted.

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
| `gen_ai.request.stream` | bool | `true` on streaming generations; not written otherwise |
| `gen_ai.output.type` | string | requested output type: `text`, `json`, `image`, or `speech`. The OpenAI integration sets `json` or `text` from `response_format` (Chat Completions) or `text.format` (Responses). |
| `gen_ai.request.encoding_formats` | string[] | `embeddings` spans only |
| `gen_ai.request.reasoning.level` | string | Claude Agent SDK: the `effort` option, on `invoke_agent` and the main thread's generation spans |

### Response / usage

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.response.finish_reasons` | string[] | generation spans; a one-item list holding the stop reason |
| `gen_ai.usage.input_tokens` | int | generation and `embeddings` spans |
| `gen_ai.usage.output_tokens` | int | generation spans |
| `gen_ai.usage.cache_read.input_tokens` | int | generation spans |
| `gen_ai.usage.cache_write.input_tokens` | int | generation spans. Anthropic `cache_creation_input_tokens`, AI SDK `cacheWrite`, and OpenAI `cache_write_tokens` all map here. |
| `gen_ai.usage.reasoning.output_tokens` | int | generation spans |
| `gen_ai.response.time_to_first_chunk` | double (s) | streaming generation spans; same value as the `gen_ai.client.time_to_first_token` metric |
| `gen_ai.conversation.compacted` | bool | Claude Agent SDK: `true` on the `invoke_agent` span and later generation spans once the CLI compacts the conversation |
| `genai.usage.cost_usd` | double | Claude Agent SDK: the run's total cost as the SDK reports it, on `invoke_agent`. Left out for resumed or continued sessions. |
| `genai.usage.is_partial` | bool | Claude Agent SDK: `true` on a generation span whose usage is a mid-reply snapshot, not the final count |

On generation spans, token counts of zero are left out. The Claude Agent SDK also puts the run's token totals on its `invoke_agent` span, except for resumed or continued sessions.

### Embedding-only

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.embeddings.input_count` | int | when the result reports it |
| `gen_ai.embeddings.dimension.count` | int | when the request or result gives it |
| `gen_ai.embeddings.input_texts` | string[] | only with `embeddingCapture.captureInput: true` and a mode other than `metadata_only`. Keeps the first `maxInputItems` texts (default 20), each cut to `maxTextLength` characters (default 1024). |

### Tool-execution-only

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.tool.name` | string | when known; the span name uses `unknown` otherwise |
| `gen_ai.tool.call.id` | string | when known |
| `gen_ai.tool.type` | string | when known |
| `gen_ai.tool.description` | string | when known |
| `gen_ai.tool.call.arguments` | string (JSON) | `full` mode only |
| `gen_ai.tool.call.result` | string (JSON) | `full` mode only |

### Retrieval-only

`retrieval` spans record a context fetch from a vector database or search system.

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.data_source.id` | string | the index or collection queried, when known |
| `gen_ai.retrieval.top_k` | int | number of documents requested, when known |
| `gen_ai.retrieval.query.text` | string | `full` mode only |
| `gen_ai.retrieval.documents` | string (JSON) | `full` mode only. An array of `{ id?, content?, score?, metadata? }`. |

### Agent-invocation-only

`invoke_agent` spans carry the agent's input and output, under the same content rules as generation spans:

| Attribute | Type | Source |
|---|---|---|
| `gen_ai.input.messages` | string (JSON) | `AgentInvocationStart.input`, or `recorder.setInput(...)` |
| `gen_ai.output.messages` | string (JSON) | `recorder.setOutput(...)` |

### Agent-creation-only

`create_agent` spans carry `gen_ai.operation.name`, `genai.sdk.name`, the agent name, id, version, and description, and the provider and model when set. They carry no conversation id, user id, or messages, since those belong to an invocation, not to the agent.

### OpenAI Agents workflow

Each OpenAI Agents run gets an `invoke_workflow <workflow name>` span above its `invoke_agent` spans. It has no agent name, no user id, and no metric.

| Attribute | Type | Where |
|---|---|---|
| `gen_ai.operation.name` | string | `invoke_workflow`, whether the run uses one agent or several |
| `genai.sdk.name` | string | always |
| `gen_ai.workflow.name` | string | the trace name (`RunConfig.workflowName`, or the `withTrace` name). For a run given none, the agent passed to `run()`. |
| `gen_ai.conversation.id` | string | the `conversationId` passed to `run()`, else the SDK's `Trace.groupId` |
| `error.type` | string | when the run fails: the SDK's error class name, else `_OTHER` |
| `genai.metadata.<key>` | string / number / bool | one per string, number, or boolean entry in the SDK's `Trace.metadata` |

### Errors

Set only when the operation fails.

| Attribute | Type | Values |
|---|---|---|
| `error.type` | string | see below |
| `error.category` | string | `timeout`, `rate_limit`, `auth_error`, `server_error`, `client_error`, or `sdk_error` (when nothing more specific matches). Not set on `invoke_workflow`. |

Default `error.type` by span:

| Span | `error.type` |
|---|---|
| generation | `provider_call_error`, `mapping_error` (the response could not be read), or `validation_error` |
| `embeddings` | `provider_call_error` or `validation_error` |
| `execute_tool` | `tool_execution_error` |
| `invoke_agent`, `retrieval` | `provider_call_error` |
| `create_agent` | `validation_error` |

An integration can replace the default with a more precise name through `recorder.setErrorType(...)`. The OpenAI Agents integration does this with the SDK's own error class (for example `InputGuardrailTripwireTriggered`), but only for class-like names ending in `Error`, `Exception`, or `TripwireTriggered`. Free-form error text never becomes `error.type`, so it cannot blow up metric cardinality.

A failed span also gets status `ERROR` and an `exception` event. Under `metadata_only`, a failed call records no exception event and the status message is just the error category.

### Span links

A generation or `invoke_agent` span with `parentGenerationIds` gets a link to each parent it can resolve, with link attribute `gen_ai.relationship = "depends_on"`. A parent given as a span context always resolves. A parent given as a generation id resolves only if that generation started in the same process recently (by default within 5 minutes, set by `spanLinkMap`). Ids that do not resolve still appear in `genai.parent_generation_ids`.

## Content capture

Content is written as span attributes in the OTel GenAI 1.37+ structured message shape. OpenTelemetry JS has no nested attribute values, so each structured value is a JSON string. The default mode is `metadata_only`, which writes none of the attributes below. `allow_list` drops them all as well; see [content-retention.md](content-retention.md). `contentCapture.enabled: false` turns all of them off in every mode, except embedding input texts, which follow `embeddingCapture.captureInput` instead.

| Attribute | Spans | `no_tool_content` | `full` |
|---|---|---|---|
| `gen_ai.system_instructions` | generation | yes | yes |
| `gen_ai.input.messages` | generation, `invoke_agent` | yes, with tool arguments and results removed | yes |
| `gen_ai.output.messages` | generation, `invoke_agent` | yes, with tool arguments and results removed | yes |
| `gen_ai.tool.definitions` | generation, when the request lists tools (OpenAI Chat Completions and Responses, LangChain) | `type` and `name` only | adds `description` and `parameters` |
| `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | `execute_tool` | no | yes |
| `gen_ai.retrieval.query.text`, `gen_ai.retrieval.documents` | `retrieval` | no | yes |
| `gen_ai.embeddings.input_texts` | `embeddings` | yes, if `embeddingCapture.captureInput` is on | same |

Size: no limit by default, so OpenTelemetry's `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` and your backend decide. Set `contentCapture.maxContentLength` to cap each value:

- Message, system instruction, and document attributes stay valid JSON. Text values (`content`, `arguments`, `response`, `text`) are shortened first, and structural fields such as `role`, `type`, and `id` are kept. If that is not enough, whole entries are dropped: the oldest messages, or the lowest-ranked documents.
- Tool definitions drop `parameters`, then `description`, then whole entries from the end.
- Plain string values (tool arguments and results, the retrieval query) are cut using `contentCapture.truncationStrategy` (`middle`, `end`, or `head_tail`).

A cut value also gets `<attribute>.truncated = true` and `<attribute>.original_size_bytes`.

## Metrics

All five are histograms.

| Name | Unit | Recorded for | Buckets |
|---|---|---|---|
| `gen_ai.client.operation.duration` | s | generation, `embeddings`, `invoke_agent`, `create_agent`, `retrieval` | powers of 2, 0.01 s to 81.92 s |
| `gen_ai.client.token.usage` | token | generation (all token types), `embeddings` (`input` only); counts of zero are not recorded | powers of 4, 1 to 67,108,864 |
| `gen_ai.client.time_to_first_token` | s | streaming generations, from `setFirstTokenAt` or `setTimeToFirstToken` | powers of 2, 0.01 s to 81.92 s |
| `gen_ai.client.tool_calls_per_operation` | count | every generation, including zero | OTel SDK default |
| `gen_ai.client.tool_execution.duration` | s | `execute_tool` (kept separate so `gen_ai.tool.name` does not multiply the other series) | powers of 2, 0.01 s to 81.92 s |

Attributes on each data point:

| Attribute | On |
|---|---|
| `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.agent.name` | every metric |
| `error.type`, `error.category` | `operation.duration` and `tool_execution.duration` |
| `gen_ai.tool.name` | `tool_execution.duration` |
| `gen_ai.token.type` | `token.usage`: `input`, `output`, `cache_read`, `cache_write`, or `reasoning` |
| `gen_ai.conversation.id` | opt-in, see below |
| `user.id` | opt-in, see below |

The always-present attributes are written as empty strings when unknown, and `error.type` / `error.category` are empty strings on success. Only `input` and `output` are well-known `gen_ai.token.type` values in the spec; the others are library extensions.

`gen_ai.conversation.id` and `user.id` are off by default, because each adds one time series per conversation or per user. Turn them on with `new Client({ metricAttributes: { conversationId: true, userId: true } })` (either one alone works). They are then added to every data point whose operation has a value: generation, `embeddings`, `invoke_agent`, `execute_tool`, and `retrieval`. `create_agent` data points never carry them.

## Span kinds and names

| Operation | SpanKind | Span name |
|---|---|---|
| Generation (streaming or not) | `CLIENT` | `{operation} {model}` |
| Embeddings | `CLIENT` | `embeddings {model}` |
| Retrieval | `CLIENT` | `retrieval {data source id}` |
| Tool execution | `INTERNAL` | `execute_tool {tool name}` |
| Agent invocation | `INTERNAL` | `invoke_agent {agent name}` |
| Agent creation | `INTERNAL` | `create_agent {agent name}` |
| Workflow (OpenAI Agents run) | `INTERNAL` | `invoke_workflow {workflow name}` |

When the second part is empty, the name is the operation alone (tool spans use `execute_tool unknown`).

## Instrumentation scope

Spans and metrics from a `Client` you create use the scope name `@genai-otel/core`. The OTel-native instrumentations use their own scope names, such as `@genai-otel/instrumentation-openai-agents`, unless you pass them a `client`.
