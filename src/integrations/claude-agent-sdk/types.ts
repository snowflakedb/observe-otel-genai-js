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

/** Per-model totals from `result.modelUsage`, the only figures that cover subagents. */
export interface AgentModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Already counted in `outputTokens`. Absent on older CLIs. */
  thinkingTokens?: number;
  [key: string]: unknown;
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
  /** A tool's structured output. A delegation's carries its last call's final `usage`. */
  tool_use_result?: unknown;

  // system/init
  session_id?: string;
  model?: string;

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
  /** Cumulative over the whole call, subagents included. */
  total_cost_usd?: number;
  modelUsage?: Record<string, AgentModelUsage>;

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
