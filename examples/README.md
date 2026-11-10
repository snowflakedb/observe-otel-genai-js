# Examples

Runnable examples of `@snowflake/observe-otel-genai`. They import from the local `src/`, so you can run them without building or publishing the package.

## Setup

From the repository root (Node.js 22 or later):

```bash
pnpm install
```

## Running

Run any example with `tsx`, which is already a dev dependency:

```bash
pnpm exec tsx examples/basic-chat/index.ts
pnpm exec tsx examples/multi-turn/index.ts
pnpm exec tsx examples/multi-agent-dag/index.ts
pnpm exec tsx examples/openai-agents/index.ts
```

These four need no backend and no API key. They print each finished span to the console. Metrics are only exported when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; with it set, spans and metrics go to that OTLP/HTTP endpoint instead of the console.

The `otlp-export` example always sends to a backend, and exits if `OTEL_EXPORTER_OTLP_ENDPOINT` is not set:

```bash
cp examples/otlp-export/.env.example .env
# fill in your endpoint and auth header
set -o allexport && source .env && set +o allexport
pnpm exec tsx examples/otlp-export/index.ts
```

## What each example shows

| Example | What it shows |
|---|---|
| `basic-chat/` | One `client.startGeneration(...)` around a mocked model call: set the result, end the span. Produces one `chat gpt-4o` span. |
| `multi-turn/` | Three turns of one conversation, each its own trace. `withConversationId` and `withUserId` set the conversation and user for every turn; `turnIndex` and `turnRole` add `genai.conversation.turn_index` and `genai.conversation.turn_role`. |
| `multi-agent-dag/` | A planner, executor and responder inside one `invokeAgent(seed, fn)` callback, so all three nest under the `invoke_agent orchestrator` span. Each later step lists earlier ones in `parentGenerationIds`, which become span links. |
| `openai-agents/` | `OpenAIAgentsInstrumentation` and `OpenAIInstrumentation` registered together on a real `Agent` / `Runner` handoff, producing one trace: `invoke_workflow` > `invoke_agent` > `chat` and `execute_tool`. A local server stands in for the OpenAI API. |
| `otlp-export/` | OTLP/HTTP export set up from `OTEL_*` env vars, sending one generation to any OTLP/HTTP backend. |

`_setup.ts` is the shared OpenTelemetry setup all the examples use. In your own app, start `NodeSDK` from `@opentelemetry/sdk-node` as [docs/exporting.md](../docs/exporting.md) describes. The examples build the providers by hand only so this repository does not depend on `sdk-node`.
