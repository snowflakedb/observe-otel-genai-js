# Framework integrations

`@genai-otel/core` ships first-party adapters for the most common TypeScript LLM SDKs and frameworks. Each adapter lives at its own subpath export so you only pay for what you import.

| Adapter | Subpath | Peer dep |
|---|---|---|
| Vercel AI SDK | `@genai-otel/core/vercel-ai-sdk` | `ai` ^7.0.0 |
| OpenAI SDK | `@genai-otel/core/openai` | `openai` ^4 / ^5 / ^6 / ^7 |
| OpenAI SDK (auto) | `@genai-otel/core/openai/instrumentation` | `openai` ^4 / ^5 / ^6 / ^7 |
| Anthropic SDK | `@genai-otel/core/anthropic` | `@anthropic-ai/sdk` >=0.30 <1 |
| Claude Agent SDK | `@genai-otel/core/claude-agent-sdk/instrumentation`, or `/claude-agent-sdk` for `wrapQuery` | none declared; works with `@anthropic-ai/claude-agent-sdk` >=0.3.142 <0.4.0 |
| LangChain.js | `@genai-otel/core/langchain` | `@langchain/core` ^0.3.0 |

All peer deps are declared optional — the core install does not pull them in.

## Content capture

Every adapter captures prompt and completion **content** — the input and output
messages — as structured `gen_ai.input.messages` / `gen_ai.output.messages` span
attributes. This is ON by default (client default mode `no_tool_content`:
prompts and completions are captured; tool args/results and retrieval
query/documents are stripped).

