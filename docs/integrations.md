# Framework integrations

`@genai-otel/core` ships adapters for the common TypeScript LLM SDKs and agent frameworks. Each adapter has its own subpath export, so you only load what you import.

| Framework | Subpath | Peer dependency |
|---|---|---|
| Vercel AI SDK | `@genai-otel/core/vercel-ai-sdk` | `ai` ^7.0.0 |
| OpenAI SDK | `@genai-otel/core/openai`, `@genai-otel/core/openai/instrumentation` | `openai` ^4, ^5, ^6 or ^7 |
| OpenAI Agents SDK | `@genai-otel/core/openai-agents/instrumentation` (processor only: `@genai-otel/core/openai-agents`) | `@openai/agents` >=0.14.0 <1 |
| Anthropic SDK | `@genai-otel/core/anthropic` | `@anthropic-ai/sdk` >=0.30.0 <1 |
| LangChain.js / LangGraph | `@genai-otel/core/langchain`, `@genai-otel/core/langchain/instrumentation` | `@langchain/core` ^0.3 or ^1 |
| Claude Agent SDK | `@genai-otel/core/claude-agent-sdk/instrumentation`, `@genai-otel/core/claude-agent-sdk` | none declared; supports `@anthropic-ai/claude-agent-sdk` >=0.3.142 <0.4.0 |

All peer dependencies are optional, so installing the core does not pull them in. The `/instrumentation` subpaths also need `@opentelemetry/instrumentation`.

Adapters work the same whether you set up OpenTelemetry yourself or with [`bootstrapOtel`](bootstrap.md).

## Capability matrix

