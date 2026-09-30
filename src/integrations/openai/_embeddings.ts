/**
 * OpenAI Embeddings (`client.embeddings.create`) instrumentation: the recording
 * core. The entry points that call into it (`wrapOpenAI`, the per-call helper,
 * and the prototype patch) live in `index.ts`.
 */

import type OpenAI from 'openai';

import type { Client } from '../../client.js';
import { type ApiPromiseLike, instrumentApiPromise } from '../_common/api-promise.js';
import type { AdapterCallOptions } from '../_common/metadata.js';

type OpenAIAdapterOptions = AdapterCallOptions;

/** Recorder returned by {@link Client.startEmbedding}. */
type EmbeddingRecorder = ReturnType<Client['startEmbedding']>;

type EmbeddingCreateParams = OpenAI.Embeddings.EmbeddingCreateParams;
type EmbeddingResult = OpenAI.Embeddings.CreateEmbeddingResponse;

/** Invokes the underlying (un-instrumented) `embeddings.create`. */
export type EmbeddingsInvoke = (params: EmbeddingCreateParams) => Promise<EmbeddingResult>;

/**
 * Shared embedding instrumentation core. Like {@link runChatCompletion}, it
 * takes an `invoke` callback so the proxy and the OTel instrumentation can share
 * it without re-entering the patched method.
 *
 * @internal exported for {@link file://./instrumentation.ts}.
 */
export async function runEmbedding(
  client: Client,
  invoke: EmbeddingsInvoke,
  params: EmbeddingCreateParams,
  options: OpenAIAdapterOptions,
): Promise<EmbeddingResult> {
  await using rec = client.startEmbedding(buildEmbeddingSeed(params, options));
  try {
    const result = await invoke(params);
    recordEmbeddingResult(rec, params, result);
    return result;
  } catch (err) {
    rec.setCallError(err);
    throw err;
  }
}

/**
 * Instrument an `embeddings.create` call while preserving the SDK's
 * `APIPromise` (so `.withResponse()` / `.asResponse()` keep working). Mirrors
 * {@link instrumentChatCompletionApiPromise}; embeddings are never streamed.
 *
 * @internal
 */
export function instrumentEmbeddingApiPromise(
  client: Client,
  apiPromise: ApiPromiseLike<unknown>,
  params: EmbeddingCreateParams,
  options: OpenAIAdapterOptions,
): unknown {
  const rec = client.startEmbedding(buildEmbeddingSeed(params, options));
  return instrumentApiPromise(apiPromise, rec, (result) => {
    recordEmbeddingResult(rec, params, result as EmbeddingResult);
    void rec.end();
    return result;
  });
}

/** Builds the embedding recorder seed from the request params. */
function buildEmbeddingSeed(params: EmbeddingCreateParams, options: OpenAIAdapterOptions) {
  return {
    model: { provider: 'openai', name: params.model },
    agentName: options.agentName,
    agentVersion: options.agentVersion,
    dimensions: params.dimensions,
    encodingFormat: params.encoding_format,
    tags: options.tags,
    metadata: options.metadata,
  };
}

/** Records the result of an embedding call onto the recorder. */
function recordEmbeddingResult(
  rec: EmbeddingRecorder,
  params: EmbeddingCreateParams,
  result: EmbeddingResult,
): void {
  const inputs = Array.isArray(params.input)
    ? params.input.filter((v): v is string => typeof v === 'string')
    : typeof params.input === 'string'
      ? [params.input]
      : undefined;
  rec.setResult({
    inputCount: Array.isArray(params.input) ? params.input.length : 1,
    inputTokens: result.usage?.prompt_tokens,
    dimensions: result.data?.[0]?.embedding?.length,
    responseModel: result.model,
    inputTexts: inputs,
  });
}