Control it globally on the `Client` (`contentCaptureMode`), per call (the
`contentCapture` option accepted by every adapter), or ambiently
(`withContentCaptureMode`). Modes: `full` (all content incl. tool args/results
and retrieval query/documents), `no_tool_content` (default — tool payloads and
retrieval content stripped), `metadata_only` (no content at all — honored by
every span type: generation, agent, tool, embedding, retrieval). For
fine-grained, field-level redaction, register a redacting `SpanProcessor` at
bootstrap — see [exporting.md](exporting.md#redacting-content).

### Adapter capability matrix

| Capability | Vercel | OpenAI | OpenAI Agents | Anthropic | LangChain | Claude Agent SDK |
|---|---|---|---|---|---|---|
| input / output messages | yes | yes | yes | yes | yes | yes (reconstructed from the message stream) |
| tool definitions (`gen_ai.tool.definitions`) | — | yes (Responses) | — | — | yes | — |
| request params (`temperature`, `top_p`, …) | yes | yes | — | yes | — | partial (system prompt, effort, thinking) |
| separate `execute_tool` spans | yes | no (tool calls ride on messages) | yes | no (tool calls ride on messages) | yes | yes |
| TTFT on streaming | yes | yes | — | yes | yes (`handleLLMNewToken`) | yes (with `includePartialMessages`) |
| per-call metadata | hooks / options | `withMetadata` | `Trace.metadata` / `groupId` | `withMetadata` | handler options | instrumentation config, or `wrapQuery` options |
| `invoke_agent` spans | via hooks | — | yes | — | via chains | yes |
| nested `invoke_agent` for subagents | — | — | yes (agents used as tools) | — | — | yes |
| OTel auto-instrumentation | — | yes | — | — | yes | yes |

## Vercel AI SDK

Wraps `generateText`, `streamText`, `generateObject`, `embed`, `embedMany` so each call runs inside a `@genai-otel/core` recorder. Maps `usage`, `finishReason`, `response.id` / `response.modelId`, and the input/output messages onto the standard `Generation` shape.

```ts
import { Client } from '@genai-otel/core';
import { wrapGenerateText, wrapStreamText } from '@genai-otel/core/vercel-ai-sdk';
import { openai } from '@ai-sdk/openai';

const client = new Client();

const result = await wrapGenerateText(
  client,
  { model: openai('gpt-4o'), prompt: 'What is OpenTelemetry?' },
  { agentName: 'demo', conversationId: 'conv-1' },
);
console.log(result.text);

const stream = wrapStreamText(client, { model: openai('gpt-4o'), prompt: 'Stream me.' });
for await (const chunk of await stream.textStream) {
  process.stdout.write(chunk);
}
```

`wrapStreamText` records TTFT via the AI SDK's `onChunk` hook and final usage via `onEnd` (v7's rename of v6's `onFinish`).

### Telemetry integration (recommended)

`genaiTelemetryIntegration(client, options?)` is an AI SDK v7 `Telemetry` integration. Register it once via `registerTelemetry(...)` and every `generateText` / `streamText` / `ToolLoopAgent` / `generateObject` call in the process emits genai-otel spans (`invoke_agent` → `chat` → `execute_tool`) — no per-call-site wiring, and it handles streaming agents automatically (the `invoke_agent` span opens on operation start and closes on completion). Per-turn identity is derived from each operation's `functionId` + `runtimeContext` via `options.deriveOptions`; expose the fields you need with `telemetry.includeRuntimeContext`.

```ts
import { registerTelemetry } from 'ai';
import { genaiTelemetryIntegration } from '@genai-otel/core/vercel-ai-sdk';

registerTelemetry(
  genaiTelemetryIntegration(client, {
    deriveOptions: (event) => {
      const rc = (event.runtimeContext ?? {}) as Record<string, unknown>;
      return { agentName: event.functionId ?? 'agent', userId: rc.userId as string | undefined };
    },
  }),
);

// Thereafter, plain calls are instrumented:
await generateObject({ model: openai('gpt-4o'), schema, system, messages, telemetry: { functionId: 'query-card' } });
```

`options.emitOperationSpan` (`boolean | (event) => boolean`, default `true`) controls whether the `invoke_agent` operation span wraps the steps. Correlation across concurrent calls uses the AI SDK `callId` on every lifecycle event; span parenting composes `RecorderBase.withActiveContext`. Model-call failures are attributed to the owning operation via `executeLanguageModelCall` (the only error signal carrying a `callId`). Tool bodies run under the matching `execute_tool` span via `executeTool`, so auto-instrumented HTTP (and nested `generateText`) inside a tool parent under that span rather than an ambient ancestor.

## OpenAI SDK

Two ways to use it. The proxy variant is one-line.

```ts
import OpenAI from 'openai';
import { Client } from '@genai-otel/core';
import { wrapOpenAI, withMetadata } from '@genai-otel/core/openai';

const client = new Client();
const openai = wrapOpenAI(client, new OpenAI());

// Same API as the OpenAI SDK — every call is instrumented automatically.
await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
});

// Attach per-call metadata via withMetadata (non-enumerable symbol so OpenAI's
// strict params validation never sees it).
await openai.chat.completions.create(
  withMetadata(
    { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    { agentName: 'planner', conversationId: 'conv-1', turnIndex: 0, turnRole: 'assistant' },
  ),
);
```

Per-method helpers are available too:

```ts
import {
  instrumentedChatCompletion,
  instrumentedEmbedding,
} from '@genai-otel/core/openai';

// Pass a plain client. A wrapped one would trace each request twice.
const result = await instrumentedChatCompletion(client, new OpenAI(), { /* params */ });
```

Use the helpers on their own. Combined with `wrapOpenAI` or
`OpenAIInstrumentation`, each request is traced twice.

### Auto-instrumentation

`OpenAIInstrumentation` is the OpenTelemetry-native alternative to `wrapOpenAI`.
It patches the SDK's prototypes so every OpenAI call in the process is traced
without wrapping a client:

```ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OpenAIInstrumentation } from '@genai-otel/core/openai/instrumentation';

registerInstrumentations({
  instrumentations: [new OpenAIInstrumentation({ agentName: 'planner' })],
});
```

Config accepts every per-call metadata field the adapter does. Values you set here
become process-wide defaults, and `withMetadata` still overrides them per call.
Covers `chat.completions.create`, `responses.create`, and `embeddings.create`.

With this installed you no longer need `wrapOpenAI`. Leaving it in place is fine:
`wrapOpenAI` sees the patched method and passes the call through, metadata
included, so each request still produces one span.

#### When another library instruments `openai` too

`@opentelemetry/instrumentation-openai` patches the same three prototypes, and
`@opentelemetry/auto-instrumentations-node` enables it by default, so the two do
meet in practice. Whichever patches first wins; the other one defers and logs at
`warn`. You get a single span per call either way. When the other library wins, its
span carries neither this library's Responses mapping nor the
`gen_ai.conversation.id` / `gen_ai.agent.name` that the Agents integration bridges
onto model calls, so turn one of them off.

```ts
// keep this library's spans: turn the other one off
getNodeAutoInstrumentations({
  '@opentelemetry/instrumentation-openai': { enabled: false },
});
```

```bash
# or by environment, either direction. Both take a package-name *suffix*.
OTEL_NODE_DISABLED_INSTRUMENTATIONS=openai   # deny-list: everything else stays on
OTEL_NODE_ENABLED_INSTRUMENTATIONS=http,pg   # allow-list: anything unlisted is off
```

`OTEL_NODE_DISABLED_INSTRUMENTATIONS` prepends `@opentelemetry/instrumentation-`
for you, so the value is `openai`. Pass the full package name and it matches
nothing and disables nothing; the only trace of the mistake is a
`Provided instrumentation name ... not found` line logged at `error` level, which
most setups never surface. The programmatic form above does take the full name.

All three levers work whether you call `getNodeAutoInstrumentations()` yourself or
preload `@opentelemetry/auto-instrumentations-node/register`. The register entry
point goes through the same helper, so only the environment variables reach it.

Version resolution can split the decision in two. `@opentelemetry/instrumentation-openai`
declares `openai` `>=4.19.0 <7`, while `@openai/agents-core` depends on `openai ^7`,
and those usually resolve to two separate copies. The other library then takes your
application's own v6 calls while this one takes the v7 copy the Agents SDK drives.
Turning one off removes the ambiguity.

Works under CommonJS with no extra setup, and under ESM with the standard OTel
loader hook (`node --import` a preload that calls
`register('@opentelemetry/instrumentation/hook.mjs', ...)`). If you cannot enable
the loader, hand the module namespace over once at startup:

```ts
import * as OpenAIModule from 'openai';
instrumentation.manuallyInstrument(OpenAIModule);
```

The patch reaches all three resource prototypes through the `OpenAI` client
class's own statics (`OpenAI.Chat.Completions`, `OpenAI.Responses`,
`OpenAI.Embeddings`), which are the same class objects backing a live client's
resources. So there are no dist file paths to drift, and behavior is identical in
both module systems.

