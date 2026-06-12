/**
 * Content sink — emits a generation's prompt/completion content onto a span as
 * structured `gen_ai.input.messages` / `gen_ai.output.messages` /
 * `gen_ai.system_instructions` attributes (semconv 1.37+ shape).
 *
 * Per the semconv, structured message values MAY be recorded as a JSON string
 * when the SDK does not support complex (nested) attribute values — which is
 * the case for OpenTelemetry JS today — so the values are JSON-encoded here.
 */

import type { Span } from '@opentelemetry/api';
import type { Generation } from '../models/generation.js';
import { ATTR_INPUT_MESSAGES, ATTR_OUTPUT_MESSAGES, ATTR_SYSTEM_INSTRUCTIONS } from '../semconv.js';
import { type ContentCapture, truncate } from './capture.js';
import {
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
  const output = toSemconvOutputMessages(generation.output, generation.stopReason || undefined);
  const system = toSystemInstructions(generation.systemPrompt);

  if (system.length > 0) applyStructuredAttribute(span, ATTR_SYSTEM_INSTRUCTIONS, system, capture);
  if (input.length > 0) applyStructuredAttribute(span, ATTR_INPUT_MESSAGES, input, capture);
  if (output.length > 0) applyStructuredAttribute(span, ATTR_OUTPUT_MESSAGES, output, capture);
}

/**
 * JSON-encodes a structured value and writes it as a span attribute, applying
 * truncation when it exceeds `maxContentLength`. On truncation, `${key}.truncated`
 * and `${key}.original_size_bytes` markers are also written so the span stays
 * queryable.
 */
function applyStructuredAttribute(
  span: Span,
  key: string,
  value: unknown,
  capture: ContentCapture,
): void {
  const encoded = JSON.stringify(value);
  if (encoded.length <= capture.maxContentLength) {
    span.setAttribute(key, encoded);
    return;
  }

  const result = truncate(encoded, capture.maxContentLength, capture.truncationStrategy);
  span.setAttribute(key, result.text);
  if (result.truncated) {
    span.setAttribute(`${key}.truncated`, true);
    span.setAttribute(`${key}.original_size_bytes`, result.originalSizeBytes);
  }
}
