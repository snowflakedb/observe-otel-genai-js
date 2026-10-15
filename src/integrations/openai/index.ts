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
 * OpenAI SDK adapter.
 *
 * Two entry points:
 *  - `wrapOpenAI(client, openai)` returns a Proxy around the OpenAI client
 *    that auto-instruments `chat.completions.create`, `responses.create` and
 *    `embeddings.create`. Drop-in replacement for the OpenAI client.
 *  - Per-method helpers (`instrumentedChatCompletion`, `instrumentedEmbedding`)
 *    if you want to opt into instrumentation per call.
 *
 * Both helpers honor the same metadata options (`agentName`, `conversationId`,
 * etc.) you can pass through a `WeakMap`-keyed call site override.
 */

import { diag } from '@opentelemetry/api';
import type OpenAI from 'openai';

import type { Client } from '../../client.js';
import { ValidationError } from '../../errors.js';
import { type ApiPromiseLike, isApiPromiseLike } from '../_common/api-promise.js';
import { isInstrumented } from '../_common/instrumented.js';
import { type AdapterCallOptions, createMetadataAccessor } from '../_common/metadata.js';
import { instrumentChatCompletionApiPromise, runChatCompletion } from './_chat.js';
import { instrumentEmbeddingApiPromise, runEmbedding } from './_embeddings.js';
import { instrumentResponseApiPromise } from './_responses.js';

/** Per-call metadata that can be attached via `withMetadata(params, opts)`. */
export type OpenAIAdapterOptions = AdapterCallOptions;

const accessor = createMetadataAccessor<OpenAIAdapterOptions>('@genai-otel/openai-metadata');
export const withMetadata = accessor.withMetadata;
const readMetadata = accessor.readMetadata;
const stripMetadata = accessor.stripMetadata;
const resolveParams = accessor.resolveParams;

// -----------------------------------------------------------------------------
// chat.completions.create (core and message mapping live in ./_chat.ts)
// -----------------------------------------------------------------------------

type ChatCompletionsCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;
type ChatCompletionsResult = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Run a non-streaming chat completion inside a generation recorder.
 */
export async function instrumentedChatCompletion(
  client: Client,
  openai: OpenAI,
  params: ChatCompletionsCreateParams,
  options: OpenAIAdapterOptions = {},
): Promise<ChatCompletionsResult> {
  const resolved = resolveParams(params, options);
  // This helper returns a resolved ChatCompletion. Streaming params would make
  // the underlying call return a Stream instead, breaking the declared return
  // type — reject them and point callers at the streaming-aware proxy.
  if ((resolved.params as { stream?: boolean }).stream === true) {
    throw new ValidationError(
      'instrumentedChatCompletion does not support streaming params (stream: true). ' +
        'Use wrapOpenAI(client, openai) instead — it instruments the streamed chunks ' +
        '(TTFT, final usage) and returns the provider stream unchanged.',
    );
  }
  return runChatCompletion(
    client,
    (p) => openai.chat.completions.create(p) as Promise<unknown>,
    resolved.params,
    resolved.options,
  ) as Promise<ChatCompletionsResult>;
}

// -----------------------------------------------------------------------------
// responses.create (mapping lives in ./_responses.ts)
// -----------------------------------------------------------------------------

type ResponseCreateParams = OpenAI.Responses.ResponseCreateParams;

// -----------------------------------------------------------------------------
// embeddings.create (core lives in ./_embeddings.ts)
// -----------------------------------------------------------------------------

type EmbeddingCreateParams = OpenAI.Embeddings.EmbeddingCreateParams;
type EmbeddingResult = OpenAI.Embeddings.CreateEmbeddingResponse;

export async function instrumentedEmbedding(
  client: Client,
  openai: OpenAI,
  params: EmbeddingCreateParams,
  options: OpenAIAdapterOptions = {},
): Promise<EmbeddingResult> {
  const resolved = resolveParams(params, options);
  return runEmbedding(
    client,
    (p) => openai.embeddings.create(p),
    resolved.params,
    resolved.options,
  );
}

// -----------------------------------------------------------------------------
// wrapOpenAI(client) — auto-instrument proxy
// -----------------------------------------------------------------------------

/**
 * Returns a Proxy around `openai` that auto-instruments every chat/embedding
 * call. Methods we do not know about are passed through untouched.
 *
 * Per-call metadata can be attached with `withMetadata(params, options)`.
 */
export function wrapOpenAI<T extends OpenAI>(client: Client, openai: T): T {
  return new Proxy(openai, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'chat') return wrapChat(client, openai, value);
      if (prop === 'responses') return wrapResponses(client, openai, value);
      if (prop === 'embeddings') return wrapEmbeddings(client, openai, value);
      return value;
    },
  });
}

function wrapChat(client: Client, openai: OpenAI, chat: unknown) {
  return new Proxy(chat as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'completions') return wrapCompletions(client, openai, value);
      return value;
    },
  });
}