### Responses API

`responses.create` is mapped alongside Chat Completions, with two differences:

- `instructions` becomes `gen_ai.system_instructions`. Responses carries the system
  prompt out-of-band, so it never appears as a message in the history.
- Tool definitions are read from the top level of each tool (`name`, `description`,
  `parameters`) instead of from a nested `function` object.

Usage maps `input_tokens_details.cached_tokens` and
`output_tokens_details.reasoning_tokens` onto the cache-read and reasoning
counters. Streaming records TTFT from the first `*.delta` event and takes the
final output and usage from the assembled `Response` on `response.completed`.

### Streaming behavior

`wrapOpenAI` detects `{ stream: true }` automatically. The returned async iterator yields each `ChatCompletionChunk` to the consumer; the adapter observes them in-band to record TTFT (first chunk), final model + id (latest chunk values), and final usage (sent by OpenAI in the last chunk when `stream_options: { include_usage: true }` is set — without it the duration histogram still fires correctly, token usage is just zero).

## OpenAI Agents SDK

The Agents SDK reports its work to trace processors. Register this integration's
processor with the SDK's own API:

```ts
import { addTraceProcessor, getCurrentTrace } from '@openai/agents';
import { GenAIOtelTracingProcessor } from '@genai-otel/core/openai-agents';

const processor = new GenAIOtelTracingProcessor({ getCurrentTrace });
addTraceProcessor(processor);
```

Register `OpenAIInstrumentation` too: on the default OpenAI model paths the `chat`
spans come from there.

### What gets a span

| SDK span type | OTel span |
|---|---|
| trace | run container named after the trace, with operation `invoke_agent` (see below) |
| `agent` | `invoke_agent <name>` |
| `function` | `execute_tool <name>` |
| `generation` on the AI SDK path (`aisdk(model)`) | `chat <model>` |
| `generation` / `response` on the OpenAI paths | none; `OpenAIInstrumentation` emits the `chat` span |
| `task`, `turn` | none; their errors are recorded on the enclosing span |
| `handoff` | none; the next `invoke_agent` span is the handoff |
| `guardrail`, `custom`, `mcp_tools`, `speech`, `transcription`, `speech_group` | none |

The rows marked none that are not model calls have no operation in the conventions.
Model calls on the OpenAI paths are left to `OpenAIInstrumentation` because it sees
the HTTP call, including time-to-first-token and `server.address`, and emitting from
both layers would count every call twice. On the AI SDK path nothing else sees the
call, so this integration emits the span. It records it when the model call
finishes, so spans the provider client creates during the call sit beside it under
`invoke_agent`.

