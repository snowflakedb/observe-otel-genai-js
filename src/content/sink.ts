/**
 * Content sink — the single entry point for emitting a generation's
 * prompt/completion content onto a span. Owns the carrier decision so the
 * recorder stays carrier-agnostic and a future carrier (e.g. standalone log
 * events) can be added here without touching the recorder.
 *
 * Carriers:
 *  - `span_attributes` (default): structured `gen_ai.input.messages` /
 *    `gen_ai.output.messages` / `gen_ai.system_instructions` attributes
 *    (JSON-string encoded today; see `content/encode.ts`) plus flat
 *    `genai.input.preview` / `genai.output.preview` strings for span tables.
 *  - `span_events`: legacy per-message span events (`gen_ai.user.message`,
 *    `gen_ai.choice`, ...), preserving prior behavior.
 *  - `none`: no content emitted.
 */

import type { Span } from '@opentelemetry/api';
import { BlobStoreError } from '../errors.js';
import type { Generation } from '../models/generation.js';
import type { Message } from '../models/message.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_INPUT_PREVIEW,
  ATTR_OUTPUT_MESSAGES,
  ATTR_OUTPUT_PREVIEW,
  ATTR_SYSTEM_INSTRUCTIONS,
  EVENT_CONTENT_COMPLETION,
  EVENT_CONTENT_PROMPT,
  EVENT_CONTENT_TOOL_CALL,
  EVENT_CONTENT_TOOL_RESULT,
} from '../semconv.js';
import { type ContentCapture, type ContentCarrier, truncate } from './capture.js';
import { encodeContentValue } from './encode.js';
import { type ContentEventKind, emitContentEvent } from './events.js';
import {
  previewOf,
  toSemconvInputMessages,
  toSemconvOutputMessages,
  toSystemInstructions,
} from './messages-schema.js';

/** Max chars for the flat preview attributes. */
const PREVIEW_MAX_CHARS = 256;

export interface EmitContentResult {
  /** Set when a blob-store offload failed; the recorder surfaces it as localError. */
  blobError?: BlobStoreError;
}

/**
 * Emits a generation's content onto `span` using the selected `carrier`.
 * Returns any blob-store error encountered so the recorder can record it; the
 * span is always populated with at least a truncated fallback.
 */
export async function emitGenerationContent(
  span: Span,
  generation: Generation,
  capture: ContentCapture,
  carrier: ContentCarrier,
): Promise<EmitContentResult> {
  if (!capture.enabled || carrier === 'none') return {};
  if (carrier === 'span_events') {
    return emitViaSpanEvents(span, generation, capture);
  }
  return emitViaSpanAttributes(span, generation, capture);
}

// -----------------------------------------------------------------------------
// span_attributes carrier (default)
// -----------------------------------------------------------------------------

async function emitViaSpanAttributes(
  span: Span,
  generation: Generation,
  capture: ContentCapture,
): Promise<EmitContentResult> {
  let blobError: BlobStoreError | undefined;

  const input = toSemconvInputMessages(generation.input);
  const output = toSemconvOutputMessages(generation.output, generation.stopReason || undefined);
  const system = toSystemInstructions(generation.systemPrompt);

  if (system.length > 0) {
    const e = await applyStructuredAttribute(span, ATTR_SYSTEM_INSTRUCTIONS, system, capture);
    blobError ??= e;
  }
  if (input.length > 0) {
    const e = await applyStructuredAttribute(span, ATTR_INPUT_MESSAGES, input, capture);
    blobError ??= e;
  }
  if (output.length > 0) {
    const e = await applyStructuredAttribute(span, ATTR_OUTPUT_MESSAGES, output, capture);
    blobError ??= e;
  }

  // Flat previews for span-table rendering (no decode needed downstream).
  const inputPreview = previewOf(generation.input, 'input', PREVIEW_MAX_CHARS);
  if (inputPreview) span.setAttribute(ATTR_INPUT_PREVIEW, inputPreview);
  const outputPreview = previewOf(generation.output, 'output', PREVIEW_MAX_CHARS);
  if (outputPreview) span.setAttribute(ATTR_OUTPUT_PREVIEW, outputPreview);

  return { blobError };
}

/**
 * Encodes a structured value and writes it as a span attribute, applying
 * truncation and (when configured) blob-store offload. On offload the full
 * payload goes to the blob store, `${key}.uri` is set, and a truncated value is
 * still written so the span remains queryable.
 */
