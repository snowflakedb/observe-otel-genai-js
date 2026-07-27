/**
 * Content sink — emits a generation's prompt/completion content onto a span as
 * structured `gen_ai.input.messages` / `gen_ai.output.messages` /
 * `gen_ai.system_instructions` attributes (semconv 1.37+ shape).
 *
 * Per the semconv, structured message values MAY be recorded as a JSON string
 * when the SDK does not support complex (nested) attribute values — which is
 * the case for OpenTelemetry JS today — so the values are JSON-encoded here.
 *
 * Size policy: by default there is no cap (matching OTel's own unbounded
 * attribute-value default). When a finite `maxContentLength` is configured, the
 * encoded value is trimmed to fit while staying valid JSON — long string leaves
 * (message text, tool arguments/results) are shortened in place so the message
 * structure is preserved and the attribute remains parseable.
 */

import type { Span } from '@opentelemetry/api';
import type { Generation } from '../models/generation.js';
import type { Message } from '../models/message.js';
import { ATTR_INPUT_MESSAGES, ATTR_OUTPUT_MESSAGES, ATTR_SYSTEM_INSTRUCTIONS } from '../semconv.js';
import { type ContentCapture, isContentCapped } from './capture.js';
import {
  resolveFinishReason,
  toSemconvInputMessages,
  toSemconvOutputMessages,
  toSystemInstructions,
} from './messages-schema.js';

/**
 * Emits a generation's content onto `span` as structured span attributes.
 */
export function emitGenerationContent(
  span: Span,
  generation: Generation,
  capture: ContentCapture,
): void {
  if (!capture.enabled) return;

  const input = toSemconvInputMessages(generation.input);
  const output = toSemconvOutputMessages(
    generation.output,
    resolveFinishReason(generation.stopReason, Boolean(generation.callError)),
  );
  const system = toSystemInstructions(generation.systemPrompt);

  if (system.length > 0) applyStructuredAttribute(span, ATTR_SYSTEM_INSTRUCTIONS, system, capture);
  if (input.length > 0) applyStructuredAttribute(span, ATTR_INPUT_MESSAGES, input, capture);
  if (output.length > 0) applyStructuredAttribute(span, ATTR_OUTPUT_MESSAGES, output, capture);
}

/**
 * Emits an agent invocation's content onto `span` as structured
 * `gen_ai.input.messages` / `gen_ai.output.messages` attributes. Shares the
 * generation size/truncation policy so a configured `maxContentLength` applies
 * uniformly across span types.
 */
export function emitAgentContent(
  span: Span,
  input: readonly Message[] | undefined,
  output: readonly Message[] | undefined,
  capture: ContentCapture,
  stopReason: string | undefined,
  hadError: boolean,
): void {
  if (!capture.enabled) return;

  const inputMessages = toSemconvInputMessages(input);
  const outputMessages = toSemconvOutputMessages(output, resolveFinishReason(stopReason, hadError));

  if (inputMessages.length > 0)
    applyStructuredAttribute(span, ATTR_INPUT_MESSAGES, inputMessages, capture);
  if (outputMessages.length > 0)
    applyStructuredAttribute(span, ATTR_OUTPUT_MESSAGES, outputMessages, capture);
}

/**
 * JSON-encodes a structured value and writes it as a span attribute. With no
 * finite cap the full value is emitted. When a cap is set and the value exceeds
 * it, the value is trimmed at the string-leaf level so the emitted attribute is
 * still valid JSON, and `${key}.truncated` / `${key}.original_size_bytes`
 * markers are written.
 */
function applyStructuredAttribute(
  span: Span,
  key: string,
  value: unknown,
  capture: ContentCapture,
): void {
  const encoded = JSON.stringify(value);
  const cap = capture.maxContentLength;
  if (!isContentCapped(cap) || encoded.length <= cap) {
    span.setAttribute(key, encoded);
    return;
  }

  const { json, originalSizeBytes } = truncateStructuredToFit(value, cap, encoded);
  span.setAttribute(key, json);
  span.setAttribute(`${key}.truncated`, true);
  span.setAttribute(`${key}.original_size_bytes`, originalSizeBytes);
}