The SDK keeps no OTel context active between its span callbacks, so a processor on
its own cannot make spans from other instrumentations, such as an OpenAI `chat`
span, nest under the agent span. That needs the SDK's model classes patched.

Not emitted:

- `create_agent`: the SDK reports nothing when an `Agent` is constructed.
- `gen_ai.tool.call.id`: the SDK's tool span carries no call id. It could only be
  guessed by matching tool names and arguments, which fails for parallel calls to
  the same tool.
- `gen_ai.tool.definitions`: the SDK reports tool names only.

Tools served by an MCP server get `gen_ai.tool.type = mcp`; other tools get
`function`.

### Agent input and output

Under content capture, `invoke_agent` spans carry `gen_ai.input.messages` from the
agent's first model call and `gen_ai.output.messages` from its last. On the AI SDK
path, the agent's instructions go to `gen_ai.system_instructions` on the `chat`
span, the same attribute the OpenAI paths use.

These messages come from the SDK's own trace data. With the SDK's
`traceIncludeSensitiveData: false`, AI SDK `chat` spans carry no messages or token
counts, and agent spans on the AI SDK and Chat Completions paths carry no messages,
whatever content capture is set to. The default Responses path still reports its
input and output to trace processors, so agent spans there keep their messages.

### The run container span

Every run gets a container span, named after the trace (`RunConfig.workflowName`,
or the SDK's default `Agent workflow`), with `gen_ai.operation.name` set to
`invoke_agent`. It looks the same whether the run uses one agent or hands off
between several, which matches the Python OpenTelemetry instrumentation for this
SDK. The agents themselves get their own `invoke_agent <name>` spans beneath it.

The conventions suggest `invoke_workflow` for multi-agent runs. This integration does
not emit it: telling the two kinds of run apart is only possible once the run is
over, and one shape for every run is simpler to query.

A run resumed after a tool approval gets a container span of its own, with the
same name and conversation id as the first part of the run. A run resumed from a
serialized state (`RunState.fromString`) gets a normal trace start and end from the
SDK. A run resumed in the same process from `result.state` gets neither, so its
container closes when the resumed run's `task` span ends. This needs the SDK's
`getCurrentTrace` passed in, as above.

With `tracing: { includeTaskAndTurnSpans: false }` the SDK sends no `task` or
`turn` spans, so a turn's error is not copied to its agent span, and a resumed run's
container stays open until the trace cap or `stop()` ends it.

The container carries `gen_ai.conversation.id` from `Trace.groupId` and
`Trace.metadata` as `genai.metadata.*`. Set them on the `Runner`, since the options
passed to `run()` do not carry them:

```ts
const runner = new Runner({
  workflowName: 'triage-workflow',   // becomes the container span's name
  groupId: 'chat-thread-1',          // becomes gen_ai.conversation.id
  traceMetadata: { tenant: 'acme' }, // becomes genai.metadata.tenant
});
```

### Errors

- A model call the SDK retries successfully does not fail the agent span.
- `error.type` is the error's class name when it looks like one (`BoomError`,
  `InputGuardrailTripwireTriggered`); otherwise the span's own category, such as
  `tool_execution_error`, or `_OTHER` on the container. Free-form error text never
  becomes a metric label.
- The SDK skips `trace.end()` when a run rejects. A processor cannot see that
  rejection, so the container stays open until the trace cap or `stop()` ends it.

Guardrails get no span of their own: `GuardrailSpanData` carries only
`{ name, triggered }`. A tripwire shows up as the `error.type` above.

Open traces are capped at 1000 (`maxTracesInFlight`). Past that, the least recently
active one is ended with the data it has.

### Metrics

- `gen_ai.client.operation.duration` for agent spans and AI SDK `chat` spans.
- `gen_ai.client.tool_execution.duration` for tool spans.
- `gen_ai.client.token.usage` from `chat` spans only, so totals are not counted
  twice.

`gen_ai.client.tool_execution.duration` is this library's name, shared by all its
integrations; the in-development conventions define `gen_ai.execute_tool.duration`.
The run container records no duration metric.

On the AI SDK path the SDK does not report why the model stopped, so `chat` spans
report `tool_call` when the model asked for a tool and otherwise the default `stop`.

### Tests under `NODE_ENV=test`

