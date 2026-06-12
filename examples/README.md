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
pnpm exec tsx examples/observe/index.ts
```

## What each example shows

| Example | Concept |
|--------|---------|
| `basic-chat/` | Single `startGeneration` lifecycle wrapped around a (mocked) provider call. |
| `multi-turn/` | `withConversationId` + `turn_index` / `turn_role` across multiple turns. |
| `multi-agent-dag/` | Planner → executor → responder with `parentGenerationIds` span links + `invokeAgent` callback variant. |
| `observe/` | `bootstrapOtel` reading env vars; designed to ship to Observe (or any OTLP/HTTP backend). |

Every example uses an in-memory exporter by default (so you can run it without a backend) and falls back to OTLP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
