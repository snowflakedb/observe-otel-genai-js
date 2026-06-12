/**
 * Encodes a structured content value (from `content/messages-schema.ts`) into
 * an OpenTelemetry `AttributeValue` suitable for `span.setAttribute`.
 *
 * Why this is its own module: OpenTelemetry JS does not yet support complex
 * (nested object/array-of-object) attribute values. As of `@opentelemetry/api`
 * 1.9.1 the `AttributeValue` type is `string | number | boolean |
 * Array<primitive>` and the SDK's `Span.setAttribute` drops anything else via
 * `isAttributeValue()`. The OTel GenAI semconv anticipates exactly this:
 *
 *   "When recorded on spans, [gen_ai.*.messages] MAY be recorded as a JSON
 *    string if structured format is not supported and SHOULD be recorded in
 *    structured form otherwise."
 *
 * So today we encode as a JSON string (`'json_string'`). When OTel JS ships
 * complex attribute support (OTEP 4485 / OTLP 1.9.0; tracked in
 * open-telemetry/opentelemetry-js#6579), flip the default to `'structured'` and
 * the same structured value flows through untouched — no other code changes.
 */

import type { AttributeValue } from '@opentelemetry/api';

/**
 * How a structured content value is rendered onto a span attribute.
 *  - `json_string` -> `JSON.stringify(value)` (works on all OTel JS versions).
 *  - `structured`  -> emit the nested value as-is (requires OTel JS complex
 *                     attribute support; NOT available as of api 1.9.1).
 */
export type ContentEncoding = 'json_string' | 'structured';

/** The encoding used today. Flip to `'structured'` once OTel JS supports it. */
export const DEFAULT_CONTENT_ENCODING: ContentEncoding = 'json_string';

/**
 * Encodes `value` for use as a span attribute.
 *
 * For `'structured'` this would return the nested value directly. We guard it
 * because the current OTel JS SDK silently drops non-primitive attribute values
 * — returning the raw object would mean the attribute never reaches the wire.
 * Until open-telemetry/opentelemetry-js#6579 lands and releases, callers should
 * use `'json_string'`.
 */
export function encodeContentValue(
  value: unknown,
  encoding: ContentEncoding = DEFAULT_CONTENT_ENCODING,
): AttributeValue {
  if (encoding === 'structured') {
    // NOTE: Not reachable by default. When OTel JS supports complex attribute
    // values, return `value as AttributeValue` here and switch
    // DEFAULT_CONTENT_ENCODING to 'structured'. Until then this path would be
    // dropped by the SDK, so we fall back to a JSON string to avoid silent
    // data loss.
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}
