# Framework integrations

`@genai-otel/core` ships first-party adapters for the most common TypeScript LLM SDKs and frameworks. Each adapter lives at its own subpath export so you only pay for what you import.

| Adapter | Subpath | Peer dep |
|---|---|---|
| Vercel AI SDK | `@genai-otel/core/vercel-ai-sdk` | `ai` ^7.0.0 |
| OpenAI SDK | `@genai-otel/core/openai` | `openai` ^4 / ^5 / ^6 |
| Anthropic SDK | `@genai-otel/core/anthropic` | `@anthropic-ai/sdk` >=0.30 <1 |
| LangChain.js | `@genai-otel/core/langchain` | `@langchain/core` ^0.3.0 |

All peer deps are declared optional — the core install does not pull them in.

## Content capture

Every adapter captures prompt and completion **content** — the input and output
messages — as structured `gen_ai.input.messages` / `gen_ai.output.messages` span
attributes. This is ON by default (client default mode `no_tool_content`:
prompts and completions are captured; tool args/results are stripped).

Control it globally on the `Client` (`contentCaptureMode`), per call (the
`contentCapture` option accepted by every adapter), or ambiently
(`withContentCaptureMode`). Modes: `full` (all content incl. tool args/results),
`no_tool_content` (default), `metadata_only` (no content at all — honored by
every span type: generation, agent, tool, embedding). For fine-grained,
field-level redaction, register a redacting `SpanProcessor` at bootstrap — see
[exporting.md](exporting.md#redacting-content).

### Adapter capability matrix

| Capability | Vercel | OpenAI | Anthropic | LangChain |
|---|---|---|---|---|
| input / output messages | yes | yes | yes | yes |
| separate `execute_tool` spans | yes | no (tool calls ride on messages) | no (tool calls ride on messages) | yes |
| TTFT on streaming | yes | yes | yes | yes (`handleLLMNewToken`) |
| per-call metadata | hooks / options | `withMetadata` | `withMetadata` | handler options |
| `invoke_agent` spans | via hooks | — | — | via chains |

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

`options.emitOperationSpan` (`boolean | (event) => boolean`, default `true`) controls whether the `invoke_agent` operation span wraps the steps. Correlation across concurrent calls uses the AI SDK `callId` on every lifecycle event; span parenting composes `RecorderBase.withActiveContext`. Model-call failures are attributed to the owning operation via `executeLanguageModelCall` (the only error signal carrying a `callId`).

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

const result = await instrumentedChatCompletion(client, openai, { /* params */ });
```

### Streaming behavior

`wrapOpenAI` detects `{ stream: true }` automatically. The returned async iterator yields each `ChatCompletionChunk` to the consumer; the adapter observes them in-band to record TTFT (first chunk), final model + id (latest chunk values), and final usage (sent by OpenAI in the last chunk when `stream_options: { include_usage: true }` is set — without it the duration histogram still fires correctly, token usage is just zero).

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
| `handleLLMEnd` | `recorder.setResult({ usage, stopReason, responseId, output })`; `recorder.end()` |
| `handleLLMError` | `recorder.setCallError(err)`; `recorder.end()` |
| `handleToolStart` | `client.startToolExecution({ toolName })`; `recorder.setResult({ arguments })` |
| `handleToolEnd` | `recorder.setResult({ result })`; `recorder.end()` |
| `handleToolError` | `recorder.setExecError(err)`; `recorder.end()` |
| `handleChainStart` (top-level only) | `client.invokeAgent({ agentName })` + input messages from `chainInputToMessages(inputs)` |
| `handleChainEnd` | `recorder.setOutput(chainOutputToMessages(output))`; `recorder.end()` |
| `handleChainError` | `recorder.setError(err)`; `recorder.end()` |
| `handleRetrieverStart` / `End` / `Error` | no span yet — records the `runId → parentRunId` edge only, so spans beneath a retriever still parent under the agent |

All spans nest into one trace: an `invoke_agent` root with `chat` / `execute_tool` spans beneath it. Runs with no span of their own (suppressed nested chains, retrievers) stay in the run tree as pass-through nodes so their descendants still parent under the nearest real ancestor.

Retrievers are a pass-through only because this library has no retrieval recorder yet — the semconv does define a `retrieval` span. Until it lands, an LLM call made inside a retriever parents directly under `invoke_agent`.

The `invoke_agent` span carries the chain's input as `gen_ai.input.messages`: a `messages` array uses the `BaseMessage` mapping, a string or a string `input` / `question` / `text` field becomes one user message, any other shape is JSON-encoded, and empty input emits nothing.

Options: `captureChains: false` skips chain instrumentation (LLM + tool spans only); `captureNestedChains: true` turns each nested chain / LangGraph node into its own `invoke_agent` span (off by default so the trace stays focused on the outermost graph invocation); `contentCapture`, `turnIndex`, and `turnRole` mirror the other adapters. When a single handler instance is reused across many requests, call `await handler.dispose()` on shutdown to end any runs whose end/error callback never fired (abandoned streams, runner exceptions) — this prevents leaked spans and unbounded internal map growth.

### LangGraph

The LangChain adapter works for LangGraph too — LangGraph reuses LangChain's callback system. Just register the same handler:

```ts
await graph.invoke(input, {
  callbacks: [handler],
  configurable: { thread_id: 'session-42' },
});
```

The top-level graph invocation is the `invoke_agent` span, and the `chat` / `execute_tool` spans nest under it as one connected trace.

When you run a graph with a checkpointer you pass a `thread_id` in `configurable`; the handler reads it from the run metadata and sets `gen_ai.conversation.id` on every span in the run, so all turns of a persisted conversation share one id. A user-provided id wins over `thread_id`; precedence is the handler `conversationId`, then `withConversationId(...)`, then `thread_id`.

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
- OpenAI Agents SDK (`@openai/agents`).
- Mastra.