The SDK turns tracing off when `NODE_ENV === 'test'`. Turn it back on before each
test, since the switch is process-wide:

```ts
import { setTracingDisabled } from '@openai/agents';

beforeEach(() => setTracingDisabled(false));
```

### Supported versions

`@openai/agents` `>=0.14.0 <1`, tested against 0.17. The floor is 0.14 because error
routing relies on its `task` and `turn` spans.

### Shutdown

The SDK calls a processor's `shutdown()` when it replaces its processor list and on
process signals, so `shutdown()` only flushes. Call `await processor.stop()` to end
every open span and flush.

## Anthropic SDK

Same shape as the OpenAI adapter, with mappings for Anthropic-specific fields:

- `usage.cache_creation_input_tokens` → `gen_ai.usage.cache_creation.input_tokens`
- `usage.cache_read_input_tokens` → `gen_ai.usage.cache_read.input_tokens`
- `stop_reason` → `gen_ai.response.finish_reasons`
- `content[*]` blocks (text/thinking/tool_use/tool_result) → structured `gen_ai.input.messages` / `gen_ai.output.messages` attributes

```ts
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@genai-otel/core';
import { wrapAnthropic, withMetadata } from '@genai-otel/core/anthropic';

const client = new Client();
const anthropic = wrapAnthropic(client, new Anthropic());

await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'hi' }],
});

// With metadata:
await anthropic.messages.create(
  withMetadata(
    {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    },
    { agentName: 'responder', conversationId: 'conv-1' },
  ),
);
```

### Streaming behavior

`wrapAnthropic` handles streaming via Anthropic's typed event stream:
- `message_start` → captures `id`, `model`, initial `input_tokens`.
- First `content_block_delta` → records `setFirstTokenAt`.
- `message_delta` → final `stop_reason` and final `output_tokens`.

## LangChain.js

LangChain uses a callback-handler pattern. `GenAIOtelCallbackHandler` implements `BaseCallbackHandler` and translates LangChain's run lifecycle into our recorders.

```ts
import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { Client } from '@genai-otel/core';
import { GenAIOtelCallbackHandler } from '@genai-otel/core/langchain';

const client = new Client();
const handler = new GenAIOtelCallbackHandler({
  client,
  agentName: 'support-bot',
  conversationId: 'conv-1',
});

const llm = new ChatOpenAI({ model: 'gpt-4o' });
const prompt = ChatPromptTemplate.fromTemplate('Answer: {q}');
const chain = prompt.pipe(llm);

await chain.invoke({ q: 'what is otel?' }, { callbacks: [handler] });
```

### What gets recorded

| LangChain event | Recorder action |
|---|---|
| `handleLLMStart` (raw completions / chat fallback) | `client.startGeneration({ model, ... })` + input messages from the prompt strings |
| `handleChatModelStart` (chat models) | `client.startGeneration(...)` + structured input messages (real roles) from `BaseMessage[]` |
| `handleLLMNewToken` (first non-empty) | `recorder.setFirstTokenAt(now)` |
| `handleLLMEnd` | `recorder.setResult({ usage, stopReason, responseId, responseModel, output })`; `recorder.end()` |
| `handleLLMError` | `recorder.setCallError(err)`; `recorder.end()` |
| `handleToolStart` | `client.startToolExecution({ toolName })` (the run's `runName`, else the serialized class name); `recorder.setResult({ arguments })` |
| `handleToolEnd` | `recorder.setToolName(...)` (the authoritative tool name from the `ToolMessage`, overriding `runName`), `recorder.setResult({ result })`; `recorder.end()` |
| `handleToolError` | `recorder.setExecError(err)`; `recorder.end()` |
| `handleChainStart` (top-level only) | `client.invokeAgent({ agentName })` + input messages from `chainInputToMessages(inputs)` |
| `handleChainEnd` | `recorder.setOutput(chainOutputToMessages(output))`; `recorder.end()` |
| `handleChainError` | `recorder.setError(err)`; `recorder.end()` |
| `handleRetrieverStart` | `client.startRetrieval({ dataSourceId, topK?, queryText })` — the retrieval span becomes the active parent |
| `handleRetrieverEnd` | `recorder.setDocuments(mapRetrieverDocuments(documents))`; `recorder.end()` |
| `handleRetrieverError` | `recorder.setCallError(err)`; `recorder.end()` |

All spans nest into one trace: an `invoke_agent` root with `chat` / `execute_tool` / `retrieval` spans beneath it. Runs with no span of their own (suppressed nested chains) stay in the run tree as pass-through nodes so their descendants still parent under the nearest real ancestor.

Retrievers emit a `retrieval` span (kind CLIENT); an in-retriever query rewrite nests under it. Query text and documents are emitted as the Opt-In `gen_ai.retrieval.query.text` / `gen_ai.retrieval.documents`. `gen_ai.retrieval.top_k` and `gen_ai.data_source.id` are read only from the retriever's serialized config (not run metadata), so they're often absent; `gen_ai.provider.name` / `gen_ai.request.model` aren't emitted (they describe the embedding call, which LangChain doesn't surface). Pass any of these to `client.startRetrieval(...)` directly if you know them.

