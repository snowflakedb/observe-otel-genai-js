# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- License changed from MIT to Apache 2.0.

### Added
- LangChain: the run's `metadata.user_id` is recorded as `user.id`.
- OpenAI: `responses.create` records the request's own `conversation` as
  `gen_ai.conversation.id`, unless `withMetadata` sets one.
- Core: opt-in `gen_ai.conversation.id` on metrics. Set
  `new Client({ metricAttributes: { conversationId: true } })` to add it to every
  histogram data point whose operation has a conversation ID. Off by default, since
  each conversation becomes its own time series.
- Core: recorders accept a framework's own error class as `error.type`
  (`rec.setErrorType(name)`), for integrations that know a more precise name than
  the recorder's coarse category. It becomes a metric label, so callers must keep
  it low-cardinality.
- `AgentInvocationRecorder.setInput(messages)` and
  `ToolExecutionRecorder.setToolType(type)`, for integrations that learn an agent's
  input or a tool's type after the span started.
- **`OpenAIInstrumentation`** (`@genai-otel/core/openai/instrumentation`), an
  OpenTelemetry-native alternative to `wrapOpenAI`. It patches
  `chat.completions.create`, `responses.create`, and `embeddings.create` on the
  prototypes the `OpenAI` client's own statics expose, so there are no dist file
  paths to drift and behavior matches across CommonJS and ESM. CommonJS
  auto-patches through the require hook; ESM is served by `manuallyInstrument`,
  which needs no launch flags. Installing both this and `wrapOpenAI` still yields
  one span per request: the patch marks each method it wraps and the proxy passes
  marked methods through. When another library reached the prototypes first, this
  one steps aside and says so at `warn` level, naming the ways to disable the
  other one.
- **OpenAI Responses API support.** `responses.create` now records a `chat` span
  through both entry points, the `wrapOpenAI` proxy and `patchResponsesCreate`.
  The shape shares almost nothing with Chat Completions, so it gets its own
  mapping: input is a list of typed items, output is a list of typed items, and
  the stream is a union of named events. `instructions` maps to
  `gen_ai.system_instructions`, since Responses carries the system prompt
  out-of-band. Tool definitions come from the top level of each tool.
  `input_tokens_details.cached_tokens` and
  `output_tokens_details.reasoning_tokens` map onto the cache-read and reasoning
  counters. Streaming takes TTFT from the first `*.delta` event and the final
  output and usage from `response.completed`.
- The `openai` peer range now includes v7.
- **OpenAI Agents SDK support.** `OpenAIAgentsInstrumentation`
  (`@genai-otel/core/openai-agents/instrumentation`) traces agent runs:
  `invoke_agent` for agents, `execute_tool` for tools, `chat` for model calls on
  the AI SDK path, and an `invoke_agent` container span for each run, named after
  the trace. On the OpenAI model paths the `chat` span comes from
  `OpenAIInstrumentation`, so each model call is reported once.
  - Model calls and tool calls run inside their span's OTel context, so spans from
    other instrumentations nest under the agent or tool, streamed calls included.
  - Model-call spans from `OpenAIInstrumentation` carry the run's
    `gen_ai.conversation.id` (from `groupId`) and the calling agent's name.
  - Agent spans carry the agent's input and output messages under content capture.
  - Runs and `withTrace` blocks that reject are closed with the error, since the
    SDK leaves them open. Failures the run recovers from do not fail the run.
  - A streamed run that fails reports the error on its container.
  - The processor stays registered when the SDK's processor list is replaced, so
    `setTraceProcessors([])` turns off the export to OpenAI and keeps these spans.
  - Time-to-first-token on the AI SDK path, measured from the first delta event.
  - `instrumentModel()` for hand-written `Model` classes, and
    `GenAIOtelTracingProcessor` (`@genai-otel/core/openai-agents`) for custom setups.
