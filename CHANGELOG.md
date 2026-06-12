# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