interface StringLeaf {
  get(): string;
  set(value: string): void;
}

/**
 * Keys whose string values (and any strings nested beneath them) carry user
 * content and may be trimmed. Structural strings — `role`, `type`, `id`,
 * `name`, `finish_reason` — are never trimmed so the message shape stays intact.
 */
const CONTENT_KEYS = new Set(['content', 'arguments', 'response', 'text']);

/** Collects trimmable string leaves (content-bearing only), with in-place setters. */
function collectStringLeaves(node: unknown, leaves: StringLeaf[], inContent: boolean): void {
  if (Array.isArray(node)) {
    const arr = node as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (typeof v === 'string') {
        if (inContent) {
          leaves.push({
            get: () => arr[i] as string,
            set: (s) => {
              arr[i] = s;
            },
          });
        }
      } else if (v && typeof v === 'object') {
        collectStringLeaves(v, leaves, inContent);
      }
    }
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const childContent = inContent || CONTENT_KEYS.has(k);
      if (typeof v === 'string') {
        if (childContent) {
          leaves.push({
            get: () => obj[k] as string,
            set: (s) => {
              obj[k] = s;
            },
          });
        }
      } else if (v && typeof v === 'object') {
        collectStringLeaves(v, leaves, childContent);
      }
    }
  }
}

const TRUNCATION_MARKER = '\u2026';

/**
 * Trims a structured value so its JSON encoding fits within `cap` characters
 * while remaining valid JSON. Long string leaves are shortened proportionally
 * to their size; if structural overhead alone still exceeds the cap, whole
 * elements are dropped from the front of a top-level array (oldest first),
 * falling back to `[]` in the extreme case.
 */
function truncateStructuredToFit(
  value: unknown,
  cap: number,
  encoded: string,
): { json: string; originalSizeBytes: number } {
  const originalSizeBytes = Buffer.byteLength(encoded, 'utf8');
  const clone = structuredClone(value);

  const leaves: StringLeaf[] = [];
  collectStringLeaves(clone, leaves, false);

  const totalLeafChars = leaves.reduce((n, l) => n + l.get().length, 0);
  const structural = encoded.length - totalLeafChars;

  // Distribute the remaining budget across string leaves proportionally.
  const budget = cap - structural;
  if (totalLeafChars > 0 && budget > 0) {
    const factor = budget / totalLeafChars;
    for (const leaf of leaves) {
      const s = leaf.get();
      const keep = Math.floor(s.length * factor) - TRUNCATION_MARKER.length;
      if (keep < s.length) {
        leaf.set(keep <= 0 ? TRUNCATION_MARKER : s.slice(0, keep) + TRUNCATION_MARKER);
      }
    }
  }

  let json = JSON.stringify(clone);

  // Safety pass: escaping and markers can still nudge past the cap. Halve the
  // currently-longest leaf until we fit (bounded iterations).
  let guard = 0;
  while (json.length > cap && guard++ < 500) {
    let longest: StringLeaf | undefined;
    for (const l of leaves) {
      if (!longest || l.get().length > longest.get().length) longest = l;
    }
    if (!longest || longest.get().length <= 1) break;
    const s = longest.get();
    longest.set(s.slice(0, Math.max(1, Math.floor(s.length / 2))));
    json = JSON.stringify(clone);
  }

  // Last resort: structure alone exceeds the cap — drop oldest top-level
  // elements until it fits, down to an empty array.
  if (json.length > cap && Array.isArray(clone)) {
    while ((clone as unknown[]).length > 0 && json.length > cap) {
      (clone as unknown[]).shift();
      json = JSON.stringify(clone);
    }
  }

  return { json, originalSizeBytes };
}
