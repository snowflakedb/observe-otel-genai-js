/**
 * Span-attribute helpers.
 *
 * `setAttribute` skip-empty pattern: empty strings / undefined / null are
 * never written so backends do not store noisy nullish values. Each
 * applyXxxAttributes function is called both at start_span time (with seed
 * data) and again in end() (with merged result), so the final span has the
 * authoritative value for every field.
 */

import type { Span } from '@opentelemetry/api';
import type { AgentCreationStart, AgentInvocationStart } from '../models/agent.js';
import type { EmbeddingResult, EmbeddingStart } from '../models/embedding.js';
import type { Generation, GenerationStart } from '../models/generation.js';
import type { ToolExecutionStart } from '../models/tool.js';
import {
  ATTR_AGENT_DESCRIPTION,
  ATTR_AGENT_ID,
  ATTR_AGENT_NAME,
  ATTR_AGENT_TASK,
  ATTR_AGENT_VERSION,
  ATTR_CONVERSATION_ID,
  ATTR_CONVERSATION_TITLE,
  ATTR_CONVERSATION_TURN_INDEX,
  ATTR_CONVERSATION_TURN_ROLE,
  ATTR_EMBEDDING_DIMENSION_COUNT,
  ATTR_EMBEDDING_INPUT_COUNT,
  ATTR_EMBEDDING_INPUT_TEXTS,
  ATTR_FINISH_REASONS,
  ATTR_GENERATION_ID,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_TYPE,
  ATTR_PARENT_GENERATION_IDS,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_CHOICE_COUNT,
  ATTR_REQUEST_ENCODING_FORMATS,
  ATTR_REQUEST_FREQUENCY_PENALTY,
  ATTR_REQUEST_MAX_TOKENS,
  ATTR_REQUEST_MODEL,
  ATTR_REQUEST_PRESENCE_PENALTY,
  ATTR_REQUEST_SEED,
  ATTR_REQUEST_STOP_SEQUENCES,
  ATTR_REQUEST_STREAM,
  ATTR_REQUEST_TEMPERATURE,
  ATTR_REQUEST_THINKING_BUDGET,
  ATTR_REQUEST_THINKING_ENABLED,
  ATTR_REQUEST_TOOL_CHOICE,
  ATTR_REQUEST_TOP_P,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_SDK_NAME,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_TOOL_CALL_ID,
  ATTR_TOOL_DESCRIPTION,
  ATTR_TOOL_NAME,
  ATTR_TOOL_TYPE,
  ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  ATTR_USAGE_REASONING_TOKENS,
  ATTR_USER_ID,
  OP_CREATE_AGENT,
  OP_EMBEDDINGS,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
  SDK_NAME,
} from '../semconv.js';

// -----------------------------------------------------------------------------
// Skip-empty setter helpers
// -----------------------------------------------------------------------------

export function setStr(span: Span, key: string, value: string | undefined | null) {
  if (value == null) return;
  const trimmed = value.trim();
  if (trimmed === '') return;
  span.setAttribute(key, trimmed);
}

export function setRawStr(span: Span, key: string, value: string | undefined | null) {
  if (value == null) return;
  if (value === '') return;
  span.setAttribute(key, value);
}

export function setNum(span: Span, key: string, value: number | undefined | null) {
  if (value == null) return;
  if (!Number.isFinite(value)) return;
  span.setAttribute(key, value);
}

export function setBool(span: Span, key: string, value: boolean | undefined | null) {
  if (value == null) return;
  span.setAttribute(key, value);
}

export function setStrArray(span: Span, key: string, value: string[] | undefined | null) {
  if (!value || value.length === 0) return;
  span.setAttribute(key, value);
}

// -----------------------------------------------------------------------------
// Generation
// -----------------------------------------------------------------------------

/**
 * View used to apply attributes — accepts either a `GenerationStart` (initial
 * pass) or a normalized `Generation` (final pass). The two share enough fields
 * that one function can handle both.
 *
 * `parentGenerationIds` is intentionally `unknown[]` here so the
 * GenerationStart shape (which carries SpanContextLike entries) and the
 * Generation shape (which carries strings) both fit. The renderer below
 * normalizes each entry through `parentRefToString`.
 */