- `allow_list` content-capture mode. It strips content like `metadata_only`, and every
  span the library creates keeps only attributes on a fixed, reviewed allowlist, so a
  new or unknown attribute is dropped instead of exported. Event and link attributes
  are filtered too, exceptions keep only `exception.type`, and the status message is
  dropped. The list is exported as `CONTENT_ALLOW_LIST`. See
  `docs/content-retention.md`.

### Changed
- **`metadata_only` is now the default content-capture mode.** A `Client` with no
  `contentCaptureMode`, and the `default` mode's fallthrough, no longer capture
  prompts and completions: spans keep their metadata but carry no messages,
  system instructions, tool definitions or payloads, conversation title,
  retrieval or embedding text, library-recorded exception events, or raw error
  messages. To capture content again, set `contentCaptureMode: 'no_tool_content'`
  (prompts and completions) or `'full'` (also tool arguments/results and
  retrieval content) on the `Client`, per call, or with `withContentCaptureMode`.
- **Core: agent name, agent version, conversation id, conversation title and user
  id now resolve in one order**: the span's own value (passed to
  `startGeneration`, `invokeAgent` and the like), the enclosing `withX(...)`
  scope, then the `Client` config. Empty strings count as unset. See "Identity
  resolution" in `docs/semconv-mapping.md`.
  - An agent version is used only from a place that also sets the agent name,
    and only if that is the name the span ends up with. So `Client({ agentVersion })`
    without `agentName`, or `startGeneration({ agentVersion })` without
    `agentName`, no longer produces a version, and a span whose agent name is
    `checkout` no longer takes the version of a `Client` that names another agent.
  - `invoke_agent` spans take the agent name from the scope or the `Client` when
    none is passed, so `AgentInvocationStart.agentName` is now optional.
- **`withAgentName` and `withAgentVersion` are replaced by `withAgent(name,
  version?)`.** A scope that names an agent drops the outer scope's version, so
  `withAgent('inner', fn)` inside `withAgent('outer', '1', fn)` has no version.
  An empty value in a scope keeps the outer scope's value.
- **`OpenAIInstrumentation` no longer takes identity options** (`agentName`,
  `agentVersion`, `conversationId`, `conversationTitle`, `userId`). They ranked a
  whole-process setting above the app's own `withX(...)` scope. Set identity with
  `withMetadata` on the call, a scope around it, or the `Client`.
- **LangChain: the handler and `LangChainInstrumentation` no longer take identity
  options** (`agentName`, `agentVersion`, `conversationId`, `conversationTitle`,
  `userId`). The run's own `runName`, `thread_id` and `metadata.user_id` give the
  identity, and an enclosing `withX(...)` scope or the `Client` fills in the rest.
  The handler no longer makes up agent names: the runnable's class name, other
  `Runnable*` names, `LangGraph` for an unnamed graph, and `langchain-chain` no
  longer count, so an unnamed chain takes the name of an enclosing `withAgent(...)`
  scope or the `Client`'s `agentName`, or gets a plain `invoke_agent` span.
- Vercel AI SDK telemetry: a call whose `deriveOptions` returns no agent name (by
  default: no `functionId` and no `runtimeContext.agent`) is no longer named
  `agent`. Its `invoke_agent` span takes the name from an enclosing
  `withAgent(...)` scope or the `Client`'s `agentName`, and is named plain
  `invoke_agent` when nothing names it.
- **Claude Agent SDK: `ClaudeAgentSdkInstrumentation` no longer takes identity
  options.** Pass them to `wrapQuery`, or wrap the call in a `withX(...)` scope.
  An unnamed run is no longer named `claude-agent-sdk`: it takes the `Client`'s
  `agentName`, or is named plain `invoke_agent`. The CLI session id is now the
  conversation id only when neither `wrapQuery` nor an enclosing scope sets one,
  and subagent spans no longer carry the main agent's version.
