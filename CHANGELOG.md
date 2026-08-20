# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- LangChain adapter: map LangGraph's `thread_id` (from `config.configurable`) to
  `gen_ai.conversation.id` on every span in the run, so the turns of a
  multi-turn or checkpointed graph share one id. A user-provided id wins:
  precedence is the handler `conversationId`, then `withConversationId(...)`,
  then `thread_id`.
- OpenTelemetry-native LangChain instrumentation (`LangChainInstrumentation`):
  register it via `registerInstrumentations(...)` and every chain / LLM / tool
  run is traced with no per-call wiring. CJS auto-patches zero-config (the hook
  targets `@langchain/core/dist/callbacks/manager.cjs`, leaving the ESM module
  graph untouched); ESM apps call `manuallyInstrument(...)`. Supports
  `@langchain/core` `>=0.3.0 <2` (peer dep `^0.3.0 || ^1.0.0`).

### Changed
- Minimum supported Node.js is now 22 (`engines.node: ">=22"`, was `">=20"`).
  Node 20 reached end-of-life on 2026-04-30 and no longer receives upstream
  security patches. CI now tests Node 22 (Maintenance LTS) and 24 (Active LTS),
  replacing the previous 20/22 matrix.

### Fixed
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
  semconv-mapping docs. Removed private design-doc links and un-staled the
  blueprint's framework-adapter scope. Added a contributor-agreement placeholder
  to `CONTRIBUTING.md` (pending OSPO).

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
