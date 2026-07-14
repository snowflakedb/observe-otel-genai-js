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

`wrapStreamText` records TTFT via the AI SDK's `onChunk` hook and final usage via `onEnd` (v7's rename of v6's `onFinish`). The lower-level `streamTextHooks` capture usage per step via `onStepEnd` instead.

### Hooks

`streamTextHooks` / `generateTextHooks` return callback bags to spread into `streamText` / `generateText`; they emit per-step generation spans (input messages, tool spans, usage) and work with `ToolLoopAgent` on v7. `generateObjectHooks` does the same for `generateObject` — spread its `onStepStart` / `onStepEnd` into the call to capture input messages (from the provider-format `promptMessages`), the raw object text output, and usage on a `generate_content` span.

```ts
import { generateObjectHooks } from '@genai-otel/core/vercel-ai-sdk';

const res = await generateObject({
  model: openai('gpt-4o'),
  schema,
  system: 'You generate query cards.',
  messages,
  ...generateObjectHooks(client, { agentName: 'query-card' }),
});
```

### Streaming agents: `agentTurn`

For a streaming agent the turn completes asynchronously after `stream()` returns, so the `invokeAgent(seed, fn)` callback form would end the `invoke_agent` span too early. `agentTurn` bundles the documented manual pattern — fluent recorder + `withActiveContext` + spread-safe hooks + an idempotent closer — into one handle. Open it in `stream()`, hold the handle, and call `end()` from the stream's `onFinish` / `onError`.

```ts
import { agentTurn } from '@genai-otel/core/vercel-ai-sdk';

const turn = agentTurn(client, { agentName: 'o11y', input: messages }, { agentName: 'o11y' });
// messages may be AI SDK ModelMessage[] (mapped internally) or genai-otel Message[].

const result = turn.run(() =>
  agent.stream({
    messages,
    onStepStart: turn.hooks.onStepStart,
    onToolExecutionStart: turn.hooks.onToolExecutionStart,
    onToolExecutionEnd: turn.hooks.onToolExecutionEnd,
    onStepEnd: turn.hooks.onStepEnd,
  }),
);

// later, from the stream's completion callbacks:
//   onFinish: () => turn.end({ output: finalText })
//   onError:  (e) => turn.end({ error: e })
```

`end()` is idempotent (first call wins; `error` beats `output`; a string `output` is wrapped via `assistantTextMessage`). The handle also supports `await using` — the turn ends on scope exit if the caller forgets. Pass the caller's own step callbacks as the fourth arg (`agentTurn(client, start, options, callerHooks)`) to compose them with telemetry. `ToolLoopAgent.stream` accepts only the step/tool callbacks — `onChunk` / `onError` are direct-`streamText` only — so wire the four explicitly rather than spreading the whole bag.

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
| `handleChainStart` (top-level only) | `client.invokeAgent({ agentName })` |
| `handleChainEnd` | `recorder.setOutput(chainOutputToMessages(output))`; `recorder.end()` |
| `handleChainError` | `recorder.setError(err)`; `recorder.end()` |

Options: `captureChains: false` skips chain instrumentation (LLM + tool spans only); `captureNestedChains: true` turns each nested chain / LangGraph node into its own `invoke_agent` span (off by default so the trace stays focused on the outermost graph invocation); `contentCapture`, `turnIndex`, and `turnRole` mirror the other adapters. When a single handler instance is reused across many requests, call `await handler.dispose()` on shutdown to end any runs whose end/error callback never fired (abandoned streams, runner exceptions) — this prevents leaked spans and unbounded internal map growth.

### LangGraph

The LangChain adapter works for LangGraph too — LangGraph reuses LangChain's callback system. Just register the same handler:

```ts
await graph.invoke(input, { callbacks: [handler] });
```

Each graph node becomes a chain run; `invokeAgent` spans naturally form the agent-level groupings.

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
