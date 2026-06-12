/**
 * Vercel AI SDK `LanguageModel` middleware.
 *
 * Unlike the `wrap*` function adapters in `index.ts` (which wrap the top-level
 * `generateText` / `streamText` / ... calls), this middleware operates at the
 * **provider** level: apply it to a model via `wrapLanguageModel({ model,
 * middleware: genaiOtelMiddleware(client) })` and every `doGenerate` /
 * `doStream` the model performs — including the per-step calls a
 * `ToolLoopAgent` / `Agent` makes internally — produces a genai-otel
 * generation span + metrics.
 *
 * This is the genai-otel equivalent of Traceloop's auto-instrumentation: one
 * wrap at the model, full coverage of an agentic loop.
 *
 * Targets AI SDK v6, whose internal provider spec is v3
 * (`LanguageModelMiddleware = LanguageModelV3Middleware`). Provider-level
 * shapes differ from the flattened top-level result shapes:
 *   - `usage` is nested: `{ inputTokens: { total, cacheRead, cacheWrite },
 *      outputTokens: { total, reasoning } }`.
 *   - `finishReason` is an object: `{ unified, raw }`.
 *   - `content` is an array of `{ type: 'text'|'reasoning'|'tool-call'|... }`.
 * These mappers are intentionally local (the granular `LanguageModelV3*` part
 * types are not re-exported from `ai`) and duck-type defensively.
 */

import type { LanguageModelMiddleware } from 'ai';

