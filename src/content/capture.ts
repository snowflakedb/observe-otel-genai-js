/**
 * Content-capture policy.
 *
 * Controls how much of a generation/tool's prompt, completion, and tool-call
 * payload makes it onto the exported telemetry. Modes are deliberately coarse
 * so they're easy to reason about in policy reviews.
 */

import type { BlobStore } from './blob-store.js';

/**
 * Coarse switch for "what content is included at all":
 *  - `default`         → fall through to the next level (per-recorder → client default).
 *  - `full`            → include all content (prompts, completions, tool args/results).
 *  - `no_tool_content` → include prompts and completions, but strip tool args/results.
 *  - `metadata_only`   → strip ALL content; only structured metadata remains.
 */
export type ContentCaptureMode = 'default' | 'full' | 'no_tool_content' | 'metadata_only';

/**
 * Where prompt/completion content is carried on the telemetry:
 *  - `span_attributes` → structured `gen_ai.input.messages` /
 *    `gen_ai.output.messages` / `gen_ai.system_instructions` attributes on the
 *    generation span (semconv 1.37+ shape; JSON-string encoded today — see
 *    `content/encode.ts`). This is the default.
 *  - `span_events`     → legacy per-message span events
 *    (`gen_ai.user.message`, `gen_ai.choice`, ...). Retained for back-compat.
 *  - `none`            → no content carrier (metadata still emitted).
 */
export type ContentCarrier = 'span_attributes' | 'span_events' | 'none';

/**
 * Truncation strategy applied when content exceeds `maxContentLength`.
 *  - `middle`    → keep first 70% and last 30% with `...[truncated N chars]...` between.
 *  - `end`       → keep the head, trim from the tail.
 *  - `head_tail` → keep first and last 50% with the middle removed.
 */
export type TruncationStrategy = 'middle' | 'end' | 'head_tail';

/**
 * Per-recording content-capture configuration. Set on `ClientConfig` for the
 * default, or override per-call via the recorder seed.
 */
export interface ContentCapture {
  /** When false, no content is emitted at all (`metadata_only` equivalent). */
  enabled: boolean;
  /** Maximum chars per content payload before truncation/offload triggers. */
  maxContentLength: number;
  /** How to truncate when content exceeds `maxContentLength`. */
  truncationStrategy: TruncationStrategy;
  /**
   * @deprecated Use `carrier` instead. When `carrier` is unset, `useEvents:true`
   * maps to `carrier:'span_attributes'`? No — it maps to `carrier:'span_events'`
   * to preserve existing behavior; `useEvents:false` is ignored in favor of the
   * `carrier` default.
   *
   * When `true`, content is emitted as span events
   * (`gen_ai.user.message`, `gen_ai.choice`, ...).
   */
  useEvents: boolean;
  /**
   * Where content is carried. Defaults to `span_attributes` (structured
   * `gen_ai.*.messages` on the span). Takes precedence over `useEvents`; when
   * unset, a legacy `useEvents:true` is honored as `span_events`.
   */
  carrier?: ContentCarrier;
  /**
   * Optional blob store. When configured and content exceeds
   * `maxContentLength`, the library uploads the full content and the span
   * event carries a `gen_ai.content.uri` attribute instead of the truncated
   * body.
   */
  blobStore?: BlobStore;
}

export const DEFAULT_MAX_CONTENT_LENGTH = 32 * 1024;

export function defaultContentCapture(): ContentCapture {
  return {
    enabled: true,
    maxContentLength: DEFAULT_MAX_CONTENT_LENGTH,
    truncationStrategy: 'middle',
    useEvents: false,
    carrier: 'span_attributes',
  };
}

/**
 * Resolves the effective content carrier. Explicit `carrier` wins; otherwise a
 * legacy `useEvents:true` maps to `span_events`; otherwise `span_attributes`.
 */
export function resolveContentCarrier(capture: ContentCapture): ContentCarrier {
  if (capture.carrier) return capture.carrier;
  if (capture.useEvents) return 'span_events';
  return 'span_attributes';
}

/**
 * Result of running content through the truncator. Carries the byte-count
 * delta so it can be reported as `gen_ai.content.original_size_bytes`.
 */
export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalSizeBytes: number;
  truncationStrategy: TruncationStrategy;
}

/**
 * Truncates `value` to fit within `maxContentLength` using `strategy`.
 * Returns the original string verbatim when it already fits.
 */
export function truncate(
  value: string,
  maxContentLength: number,
  strategy: TruncationStrategy = 'middle',
): TruncationResult {
  const originalSizeBytes = Buffer.byteLength(value, 'utf8');
  if (value.length <= maxContentLength) {
    return {
      text: value,
      truncated: false,
      originalSizeBytes,
      truncationStrategy: strategy,
    };
  }

  let text: string;
  const cap = Math.max(maxContentLength, 0);

  if (cap <= 3) {
    text = value.slice(0, cap);
  } else if (strategy === 'end') {
    text = `${value.slice(0, cap - 3)}...`;
  } else if (strategy === 'head_tail') {
    const half = Math.floor((cap - 16) / 2);
    if (half <= 0) {
      text = value.slice(0, cap);
    } else {
      const removed = value.length - 2 * half;
      text = `${value.slice(0, half)}\n...[truncated ${removed} chars]...\n${value.slice(-half)}`;
    }
  } else {
    // middle: keep 70% head, 30% tail
    const overhead = 30;
    const remaining = Math.max(cap - overhead, 1);
    const headLen = Math.floor(remaining * 0.7);
    const tailLen = remaining - headLen;
    const removed = value.length - headLen - tailLen;
    text = `${value.slice(0, headLen)}\n...[truncated ${removed} chars]...\n${value.slice(-tailLen)}`;
  }

  return {
    text,
    truncated: true,
    originalSizeBytes,
    truncationStrategy: strategy,
  };
}

/**
 * Resolves the effective capture mode given a per-call override, an ambient
 * context value, and a client-level default. `default` falls through.
 */
export function resolveContentCaptureMode(
  perCall: ContentCaptureMode | undefined,
  context: ContentCaptureMode | undefined,
  clientDefault: ContentCaptureMode,
): ContentCaptureMode {
  if (perCall && perCall !== 'default') return perCall;
  if (context && context !== 'default') return context;
  if (clientDefault === 'default') return 'no_tool_content';
  return clientDefault;
}