export type GenerationAttributeView = Omit<Partial<Generation>, 'parentGenerationIds'> &
  Omit<Partial<GenerationStart>, 'parentGenerationIds'> & {
    model?: Partial<{ provider: string; name: string }>;
    parentGenerationIds?: readonly unknown[];
  };

export function applyGenerationAttributes(span: Span, view: GenerationAttributeView) {
  setStr(span, ATTR_OPERATION_NAME, view.operationName);
  setStr(span, ATTR_SDK_NAME, SDK_NAME);

  setStr(span, ATTR_GENERATION_ID, view.id);
  setStr(span, ATTR_CONVERSATION_ID, view.conversationId);
  setStr(span, ATTR_CONVERSATION_TITLE, view.conversationTitle);
  setStr(span, ATTR_USER_ID, view.userId);
  setStr(span, ATTR_AGENT_NAME, view.agentName);
  setStr(span, ATTR_AGENT_VERSION, view.agentVersion);

  setStr(span, ATTR_PROVIDER_NAME, view.model?.provider);
  setStr(span, ATTR_REQUEST_MODEL, view.model?.name);
  setStr(span, ATTR_RESPONSE_MODEL, view.responseModel);
  setStr(span, ATTR_RESPONSE_ID, view.responseId);

  setNum(span, ATTR_REQUEST_MAX_TOKENS, view.maxTokens);
  setNum(span, ATTR_REQUEST_TEMPERATURE, view.temperature);
  setNum(span, ATTR_REQUEST_TOP_P, view.topP);
  setNum(span, ATTR_REQUEST_FREQUENCY_PENALTY, view.frequencyPenalty);
  setNum(span, ATTR_REQUEST_PRESENCE_PENALTY, view.presencePenalty);
  setNum(span, ATTR_REQUEST_SEED, view.seed);
  setNum(span, ATTR_REQUEST_CHOICE_COUNT, view.choiceCount);
  setStr(span, ATTR_REQUEST_TOOL_CHOICE, view.toolChoice);
  setStrArray(span, ATTR_REQUEST_STOP_SEQUENCES, view.stopSequences);
  setBool(span, ATTR_REQUEST_THINKING_ENABLED, view.thinkingEnabled);
  setNum(span, ATTR_REQUEST_THINKING_BUDGET, view.thinkingBudgetTokens);
  setStr(span, ATTR_OUTPUT_TYPE, view.outputType);
  setStr(span, ATTR_SERVER_ADDRESS, view.serverAddress);
  setNum(span, ATTR_SERVER_PORT, view.serverPort);
  if (view.mode === 'STREAM') setBool(span, ATTR_REQUEST_STREAM, true);

  setNum(span, ATTR_CONVERSATION_TURN_INDEX, view.turnIndex);
  setStr(span, ATTR_CONVERSATION_TURN_ROLE, view.turnRole);

  const parents = view.parentGenerationIds;
  if (parents && parents.length > 0) {
    span.setAttribute(
      ATTR_PARENT_GENERATION_IDS,
      parents.map((p: unknown) => parentRefToString(p)),
    );
  }

  if (view.stopReason && view.stopReason.length > 0) {
    span.setAttribute(ATTR_FINISH_REASONS, [view.stopReason]);
  }

  const usage = view.usage;
  if (usage) {
    if (usage.inputTokens) setNum(span, ATTR_USAGE_INPUT_TOKENS, usage.inputTokens);
    if (usage.outputTokens) setNum(span, ATTR_USAGE_OUTPUT_TOKENS, usage.outputTokens);
    if (usage.cacheReadInputTokens)
      setNum(span, ATTR_USAGE_CACHE_READ_INPUT_TOKENS, usage.cacheReadInputTokens);
    if (usage.cacheCreationInputTokens)
      setNum(span, ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS, usage.cacheCreationInputTokens);
    if (usage.reasoningTokens) setNum(span, ATTR_USAGE_REASONING_TOKENS, usage.reasoningTokens);
  }
}

// -----------------------------------------------------------------------------
// Embedding
// -----------------------------------------------------------------------------

