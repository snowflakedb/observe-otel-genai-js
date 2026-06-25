# Framework integrations

`@genai-otel/core` ships first-party adapters for the most common TypeScript LLM SDKs and frameworks. Each adapter lives at its own subpath export so you only pay for what you import.

| Adapter | Subpath | Peer dep |
|---|---|---|
| Vercel AI SDK | `@genai-otel/core/vercel-ai-sdk` | `ai` ^6.0.0 |
| OpenAI SDK | `@genai-otel/core/openai` | `openai` ^4.0.0 |
| Anthropic SDK | `@genai-otel/core/anthropic` | `@anthropic-ai/sdk` ^0.30.0 |
| LangChain.js | `@genai-otel/core/langchain` | `@langchain/core` ^0.3.0 |

All peer deps are declared optional — the core install does not pull them in.

## Vercel AI SDK

Wraps `generateText`, `streamText`, `generateObject`, `embed`, `embedMany` so each call runs inside a `@genai-otel/core` recorder. Maps `usage`, `finishReason`, and `response.id` / `response.modelId` onto the standard `Generation` shape.

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

`wrapStreamText` records TTFT via the AI SDK's `onChunk` hook and final usage via `onFinish`.

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
- `content[*]` blocks (text/thinking/tool_use/tool_result) → content events

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
| `handleLLMStart` | `client.startGeneration({ model, ... })` (provider inferred from the `Serialized.id` path) |
| `handleLLMNewToken` (first non-empty) | `recorder.setFirstTokenAt(now)` |
| `handleLLMEnd` | `recorder.setResult({ usage, stopReason, responseId })`; `recorder.end()` |
| `handleLLMError` | `recorder.setCallError(err)`; `recorder.end()` |
| `handleToolStart` | `client.startToolExecution({ toolName })`; `recorder.setResult({ arguments })` |
| `handleToolEnd` | `recorder.setResult({ result })`; `recorder.end()` |
| `handleToolError` | `recorder.setExecError(err)`; `recorder.end()` |
| `handleChainStart` (top-level only) | `client.invokeAgent({ agentName })` |
| `handleChainEnd` | `recorder.setOutput(assistantTextMessage(output))`; `recorder.end()` |
| `handleChainError` | `recorder.setError(err)`; `recorder.end()` |

Pass `captureChains: false` to skip chain instrumentation if you only want LLM + tool spans.

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

// every call from `openai` now produces a chat span + the four GenAI metrics
// shipping via OTLP/HTTP to whichever backend OTEL_EXPORTER_OTLP_ENDPOINT points at.
```

## Deferred to v2

- LangGraph-specific helpers (graph node → workflow step semantics beyond what the LangChain adapter already gives you).
- Google Gemini SDK (`@google/genai`).
- LlamaIndex.TS (`llamaindex`).
- OpenAI Agents SDK (`@openai/agents`).
- Mastra.