async function applyStructuredAttribute(
  span: Span,
  key: string,
  value: unknown,
  capture: ContentCapture,
): Promise<BlobStoreError | undefined> {
  const encoded = String(encodeContentValue(value));
  const overflowed = encoded.length > capture.maxContentLength;

  if (!overflowed) {
    span.setAttribute(key, encoded);
    return undefined;
  }

  let blobError: BlobStoreError | undefined;
  if (capture.blobStore) {
    const blobKey = `${key.replace(/\./g, '_')}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const uri = await capture.blobStore.put(
        blobKey,
        Buffer.from(encoded, 'utf8'),
        'application/json',
      );
      span.setAttribute(`${key}.uri`, uri);
    } catch (err) {
      blobError =
        err instanceof BlobStoreError
          ? err
          : new BlobStoreError(`BlobStore.put failed: ${(err as Error).message}`, { cause: err });
    }
  }

  const result = truncate(encoded, capture.maxContentLength, capture.truncationStrategy);
  span.setAttribute(key, result.text);
  if (result.truncated) {
    span.setAttribute(`${key}.truncated`, true);
    span.setAttribute(`${key}.original_size_bytes`, result.originalSizeBytes);
  }
  return blobError;
}

// -----------------------------------------------------------------------------
// span_events carrier (legacy, retained)
// -----------------------------------------------------------------------------

async function emitViaSpanEvents(
  span: Span,
  generation: Generation,
  capture: ContentCapture,
): Promise<EmitContentResult> {
  let blobError: BlobStoreError | undefined;

  const emit = async (
    kind: ContentEventKind,
    text: string,
    options: { role?: string; index?: number },
  ): Promise<void> => {
    if (!text) return;
    try {
      await emitContentEvent(span, kind, text, capture, options);
    } catch (err) {
      if (err instanceof BlobStoreError) {
        blobError ??= err;
        // Fall back to a truncated event so the trace still shows content.
        await emitContentEvent(span, kind, text, { ...capture, blobStore: undefined }, options);
      } else {
        throw err;
      }
    }
  };

  if (generation.systemPrompt) {
    await emit(EVENT_CONTENT_PROMPT, generation.systemPrompt, { role: 'system', index: 0 });
  }
  const inputMsgs = generation.input ?? [];
  for (let i = 0; i < inputMsgs.length; i++) {
    const msg = inputMsgs[i]!;
    const text = messageToText(msg);
    await emit(EVENT_CONTENT_PROMPT, text, { role: msg.role, index: i + 1 });
  }

  const outputMsgs = generation.output ?? [];
  for (let i = 0; i < outputMsgs.length; i++) {
    const msg = outputMsgs[i]!;
    for (const part of msg.parts) {
      if (part.kind === 'text' && part.text) {
        await emit(EVENT_CONTENT_COMPLETION, part.text, { role: msg.role, index: i });
      } else if (part.kind === 'thinking' && part.thinking) {
        await emit(EVENT_CONTENT_COMPLETION, part.thinking, {
          role: 'assistant.thinking',
          index: i,
        });
      } else if (part.kind === 'tool_call' && part.toolCall?.inputJson) {
        await emit(EVENT_CONTENT_TOOL_CALL, part.toolCall.inputJson, {
          role: part.toolCall.name ?? 'tool',
          index: i,
        });
      } else if (part.kind === 'tool_result' && part.toolResult) {
        const content = part.toolResult.content ?? part.toolResult.contentJson ?? '';
        await emit(EVENT_CONTENT_TOOL_RESULT, content, { role: 'tool', index: i });
      }
    }
  }

  return { blobError };
}

function messageToText(msg: Message): string {
  const chunks: string[] = [];
  for (const part of msg.parts) {
    if (part.kind === 'text' && part.text) chunks.push(part.text);
    else if (part.kind === 'thinking' && part.thinking) chunks.push(part.thinking);
    else if (part.kind === 'tool_call' && part.toolCall?.inputJson)
      chunks.push(part.toolCall.inputJson);
    else if (part.kind === 'tool_result' && part.toolResult) {
      chunks.push(part.toolResult.content ?? part.toolResult.contentJson ?? '');
    }
  }
  return chunks.join('\n');
}
