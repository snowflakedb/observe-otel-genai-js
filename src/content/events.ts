/**
 * Content emission via OTel span events.
 *
 * The library prefers `span.addEvent(...)` over `span.setAttribute(...)` for
 * large content because:
 *  - Events have generous size limits in most backends (Observe, Tempo, etc.).
 *  - Events have timestamps, so streaming response chunks naturally render as
 *    a timeline within the span.
 *  - Event count is bounded by `OTEL_SPAN_EVENT_COUNT_LIMIT` (default 128)
 *    so we can chunk freely.
 *
 * Wire-level event names follow the OTel GenAI semconv:
 *   - `gen_ai.system.message`     (system prompt)
 *   - `gen_ai.user.message`       (user input)
 *   - `gen_ai.assistant.message`  (assistant output, including thinking)
 *   - `gen_ai.tool.message`       (tool call / tool result)
 *   - `gen_ai.choice`             (model choice / completion)
 *
 * The body of each event is stored under `genai.content.body` (a
 * library-specific extension since the OTel spec recommends a structured body
 * but the JS API does not currently expose a structured body field).
 *
 * When `ContentCapture.useEvents` is `false`, callers fall back to span
 * attributes via the `applyContentAttribute` helper.
 */

import type { Span } from '@opentelemetry/api';
import { BlobStoreError } from '../errors.js';
import {
  ATTR_CONTENT_BODY,
  ATTR_CONTENT_INDEX,
  ATTR_CONTENT_ORIGINAL_SIZE_BYTES,
  ATTR_CONTENT_ROLE,
  ATTR_CONTENT_TRUNCATED,
  ATTR_CONTENT_TRUNCATION_STRATEGY,
  ATTR_CONTENT_URI,
  EVENT_CONTENT_COMPLETION,
  type EVENT_CONTENT_PROMPT,
  EVENT_CONTENT_TOOL_CALL,
  EVENT_CONTENT_TOOL_RESULT,
  EVENT_GENAI_ASSISTANT_MESSAGE,
  EVENT_GENAI_CHOICE,
  EVENT_GENAI_SYSTEM_MESSAGE,
  EVENT_GENAI_TOOL_MESSAGE,
  EVENT_GENAI_USER_MESSAGE,
} from '../semconv.js';
import { type ContentCapture, truncate } from './capture.js';

/**
 * Internal event kind used by recorders. `prompt` / `completion` /
 * `tool_call` / `tool_result` are mapped to spec-compliant wire-level event
 * names at emit time based on the message role.
 */
export type ContentEventKind =
  | typeof EVENT_CONTENT_PROMPT
  | typeof EVENT_CONTENT_COMPLETION
  | typeof EVENT_CONTENT_TOOL_CALL
  | typeof EVENT_CONTENT_TOOL_RESULT;

export interface EmitContentOptions {
  /** `user` / `assistant` / `tool` / `system` / `assistant.thinking` etc. */
  role?: string;
  /** Position within a sequence (0-based) when emitting multiple of the same kind. */
  index?: number;
  /** Stable key used when offloading to BlobStore (defaults to event_kind-index). */
  blobKey?: string;
}

/**
 * Maps the recorder-internal kind + role to a spec-compliant wire-level event
 * name. We hold to the spec's role-keyed event taxonomy:
 *   - System prompt          -> gen_ai.system.message
 *   - User input             -> gen_ai.user.message
 *   - Assistant input/output -> gen_ai.assistant.message  (or gen_ai.choice for completion)
 *   - Tool call/result       -> gen_ai.tool.message
 */
function resolveEventName(kind: ContentEventKind, role: string | undefined): string {
  if (kind === EVENT_CONTENT_TOOL_CALL || kind === EVENT_CONTENT_TOOL_RESULT) {
    return EVENT_GENAI_TOOL_MESSAGE;
  }
  if (kind === EVENT_CONTENT_COMPLETION) {
    return EVENT_GENAI_CHOICE;
  }
  // EVENT_CONTENT_PROMPT — derive from role.
  if (role === 'system') return EVENT_GENAI_SYSTEM_MESSAGE;
  if (role === 'assistant' || role === 'assistant.thinking') return EVENT_GENAI_ASSISTANT_MESSAGE;
  if (role === 'tool') return EVENT_GENAI_TOOL_MESSAGE;
  return EVENT_GENAI_USER_MESSAGE;
}

/**
 * Emits a content payload as a span event. Truncates per the capture config;
 * offloads to BlobStore when configured and the payload exceeds the cap.
 *
 * Returns `{ truncated, offloaded, uri? }` so callers can record additional
 * metrics or attributes if they care.
 */
export async function emitContentEvent(
  span: Span,
  kind: ContentEventKind,
  content: string,
  capture: ContentCapture,
  options: EmitContentOptions = {},
): Promise<{ truncated: boolean; offloaded: boolean; uri?: string }> {
  if (!capture.enabled) return { truncated: false, offloaded: false };
  if (!content) return { truncated: false, offloaded: false };

  const overflowed = content.length > capture.maxContentLength;
  let text = content;
  let truncated = false;
  let originalSizeBytes = Buffer.byteLength(content, 'utf8');
  let offloaded = false;
  let uri: string | undefined;

  if (overflowed && capture.blobStore) {
    const blobKey =
      options.blobKey ??
      `${kind.replace(/\./g, '_')}/${options.index ?? 0}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      uri = await capture.blobStore.put(blobKey, Buffer.from(content, 'utf8'));
      offloaded = true;
      text = '';
      truncated = false; // full content lives in the blob
    } catch (err) {
      if (!(err instanceof BlobStoreError)) {
        // Wrap unknown errors so callers can detect blob-store failures.
        throw new BlobStoreError(`BlobStore.put failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  if (!offloaded && overflowed) {
    const result = truncate(content, capture.maxContentLength, capture.truncationStrategy);
    text = result.text;
    truncated = result.truncated;
    originalSizeBytes = result.originalSizeBytes;
  }

  const attributes: Record<string, string | number | boolean> = {
    [ATTR_CONTENT_BODY]: text,
  };
  if (options.role) attributes[ATTR_CONTENT_ROLE] = options.role;
  if (options.index != null) attributes[ATTR_CONTENT_INDEX] = options.index;
  if (truncated) {
    attributes[ATTR_CONTENT_TRUNCATED] = true;
    attributes[ATTR_CONTENT_ORIGINAL_SIZE_BYTES] = originalSizeBytes;
    attributes[ATTR_CONTENT_TRUNCATION_STRATEGY] = capture.truncationStrategy;
  }
  if (uri) attributes[ATTR_CONTENT_URI] = uri;

  const eventName = resolveEventName(kind, options.role);
  span.addEvent(eventName, attributes);

  return { truncated, offloaded, uri };
}

/**
 * Fallback: stores content as a span attribute under `key`. Used when
 * `ContentCapture.useEvents` is false. Attribute storage is more aggressive
 * about truncation since backends limit per-attribute size more strictly.
 */
export function applyContentAttribute(
  span: Span,
  key: string,
  content: string | undefined,
  capture: ContentCapture,
): void {
  if (!capture.enabled || !content) return;
  const result = truncate(content, capture.maxContentLength, capture.truncationStrategy);
  span.setAttribute(key, result.text);
  if (result.truncated) {
    span.setAttribute(`${key}.truncated`, true);
    span.setAttribute(`${key}.original_size_bytes`, result.originalSizeBytes);
  }
}
