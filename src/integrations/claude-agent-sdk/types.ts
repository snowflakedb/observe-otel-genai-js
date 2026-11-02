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
 * Structural types for the messages the Claude Agent SDK streams.
 *
 * Vendored rather than imported from `@anthropic-ai/claude-agent-sdk`: the SDK is
 * pre-1.0 and its message union churns between patch releases, while the adapter
 * reads only a few of its fields. These declare just those fields, so a new SDK field
 * is never a breaking change here.
 */

import type { AnthropicBlock } from '../_common/anthropic-blocks.js';

/** An Anthropic Messages API content block, relayed verbatim by the SDK. */
export type AgentContentBlock = AnthropicBlock;

/** Shape of `assistant.message`: an Anthropic Messages API message. */
interface AgentInnerMessage {
  /** Identifies the API call. Consecutive assistant messages share it. */
  id?: string;
  model?: string;
  content?: AgentContentBlock[] | string;
  stop_reason?: string | null;
  /** A mid-stream snapshot; the call's final figures come from `message_delta`. */
  usage?: AgentUsage;
  [key: string]: unknown;
}

/** Raw Anthropic usage counters. Cache counts are not included in `input_tokens`. */
export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

export interface AgentMessage {
  type?: string;
  subtype?: string;

  // assistant / user
  message?: AgentInnerMessage;
  /** Set when the message came from inside a subagent launched by that tool call. */
  parent_tool_use_id?: string | null;
  /** Set when an interrupt cut the message short. */
  aborted?: true;

  // system/init
  session_id?: string;
  model?: string;
  /** The tools the main agent can call this turn, MCP tools included. */
  tools?: string[];

  // stream_event
  /** Carried on `message_start`. */
  ttft_ms?: number;
  /** One Anthropic streaming event. `message_delta` carries the call's final usage. */
  event?: {
    type?: string;
    message?: { id?: string; model?: string; usage?: AgentUsage };
    delta?: { stop_reason?: string | null };
    usage?: AgentUsage;
  };

  // system/task_started, system/task_notification
  task_id?: string;
  /** Optional on task messages; `task_id` is the one id they always carry. */
  tool_use_id?: string;
  status?: 'completed' | 'failed' | 'stopped';
  /** The task's output, on `task_notification`. */
  summary?: string;
  /** What changed, on `task_updated`. */
  patch?: { status?: string };

  // result
  is_error?: boolean;
  /** The final assistant text, or the API error text when `is_error` is set. */
  result?: string;
  /** Why an early-stop subtype stopped. */
  errors?: string[];
  api_error_status?: number | null;
  /** Why the run stopped, e.g. `completed`, `api_error`, `max_turns`. */
  terminal_reason?: string;
  stop_reason?: string | null;

  [key: string]: unknown;
}

/** The subset of the SDK's `Options` the adapter reads. */
export interface AgentQueryOptions {
  model?: string;
  effort?: string;
  thinking?: { type?: string; budgetTokens?: number };
  /** Resuming or continuing a session: its first result already carries earlier usage. */
  resume?: string;
  continue?: boolean;
  /** Needed for per-call token totals and time to first token. */
  includePartialMessages?: boolean;
  systemPrompt?: unknown;
  /** Replaces the subprocess environment rather than merging into it. */
  env?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface AgentQueryParams {
  prompt: unknown;
  options?: AgentQueryOptions;
}

/**
 * Any function shaped like the SDK's `query`. Kept loose so the real `query` fits
 * without casts; the adapter reads its arguments as {@link AgentQueryParams}.
 */
export type AgentQueryFn = (params: never) => AsyncIterable<unknown>;

/** The subset of the SDK's `WarmQuery` the adapter uses. */
export interface AgentWarmQuery {
  query(prompt: never): AsyncIterable<unknown>;
}

/** Any function shaped like the SDK's `startup`, which pre-warms the CLI. */
export type AgentStartupFn = (params?: never) => Promise<AgentWarmQuery>;
