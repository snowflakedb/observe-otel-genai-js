import type { ContentCaptureMode } from '../content/capture.js';
import type { ParentGenerationRef } from './generation.js';
import type { Message } from './message.js';

/**
 * Seed fields used when invoke_agent recording starts. Wraps an agent's
 * overall task so nested LLM/tool calls parent under it via the active span
 * context.
 */
export interface AgentInvocationStart {
  agentName: string;
  agentId?: string;
  agentVersion?: string;
  agentDescription?: string;
  /**
   * The agent's input as structured chat messages. Emitted as the standard
   * `gen_ai.input.messages` attribute (subject to content-capture config).
   */
  input?: Message[];
  /** Model provider backing the agent (emitted as `gen_ai.provider.name`). */
  requestProvider?: string;
  /** Model the agent requests (emitted as `gen_ai.request.model`). */
  requestModel?: string;
  conversationId?: string;
  userId?: string;
  parentGenerationIds?: ParentGenerationRef[];
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  contentCapture?: ContentCaptureMode;
  startedAt?: Date | number;
}

/**
 * Seed fields used when create_agent recording starts. Captures the one-time
 * setup work that happens when an agent is initialized — loading config,
 * registering tools, building the system prompt, etc.
 *
 * Per the OTel GenAI semantic conventions, `create_agent` is a distinct
 * operation from `invoke_agent`. It does not have a `task` field (creation
 * is the agent definition, not a specific task) nor a `conversationId` or
 * `userId` (creation is per-agent, not per-conversation/user).
 */
export interface AgentCreationStart {
  agentName: string;
  agentId?: string;
  agentVersion?: string;
  agentDescription?: string;
  /** Model provider backing the agent (emitted as `gen_ai.provider.name`). */
  requestProvider?: string;
  /** Model the agent is configured to use (emitted as `gen_ai.request.model`). */
  requestModel?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  startedAt?: Date | number;
}
