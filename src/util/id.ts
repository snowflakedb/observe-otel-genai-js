/**
 * Random-ID generator used for generation_id, span fallback ids, etc.
 *
 * Uses `crypto.getRandomValues` when available (Node 20+, browsers, edge
 * runtimes) and falls back to `Math.random` otherwise. 8 random bytes is
 * sufficient for the library's purposes; we never use these for security.
 */

export function generateId(prefix: string): string {
  return `${prefix}_${randomHex(8)}`;
}

export function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteCount; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
