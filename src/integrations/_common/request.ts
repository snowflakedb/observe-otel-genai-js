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

import type { OutputType } from '../../semconv.js';

/** `server.address` / `server.port` for a client's base URL. The port defaults to the scheme's. */
export function serverOf(baseURL: string | undefined): {
  serverAddress?: string;
  serverPort?: number;
} {
  if (!baseURL) return {};
  try {
    const url = new URL(baseURL);
    const port = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
    return { serverAddress: url.hostname, serverPort: port };
  } catch {
    return {};
  }
}

/** `gen_ai.output.type` for a requested response format (`json_schema`, `json_object`, `text`). */
export function outputTypeOf(format: string | undefined): OutputType | undefined {
  if (format === 'json_schema' || format === 'json_object') return 'json';
  if (format === 'text') return 'text';
  return undefined;
}
