# Keeping content out of telemetry (`allow_list`)

Use the `allow_list` content mode when you have promised that prompts,
completions, and other user content never leave your process, for example
under a zero data retention agreement.

`metadata_only`, the default mode, already stops the library from writing the
content it knows about. `allow_list` goes one step further: every span the
library creates keeps **only** the attributes on a fixed, reviewed list.
Anything else is dropped, including attributes added later by a new library
version, an adapter, or your own code. A new attribute stays off the wire until
someone reviews it and adds it to the list.

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

There is no environment variable for it.

`allow_list` follows the same order as the other modes: the call's own
`contentCapture` option, then the scope, then the client. A call or scope that
picks another mode overrides a client-level `allow_list`, so leave the
integrations' `contentCapture` option unset.

That option also covers only the spans its own integration opens. With the
OpenAI Agents SDK, the `chat` spans on the OpenAI model paths come from
`OpenAIInstrumentation`, so setting `allow_list` only on
`OpenAIAgentsInstrumentation` leaves them unfiltered. Set it on the client.

The mode in effect when a span starts decides whether it is filtered. A span
started inside `withContentCaptureMode('allow_list', ...)` stays filtered even
if it ends after the scope exits; a span started before the scope is not
filtered. So open the scope before the call that starts the span. The Claude
Agent SDK's `wrapQuery` records every span in the context its `query()` was
called in, so wrapping that call is enough, even if you read the stream later.
If you cannot keep every span inside the scope, set the mode on the client.

## What is kept

Only attributes whose key appears, exactly, on the list. There are no prefixes
or wildcards. The list is exported from the package as `CONTENT_ALLOW_LIST`.

In short, it covers:

- which operation ran, on which provider, model, and server, and the SDK name;
- token counts;
- request settings: temperature, top-p, max tokens, penalties, seed, choice
  count, tool choice, thinking settings, streaming, output type, and embedding
  encoding formats;
- response id, response model, and finish reasons;
- agent name, id, version, and description, and workflow name;
- tool name, call id, type, and description;
- conversation id, turn index and role, user id, and generation ids;
- error type, error category, and exception type.

## What is dropped

- **All content**: input and output messages, system instructions, tool
  definitions, tool arguments and results, embedding input texts, retrieval
  query and documents.
- **Free text that can hold content**: the conversation title and stop
  sequences.
- **Exception details**: a failed call still gets an exception event, but it
  keeps only `exception.type` (the error code if it has one, otherwise the error
  class name, as OpenTelemetry records it). The message and stack trace are
  dropped, because they can quote the input that caused the error. The same
  applies to exceptions your own code records on the span.
- **Status message**: the status code (OK or ERROR) is kept, the message is
  dropped.
- **Everything else not on the list.** Today that includes some metadata the
  library emits that has not been through privacy review yet: time to first
  chunk, cost, partial-usage and compaction flags, reasoning level, embedding
  input and dimension counts, retrieval data source and top-k, the OpenAI Agents
  `genai.metadata.*` entries, and the `gen_ai.relationship` attribute on span
  links.

The filter applies to span attributes, event attributes, and link attributes,
on every span the library creates: `chat`, `embeddings`, `execute_tool`,
`retrieval`, `invoke_agent`, `create_agent`, and the OpenAI Agents
`invoke_workflow` span. It also covers writes that do not come from the
library: `rec.setAttributes(...)`, and `trace.getActiveSpan()` inside an
`invokeAgent` / `createAgent` callback or `rec.withActiveContext(...)`, where the
active span is the filtered one.

## The list is fixed

There is no way to add keys at runtime. Changing the list means editing
[`src/content/allow-list.ts`](https://github.com/Snowflake-Labs/observe-otel-genai-js/blob/main/src/content/allow-list.ts),
and needs a privacy review.

## What it does not cover

- **Metrics.** Metric attributes are a fixed set (operation, provider, model,
  agent name, tool name, token type, error type and category, and the opt-in
  conversation id and user id), all on the list, so they are not filtered at
  runtime. A test fails if a metric attribute outside the list is added.
- **Span names.** Names such as `chat gpt-4o`, `execute_tool search`,
  `invoke_agent planner`, `retrieval docs-index`, or `invoke_workflow
  support-flow` are built from the operation, model, tool, agent, data source,
  and workflow names, and are not filtered. The data source name stays in the
  span name even though its attribute is dropped. Do not put user content in any
  of these names.
- **Resource attributes** such as `service.name`. Your OpenTelemetry setup
  sets these, not this library.
- **Spans from other libraries**: HTTP or database instrumentation, or a
  framework's own telemetry (for example the Vercel AI SDK's `ai.*` spans).
  This library does not create them, so it cannot filter them. To cover those,
  filter at export time with a span processor or exporter; see
  [exporting.md](exporting.md#redacting-content).
