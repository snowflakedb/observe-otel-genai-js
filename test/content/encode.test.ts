import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT_ENCODING, encodeContentValue } from '../../src/content/encode.js';

describe('content encode', () => {
  it('defaults to json_string (OTel JS has no complex-attribute support yet)', () => {
    expect(DEFAULT_CONTENT_ENCODING).toBe('json_string');
  });

  it('json_string encodes structured values as a JSON string', () => {
    const value = [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }];
    const encoded = encodeContentValue(value, 'json_string');
    expect(typeof encoded).toBe('string');
    expect(JSON.parse(encoded as string)).toEqual(value);
  });

  it('structured falls back to a JSON string today to avoid SDK drop', () => {
    // Until opentelemetry-js#6579 ships, a nested object attribute value would be
    // dropped by the SDK; the encoder guards against silent data loss.
    const value = { a: 1, b: [2, 3] };
    const encoded = encodeContentValue(value, 'structured');
    expect(typeof encoded).toBe('string');
    expect(JSON.parse(encoded as string)).toEqual(value);
  });
});