- Spans that succeed now leave their status unset instead of setting it to OK, as
  the OpenTelemetry conventions recommend for instrumentation libraries.
- LangChain adapter: provider matching now also ignores `.` in provider ids.

### Fixed
- OpenAI Agents: the `conversationId` passed to `run()`, or kept in a resumed run's
  state, becomes the run's `gen_ai.conversation.id`, ahead of `groupId`. The SDK
  sends it as the Responses `conversation`, which the chat spans record, so before
  this the agent spans and the chat spans under them could carry different ids.
- Embedding spans no longer drop `gen_ai.agent.name` under `metadata_only`. The
  agent name is metadata, and the other span types already keep it.
- OpenAI Agents integration: the run container span read its content-capture mode
  from the processor option alone, falling back to the client default only when
  unset. So a processor set to `default`, or a `metadata_only` scope opened with
  `withContentCaptureMode`, still put the raw error message on its status. It now
  uses the mode resolved when the trace opens.
- Peer ranges for the OpenTelemetry OTLP exporters accepted one minor release
  only. `^0.200.0` on a `0.x` version means `>=0.200.0 <0.201.0`, so a project on
  any current release (0.201 and later) could not install this package without
  `--legacy-peer-deps`. Both are now `>=0.200.0 <0.300.0`, matching
  `@opentelemetry/instrumentation`. 0.300.x ships with OpenTelemetry JS SDK 3.0
  and stays out until it is tested.

### Known
- `gen_ai.tool.call.id` is not emitted on `execute_tool` spans from the OpenAI
  Agents SDK. Its `FunctionSpanData` is `{ name, input, output, mcp_data }` and
  carries no call id, so the only way to supply one is to scrape the preceding
  model span's output and pair entries up by tool name and arguments. That pairing
  breaks on parallel calls to the same tool, and it breaks once
  `RunConfig.traceIncludeSensitiveData` blanks the arguments being matched on. The
  conventions ask for the attribute "if available"; from this SDK it is not. The
  LangChain integration still emits it, where the tool-end message supplies the id
  directly.

## [0.6.0] - 2026-09-29

### Added
- Claude Agent SDK adapter. `ClaudeAgentSdkInstrumentation`
  (`@genai-otel/core/claude-agent-sdk/instrumentation`) patches the SDK's `query`
  through the OpenTelemetry ESM loader hook; `wrapQuery`
  (`@genai-otel/core/claude-agent-sdk`) wraps a call site without the hook, and
  `wrapStartup` does the same for a pre-warmed `startup()` handle. Each
  `query()` gets an `invoke_agent` span with `chat` and `execute_tool` children and a
  nested `invoke_agent` per subagent, rebuilt from the CLI's message stream. Works with
  `@anthropic-ai/claude-agent-sdk` `>=0.3.142 <0.4.0`.
- Every adapter: `chat` spans also carry `gen_ai.usage.cache_write.input_tokens` (the
  current name for `cache_creation`), and streaming `chat` spans carry
  `gen_ai.response.time_to_first_chunk`.
- Core: recorders accept a caller-supplied end time (`rec.setEndedAt(t)`) and extra
  span attributes (`rec.setAttributes(...)`).

### Fixed
- Vercel AI SDK adapter: implement `Telemetry.executeTool` so work inside
  `tool.execute` (auto-instrumented HTTP/undici, nested generations, …) parents
  under the matching `execute_tool` span. Previously `withActiveContext` was only
  used when *creating* the tool span, so downstream client spans attached to an
  ambient ancestor instead.
- `no_tool_content` now strips tool arguments and results from `chat` spans in every
  adapter, as it already did on `invoke_agent` spans. Before, they still appeared in
  `chat` input and output messages under the default mode.

## [0.5.0] - 2026-09-17

### Added
- LangChain adapter: emit `gen_ai.response.model` on `chat` spans — the model
  that served the call, which can be more specific than the requested one (ask
  for `gpt-4o`, get `gpt-4o-2024-11-20`). `gen_ai.request.model` still reports
  what you asked for.