The `invoke_agent` span carries the chain's input as `gen_ai.input.messages`: a `messages` array uses the `BaseMessage` mapping, a string or a string `input` / `question` / `text` field becomes one user message, any other shape is JSON-encoded, and empty input emits nothing.

`chat` spans also carry `gen_ai.tool.definitions`, the model's bound tools normalized to the semconv `{ type, name, description, parameters }` shape. `type` and `name` are always emitted; `description` and `parameters` only under `full` content capture.

`gen_ai.provider.name` uses the semconv well-known values (`openai`, `anthropic`, `aws.bedrock`, `gcp.gemini`, and so on). A hosting platform wins over the vendor it hosts, so a Bedrock-hosted Anthropic model reports `aws.bedrock`.

`gen_ai.response.model` is the model that served the call — ask for `gpt-4o`, get `gpt-4o-2024-11-20`. `gen_ai.request.model` keeps the requested name.

Token usage covers `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and the prompt-cache counts `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens`.

Options: `captureChains: false` skips chain instrumentation (LLM + tool spans only); `captureNestedChains: true` turns each nested chain / LangGraph node into its own `invoke_agent` span (off by default so the trace stays focused on the outermost graph invocation); `contentCapture`, `turnIndex`, and `turnRole` mirror the other adapters. When a single handler instance is reused across many requests, call `await handler.dispose()` on shutdown to end any runs whose end/error callback never fired (abandoned streams, runner exceptions) — this prevents leaked spans and unbounded internal map growth.

### Auto-instrumentation

`LangChainInstrumentation` is a standard OpenTelemetry instrumentation. Register it and the handler is injected into every chain / LLM / tool run, including runs invoked with no callbacks. It dedupes by handler name, so also passing the handler manually does not double-instrument.

```ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { LangChainInstrumentation } from '@genai-otel/core/langchain/instrumentation';

registerInstrumentations({
  instrumentations: [new LangChainInstrumentation({ agentName: 'support-bot' })],
});
```

The config takes every `GenAIOtelCallbackHandler` option plus an optional `client`. Omit `client` and one is created from the globally-registered tracer/meter providers — register those first (e.g. via `bootstrapOtel`).

#### CommonJS

Auto-patches. Call `registerInstrumentations(...)` before the first `require('@langchain/core')`.

#### ESM

Patch manually. Call `manuallyInstrument(...)` once, before importing `@langchain/core`:

```ts
import { LangChainInstrumentation } from '@genai-otel/core/langchain/instrumentation';
import * as CallbackManagerModule from '@langchain/core/callbacks/manager';

