/*
 * Copyright 2026 Snowflake Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
