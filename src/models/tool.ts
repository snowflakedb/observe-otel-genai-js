import type { ContentCaptureMode } from '../content/capture.js';

/**
 * Seed fields used when execute_tool recording starts.
 */
export interface ToolExecutionStart {
  toolName: string;
  toolCallId?: string;
  /** e.g. `"function"`, `"computer_use"`. */
  toolType?: string;
  toolDescription?: string;
  conversationId?: string;
  conversationTitle?: string;
  agentName?: string;
  agentVersion?: string;
  /** Provider/model that requested this tool (carried through for filters). */
  requestModel?: string;
  requestProvider?: string;
  /** Per-call content capture override; defaults to client config. */
  contentCapture?: ContentCaptureMode;
  startedAt?: Date | number;
}

/**
 * Completion payload for an execute_tool span.
 */
export interface ToolExecutionEnd {
  /** Arbitrary arguments object (will be JSON-stringified for span attrs). */
  arguments?: unknown;
  /** Arbitrary tool result (will be JSON-stringified for span attrs). */
  result?: unknown;
  completedAt?: Date | number;
}

/**
 * Options accepted by the optional `Client.executeToolCalls(...)` helper.
 * Reserved for forward compatibility; not used by core lifecycle.
 */
export interface ExecuteToolCallsOptions {
  conversationId?: string;
  conversationTitle?: string;
  agentName?: string;
  agentVersion?: string;
  contentCapture?: ContentCaptureMode;
  requestModel?: string;
  requestProvider?: string;
  toolType?: string;
  tags?: Record<string, string>;
}