const instrumentation = new LangChainInstrumentation({ agentName: 'support-bot' });
instrumentation.manuallyInstrument(CallbackManagerModule);
```

Also use `manuallyInstrument` wherever there is no runtime `require` to hook: bundlers that inline `@langchain/core` (Next.js, some Webpack/esbuild setups) and non-Node runtimes. Do not enable OpenTelemetry's ESM loader hook for `@langchain/core`, it breaks the library's langsmith interop.

#### Supported versions

| Package | Range |
|---|---|
| `@langchain/core` | `>=0.3.0 <2` (0.3.x, 1.x) |

#### Shutdown

`await instrumentation.shutdown()` drains runs whose end/error callback never fired, and shuts down the `Client` only if the instrumentation created it (a `client` you passed in is yours to shut down).

`disable()` removes the patch and best-effort drains the handler, but does not flush a self-created client. Prefer `shutdown()`, or rely on your `TracerProvider` shutdown to flush trailing spans.

### LangGraph

The LangChain adapter works for LangGraph too — LangGraph reuses LangChain's callback system. Just register the same handler:

```ts
await graph.invoke(input, {
  callbacks: [handler],
  configurable: { thread_id: 'session-42' },
});
```

The top-level graph invocation is the `invoke_agent` span, and the `chat` / `execute_tool` spans nest under it as one connected trace.

With a checkpointer, the `thread_id` you pass in `configurable` is read from the run metadata and set as `gen_ai.conversation.id` on every span in the run, so all turns of a persisted conversation share one id. Precedence: the handler `conversationId`, then the per-run `thread_id`.

## Claude Agent SDK

The Claude Agent SDK does not run the agent in your process. It starts the Claude
Code CLI and streams JSON messages back, so there is no model call to wrap: the
adapter rebuilds the span tree from that message stream. Your `query()` options are
passed through unchanged, and the returned `Query` keeps all its methods
(`interrupt()`, `setModel()`, …).

### Setup

Register it as an OpenTelemetry instrumentation, which needs
`@opentelemetry/instrumentation` installed. The SDK ships an ESM build only, so this
also needs the OpenTelemetry ESM loader hook, registered before your app first
imports the SDK. A preload does that:

```js
// preload.mjs
import { register } from 'node:module';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { bootstrapOtel } from '@genai-otel/core/bootstrap';
import { ClaudeAgentSdkInstrumentation } from '@genai-otel/core/claude-agent-sdk/instrumentation';

// Register the hook before the app imports the SDK.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
bootstrapOtel({ serviceName: 'my-agent' });
registerInstrumentations({
  instrumentations: [new ClaudeAgentSdkInstrumentation({ agentName: 'support-bot' })],
});
```

```bash
node --import ./preload.mjs app.mjs
```

The config takes the usual metadata (`agentName`, `conversationId`, `userId`,
`contentCapture`, …) plus an optional `client`; without one, a client is built from
the registered providers.

Without the hook, or if the SDK was imported before the hook was registered, nothing
is traced and nothing is logged. An app that loads the SDK with `require()` is not
patched either; the instrumentation logs a warning in that case. Either way, or to
avoid the hook entirely, wrap the call site instead:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { wrapQuery } from '@genai-otel/core/claude-agent-sdk';

const tracedQuery = wrapQuery(client, query, { agentName: 'support-bot' });
for await (const msg of tracedQuery({ prompt, options })) { /* ... */ }
```

A query sent through a pre-warmed `startup()` handle does not go through `query`, so
wrap `startup` the same way with `wrapStartup(client, startup, options)`. The
instrumentation patches both.

### Options worth turning on

Two SDK options are off by default. The adapter does not turn them on for you,
because both change what your own loop receives.

```ts
options: {
  forwardSubagentText: true,     // subagent model calls and their content
  includePartialMessages: true,  // exact per-call tokens, stop reasons, time to first token
}
```

Without `forwardSubagentText`, a delegation still gets its `execute_tool` span and
timing, but none of the subagent's messages reach the stream, so there is no nested
`invoke_agent` span. `includePartialMessages` is covered under tokens below.

### Span tree

Each `query()` call gets one `invoke_agent` span, and everything else hangs off it.
That span sits under whatever OpenTelemetry context you call from. Several user turns
means several `query()` calls, linked by `gen_ai.conversation.id` (the CLI session id,
unless you set `conversationId`).

```
invoke_agent <agentName>          one per query() call
  chat <model>                    one per API call
  execute_tool Read
  execute_tool Agent              the delegation tool (called Task on older CLIs)
    invoke_agent <subagent_type>  the subagent's own run
      chat <model>
      execute_tool Grep
```

- The CLI sends one assistant message per content block, so a call that returns
  thinking, text and a tool call arrives as three messages sharing a `message.id`.
  They become one `chat` span.
- Each `chat` span's input is the conversation so far, capped at the latest 40
  messages so a long tool loop does not outgrow what an exporter accepts.
- Subagents nest under the delegation that started them, matched by
  `parent_tool_use_id`, so parallel delegations stay apart.
- A task (a delegation, or `Bash` with `run_in_background`) answers its tool call
  with a launch receipt within milliseconds while the work goes on. Its span stays
  open until the CLI reports the task finished, so it covers the real work. A task
  run in the foreground reports finishing just before its real `tool_result`, which
  then closes the span with the full output. A task still running when the run ends
  is closed with its receipt, not as an error.