function wrapCompletions(client: Client, openai: OpenAI, completions: unknown) {
  return new Proxy(completions as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create') {
        return (params: ChatCompletionsCreateParams, ...rest: unknown[]) => {
          const create = openai.chat.completions.create as (...a: unknown[]) => unknown;
          if (isInstrumented(create)) return create.call(openai.chat.completions, params, ...rest);
          const options = readMetadata(params);
          stripMetadata(params);
          const raw = create.call(openai.chat.completions, params, ...rest);
          return instrumentOrPassThrough(raw, (p) =>
            instrumentChatCompletionApiPromise(client, p, params, options),
          );
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapResponses(client: Client, openai: OpenAI, responses: unknown) {
  return new Proxy(responses as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create') {
        return (params: ResponseCreateParams, ...rest: unknown[]) => {
          const create = openai.responses.create as (...a: unknown[]) => unknown;
          if (isInstrumented(create)) return create.call(openai.responses, params, ...rest);
          const options = readMetadata(params);
          stripMetadata(params);
          const raw = create.call(openai.responses, params, ...rest);
          return instrumentOrPassThrough(raw, (p) =>
            instrumentResponseApiPromise(client, p, params, options),
          );
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapEmbeddings(client: Client, openai: OpenAI, embeddings: unknown) {
  return new Proxy(embeddings as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create') {
        return (params: EmbeddingCreateParams, ...rest: unknown[]) => {
          const create = openai.embeddings.create as (...a: unknown[]) => unknown;
          if (isInstrumented(create)) return create.call(openai.embeddings, params, ...rest);
          const options = readMetadata(params);
          stripMetadata(params);
          const raw = create.call(openai.embeddings, params, ...rest);
          return instrumentOrPassThrough(raw, (p) =>
            instrumentEmbeddingApiPromise(client, p, params, options),
          );
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// -----------------------------------------------------------------------------
// Prototype-patch entry points (used by OpenAIInstrumentation)
// -----------------------------------------------------------------------------

/**
 * Builds a shimmer-style wrapper for `Completions.prototype.create`. The
 * instrumentation applies this to the SDK's prototype method; `original` is the
 * un-instrumented `create`. We read any per-call metadata attached via
 * {@link withMetadata}, strip it before it hits the wire, and drive the shared
 * {@link runChatCompletion} core with an `invoke` that calls `original` on the
 * resource instance — so we never recurse back into the patched method.
 *
 * @internal
 */
export function patchChatCompletionsCreate(
  client: Client,
  defaults: OpenAIAdapterOptions = {},
): (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown {
  return (original) =>
    function patchedCreate(this: unknown, ...args: unknown[]): unknown {
      const params = args[0] as ChatCompletionsCreateParams;
      const rest = args.slice(1);
      // Instrumentation-level defaults, overridable per call via withMetadata().
      const options = { ...defaults, ...readMetadata(params) };
      stripMetadata(params);
      const raw = original.apply(this, [params, ...rest]);
      return instrumentOrPassThrough(raw, (p) =>
        instrumentChatCompletionApiPromise(client, p, params, options),
      );
    };
}

/**
 * Builds a shimmer-style wrapper for `Responses.prototype.create`, mirroring
 * {@link patchChatCompletionsCreate}.
 *
 * This is the entry point that matters most for the OpenAI Agents SDK: it
 * defaults to the Responses API, so this patch is what produces the `chat` span
 * that `invoke_agent` parents.
 *
 * @internal
 */
export function patchResponsesCreate(
  client: Client,
  defaults: OpenAIAdapterOptions = {},
): (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown {
  return (original) =>
    function patchedCreate(this: unknown, ...args: unknown[]): unknown {
      const params = args[0] as ResponseCreateParams;
      const rest = args.slice(1);
      const options = { ...defaults, ...readMetadata(params) };
      stripMetadata(params);
      const raw = original.apply(this, [params, ...rest]);
      return instrumentOrPassThrough(raw, (p) =>
        instrumentResponseApiPromise(client, p, params, options),
      );
    };
}

/**
 * Builds a shimmer-style wrapper for `Embeddings.prototype.create`, mirroring
 * {@link patchChatCompletionsCreate}.
 *
 * @internal
 */
export function patchEmbeddingsCreate(
  client: Client,
  defaults: OpenAIAdapterOptions = {},
): (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown {
  return (original) =>
    function patchedCreate(this: unknown, ...args: unknown[]): unknown {
      const params = args[0] as EmbeddingCreateParams;
      const rest = args.slice(1);
      const options = { ...defaults, ...readMetadata(params) };
      stripMetadata(params);
      const raw = original.apply(this, [params, ...rest]);
      return instrumentOrPassThrough(raw, (p) =>
        instrumentEmbeddingApiPromise(client, p, params, options),
      );
    };
}

/**
 * Instruments what the SDK returned. The request is already on its way by now, so
 * a telemetry failure (e.g. a `Client` that was shut down) returns the SDK's
 * result untraced rather than breaking the caller's call.
 */
function instrumentOrPassThrough(
  raw: unknown,
  instrument: (apiPromise: ApiPromiseLike<unknown>) => unknown,
): unknown {
  // Only a real SDK client returns an `APIPromise`; anything else passes through.
  if (!isApiPromiseLike(raw)) return raw;
  try {
    return instrument(raw);
  } catch (err) {
    diag.debug(
      'genai-otel: failed to record OpenAI telemetry; returning the call untraced',
      err instanceof Error ? err.message : String(err),
    );
    return raw;
  }
}