- LangChain adapter: map prompt-cache token counts onto `chat` spans as
  `gen_ai.usage.cache_read.input_tokens` and
  `gen_ai.usage.cache_creation.input_tokens`, whenever the provider reports them.
- LangChain adapter: emit `gen_ai.tool.definitions` on `chat` spans from the
  model's bound tools. `type` + `name` are always emitted; `description` /
  `parameters` only under `full` content capture.
- OpenTelemetry-native LangChain instrumentation (`LangChainInstrumentation`):
  register it via `registerInstrumentations(...)` and every chain / LLM / tool
  run is traced with no per-call wiring. CJS auto-patches zero-config (the hook
  targets `@langchain/core/dist/callbacks/manager.cjs`, leaving the ESM module
  graph untouched); ESM apps call `manuallyInstrument(...)`. Supports
  `@langchain/core` `>=0.3.0 <2` (peer dep `^0.3.0 || ^1.0.0`).
- LangChain adapter: map LangGraph's `thread_id` (from `config.configurable`) to
  `gen_ai.conversation.id` on every span in the run, so the turns of a
  multi-turn or checkpointed graph share one id. A user-provided id wins:
  precedence is the handler `conversationId`, then `withConversationId(...)`,
  then `thread_id`.

### Fixed
- Vercel adapter: normalize AI SDK provider/API identifiers such as
  `snowflake.chat`, `openai.responses`, and `anthropic.messages` to canonical
  `gen_ai.provider.name` values. Known Bedrock, Vertex AI, Gemini, and Azure
  OpenAI families map to their OpenTelemetry semantic provider names; unknown
  custom provider identifiers remain unchanged.

### Changed
- **LangChain adapter: `gen_ai.provider.name` now emits the semconv well-known
  values.** `google` → `gcp.vertex_ai` / `gcp.gemini` / `gcp.gen_ai`,
  `aws-bedrock` → `aws.bedrock`, `mistralai` → `mistral_ai`. Classes that
  previously reported their own name, `AzureChatOpenAI`,
  `ChatGoogleGenerativeAI` and `ChatBedrockConverse` among them, now map too.
- Minimum supported Node.js is now 22 (`engines.node: ">=22"`, was `">=20"`).
  Node 20 reached end-of-life on 2026-04-30 and no longer receives upstream
  security patches. CI now tests Node 22 (Maintenance LTS) and 24 (Active LTS),
  replacing the previous 20/22 matrix.

### Fixed
- LangChain adapter: mark streamed calls with `gen_ai.request.stream` (via
  `startStreamingGeneration`) so TTFT records, and recover
  `gen_ai.usage.input_tokens` from the generation message's `usage_metadata` on
  streams that only surface it there.
- LangChain adapter: report the real provider stop reason (read from
  `response_metadata` / `llmOutput`, passed through unchanged) instead of always
  `stop`; fall back to `stop` (or `error` on failures) only when the provider
  reason is unknown.
- LangChain adapter: set `gen_ai.tool.call.result` to the tool's actual return value by unwrapping the tool-end `ToolMessage`, instead of the serialized message envelope.
- LangChain adapter: emit `gen_ai.tool.call.id` on `execute_tool` spans by backfilling the id from the tool-end `ToolMessage`, so the tool span correlates to the model's tool call.
- LangChain adapter: name `execute_tool` spans from the tool instance's real name instead of the serialized class name — the run's `runName` at start (present even on failures), overridden by the authoritative tool-end `ToolMessage` `name` on success.
- LangChain instrumentation: set `gen_ai.conversation.id` on the auto-patched
  `invoke_agent` root span. With no callbacks passed, `_configureSync` builds no
  manager and drops its metadata, so the fabricated fallback lost the run's
  `thread_id` while child spans kept it; the metadata is now replayed onto it.
