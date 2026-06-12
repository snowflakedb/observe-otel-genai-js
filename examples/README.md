# Examples

Runnable demonstrations of `@genai-otel/core`. Each example imports from the local source so you can experiment without publishing the package.

## Prerequisites

```bash
pnpm install
```

## Running

Use `tsx` (already in devDependencies):

```bash
pnpm exec tsx examples/basic-chat/index.ts
pnpm exec tsx examples/multi-turn/index.ts
pnpm exec tsx examples/multi-agent-dag/index.ts
pnpm exec tsx examples/otlp-export/index.ts
```

## What each example shows

| Example | Concept |
|--------|---------|
| `basic-chat/` | Single `startGeneration` lifecycle wrapped around a (mocked) provider call. |
| `multi-turn/` | `withConversationId` + `genai.conversation.turn_index` / `turn_role` across multiple turns. |
| `multi-agent-dag/` | Planner → executor → responder with `parentGenerationIds` span links + `invokeAgent` callback variant. |
| `otlp-export/` | `bootstrapOtel` reading env vars; ships to any OTLP/HTTP backend (Tempo, Honeycomb, Jaeger, Datadog, Observe, ...). |

Every example uses an in-memory exporter by default (so you can run it without a backend) and falls back to OTLP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