- The SDK's `result` messages are checkpoints: a background task can keep the run
  going past the first one. The run ends when the stream does, and its status follows
  the last result.
- Breaking out of your loop early, or calling `close()`, ends every span without
  marking an error.
- A failed API call gets a `chat` span of its own, marked with the error.

### Other attributes

- `gen_ai.provider.name` comes from the platform the CLI is told to use:
  `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_MANTLE` (`aws.bedrock`),
  `CLAUDE_CODE_USE_VERTEX` (`gcp.vertex_ai`) or `CLAUDE_CODE_USE_FOUNDRY`
  (`azure.ai.inference`). They are read from `options.env` when you set it (it
  replaces the CLI's environment), and from the process environment otherwise, and
  count as on only for `1`, `true`, `yes` or `on`, as in the CLI. Without any of
  them it is `anthropic`.
- `options.effort` becomes `gen_ai.request.reasoning.level` on the run's
  `invoke_agent` span and the main thread's `chat` spans. A string
  or custom (`{ type: 'custom', prompt }`) `options.systemPrompt` and
  `options.thinking` go on the main thread's `chat` spans only; subagents have their
  own. A preset is not recorded: the CLI renders it, and its `append` is only part of
  the prompt.
- After the CLI compacts the conversation, the run and every later `chat` span carry
  `gen_ai.conversation.compacted`. Later `chat` inputs start after the compaction:
  the summary the CLI puts in place of the earlier turns never reaches the process.
  A `/clear` likewise starts them over, and ends the compacted flag.

### Tokens, cost, and time to first token

The `invoke_agent` span carries the run totals from the latest `result.modelUsage`,
which is the only source that includes subagents, plus the cost in
`genai.usage.cost_usd`. A `/clear` mid-run resets the SDK's totals; the usage from
before it still counts toward the run. A run started with `resume` or `continue`
gets no run totals: the SDK carries the earlier session's usage into its first
result without saying how much of it there is. Each `chat` span carries its own call's figures, so summing
token attributes across every span in a trace counts them twice; use either the
`invoke_agent` span or the `chat` spans. The token metric is recorded from `chat`
spans only.

Exact per-call counts need `includePartialMessages`. Without it, a `chat` span only
has the `usage` snapshot taken as the reply starts. Its input and cache figures are
kept, its output count is left out rather than reported low, and the span is marked
`genai.usage.is_partial`. With the option on, the `message_delta` event supplies each
call's final usage, stop reason and reasoning tokens, and the `message_start` event
supplies time to first token and the real start of the call.

The SDK does not forward stream events for subagents, so their `chat` spans are
marked `is_partial`. The exception is a foreground delegation's last call: its
`tool_result` carries that call's final usage. Subagent tokens are in the run
totals either way.

Cached tokens are counted in `gen_ai.usage.input_tokens`, as the GenAI conventions
ask. The `/anthropic` adapter does not do this yet, so the two report different input
counts for the same call.

### Content capture

The standard modes apply. The default hides tool arguments and results, which here
are shell commands, file paths, file bodies and command output. A subagent's prompt
and report are the delegation tool's argument and result, so they follow the same
rule: they appear on its `invoke_agent` span, and as its first `chat` input, only
with full capture. What the subagent's model writes is a completion like any other,
so its `chat` output follows the completion rule.

## Composing with `bootstrapOtel`

Adapters work the same whether you wire OTel providers yourself or via `bootstrapOtel`:

```ts
import { Client } from '@genai-otel/core';
import { bootstrapOtel } from '@genai-otel/core/bootstrap';
import { wrapOpenAI } from '@genai-otel/core/openai';
import OpenAI from 'openai';

const { tracerProvider, meterProvider } = bootstrapOtel({ serviceName: 'my-agent' });
const client = new Client();
const openai = wrapOpenAI(client, new OpenAI());

// every call from `openai` now produces a chat span + the GenAI metrics
// shipping via OTLP/HTTP to whichever backend OTEL_EXPORTER_OTLP_ENDPOINT points at.
```

## Deferred to v2

- LangGraph-specific helpers (graph node → workflow step semantics beyond what the LangChain adapter already gives you).
- Google Gemini SDK (`@google/genai`).
- LlamaIndex.TS (`llamaindex`).
- `plan` / `invoke_workflow` / memory spans for the Claude Agent SDK. The GenAI conventions define them, but the Claude Agent SDK adapter does not emit them yet.
- Mastra.
