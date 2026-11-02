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
 * Anthropic content-block → `Part[]` mapping.
 *
 * Shared by the Anthropic SDK adapter and the Claude Agent SDK adapter: both
 * carry the same `text` / `thinking` / `tool_use` / `tool_result` block shapes,
 * because the Agent SDK relays Anthropic Messages API objects verbatim.
 *
 * Scope is deliberately just the block vocabulary. Helpers that assemble whole
 * request/response shapes have one caller each and live with that caller.
 *
 * Image and document blocks are not modeled and are skipped.
 */

import {
  type Part,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';

export interface AnthropicBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface AnthropicMessageParam {
  role?: string;
  content?: string | AnthropicBlock[];
}

/** JSON-encodes a value, passing strings through and swallowing cycles. */
function jsonOrUndef(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Maps one Anthropic content block to zero or more `Part`s. */
export function blockToParts(b: AnthropicBlock): Part[] {
  if (!b || typeof b !== 'object') return [];
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' && b.text ? [textPart(b.text)] : [];
    case 'thinking':
      return typeof b.thinking === 'string' && b.thinking ? [thinkingPart(b.thinking)] : [];
    case 'tool_use':
      return [toolCallPart({ name: b.name ?? '', id: b.id, inputJson: jsonOrUndef(b.input) })];
    case 'tool_result':
      return [
        toolResultPart({
          toolCallId: b.tool_use_id,
          content: typeof b.content === 'string' ? b.content : undefined,
          contentJson:
            b.content != null && typeof b.content !== 'string' ? jsonOrUndef(b.content) : undefined,
          isError: b.is_error,
        }),
      ];
    default:
      return [];
  }
}