- LangChain adapter: nest child spans under the agent trace. Each LLM / tool /
  chain recorder opened its own root span, so one agent run produced N
  disconnected single-span traces; a run now emits one connected trace
  (`invoke_agent` → `chat` / `execute_tool`).
- LangChain adapter: keep retriever runs in the run tree. Retrievers emit no
  span (no retrieval recorder yet), and without their `runId` recorded, a RAG
  chain's LLM call dead-ended the ancestor walk and started a new root trace.
  `handleRetrieverStart` / `End` / `Error` now record the parent edge so the
  trace stays connected (though an LLM call inside a retriever parents under
  `invoke_agent`, not a retrieval span).
- LangChain adapter: emit `gen_ai.input.messages` on the `invoke_agent` span,
  which previously showed output but no input. A `messages` array (LangGraph)
  uses the `BaseMessage` mapping, a string or a string `input` / `question` /
  `text` field becomes one user message, and any other shape is JSON-encoded.
- LangChain adapter: map a LangGraph `messages` output on the `invoke_agent`
  span's `gen_ai.output.messages` instead of JSON-serializing the whole graph
  state. The final state's `messages` array was dumped verbatim — a blob of
  serialized `BaseMessage`s that also duplicated the input — so only the last
  message (the agent's answer) is now kept.

## [0.3.0] - 2026-07-15

### Added
- Vercel adapter: `genaiTelemetryIntegration(client, options?)` — an AI SDK v7
  `Telemetry` integration. Register once via `registerTelemetry(...)` and every
  `generateText` / `streamText` / `ToolLoopAgent` / `generateObject` call in the
  process emits genai-otel spans (`invoke_agent` → `chat` → `execute_tool`) with
  no per-call-site wiring. Per-turn identity is derived from each operation's
  `functionId` + `runtimeContext` via `options.deriveOptions`; `options`
  `emitOperationSpan` (`boolean | (event) => boolean`, default `true`) controls
  whether the `invoke_agent` operation span is emitted. Operation correlation
  uses the AI SDK `callId` on every lifecycle event; span parenting composes the
  existing `RecorderBase.withActiveContext` primitive (no AsyncLocalStorage).
  Model-call failures are attributed to the owning operation via
  `executeLanguageModelCall` (the only error signal carrying a `callId`).
- Vercel adapter: `defaultDeriveOptions`, plus `DeriveOptions` /
  `DeriveOptionsEvent` / `GenaiTelemetryOptions` types.

### Changed
- Vercel adapter: extracted the shared event-shape interfaces and message
  mappers into an internal `_map.ts` module, now consumed by the `Telemetry`
  integration.

### Removed
- Vercel adapter: the per-call hook-bag API — `streamTextHooks`,
  `generateTextHooks`, `generateObjectHooks`, `mergeHooks`, `agentTurn` (and the
  `StreamTextHooks` / `GenerateTextHooks` / `GenerateObjectHooks` / `AgentTurn`
  types) — is removed, fully superseded by `genaiTelemetryIntegration`. The
  standalone function wrappers (`wrapGenerateText` / `wrapStreamText` /
  `wrapGenerateObject` / `wrapEmbed` / `wrapEmbedMany`) and the
  `toAgentInputMessages` mapper remain.

## [0.2.2] - 2026-07-14

### Added
- Vercel adapter: `agentTurn(client, start, options?, callerHooks?)` — a
  streaming-aware `invoke_agent` lifecycle handle. Bundles the documented manual
  pattern (fluent recorder + `withActiveContext` + spread-safe hooks + an
  idempotent closer) into one `AgentTurn`: `{ recorder, hooks, run(fn),
  end({output?, error?}), [Symbol.asyncDispose] }`. `input` accepts AI SDK
  `ModelMessage[]` (mapped internally via `toAgentInputMessages`) or genai-otel
  `Message[]`. `end()` is idempotent (first call wins; `error` beats `output`;
  a string `output` is wrapped via `assistantTextMessage`), and the handle
  supports `await using` for leak-safe scope exit. Composes existing primitives
  only — no new span emission logic.

## [0.2.1] - 2026-07-14

### Added
- Vercel adapter: `toAgentInputMessages(messages)` — a public mapper that
  converts AI SDK `ModelMessage[]` (the `streamText` / `generateText` input
  shape) to genai-otel `Message[]`, suitable for `gen_ai.input.messages` on a
  manually-authored `invoke_agent` span. System messages are skipped per the
  GenAI semantic conventions (they ride on the agent/generation `systemPrompt`).
- Vercel adapter: `mergeHooks(sdk, caller)` plus an optional `callerHooks` third
  argument on `streamTextHooks` / `generateTextHooks`, so a caller's own AI SDK
  callbacks compose with the telemetry callbacks instead of clobbering them when
  spread into `streamText` / `generateText`. The telemetry handler runs first
  and defensively — a throw from it is swallowed so instrumentation can never
  break the caller's handler — then the caller's handler runs and its errors
  propagate. Handlers present on only one side pass through unchanged.

## [0.2.0] - 2026-07-13

### Added
- Prompt/completion **content parity** across all adapters. The OpenAI,
  Anthropic, and LangChain adapters now emit `gen_ai.input.messages` /
  `gen_ai.output.messages` (previously only the Vercel adapter did). OpenAI and
  Anthropic map request messages and response content/tool-calls on both the
  sync and streaming paths; LangChain gains a `handleChatModelStart` override
  that captures structured chat messages with real roles (and `handleLLMEnd`
  now records output).
- `contentCapture` per-call override is now threaded through every adapter and
  the `GenerationStart` / `EmbeddingStart` seeds (previously accepted but
  silently ignored by the OpenAI/Anthropic/LangChain paths).
- LangChain adapter: `turnIndex` / `turnRole` options for parity with the other
  adapters, and a `dispose()` method that ends any still-open runs on shutdown
  (guards against leaked spans / unbounded map growth on long-lived handlers).

### Fixed
- OpenAI adapter reads `max_completion_tokens` (o1/o3 and openai SDK v5+) in
  addition to the legacy `max_tokens`.
- Anthropic streaming TTFT is now recorded on the first content token
  (`content_block_start` / `content_block_delta`) rather than the `message_start`
  metadata event, which under-reported time-to-first-token.
- Vercel adapter `maxTokens` mapping now prefers v7's `maxOutputTokens` over the
  legacy `maxTokens` alias.

### Changed
- Widened peer ranges: `openai` `^4 || ^5 || ^6`, `@anthropic-ai/sdk` `>=0.30 <1`.
- `src/version.ts` is now generated from `package.json#version` by
  `scripts/sync-version.mjs` (runs on `prebuild` / `pretest`) instead of being
  hand-synced.
- Internal: per-call metadata resolution (`resolveParams`) now keys off the
  non-enumerable symbol brand set by `withMetadata` instead of structural
  `{ params, options }` key-matching, so a native provider params object can no
  longer be misread as a metadata wrapper. Removed the vestigial `WithMetadata`
  wrapper type from adapter signatures.

### Removed
- **Breaking:** removed the `generationSanitizer` hook and the `GenerationSanitizer`
  type from `ClientConfig`. It only sanitized generation spans, silently leaving
  agent, tool, and embedding span content unredacted — a false-confidence gap.
  Redaction is now purely OpenTelemetry-native: use `contentCaptureMode`
  (`metadata_only` / `no_tool_content`) for coarse cross-span control, and a
  redacting `SpanProcessor` at bootstrap for fine-grained scrubbing of any span
  before export. See `docs/exporting.md`.

## [0.1.10] - 2026-07-10

### Changed
- Vercel AI SDK adapter targets AI SDK v7 (`ai ^7.0.0`): callback renames
  (`onFinish`→`onEnd`, `experimental_onStepStart`→`onStepStart`, etc.) and the
  v7 event shapes. Added `generateObjectHooks` for instrumenting
  `generateObject` calls. The adapter still duck-types the legacy v5/v6 field
  names so it tolerates older shapes.

## [0.1.8] - 2026-07-01

### Fixed
- Streaming adapters no longer let a telemetry-finalization error surface into
  the consumer's `for await` loop. `wrapProviderStream` now swallows errors
  thrown by its `onComplete` / `onError` / `onAbandoned` callbacks (e.g. an
  exporter flush failure inside `recorder.end()`), so instrumentation can never
  break the user's OpenAI / Anthropic stream. Early stream termination
  (consumer `break`) now routes to `onAbandoned` rather than being recorded as
  a clean completion.
- LangChain callback handlers wrap every `recorder.end()` in a guard so an
  export error can't reject the user's `invoke` / `stream` call.
- `instrumentedChatCompletion` (OpenAI) now throws `ValidationError` when called
  with `stream: true` instead of returning a value that violates its declared
  `Promise<ChatCompletion>` return type. Use `wrapOpenAI` for streaming.

### Changed
- `instrumentedMessageCreate` (Anthropic) now accepts `withMetadata(...)`-wrapped
  params for parity with the OpenAI helper.
- Internal: collapsed three duplicate `identityFields` wrappers onto the shared
  `identityFieldsFromOptions`; `VercelAdapterOptions` is now an alias of
  `AdapterCallOptions`; per-call metadata uses a module-local `Symbol` instead
  of `Symbol.for` to avoid cross-version collisions. No public API change.

### Added
- `test/invariants.test.ts` enforces two design invariants in CI: the core
  (`src/` outside `bootstrap/`) imports nothing from `@opentelemetry/sdk-*`,
  the OTLP exporters, or `@opentelemetry/resources`; and `src/version.ts`
  `VERSION` matches `package.json` `version`.
- `SECURITY.md` with a private vulnerability-reporting policy; `repository`,
  `homepage`, `bugs`, `author`, and `keywords` fields on `package.json`.

### Docs
- Corrected the metric count (4 to 5 histograms) and added the
  `gen_ai.client.tool_execution.duration` row across the README, blueprint, and
  semconv-mapping docs. Updated the blueprint's framework-adapter scope. Added a
  contributor-agreement section to `CONTRIBUTING.md`.

## [0.1.7] - 2026-06-25

### Changed
- Agent spans now emit the standard structured content attributes
  `gen_ai.input.messages` / `gen_ai.output.messages` instead of the custom
  `genai.agent.task` / `genai.agent.output`. Agent input is supplied as
  `AgentInvocationStart.input: Message[]` and output via
  `recorder.setOutput(messages: Message[])` (message-native; no scalar
  fallback). Content reuses the generation size/truncation policy via the new
  `emitAgentContent` sink.
- LangChain adapter wraps chain output into an assistant message before
  `setOutput`.

### Added
- `gen_ai.provider.name` and `gen_ai.request.model` on `invoke_agent` and
  `create_agent` spans, sourced from new optional `requestProvider` /
  `requestModel` seed fields. Closes the OTel-required `gen_ai.provider.name`
  gap on `create_agent` spans.

### Removed
- `genai.agent.task` / `genai.agent.output` attributes and the `task` scalar
  field on `AgentInvocationStart`.

### Fixed
- Blank agent name now yields the bare span name `invoke_agent` /
  `create_agent` (matching the semconv) instead of `... unknown`.

### Docs
- Removed stale span-events / `BlobStore` offload documentation; documented the
  current structured-attribute content capture in `docs/semconv-mapping.md` and
  `docs/blueprint.md`.

## [0.1.6] - 2026-06-17

### Changed
- Version bump to catch up with missed `0.1.5` increment.

## [0.1.5] - 2026-06-17

### Changed
- Vercel AI SDK adapter: replaced `LanguageModel` provider middleware with
  `streamTextHooks` / `generateTextHooks` spread into `streamText` /
  `generateText` params.  Supports per-step generation spans, TTFT on the first
  text-delta, and discrete `execute_tool` spans via the
  `experimental_onToolCall*` callbacks.  An `onStepFinish`-only fallback is
  provided for `ToolLoopAgent`.
- `mapAiUsage` moved and extended in `_model.ts` to cover cache and reasoning
  token fields.
- Reasoning content is now mapped to assistant thinking parts in
  input/output messages.
- Open tool recorders are reused in the `onStepFinish` fallback so an
  unmatched `onToolCallStart` neither leaks nor double-records.

### Removed
- `middleware.ts` and its test suite replaced by `hooks.ts`.

## [0.1.4]

### Added
- `RecorderBase.withActiveContext(fn)` runs `fn` with the recorder's span
  installed as the active OTel span (without ending the recorder). This lets
  callers open an agent span with the fluent `invokeAgent(seed)` variant, kick
  off a streaming turn so its per-step generation spans nest under the agent
  span, and end the recorder later from the stream's onFinish/onError.

### Fixed
- `wrapStreamText` (Vercel AI SDK adapter) now returns the real
  `StreamTextResult` instead of a Proxy that broke the AI SDK contract.
  Properties (`textStream`, `usage`, etc.) are now synchronous as the AI SDK
  documents.
- OpenAI / Anthropic streaming wrappers no longer leak spans when the
  consumer never iterates the returned stream. A watchdog timer (default 10
  minutes, `.unref()`'d) ends the recorder if the stream is abandoned.
- OpenAI / Anthropic streaming wrappers now preserve provider-specific stream
  methods (`tee`, `toReadableStream`, `controller`, ...) by returning a Proxy
  that forwards unknown properties.
- `recordTimeToFirstToken` and `recordToolCalls` now include
  `gen_ai.operation.name` on the recorded labels per spec.
- `flush(timeoutMs)` now rejects with a `FlushTimeoutError` when the deadline
  expires; the timeout handle is `.unref()`'d so it does not keep the event
  loop alive.
- `startActiveSpan` callers now reject the wrapping promise if the tracer
  throws synchronously (previously the promise hung forever).

### Changed
- Tool execution duration moved to a dedicated histogram
  `gen_ai.client.tool_execution.duration` so `gen_ai.tool.name` cardinality
  no longer pollutes the shared `gen_ai.client.operation.duration`.
- `gen_ai.parent_generation_ids` renamed to `genai.parent_generation_ids` to
  match the project's namespace convention for library-specific extensions.
- Content events now use spec-compliant names (`gen_ai.user.message`,
  `gen_ai.assistant.message`, `gen_ai.tool.message`, `gen_ai.system.message`,
  `gen_ai.choice`) with the payload under `genai.content.body`.
- `bootstrapOtel` is idempotent: it no longer overwrites an
  already-registered TracerProvider / MeterProvider unless `force: true` is
  passed. The redundant `trace.setGlobalTracerProvider` call after
  `tracerProvider.register()` was removed.
- `Client` passes the library version to `trace.getTracer(name, version)` and
  `metrics.getMeter(name, version)` so backends can filter by SDK version.

### Removed
- `EnqueueError` was unused and has been removed.
- Dead `includeContent` flag in the tool execution recorder.

### Added
- `@opentelemetry/sdk-trace-base` is now declared in `peerDependencies`.
- `FlushTimeoutError` is exported from the package root.
- `captureNestedChains` option on the LangChain callback handler — emits a
  per-node `invoke_agent` span when set to `true`.
- Repo housekeeping: `prepack` script, `packageManager` field, expanded
  `.gitignore`, and this changelog.

## [0.1.0] - 2026-05-27

Initial pre-release.
