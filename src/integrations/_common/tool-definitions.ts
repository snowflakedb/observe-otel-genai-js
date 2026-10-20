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

import type { ToolDefinition } from '../../models/generation.js';

/** Maps a request's tool list to tool definitions, skipping entries with no name. */
export function toolDefinitions(tools: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const defs = tools.map(normalizeToolDefinition).filter((d): d is ToolDefinition => !!d);
  return defs.length > 0 ? defs : undefined;
}

/**
 * Normalizes one provider-specific tool entry into `{ name, description?,
 * inputSchemaJson? }`. Handles the shapes OpenAI Chat Completions and
 * LangChain use:
 *   - OpenAI:    `{ type: 'function', function: { name, description, parameters } }`
 *                (or `custom: { name, description }` for a custom tool)
 *   - Anthropic: `{ name, description, input_schema }`
 *   - already-normalized: `{ name, description, parameters }`
 * The JSON schema is stored as a JSON string (`inputSchemaJson`); the content
 * sink parses it back into `parameters` for the semconv shape.
 */
function normalizeToolDefinition(raw: unknown): ToolDefinition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  // OpenAI wraps the definition under `function` or `custom`; other providers are flat.
  const wrapped = r.function ?? r.custom;
  const fn =
    wrapped && typeof wrapped === 'object' ? (wrapped as Record<string, unknown>) : undefined;
  const src = fn ?? r;

  const name = src.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;

  const def: ToolDefinition = { name };

  const description = src.description;
  if (typeof description === 'string' && description.length > 0) def.description = description;

  // `parameters` (OpenAI / normalized) or `input_schema` (Anthropic).
  const schema = src.parameters ?? src.input_schema ?? src.inputSchema ?? src.schema;
  if (schema != null) {
    const encoded = jsonOf(schema);
    if (encoded != null) def.inputSchemaJson = encoded;
  }

  // The OTel schema requires `type`. OpenAI carries it at the top level
  // (`type: 'function'`); Anthropic and bare/normalized tools don't, so default
  // to the cross-provider function-tool type.
  def.type = typeof r.type === 'string' && r.type.length > 0 ? r.type : 'function';

  return def;
}

function jsonOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
