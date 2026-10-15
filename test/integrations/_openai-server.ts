/*
 * Copyright 2026 Snowflake Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A local stand-in for the OpenAI HTTP API.
 *
 * The OpenAI and Agents instrumentation tests both need a real `openai` client
 * making real HTTP calls, so they reach the two things most likely to break: the
 * `APIPromise` the SDK returns, and the prototype method the instrumentation
 * patches. Pointing a genuine client at `http://127.0.0.1:<port>` exercises both
 * and stays hermetic and fast enough for the default test run.
 *
 * Responses are scripted per test: hand `respond` a queue of payloads, or a
 * function of the request, and assert on what comes out the other end.
 *
 * Streaming is served as real server-sent events. A streamed call is the one case
 * where the SDK's model method is an `async *` generator, so its body, and the
 * HTTP request inside it, does not run until the consumer's first `next()`. Only
 * an SSE response over HTTP reproduces that ordering.
 */

import { type Server, createServer } from 'node:http';

export interface FakeOpenAIRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Returns the JSON body for a request, an `{ status, body }` pair to fail it, or
 * `{ sse: [...] }` to stream the given events as server-sent events.
 */
export type FakeOpenAIHandler = (
  req: FakeOpenAIRequest,
  callIndex: number,
) => unknown | { status: number; body: unknown } | { sse: unknown[] };

export interface FakeOpenAIServer {
  /** Base URL to hand an `OpenAI` client, already including `/v1`. */
  readonly baseURL: string;
  /** Every request the server received, in order. */
  readonly requests: FakeOpenAIRequest[];
  close(): Promise<void>;
}

export async function startFakeOpenAI(handler: FakeOpenAIHandler): Promise<FakeOpenAIServer> {
  const requests: FakeOpenAIRequest[] = [];
  let callIndex = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        // A non-JSON body is fine to record as empty; no test depends on it.
      }
      const request = { url: req.url ?? '', body };
      requests.push(request);
      let result: unknown;
      try {
        result = handler(request, callIndex++);
      } catch (err) {
        res.setHeader('content-type', 'application/json');
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: String(err) } }));
        return;
      }
      if (isFailure(result)) {
        res.setHeader('content-type', 'application/json');
        res.statusCode = result.status;
        res.end(JSON.stringify(result.body));
        return;
      }
      if (isStream(result)) {
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        for (const event of result.sse) {
          // The SDK dispatches on the event name, so every frame needs its
          // `event:` line.
          const name = (event as { type?: unknown }).type;
          if (typeof name === 'string') res.write(`event: ${name}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function isStream(value: unknown): value is { sse: unknown[] } {
  return (
    value != null && typeof value === 'object' && Array.isArray((value as { sse?: unknown }).sse)
  );
}

function isFailure(value: unknown): value is { status: number; body: unknown } {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { status?: unknown }).status === 'number' &&
    'body' in value
  );
}

// -----------------------------------------------------------------------------
// Payload builders
// -----------------------------------------------------------------------------

/** A minimal successful Chat Completions response. */
export function chatCompletion(
  overrides: {
    id?: string;
    model?: string;
    content?: string;
    finishReason?: string;
    usage?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: overrides.model ?? 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason: overrides.finishReason ?? 'stop',
        message: { role: 'assistant', content: overrides.content ?? 'hello from chat' },
      },
    ],
    usage: overrides.usage ?? {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  };
}

/** A successful Responses API response carrying a single assistant message. */
export function responsesMessage(
  overrides: {
    id?: string;
    model?: string;
    text?: string;
    usage?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'resp-test',
    object: 'response',
    created_at: 1,
    model: overrides.model ?? 'gpt-4o-mini',
    status: 'completed',
    output: [
      {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: overrides.text ?? 'hello from responses', annotations: [] },
        ],
      },
    ],
    usage: overrides.usage ?? defaultResponsesUsage(),
  };
}

/** A Responses API response that calls one function tool. */
export function responsesToolCall(overrides: {
  id?: string;
  model?: string;
  name: string;
  args?: Record<string, unknown>;
  callId?: string;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'resp-tool',
    object: 'response',
    created_at: 1,
    model: overrides.model ?? 'gpt-4o-mini',
    status: 'completed',
    output: [
      {
        type: 'function_call',
        id: 'fc-1',
        call_id: overrides.callId ?? 'call-1',
        name: overrides.name,
        arguments: JSON.stringify(overrides.args ?? {}),
        status: 'completed',
      },
    ],
    usage: overrides.usage ?? defaultResponsesUsage(),
  };
}

export function defaultResponsesUsage(): Record<string, unknown> {
  return {
    input_tokens: 20,
    output_tokens: 8,
    total_tokens: 28,
    input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 2 },
  };
}

/**
 * The server-sent events for one streamed Responses turn that answers with text.
 *
 * Trimmed to the events the SDK acts on: the deltas it forwards, and the
 * `response.completed` carrying the final payload it parses usage and output from.
 */
export function responsesStreamEvents(
  overrides: {
    id?: string;
    model?: string;
    text?: string;
    usage?: Record<string, unknown>;
  } = {},
): unknown[] {
  const text = overrides.text ?? 'streamed hello';
  const final = responsesMessage(overrides);
  return [
    {
      type: 'response.created',
      response: { id: overrides.id ?? 'resp-test', status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant' },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text },
    { type: 'response.completed', response: final },
  ];
}