export function applyEmbeddingStartAttributes(span: Span, start: EmbeddingStart) {
  setStr(span, ATTR_OPERATION_NAME, OP_EMBEDDINGS);
  setStr(span, ATTR_SDK_NAME, SDK_NAME);
  setStr(span, ATTR_PROVIDER_NAME, start.model.provider);
  setStr(span, ATTR_REQUEST_MODEL, start.model.name);
  setStr(span, ATTR_AGENT_NAME, start.agentName);
  setStr(span, ATTR_AGENT_VERSION, start.agentVersion);
  setNum(span, ATTR_EMBEDDING_DIMENSION_COUNT, start.dimensions);
  if (start.encodingFormat && start.encodingFormat.trim() !== '') {
    span.setAttribute(ATTR_REQUEST_ENCODING_FORMATS, [start.encodingFormat.trim()]);
  }
}

export function applyEmbeddingEndAttributes(
  span: Span,
  result: EmbeddingResult,
  capturedInputTexts: string[] | undefined,
) {
  setNum(span, ATTR_EMBEDDING_INPUT_COUNT, result.inputCount);
  setNum(span, ATTR_USAGE_INPUT_TOKENS, result.inputTokens);
  setStr(span, ATTR_RESPONSE_MODEL, result.responseModel);
  setNum(span, ATTR_EMBEDDING_DIMENSION_COUNT, result.dimensions);
  if (capturedInputTexts && capturedInputTexts.length > 0) {
    span.setAttribute(ATTR_EMBEDDING_INPUT_TEXTS, capturedInputTexts);
  }
}

// -----------------------------------------------------------------------------
// Tool execution
// -----------------------------------------------------------------------------

export function applyToolAttributes(span: Span, start: ToolExecutionStart) {
  setStr(span, ATTR_OPERATION_NAME, OP_EXECUTE_TOOL);
  setStr(span, ATTR_TOOL_NAME, start.toolName);
  setStr(span, ATTR_SDK_NAME, SDK_NAME);

  setStr(span, ATTR_TOOL_CALL_ID, start.toolCallId);
  setStr(span, ATTR_TOOL_TYPE, start.toolType);
  setStr(span, ATTR_TOOL_DESCRIPTION, start.toolDescription);
  setStr(span, ATTR_CONVERSATION_ID, start.conversationId);
  setStr(span, ATTR_CONVERSATION_TITLE, start.conversationTitle);
  setStr(span, ATTR_AGENT_NAME, start.agentName);
  setStr(span, ATTR_AGENT_VERSION, start.agentVersion);
  setStr(span, ATTR_PROVIDER_NAME, start.requestProvider);
  setStr(span, ATTR_REQUEST_MODEL, start.requestModel);
}

// -----------------------------------------------------------------------------
// Agent invocation
// -----------------------------------------------------------------------------

export function applyAgentAttributes(span: Span, start: AgentInvocationStart) {
  setStr(span, ATTR_OPERATION_NAME, OP_INVOKE_AGENT);
  setStr(span, ATTR_SDK_NAME, SDK_NAME);

  setStr(span, ATTR_AGENT_NAME, start.agentName);
  setStr(span, ATTR_AGENT_ID, start.agentId);
  setStr(span, ATTR_AGENT_VERSION, start.agentVersion);
  setStr(span, ATTR_AGENT_DESCRIPTION, start.agentDescription);
  setStr(span, ATTR_AGENT_TASK, start.task);
  setStr(span, ATTR_CONVERSATION_ID, start.conversationId);
  setStr(span, ATTR_USER_ID, start.userId);

  if (start.parentGenerationIds && start.parentGenerationIds.length > 0) {
    span.setAttribute(
      ATTR_PARENT_GENERATION_IDS,
      start.parentGenerationIds.map((p: unknown) => parentRefToString(p)),
    );
  }
}

// -----------------------------------------------------------------------------
// Agent creation
// -----------------------------------------------------------------------------

export function applyAgentCreationAttributes(span: Span, start: AgentCreationStart) {
  setStr(span, ATTR_OPERATION_NAME, OP_CREATE_AGENT);
  setStr(span, ATTR_SDK_NAME, SDK_NAME);

  setStr(span, ATTR_AGENT_NAME, start.agentName);
  setStr(span, ATTR_AGENT_ID, start.agentId);
  setStr(span, ATTR_AGENT_VERSION, start.agentVersion);
  setStr(span, ATTR_AGENT_DESCRIPTION, start.agentDescription);
}

function parentRefToString(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object') {
    const r = ref as { traceId?: string; spanId?: string };
    if (r.traceId && r.spanId) return `${r.traceId}:${r.spanId}`;
  }
  return '';
}
