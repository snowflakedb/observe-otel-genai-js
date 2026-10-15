/**
 * Content-capture policy.
 *
 * Controls how much of a generation/tool's prompt, completion, and tool-call
 * payload makes it onto the exported telemetry. Modes are deliberately coarse
 * so they're easy to reason about in policy reviews. Content is always carried
 * as structured span attributes (`gen_ai.input.messages` etc.).
 */

import type { Span } from '@opentelemetry/api';

/**
 * Coarse switch for "what content is included at all":
 *  - `default`         → fall through to the next level (per-recorder → client default).
 *  - `full`            → include all content (prompts, completions, tool args/results).
 *  - `no_tool_content` → include prompts and completions, but strip tool args/results
 *                        and retrieval query/documents.
 *  - `metadata_only`   → strip ALL content; only structured metadata remains.
 *                        An unset or `default` client mode means this.
 *  - `allow_list`      → strip ALL content like `metadata_only`, and also drop every
 *                        span attribute whose key is not in `CONTENT_ALLOW_LIST`.
 */
export type ContentCaptureMode =
  | 'default'
  | 'full'
  | 'no_tool_content'
  | 'metadata_only'
  | 'allow_list';

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
  /**
   * Cap (in characters) on each content attribute. Defaults to
   * `DEFAULT_MAX_CONTENT_LENGTH`. Set `0` or a non-finite value (e.g.
   * `Infinity`) to turn the cap off and emit content in full.
   */
  maxContentLength?: number;
  /** How to truncate string payloads when a finite `maxContentLength` is set. */
  truncationStrategy: TruncationStrategy;
}

/**
 * Default cap on each content attribute: 1,048,576 characters. Kept large so
 * it only trims content that would otherwise make a span too big to export.
 */
export const DEFAULT_MAX_CONTENT_LENGTH = 1024 * 1024;

export function defaultContentCapture(): ContentCapture {
  return {
    enabled: true,
    maxContentLength: DEFAULT_MAX_CONTENT_LENGTH,
    truncationStrategy: 'middle',
  };
}

/** True when `maxContentLength` is a finite, positive cap that should truncate. */
export function isContentCapped(maxContentLength: number | undefined): maxContentLength is number {
  return (
    typeof maxContentLength === 'number' &&
    Number.isFinite(maxContentLength) &&
    maxContentLength > 0
  );
}

/**
 * Result of running content through the truncator. Carries the byte-count
 * delta so it can be reported via the `${attr}.original_size_bytes` marker.
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
 * Stores content as a span attribute under `key`, applying truncation. When the
 * payload overflows `maxContentLength`, the truncated body is written along with
 * `${key}.truncated` and `${key}.original_size_bytes` markers so the original
 * size is still visible on the span.
 */
export function applyContentAttribute(
  span: Span,
  key: string,
  content: string | undefined,
  capture: ContentCapture,
): void {
  if (!capture.enabled || !content) return;
  const cap = capture.maxContentLength;
  if (!isContentCapped(cap)) {
    span.setAttribute(key, content);
    return;
  }
  const result = truncate(content, cap, capture.truncationStrategy);
  span.setAttribute(key, result.text);
  if (result.truncated) {
    span.setAttribute(`${key}.truncated`, true);
    span.setAttribute(`${key}.original_size_bytes`, result.originalSizeBytes);
  }
}

/**
 * Resolves the effective capture mode given a per-call override, an ambient
 * context value, and a client-level default. `default` falls through, ending
 * at `metadata_only`.
 */
export function resolveContentCaptureMode(
  perCall: ContentCaptureMode | undefined,
  context: ContentCaptureMode | undefined,
  clientDefault: ContentCaptureMode,
): ContentCaptureMode {
  if (perCall && perCall !== 'default') return perCall;
  if (context && context !== 'default') return context;
  if (clientDefault === 'default') return 'metadata_only';
  return clientDefault;
}
