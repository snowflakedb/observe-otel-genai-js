# Keeping content out of telemetry (`allow_list`)

Use the `allow_list` content mode when you have promised that prompts,
completions, and other user content never leave your process, for example
under a zero data retention agreement.

`metadata_only`, the default mode, already stops the library from writing the
content it knows about. `allow_list` goes one step further: every span the
library creates keeps **only** the attributes on a fixed, reviewed list. Anything else is dropped,
including attributes added later by a new library version, an adapter, or your
own code. A new attribute stays off the wire until someone reviews it and adds
it to the list.

## Turning it on

For every span:

```ts
const client = new Client({ contentCaptureMode: 'allow_list' });
```

For one request (every span started inside `fn`):

```ts
import { withContentCaptureMode } from '@genai-otel/core';

await withContentCaptureMode('allow_list', () => handleRequest(req));
```

`allow_list` follows the same order as the other modes: per call, then the
ambient scope, then the client. So a call or scope that picks another mode
overrides a client-level `allow_list`. Integrations pass their own
`contentCapture` option per call, so leave it unset there.

An integration's own `contentCapture` option covers only the spans that
integration opens. With the OpenAI Agents SDK, the `chat` spans on the OpenAI
model paths come from `OpenAIInstrumentation`, so setting `allow_list` only on
`OpenAIAgentsInstrumentation` leaves them unfiltered. Set it on the client.

Only the mode in effect when a span starts counts. Open
`withContentCaptureMode('allow_list', ...)` before the call that starts the
span: a span that started inside the scope stays filtered even if it ends after
the scope has exited, and a span that started before the scope is not filtered.

A stream or async iterator, such as the Claude Agent SDK's `wrapQuery`, starts
spans as its messages arrive, so keep the scope open until it is fully
consumed. If you cannot, set `contentCaptureMode: 'allow_list'` on the client
instead.

## What is kept

Only attributes whose key appears, exactly, on the list. There are no prefixes
or wildcards. The list is exported from the package as `CONTENT_ALLOW_LIST`,
and defined in
[`src/content/allow-list.ts`](https://github.com/snowflake-eng/genai-otel/blob/main/src/content/allow-list.ts).

In short, the list covers:

- which operation ran, on which provider and model, and the SDK name;
- token counts;
- request settings such as temperature, max tokens, seed, and tool choice;
- response id, response model, and finish reasons;
- agent, tool, and conversation ids and names, and the user id;
- error type and error category.

## What is dropped

- **All content**: input and output messages, system instructions, tool
  definitions, tool arguments and results, embedding input texts, retrieval
  query and documents.
- **Free text that can hold content**: the conversation title and stop
  sequences.
- **Exception details**: a failed call still gets an exception event, but it
  keeps only `exception.type` (the error code if it has one, otherwise the error
  class name, which is what OpenTelemetry records). The message and stack trace
  are dropped, because they can quote the input that caused the error. The same
  applies to exceptions your own code records on the span. (`metadata_only`
  records no exception event of its own, but leaves ones your code records
  untouched.)
- **Status message**: the status code (OK or ERROR) is kept, the message is
  dropped.
- **Everything else not on the list.** Today that includes some metadata the
  library emits but that has not been through privacy review yet, for example
  time to first chunk, cache-write token counts, and cost.

The filter applies to span attributes, event attributes, and link attributes,
on every span type: `chat`, `embeddings`, `execute_tool`, `retrieval`,
`invoke_agent`, and `create_agent`. It also covers writes that do not come from
the library: `rec.setAttributes(...)`, and `trace.getActiveSpan()` inside an
`invokeAgent` / `createAgent` callback or `rec.withActiveContext(...)`, where the
active span is the filtered one.

## The list is fixed

There is no environment variable and no way to add keys at runtime. Changing
the list means editing `src/content/allow-list.ts`, and needs a privacy review.
Observe's Python SDK applies the same list, so change both together.

## What it does not cover

- **Metrics.** Histogram labels are a fixed set (operation, provider, model,
  agent name, tool name, token type, error type and category), all on the list,
  so they are not filtered at runtime. A test fails if a label outside the list
  is added.
- **Span names.** Names such as `chat gpt-4o`, `execute_tool search`, or
  `invoke_agent planner` are built from the operation, model, tool, and agent
  names, and are not filtered. Do not put user content in tool or agent names.
- **Resource attributes** such as `service.name`. Your OpenTelemetry setup
  sets these, not this library.
- **Spans from other libraries**: HTTP or database instrumentation, or a
  framework's own telemetry (for example the Vercel AI SDK's `ai.*` spans).
  This library does not create them, so it cannot filter them. To cover those,
  filter at export time with a span processor or exporter; see
  [exporting.md](exporting.md#redacting-content).