import type { Client } from '../../client.js';
import type { GenerationStart } from '../../models/generation.js';
import {
  type Message,
  assistantTextMessage,
  textPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';
import type { TokenUsage } from '../../models/usage.js';
import { OP_CHAT } from '../../semconv.js';
import { type VercelAdapterOptions, identityFields, modelRefFromAi } from './_model.js';

// -----------------------------------------------------------------------------
// Middleware factory
// -----------------------------------------------------------------------------

export function genaiOtelMiddleware(
  client: Client,
  options: VercelAdapterOptions = {},
): LanguageModelMiddleware {
  const middleware = {
    wrapGenerate: async ({
      doGenerate,
      model,
      params,
    }: {
      doGenerate: () => PromiseLike<ProviderGenerateResult>;
      model: unknown;
      params: ProviderCallParams;
    }): Promise<ProviderGenerateResult> => {
      const rec = client.startGeneration(startSeed(model, params, options));
      // Capture the prompt up-front so it's recorded even if the call throws.
      rec.setResult({ input: messagesFromPrompt(params.prompt) });

      try {
        const result = await doGenerate();
        rec.setResult({
          responseId: result.response?.id,
          responseModel: result.response?.modelId,
          stopReason: unifiedFinishReason(result.finishReason),
          usage: mapV3Usage(result.usage),
          output: messagesFromContent(result.content),
        });
        await rec.end();
        return result;
      } catch (err) {
        rec.setCallError(err);
        await safeEnd(rec);
        throw err;
      }
    },

    wrapStream: async ({
      doStream,
      model,
      params,
    }: {
      doStream: () => PromiseLike<ProviderStreamResult>;
      model: unknown;
      params: ProviderCallParams;
    }): Promise<ProviderStreamResult> => {
      const rec = client.startStreamingGeneration(startSeed(model, params, options));
      rec.setResult({ input: messagesFromPrompt(params.prompt) });

      let firstTokenSeen = false;
      let ended = false;
      const endOnce = async () => {
        if (ended) return;
        ended = true;
        await safeEnd(rec);
      };

      try {
        const { stream, ...rest } = await doStream();
        const textChunks: string[] = [];

        const instrumented = stream.pipeThrough(
          new TransformStream({
            transform(part: ProviderStreamPart, controller) {
              if (part.type === 'text-delta') {
                if (!firstTokenSeen) {
                  firstTokenSeen = true;
                  rec.setFirstTokenAt(Date.now());
                }
                if (typeof part.delta === 'string') textChunks.push(part.delta);
              } else if (part.type === 'response-metadata') {
                rec.setResult({ responseId: part.id, responseModel: part.modelId });
              } else if (part.type === 'finish') {
                rec.setResult({
                  stopReason: unifiedFinishReason(part.finishReason),
                  usage: mapV3Usage(part.usage),
                  output: textChunks.length
                    ? [assistantTextMessage(textChunks.join(''))]
                    : undefined,
                });
              }
              controller.enqueue(part);
            },
            async flush() {
              await endOnce();
            },
          }),
        );

        return { ...rest, stream: instrumented };
      } catch (err) {
        rec.setCallError(err);
        await endOnce();
        throw err;
      }
    },
  };

  return middleware as unknown as LanguageModelMiddleware;
}

// -----------------------------------------------------------------------------
// Recorder seed
// -----------------------------------------------------------------------------

function startSeed(
  model: unknown,
  params: ProviderCallParams,
  options: VercelAdapterOptions,
): GenerationStart {
  return {
    model: modelRefFromAi(model),
    operationName: OP_CHAT,
    ...identityFields(options),
    systemPrompt: systemPromptFromPrompt(params.prompt),
    maxTokens: params.maxOutputTokens,
    temperature: params.temperature,
    topP: params.topP,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stopSequences: normalizeStopSequences(params.stopSequences),
    seed: params.seed,
    tags: options.tags,
    metadata: options.metadata,
    parentGenerationIds: options.parentGenerationIds,
  };
}

async function safeEnd(rec: { end: () => Promise<void> }): Promise<void> {
  try {
    await rec.end();
  } catch {
    /* ignore */
  }
}

// -----------------------------------------------------------------------------
// Provider-level (LanguageModelV3) duck-typed shapes + mappers
// -----------------------------------------------------------------------------

interface ProviderCallParams {
  prompt?: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: unknown;
  seed?: number;
}

interface ProviderGenerateResult {
  content?: unknown;
  finishReason?: unknown;
  usage?: unknown;
  response?: { id?: string; modelId?: string };
}

interface ProviderStreamResult {
  stream: ReadableStream<ProviderStreamPart>;
  [k: string]: unknown;
}

interface ProviderStreamPart {
  type: string;
  delta?: string;
  id?: string;
  modelId?: string;
  finishReason?: unknown;
  usage?: unknown;
}

interface NestedTokenField {
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

function mapV3Usage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as { inputTokens?: NestedTokenField; outputTokens?: NestedTokenField };
  const input = u.inputTokens;
  const output = u.outputTokens;
  const out: TokenUsage = {
    inputTokens: input?.total,
    outputTokens: output?.total,
    cacheReadInputTokens: input?.cacheRead,
    cacheWriteInputTokens: input?.cacheWrite,
    reasoningTokens: output?.reasoning,
  };
  return out;
}

function unifiedFinishReason(finishReason: unknown): string | undefined {
  if (typeof finishReason === 'string') return finishReason;
  if (finishReason && typeof finishReason === 'object') {
    const fr = finishReason as { unified?: string };
    return fr.unified;
  }
  return undefined;
}

function normalizeStopSequences(s: unknown): string[] | undefined {
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
  return undefined;
}

// --- prompt (input) mapping ---------------------------------------------------

interface ProviderPromptMessage {
  role?: string;
  content?: unknown;
}

interface ProviderContentPart {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
}

function asMessageRole(role: string | undefined): Message['role'] {
  if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
  return 'user';
}

function messagesFromPrompt(prompt: unknown): Message[] {
  if (!Array.isArray(prompt)) return [];
  const messages: Message[] = [];
  for (const raw of prompt) {
    const msg = raw as ProviderPromptMessage;
    const role = asMessageRole(msg.role);
    if (typeof msg.content === 'string') {
      messages.push({ role, parts: [textPart(msg.content)] });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    const parts = partsFromContent(msg.content as ProviderContentPart[]);
    if (parts.length) messages.push({ role, parts });
  }
  return messages;
}

function partsFromContent(content: ProviderContentPart[]): Message['parts'] {
  const parts: Message['parts'] = [];
  for (const c of content) {
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') parts.push(textPart(c.text));
        break;
      case 'reasoning':
        if (typeof c.text === 'string') parts.push({ kind: 'thinking', thinking: c.text });
        break;
      case 'tool-call':
        parts.push(
          toolCallPart({
            name: c.toolName ?? '',
            id: c.toolCallId,
            inputJson: jsonString(c.input),
          }),
        );
        break;
      case 'tool-result':
        parts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            contentJson: jsonString(c.output),
          }),
        );
        break;
      default:
        // file / source / approval parts: skip (no text payload to record).
        break;
    }
  }
  return parts;
}

function messagesFromContent(content: unknown): Message[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = partsFromContent(content as ProviderContentPart[]);
  if (!parts.length) return undefined;
  return [{ role: 'assistant', parts }];
}

function systemPromptFromPrompt(prompt: unknown): string | undefined {
  if (!Array.isArray(prompt)) return undefined;
  const systems: string[] = [];
  for (const raw of prompt) {
    const msg = raw as ProviderPromptMessage;
    if (msg.role === 'system' && typeof msg.content === 'string') systems.push(msg.content);
  }
  return systems.length ? systems.join('\n\n') : undefined;
}

function jsonString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
