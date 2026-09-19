/**
 * Structural types for the messages the Claude Agent SDK streams.
 *
 * Deliberately vendored rather than imported from `@anthropic-ai/claude-agent-sdk`:
 * the SDK is pre-1.0, its `SDKMessage` union has ~38 members that churn between
 * patch releases, and the adapter only reads a dozen fields. Structural typing
 * keeps the adapter working across the whole 0.3.x range with no peer dep.
 *
 * These declare **only the fields the adapter reads**. Real messages carry far
 * more, so the index signature lets everything else through untyped — that is
 * what keeps a new SDK field from being a breaking change here. Every read is
 * defensive: an unknown message type is ignored, never a crash.
 */

import type { AnthropicBlock } from '../_common/anthropic-blocks.js';

/**
 * Anthropic Messages API content block. The Agent SDK relays these verbatim, so
 * this is the same vocabulary the Anthropic SDK adapter maps.
 */
export type AgentContentBlock = AnthropicBlock;

/** Shape of `assistant.message` — an Anthropic Messages API Message. */
export interface AgentInnerMessage {
  /** Identifies the API call. Consecutive assistant messages share it. */
  id?: string;
  model?: string;
  content?: AgentContentBlock[] | string;
  stop_reason?: string | null;
  /** Mid-stream counts, not final — the result message carries the totals. */
  usage?: AgentUsage;
  [key: string]: unknown;
}

/** Raw Anthropic usage counters. Cache counts are NOT included in `input_tokens`. */
export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Per-model totals from `result.modelUsage` — the field Anthropic documents as
 * correct for token and cost accounting, and the only one that covers subagents.
 */
export interface AgentModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  /** Canonical model id used for the pricing lookup; may differ from the key. */
  canonicalModel?: string;
  [key: string]: unknown;
}

export interface AgentMessage {
  type?: string;
  subtype?: string;

  // assistant / user
  message?: AgentInnerMessage;
  /** Non-null when the message came from inside a subagent started by that tool call. */
  parent_tool_use_id?: string | null;
  session_id?: string;
  /** Set when an interrupt truncated the message before the stream completed. */
  aborted?: true;

  // system/init
  model?: string;

  // stream_event
  /** Carried on `message_start`, before the first assistant message of that call. */
  ttft_ms?: number;
  /**
   * One Anthropic Messages API streaming event. `message_delta` is the only place
   * the stream carries a call's **final** usage and stop reason — the per-message
   * `message.usage` is a mid-stream snapshot that never gets corrected.
   */
  event?: {
    type?: string;
    delta?: { stop_reason?: string | null };
    usage?: AgentUsage & {
      output_tokens_details?: { thinking_tokens?: number };
    };
  };

  // system/task_started, system/task_notification
  /** The delegation this task message is about. */
  tool_use_id?: string;
  /** `completed`, or a failure state, on `task_notification`. */
  status?: string;
  /** The subagent's report, on `task_notification`. */
  summary?: string;

  // result
  is_error?: boolean;
  /**
   * On a `success` result this is the final assistant text — or, when `is_error` is
   * set, the API error text. The early-stop subtypes put their text in `errors`.
   */
  result?: string;
  /** Human-readable reasons behind an early-stop subtype. */
  errors?: string[];
  /** HTTP status when the run ended on an API error. */
  api_error_status?: number | null;
  /** Why the run stopped, e.g. `completed`, `api_error`, `max_turns`. */
  terminal_reason?: string;
  stop_reason?: string | null;
  total_cost_usd?: number;
  modelUsage?: Record<string, AgentModelUsage>;

  [key: string]: unknown;
}

/** The subset of `ClaudeAgentOptions` the adapter reads or augments. */
export interface AgentQueryOptions {
  model?: string;
  /** Reasoning effort, passed through verbatim to `gen_ai.request.reasoning.level`. */
  effort?: string;
  thinking?: { type?: string; budgetTokens?: number };
  /** Required for per-call TTFT: without it the SDK sends no `stream_event`s. */
  includePartialMessages?: boolean;
  systemPrompt?: string | { type?: string; preset?: string; append?: string };
  /** Replaces the subprocess environment rather than merging into it. */
  env?: Record<string, string | undefined>;
  [key: string]: unknown;
}

/** `query({ prompt, options })` — the function this adapter wraps. */
export type AgentQueryFn = (params: {
  prompt: unknown;
  options?: AgentQueryOptions;
}) => AsyncIterable<AgentMessage>;