Messages and tool definitions appear only once [content capture](#content-capture) is on.

| Capability | Vercel AI SDK | OpenAI | OpenAI Agents | Anthropic | LangChain | Claude Agent SDK |
|---|---|---|---|---|---|---|
| Input and output messages | telemetry integration only | yes | yes | yes | yes | yes, rebuilt from the message stream |
| Tool definitions (`gen_ai.tool.definitions`) | — | yes | OpenAI model paths, from `OpenAIInstrumentation` | — | yes | — |
| Request parameters (`temperature`, `top_p`, …) | wrappers only | yes | OpenAI model paths, from `OpenAIInstrumentation` | yes | — | partial: system prompt, effort, thinking |
| `execute_tool` spans | telemetry integration only | no, tool calls stay in the messages | yes | no, tool calls stay in the messages | yes | yes |
| Time to first token on streams | `wrapStreamText` only | yes | yes | yes | yes | with `includePartialMessages` |
| Per-call tags and metadata | `deriveOptions` or wrapper options | `withMetadata` | `Trace.metadata` | `withMetadata` | handler options | `wrapQuery` options or instrumentation config |
| `invoke_agent` spans | telemetry integration | — | yes | — | top-level chains, named graphs | yes |
| Nested `invoke_agent` for subagents | a call made inside a tool | — | agents used as tools | — | named LangGraph graphs | yes |
| OpenTelemetry instrumentation class | — | yes | yes | — | yes | yes |

For identity (agent name, conversation id, user id), see [Identity](#identity).

## Content capture

Content capture is off by default. The `Client` default mode is `metadata_only`: adapters record model, usage, timing and errors, but no prompts, completions or tool payloads.

The mode comes from the first of these that is set:

1. The integration's `contentCapture` option: per call through `withMetadata` (OpenAI, Anthropic), on the handler (LangChain), in `wrapQuery` options (Claude Agent SDK), or in an instrumentation's config.
2. A `withContentCaptureMode(mode, fn)` scope around the call.
3. The `Client`'s `contentCaptureMode`.

The scope in effect when a span starts sets its mode. A span started inside `withContentCaptureMode('full', ...)` keeps its content even if it ends after the scope exits; a span started before the scope is not affected.

The Vercel AI SDK adapter ignores a `contentCapture` option, so use a scope or the `Client` there.

| Mode | What is recorded |
|---|---|
| `metadata_only` (default) | no content on any span |
| `no_tool_content` | prompts and completions; no tool arguments or results, no retrieval query or documents |
| `full` | all content, including tool arguments and results and retrieval content |
| `allow_list` | no content, and only attributes on a fixed list; see [content-retention.md](content-retention.md) |

Content lands in `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions` (see [semconv-mapping.md](semconv-mapping.md#content-capture)). To redact single fields, register a redacting `SpanProcessor`; see [exporting.md](exporting.md#redacting-content).

## Identity

Spans carry an agent name and version, a conversation id and a user id; chat and
tool spans also carry a conversation title. Each takes the first value set by:

1. **The span's own value**: what the framework says about this call (a LangChain
   `runName`, an OpenAI Agents `Agent.name`), or what you pass for this one call
   (`withMetadata`, the Vercel wrapper options, `wrapQuery`, `deriveOptions`, or the
   start call in manual instrumentation).
2. **The enclosing scope**: `withAgent(name, version?)`, `withConversationId`,
   `withConversationTitle`, `withUserId` or `withContext` around the call, or the
   span the call runs under (inside `client.invokeAgent(seed, fn)` or a recorder's
   `withActiveContext(fn)`). The innermost scope that sets a value wins.
3. **The `Client` config**: `agentName`, `agentVersion`, `userId`.

Empty strings count as unset, at every level.

The agent name and version travel together:

- The version comes from the first level that gives the span's agent name together
  with a version. With `new Client({ agentName: 'shop-bot', agentVersion: '2' })`, a
  span named `shop-bot` gets version `2`; a span named `checkout` by a scope gets no
  version.
- A scope that names an agent replaces the outer scope's version, even when it gives
  none. So `withAgent('inner', fn)` inside `withAgent('outer', '1', fn)` has no
  version.

A span passes down to the spans started under it only its own and inherited values,
never the `Client` config; those spans fall back to the `Client` on their own. So a
sub-agent named `helper` under agent `checkout` version `1` has no version, and
neither do the spans under it. `create_agent` spans take only what you pass to
`createAgent`, and pass nothing down.

Scopes live in the OpenTelemetry context, next to the active span, so code that saves
and restores a context restores both. Like span nesting, they need a registered
context manager (`bootstrapOtel` and `NodeTracerProvider.register()` install one);
without it, scopes do nothing.

Integrations never make up a name, so an agent nothing names gets a plain
`invoke_agent` span. Instrumentations take no identity options; use a scope or the
`Client`.

The table shows where each integration reads the span's own value. A `withX(...)`
scope and the `Client` work everywhere, and are the only way to set a field marked
"–". The one exception is the OpenAI Agents `invoke_workflow` span, which takes only
the run's `conversationId` or `groupId`.

| Integration | Agent name | Agent version | Conversation id | Conversation title | User id |
|---|---|---|---|---|---|
| LangChain / LangGraph | `runName`, `createAgent({ name })`, a compiled graph's name | – | `thread_id` | – | `metadata.user_id` |
| OpenAI Agents | `Agent.name` | – | `conversationId` passed to `run()`, else `groupId` | – | – |
| Vercel AI SDK telemetry | `deriveOptions` (by default `functionId`, then `runtimeContext.agent`) | `deriveOptions` | `deriveOptions` (by default `runtimeContext.conversationId`) | `deriveOptions` | `deriveOptions` (by default `runtimeContext.userId`) |
| Vercel AI SDK wrappers | wrapper options | wrapper options | wrapper options | wrapper options | wrapper options |
| Claude Agent SDK | `wrapQuery` options; subagents: `subagent_type` | `wrapQuery` options | `wrapQuery` options; the CLI session id as a last fallback | `wrapQuery` options | `wrapQuery` options |
| OpenAI | `withMetadata` | `withMetadata` | `withMetadata`, then the Responses request's `conversation` | `withMetadata` | `withMetadata` |
| Anthropic | `withMetadata` | `withMetadata` | `withMetadata` | `withMetadata` | `withMetadata` |

## Vercel AI SDK

Two ways in: the telemetry integration, registered once for the whole process, or wrappers around single calls. Use one or the other for a given call; both on the same call trace it twice.

### Telemetry integration (recommended)

`genaiTelemetryIntegration(client, options?)` is an AI SDK v7 telemetry integration. Register it once and every `generateText`, `streamText`, `generateObject` and `ToolLoopAgent` call in the process is traced:

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, registerTelemetry } from 'ai';
import { Client } from '@genai-otel/core';
import { genaiTelemetryIntegration } from '@genai-otel/core/vercel-ai-sdk';

const client = new Client();
registerTelemetry(genaiTelemetryIntegration(client));

await generateText({
  model: openai('gpt-4o'),
  prompt: 'What is OpenTelemetry?',
  runtimeContext: { conversationId: 'conv-1', userId: 'user-1' },
  telemetry: {
    functionId: 'support-bot',
    includeRuntimeContext: { conversationId: true, userId: true },
  },
});
```

Options:

- `deriveOptions(event)`: returns the identity, `tags` and `metadata` for one call, from its `functionId` and `runtimeContext`. The default reads `functionId` (or `runtimeContext.agent`) as the agent name, and `runtimeContext.conversationId` and `runtimeContext.userId`. The AI SDK passes on only the `runtimeContext` fields you list in `telemetry.includeRuntimeContext`.
- `emitOperationSpan` (`boolean | (event) => boolean`, default `true`): whether each call gets an `invoke_agent` span above its steps. Pass a function to keep it for real agents and drop it for one-shot calls.

What gets recorded:

- One `invoke_agent` span per call, one `chat` span per step (`generate_content` for `generateObject`), and one `execute_tool` span per tool call.
- Concurrent calls stay in separate trees.
- Work inside a tool, such as HTTP calls or a nested `generateText`, nests under that tool's `execute_tool` span. A nested `generateText` gets its own `invoke_agent` span there.
- A failed model call marks the `invoke_agent` span as an error.
- The AI SDK's `telemetry.recordInputs: false` and `recordOutputs: false` drop inputs and outputs, whatever the content capture mode.

Limits: the integration records no request parameters (`temperature` and the like), no time to first token and no tool definitions, and does not trace `embed` or `embedMany`. Use the wrappers for those.

### Wrappers

`wrapGenerateText`, `wrapStreamText`, `wrapGenerateObject`, `wrapEmbed` and `wrapEmbedMany` each trace one call. The third argument takes identity, `tags` and `metadata`:

```ts
import { openai } from '@ai-sdk/openai';
import { Client } from '@genai-otel/core';
import { wrapGenerateText, wrapStreamText } from '@genai-otel/core/vercel-ai-sdk';

const client = new Client();

const result = await wrapGenerateText(
  client,
  { model: openai('gpt-4o'), prompt: 'What is OpenTelemetry?' },
  { agentName: 'demo', conversationId: 'conv-1' },
);
console.log(result.text);

const stream = wrapStreamText(client, { model: openai('gpt-4o'), prompt: 'Stream me.' });
for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

Each wrapper emits one `chat`, `generate_content` or `embeddings` span with the model, request parameters, usage, finish reason and response id. `wrapStreamText` also records time to first token.

Limits: wrappers record the `system` prompt but not the input or output messages, and emit no `invoke_agent` or `execute_tool` spans.

## OpenAI SDK

### Setup

Wrap a client and use it as usual:

```ts
import OpenAI from 'openai';
import { Client } from '@genai-otel/core';
import { wrapOpenAI, withMetadata } from '@genai-otel/core/openai';

const client = new Client();
const openai = wrapOpenAI(client, new OpenAI());

await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
});

// Per-call options ride on the params and are removed before the request is sent.
await openai.chat.completions.create(
  withMetadata(
    { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    { agentName: 'planner', conversationId: 'conv-1', turnIndex: 0, turnRole: 'assistant' },
  ),
);
```

`wrapOpenAI` traces `chat.completions.create`, `responses.create` and `embeddings.create`. Other methods pass through untouched.

Per-method helpers are available too. Pass them a plain client: a wrapped or auto-instrumented one traces each request twice. `instrumentedChatCompletion` does not accept `stream: true`; use `wrapOpenAI` for streams.

```ts
import { instrumentedChatCompletion, instrumentedEmbedding } from '@genai-otel/core/openai';

const result = await instrumentedChatCompletion(client, new OpenAI(), { /* params */ });
```

### Auto-instrumentation

`OpenAIInstrumentation` traces every OpenAI client in the process, with no wrapping:

```ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OpenAIInstrumentation } from '@genai-otel/core/openai/instrumentation';

registerInstrumentations({
  instrumentations: [new OpenAIInstrumentation()],
});
```

- The config takes `client`, `contentCapture`, `tags`, `metadata`, `turnIndex`, `turnRole` and `parentGenerationIds`. These are process-wide defaults; `withMetadata` overrides them per call. Without a `client`, one is built from the registered providers.
- It covers the same three methods as `wrapOpenAI`. Leaving `wrapOpenAI` in place is fine: it passes the call through to the patched method, metadata included, so each request still produces one span.
- CommonJS needs no extra setup. Under ESM, use the OpenTelemetry loader hook (`node --import` a preload that calls `register('@opentelemetry/instrumentation/hook.mjs', ...)`), or hand the module over once at startup:

  ```ts
  import * as OpenAIModule from 'openai';
  instrumentation.manuallyInstrument(OpenAIModule);
  ```

- `await instrumentation.shutdown()` removes the patch and shuts down a `Client` the instrumentation created. `disable()` only removes the patch.

### When another library instruments `openai` too

`@opentelemetry/instrumentation-openai` patches the same methods, and `@opentelemetry/auto-instrumentations-node` turns it on by default. Whichever patches first wins; the other one steps aside and logs a warning, so you get one span per call. When the other library wins, its spans lack this library's Responses mapping and the conversation id and agent name that the OpenAI Agents integration passes to model calls. Turn one of them off:

```ts
// keep this library's spans: turn the other one off
getNodeAutoInstrumentations({
  '@opentelemetry/instrumentation-openai': { enabled: false },
});
```

```bash
# or by environment. The value is the package name without
# the "@opentelemetry/instrumentation-" prefix.
OTEL_NODE_DISABLED_INSTRUMENTATIONS=openai
```

`OTEL_NODE_DISABLED_INSTRUMENTATIONS` matches nothing if you pass the full package name. The environment variable is the only option when you preload `@opentelemetry/auto-instrumentations-node/register`.

If both stay on, the split can depend on versions: the other library may take your app's own `openai` v6 calls while this one takes the v7 copy that the Agents SDK uses. Turning one off avoids that.

### What gets recorded

- One `chat` span per `chat.completions.create` or `responses.create` call, and one `embeddings` span per `embeddings.create` call.
- Request parameters, tool definitions, `server.address` (from the client's `baseURL`), usage including cached and reasoning tokens, finish reason, response id and model.
- On `responses.create`, `instructions` becomes `gen_ai.system_instructions`, and the request's `conversation` becomes the conversation id unless `withMetadata` sets one.
- With `stream: true`, the stream is returned unchanged. Time to first token comes from the first chunk (Chat Completions) or the first `*.delta` event (Responses). Final usage on Chat Completions streams needs `stream_options: { include_usage: true }`; without it the span has no token counts.

## OpenAI Agents SDK

### Setup

```ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OpenAIAgentsInstrumentation } from '@genai-otel/core/openai-agents/instrumentation';
import { OpenAIInstrumentation } from '@genai-otel/core/openai/instrumentation';

registerInstrumentations({
  instrumentations: [new OpenAIAgentsInstrumentation(), new OpenAIInstrumentation()],
});
```

Register both. On the default OpenAI model paths the `chat` spans come from `OpenAIInstrumentation`; without it, runs show `invoke_agent` and `execute_tool` with no model call beneath them.

The config takes `client`, `contentCapture` and `maxTracesInFlight` (default 1000; past it, the least recently active trace is ended with the data it has).

CommonJS needs no extra setup. Under ESM, use the OpenTelemetry loader hook, or hand the module namespaces over at startup:

```ts
import * as Agents from '@openai/agents';
import * as AiSdk from '@openai/agents-extensions/ai-sdk';
instrumentation.manuallyInstrument(Agents, AiSdk);
```

Without the loader hook, spans created inside tool functions do not nest under `execute_tool`, and a `withTrace` block that throws stays open until the trace cap or shutdown ends it.

The SDK turns tracing off when `NODE_ENV === 'test'`. Turn it back on before each test, since the switch is process-wide:

```ts
import { setTracingDisabled } from '@openai/agents';

beforeEach(() => setTracingDisabled(false));
```

### What gets a span

| SDK span type | OTel span |
|---|---|
| trace | `invoke_workflow <workflow name>` (see below) |
| `agent` | `invoke_agent <name>` |
| `function` | `execute_tool <name>` |
| `generation` on the AI SDK path (`aisdk(model)`) | `chat <model>` |
| `generation` / `response` on the OpenAI paths | none; `OpenAIInstrumentation` emits the `chat` span |
| `task`, `turn` | none; their errors are recorded on the enclosing span |
| `handoff` | none; the next `invoke_agent` span is the handoff |
| `guardrail`, `custom`, `mcp_tools`, `speech`, `transcription`, `speech_group` | none |

- Model calls and tool calls run inside the OpenTelemetry context of their agent or tool span, so spans from other instrumentations (a `chat` span, a database call inside a tool) nest under them.
- On the AI SDK path the `chat` span is recorded when the model call ends, so spans the provider client creates during the call sit beside it under `invoke_agent`.
- Tools served by an MCP server get `gen_ai.tool.type = mcp`; other tools get `function`.
- Metrics: `gen_ai.client.operation.duration` for agent spans and AI SDK `chat` spans (not the workflow span), `gen_ai.client.tool_execution.duration` for tool spans, and `gen_ai.client.token.usage` from `chat` spans only, so totals are not counted twice. On the AI SDK path, time to first token is measured from the first text, reasoning or tool-argument delta.

### The workflow span

Every run gets one `invoke_workflow <workflow name>` span, even a run with a single agent. Each agent gets its own `invoke_agent <name>` span beneath it, so a run that hands off between agents shows them side by side under one workflow.

- The workflow name is the trace's name: `workflowName` on the `Runner` or `RunConfig`, or the name given to `withTrace`. A run given no name is named after the agent passed to `run()`.
- The conversation id is the `conversationId` passed to `run()` (or kept in a resumed run's state), else the trace's `groupId`.
- `Trace.metadata` is recorded as `genai.metadata.<key>`.

Set the name, the group id and the metadata on the `Runner`, since the options passed to `run()` do not carry them:

```ts
const runner = new Runner({
  workflowName: 'triage-workflow',   // span name and gen_ai.workflow.name
  groupId: 'chat-thread-1',          // gen_ai.conversation.id, unless run() gets a conversationId
  traceMetadata: { tenant: 'acme' }, // genai.metadata.tenant
});
```

Resumed runs:

- A run resumed after a tool approval gets its own workflow span, with the same name and conversation id as the first part.
- A run resumed from `result.state` in the same process gets no trace start or end from the SDK, so its workflow span closes when the resumed run's `task` span ends. A run resumed from `RunState.fromString` is traced normally.
- With `tracing: { includeTaskAndTurnSpans: false }` the SDK sends no `task` or `turn` spans: a turn's error is not copied to its agent span, and a resumed run's workflow span stays open until the trace cap or shutdown ends it.

The workflow attributes are listed in [semconv-mapping.md](semconv-mapping.md#openai-agents-workflow).

### Agent input and output

When content capture is on, `invoke_agent` spans carry the input of the agent's first model call and the output of its last. On the AI SDK path, the agent's instructions go to `gen_ai.system_instructions` on the `chat` span.

With the SDK's `traceIncludeSensitiveData: false`, AI SDK `chat` spans carry no messages or token counts, and agent spans on the AI SDK and Chat Completions paths carry no messages, whatever the content capture mode. The default Responses path still reports its input and output, so agent spans there keep their messages.

### Identity

The run's conversation id and the current agent's name are passed down to model calls, so the `chat` span from `OpenAIInstrumentation` carries the same `gen_ai.conversation.id` and the right `gen_ai.agent.name`. They are the run's own values, so they win over a `withConversationId(...)` or `withAgent(...)` scope around the run.

### Errors

- A run that rejects, streamed or not, closes the traces it opened with the error on the workflow span. A `withTrace(...)` block that throws is closed the same way.
- A failure the run recovers from fails nothing above it: a model call the SDK retries, or an agent used as a tool whose failure the outer agent handles.
- `error.type` is the error's class name when it looks like one (`BoomError`, `InputGuardrailTripwireTriggered`); otherwise the span's own category, such as `tool_execution_error`, or `_OTHER` on the workflow span.
- Guardrails get no span of their own; a tripwire shows up as the `error.type` above.

### Limits

- No `create_agent` span: the SDK reports nothing when an `Agent` is constructed.
- No `gen_ai.tool.call.id` on tool spans: the SDK's tool span carries no call id.
- No `gen_ai.tool.definitions` on AI SDK path `chat` spans: the SDK reports tool names only.
- On the AI SDK path the SDK does not report why the model stopped, so `chat` spans report `tool_call` when the model asked for a tool and `stop` otherwise.

### Where agent traces go

The SDK's own export to the OpenAI Traces dashboard keeps running next to this integration. To stop it, replace the SDK's processor list; this integration's processor stays registered through any replacement:

```ts
import { setTraceProcessors } from '@openai/agents';

setTraceProcessors([]);
```

### Custom `Model` classes

Automatic patching reaches the SDK's own model classes only. Wrap a hand-written model so spans it creates nest under the agent:

```ts
import { instrumentModel } from '@genai-otel/core/openai-agents/instrumentation';
import { getCurrentSpan } from '@openai/agents';

const model = instrumentModel(new MyModel(), instrumentation.processor, getCurrentSpan);
```

### Supported versions

`@openai/agents` >=0.14.0 <1. CI tests 0.14, 0.16 and the latest release. The floor is 0.14 because error routing relies on its `task` and `turn` spans.

### Shutdown and disable

- `await instrumentation.shutdown()` ends every open span, flushes, and shuts down a `Client` the instrumentation created. A `client` you passed in is left to you.
- `disable()` ends open spans and stops tracing until `enable()`. The processor stays in the SDK's list, since the SDK cannot remove one.
- The SDK also shuts processors down on process signals and whenever its processor list is replaced. This integration only flushes then, so tracing carries on if the process does.

### The processor on its own

`@genai-otel/core/openai-agents` exports `GenAIOtelTracingProcessor` for custom setups:

```ts
import { addTraceProcessor, getCurrentTrace } from '@openai/agents';
import { GenAIOtelTracingProcessor } from '@genai-otel/core/openai-agents';

const processor = new GenAIOtelTracingProcessor({ getCurrentTrace });
addTraceProcessor(processor);
// On shutdown: `stop()` ends open spans; `shutdown()` only flushes.
await processor.stop();
```

Without the instrumentation:

- spans from other instrumentations, such as OpenAI `chat` spans, do not nest under agent spans;
- a run that rejects leaves its workflow span open until the trace cap or `stop()` ends it;
- the processor can be dropped when the SDK's processor list is replaced.

## Anthropic SDK

### Setup

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

// With per-call options:
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

`instrumentedMessageCreate(client, anthropic, params, options?)` traces a single call on a plain client.

### What gets recorded

- One `chat` span per `messages.create` call, with `max_tokens`, `temperature`, `top_p` and `stop_sequences`.
- `system` becomes `gen_ai.system_instructions`; text, thinking, tool-use and tool-result blocks become input and output messages.
- Usage, including `cache_read_input_tokens` and `cache_creation_input_tokens` as the cache-read and cache-write counts. `gen_ai.usage.input_tokens` is Anthropic's `input_tokens`, which leaves cached tokens out.
- With `stream: true`, time to first token is taken at the first content block, and the final stop reason and output tokens from `message_delta`.

### Limits

- Only `messages.create` is traced; `messages.stream()` is not. Use `messages.create({ stream: true })`.
- The wrapped `messages.create` returns a plain promise, so `.withResponse()` and `.asResponse()` are not available on it.
- There is no auto-instrumentation class.

## LangChain.js / LangGraph

### Setup

Pass `GenAIOtelCallbackHandler` as a callback:

```ts
import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { Client } from '@genai-otel/core';
import { GenAIOtelCallbackHandler } from '@genai-otel/core/langchain';

const client = new Client();
const handler = new GenAIOtelCallbackHandler({ client });

const llm = new ChatOpenAI({ model: 'gpt-4o' });
const prompt = ChatPromptTemplate.fromTemplate('Answer: {q}');
const chain = prompt.pipe(llm).withConfig({ runName: 'support-bot' });

await chain.invoke(
  { q: 'what is otel?' },
  { callbacks: [handler], metadata: { thread_id: 'conv-1', user_id: 'user-1' } },
);
```

LangGraph uses the same callback system, so the same handler works there:

```ts
await graph.invoke(input, {
  callbacks: [handler],
  configurable: { thread_id: 'session-42' },
});
```

Handler options:

- `captureChains` (default `true`): set `false` to skip `invoke_agent` spans and record only model, tool and retriever spans.
- `contentCapture`, `tags`, `metadata`, `turnIndex`, `turnRole`.

When one handler is reused across many requests, call `await handler.dispose()` on shutdown. It ends runs whose end or error callback never fired, such as abandoned streams.

### Auto-instrumentation

`LangChainInstrumentation` adds the handler to every chain, model and tool run, including runs invoked with no callbacks. Passing the handler by hand as well does not trace twice.

```ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { LangChainInstrumentation } from '@genai-otel/core/langchain/instrumentation';

registerInstrumentations({
  instrumentations: [new LangChainInstrumentation()],
});
```

- The config takes every handler option plus an optional `client`. Without a `client`, one is built from the registered providers, so register those first (for example with `bootstrapOtel`).
- **CommonJS**: patched automatically. Call `registerInstrumentations(...)` before the first `require('@langchain/core')`.
- **ESM**: call `manuallyInstrument(...)` once, before importing `@langchain/core`. Do the same for bundlers that inline `@langchain/core` (Next.js, some Webpack or esbuild setups) and non-Node runtimes. Do not enable the OpenTelemetry ESM loader hook for `@langchain/core`: it breaks the library's LangSmith interop.

  ```ts
  import { LangChainInstrumentation } from '@genai-otel/core/langchain/instrumentation';
  import * as CallbackManagerModule from '@langchain/core/callbacks/manager';

  const instrumentation = new LangChainInstrumentation();
  instrumentation.manuallyInstrument(CallbackManagerModule);
  ```

- Supported `@langchain/core` versions: >=0.3.0 <2 (0.3.x and 1.x).
- `await instrumentation.shutdown()` ends open runs and shuts down a `Client` the instrumentation created. `disable()` removes the patch and ends open runs, but does not flush that client; prefer `shutdown()`, or rely on your `TracerProvider` shutdown.

### What gets recorded

All spans from one invocation form one trace:

| LangChain run | Span |
|---|---|
| top-level chain or graph | `invoke_agent [<name>]` |
| nested LangGraph graph with a name (`createAgent({ name })`, `compile({ name })`, `entrypoint(name, …)`) | its own `invoke_agent <name>`; the spans under it take its name |
| any other nested chain | none; its children nest under the nearest span |
| chat model or LLM call | `chat <model>` |
| tool | `execute_tool <name>` |
| retriever | `retrieval`, with any query rewrite nested under it |

- `invoke_agent` input: a `messages` array maps message by message; a string, or a string `input`, `question` or `text` field, becomes one user message; any other shape is JSON-encoded. The output is the last message of a `messages` array, else a string, `output` or `text` field, else the JSON-encoded result.
- `chat` spans carry input and output messages, the model's bound tools as `gen_ai.tool.definitions`, usage including cache-read and cache-write tokens, the finish reason, response id and served model (`gen_ai.response.model`, for example `gpt-4o-2024-11-20` for a `gpt-4o` request). Streaming calls record time to first token.
- `gen_ai.provider.name` uses the well-known values (`openai`, `anthropic`, `aws.bedrock`, `gcp.gemini`, …). A hosting platform wins over the vendor it hosts, so a Bedrock-hosted Anthropic model reports `aws.bedrock`.
- The tool name is the run's `runName`, else the tool's class name; on success, the name on the returned `ToolMessage` replaces it.
- Retrieval spans carry the query text and documents (subject to content capture). `gen_ai.retrieval.top_k` and `gen_ai.data_source.id` come only from the retriever's serialized config, so they are often missing.

### Identity

- **Agent name**: the agent run's `runName`, set with `withConfig({ runName })`, `createAgent({ name })` or a compiled graph's name. Names LangChain fills in when you set none do not count: the runnable's class name, any `Runnable*` name, and `LangGraph` for an unnamed graph.
- **Conversation id**: the run's `thread_id`, from `configurable.thread_id` on a LangGraph graph or `metadata.thread_id` on any run. Every span in the run gets it, so all turns of a persisted conversation share one id.
- **User id**: the run's `metadata.user_id`.

These are the run's own values, so they win over an enclosing `withX(...)` scope. LangChain has no field for the agent version or the conversation title; use `withAgent(name, version, fn)` or `withConversationTitle(...)` around the call. The version is used only when the scope names the same agent as the run, or the run has no name of its own. Chat, tool and retriever spans under an agent carry its identity.

### Limits

- Request parameters (`temperature` and the like) are not recorded.
- Retrieval spans have no `gen_ai.provider.name` or `gen_ai.request.model`: those describe the embedding call, which LangChain does not report.

## Claude Agent SDK

The Claude Agent SDK does not run the agent in your process. It starts the Claude Code CLI and streams JSON messages back, so there is no model call to wrap: the adapter rebuilds the span tree from that message stream. Your `query()` options are passed through unchanged, and the returned `Query` keeps all its methods (`interrupt()`, `setModel()`, …).

### Setup

Register it as an OpenTelemetry instrumentation, which needs `@opentelemetry/instrumentation` installed. The SDK ships an ESM build only, so this also needs the OpenTelemetry ESM loader hook, registered before your app first imports the SDK. A preload does that:

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
  instrumentations: [new ClaudeAgentSdkInstrumentation()],
});
```

```bash
node --import ./preload.mjs app.mjs
```

The config takes the `wrapQuery` options except identity (`contentCapture`, `tags`, …), plus an optional `client`; without one, a client is built from the registered providers.

Without the hook, or if the SDK was imported before the hook was registered, nothing is traced and nothing is logged. An app that loads the SDK with `require()` is not patched either; the instrumentation logs a warning then. In either case, or to avoid the hook, wrap the call site instead:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { wrapQuery } from '@genai-otel/core/claude-agent-sdk';

const tracedQuery = wrapQuery(client, query, { agentName: 'support-bot' });
for await (const msg of tracedQuery({ prompt, options })) { /* ... */ }
```

A query sent through a pre-warmed `startup()` handle does not go through `query`, so wrap `startup` the same way with `wrapStartup(client, startup, options)`. The instrumentation patches both.

`await instrumentation.shutdown()` removes the patch and shuts down a `Client` the instrumentation created; `disable()` only removes the patch.

### Options worth turning on

Two SDK options are off by default. The adapter does not turn them on for you, because both change what your own loop receives.

```ts
options: {
  forwardSubagentText: true,     // subagent model calls and their content
  includePartialMessages: true,  // exact per-call tokens, stop reasons, time to first token
}
```

Without `forwardSubagentText`, a delegation still gets its `execute_tool` span and timing, but none of the subagent's messages reach the stream, so there is no nested `invoke_agent` span. `includePartialMessages` is covered under [tokens](#tokens-cost-and-time-to-first-token) below.

### Span tree

Each `query()` call gets one `invoke_agent` span, under whatever OpenTelemetry context you call from. Several user turns means several `query()` calls, linked by `gen_ai.conversation.id`.

```
invoke_agent <agentName>          one per query() call
  chat <model>                    one per API call
  execute_tool Read
  execute_tool Agent              the delegation tool (called Task on older CLIs)
    invoke_agent <subagent_type>  the subagent's own run
      chat <model>
      execute_tool Grep
```

- The CLI sends one assistant message per content block. Messages sharing a `message.id` become one `chat` span.
- Each `chat` span's input is the conversation so far, capped at the latest 40 messages so a long tool loop does not outgrow what an exporter accepts.
- Subagents nest under the delegation that started them, so parallel delegations stay apart.
- A task (a delegation, or `Bash` with `run_in_background`) answers its tool call with a launch receipt right away while the work goes on. Its span stays open until the CLI reports the task finished, so it covers the real work. A task still running when the run ends is closed with its receipt, not as an error.
- The SDK's `result` messages are checkpoints: a background task can keep the run going past the first one. The run ends when the stream does, and its status follows the last result.
- Breaking out of your loop early, or calling `close()`, ends every span without marking an error.
- A failed API call gets a `chat` span of its own, marked with the error.

### Other attributes

- `gen_ai.provider.name` follows the platform the CLI is told to use: `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_MANTLE` (`aws.bedrock`), `CLAUDE_CODE_USE_VERTEX` (`gcp.vertex_ai`) or `CLAUDE_CODE_USE_FOUNDRY` (`azure.ai.inference`), else `anthropic`. They are read from `options.env` when you set it (it replaces the CLI's environment), and from the process environment otherwise. As in the CLI, only `1`, `true`, `yes` or `on` count as on.
- `options.effort` becomes `gen_ai.request.reasoning.level` on the run's `invoke_agent` span and the main thread's `chat` spans.
- A string or custom (`{ type: 'custom', prompt }`) `options.systemPrompt`, and `options.thinking`, go on the main thread's `chat` spans only; subagents have their own. A preset system prompt is not recorded, since the CLI renders it.
- A streamed prompt (an async iterable of user messages, passed to `query()` or `streamInput()`) is passed to the SDK unchanged, and the run's input lists every user message. A user message shows up in the `chat` spans' conversation once the SDK has read it, which can be before the call that answers it.
- After the CLI compacts the conversation, the run and every later `chat` span carry `gen_ai.conversation.compacted`. Later `chat` inputs start after the compaction, since the summary never reaches the process. A `/clear` also starts them over, and ends the compacted flag.

### Tokens, cost, and time to first token

- The `invoke_agent` span carries the run totals from the latest `result.modelUsage`, the only source that includes subagents, plus the cost in `genai.usage.cost_usd`. A `/clear` mid-run resets the SDK's totals; usage from before it still counts.
- A run started with `resume` or `continue` gets no run totals: the SDK folds the earlier session's usage into its first result without saying how much of it there is.
- Each `chat` span carries its own call's figures, so summing across every span in a trace counts tokens twice. Use either the `invoke_agent` span or the `chat` spans. The token metric is recorded from `chat` spans only.
- Exact per-call counts need `includePartialMessages`. Without it, a `chat` span has only the usage snapshot taken as the reply starts: input and cache figures are kept, the output count is left out rather than reported low, and the span is marked `genai.usage.is_partial`. With it, each call gets its final usage, stop reason, reasoning tokens, time to first token and real start time.
- The SDK does not forward stream events for subagents, so their `chat` spans are marked `is_partial`, except a foreground delegation's last call, whose `tool_result` carries its final usage. Subagent tokens are in the run totals either way.
- Cached tokens are counted in `gen_ai.usage.input_tokens`, as the GenAI conventions ask. The [Anthropic adapter](#anthropic-sdk) does not do this, so the two report different input counts for the same call.

### Content capture

The [standard modes](#content-capture) apply. Only `full` records tool arguments and results, which here are shell commands, file paths, file bodies and command output. A subagent's prompt and report are the delegation tool's argument and result, so they appear (on its `invoke_agent` span, and as its first `chat` input) only under `full`. What the subagent's model writes is a completion like any other, so its `chat` output appears under `no_tool_content` or `full`.

### Identity

- With the instrumentation, name the agent and set the conversation or user with a `withAgent(...)`, `withConversationId(...)` or `withUserId(...)` scope around the call, or on the `Client`. Options passed to `wrapQuery` have no effect while the instrumentation is on: it has already wrapped `query`, and `wrapQuery` returns that wrapped `query` unchanged.
- With `wrapQuery`, its options are the run's own values and win over a scope.
- When nothing sets a conversation id, the CLI session id is used.
- A subagent's `invoke_agent` span is named after its `subagent_type` and carries no agent version, since the version belongs to the main agent.

### Limits

- No `plan`, `invoke_workflow` or memory spans yet, although the GenAI conventions define them.

## Not covered yet

- Google Gemini SDK (`@google/genai`)
- LlamaIndex.TS (`llamaindex`)
- Mastra
