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
 * Public entry point for `@genai-otel/core`.
 *
 * Re-exports the user-facing surface. Internals (recorder base class, span
 * helpers, metric helpers, etc.) are intentionally not exported.
 */

// Client
export { Client } from './client.js';

// Config
export {
  defaultConfig,
  resolveConfig,
  type ClientConfig,
  type EmbeddingCaptureConfig,
  type Logger,
  type MetricAttributesConfig,
  type ResolvedClientConfig,
  type SpanLinkMapConfig,
} from './config.js';

// Context
export {
  agentNameFromContext,
  agentVersionFromContext,
  conversationIdFromContext,
  conversationTitleFromContext,
  contentCaptureModeFromContext,
  userIdFromContext,
  withAgent,
  withContext,
  withContentCaptureMode,
  withConversationId,
  withConversationTitle,
  withUserId,
} from './context.js';

// Errors
export {
  ClientShutdownError,
  FlushTimeoutError,
  GenAIOtelError,
  ValidationError,
} from './errors.js';
export { classifyError, type ErrorClassifier } from './errors/classify.js';

// Content
export {
  defaultContentCapture,
  DEFAULT_MAX_CONTENT_LENGTH,
  resolveContentCaptureMode,
  truncate,
  type ContentCapture,
  type ContentCaptureMode,
  type TruncationResult,
  type TruncationStrategy,
} from './content/capture.js';
export { CONTENT_ALLOW_LIST } from './content/allow-list.js';
export {
  resolveFinishReason,
  toSemconvInputMessages,
  toSemconvOutputMessages,
  toSystemInstructions,
  type SemconvInstruction,
  type SemconvMessage,
  type SemconvPart,
} from './content/messages-schema.js';
export {
  toToolDefinitions,
  type SemconvToolDefinition,
} from './content/tool-definitions-schema.js';

// Recorder types (the user receives instances; the types are needed for
// generics in their own code).
export type {
  AgentCreationRecorder,
  AgentInvocationRecorder,
} from './recorders/agent.js';
export type { EmbeddingRecorder } from './recorders/embedding.js';
export type { GenerationRecorder } from './recorders/generation.js';
export type { RetrievalRecorder } from './recorders/retrieval.js';
export type { ToolExecutionRecorder } from './recorders/tool.js';
export type { WorkflowInvocationRecorder } from './recorders/workflow.js';

// Models
export type { AgentCreationStart, AgentInvocationStart } from './models/agent.js';
export type { WorkflowInvocationStart } from './models/workflow.js';
export type {
  Generation,
  GenerationMode,
  GenerationStart,
  ModelRef,
  ParentGenerationRef,
  SpanContextLike,
  ToolDefinition,
  ConversationSnapshotKind,
} from './models/generation.js';
export type { EmbeddingResult, EmbeddingStart } from './models/embedding.js';
export type {
  RetrievalDocument,
  RetrievalResult,
  RetrievalStart,
} from './models/retrieval.js';
export type {
  ExecuteToolCallsOptions,
  ToolExecutionEnd,
  ToolExecutionStart,
} from './models/tool.js';
export type {
  Message,
  MessageRole,
  Part,
  PartKind,
  PartMetadata,
  ToolCall,
  ToolResult,
} from './models/message.js';
export type { TokenUsage } from './models/usage.js';

// Message builders
export {
  assistantTextMessage,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultMessage,
  toolResultPart,
  userTextMessage,
} from './models/message.js';

// Usage helpers
export { normalizeUsage } from './models/usage.js';

// Semconv constants — convenient for callers writing custom attribute sets.
export {
  ATTR_AGENT_NAME,
  ATTR_AGENT_VERSION,
  ATTR_CONVERSATION_COMPACTED,
  ATTR_CONVERSATION_ID,
  ATTR_DATA_SOURCE_ID,
  ATTR_GENERATION_ID,
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_REQUEST_REASONING_LEVEL,
  ATTR_RESPONSE_MODEL,
  ATTR_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_RETRIEVAL_DOCUMENTS,
  ATTR_RETRIEVAL_QUERY_TEXT,
  ATTR_RETRIEVAL_TOP_K,
  ATTR_SYSTEM_INSTRUCTIONS,
  ATTR_TOOL_DEFINITIONS,
  ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS,
  ATTR_USAGE_COST_USD,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_IS_PARTIAL,
  ATTR_USAGE_OUTPUT_TOKENS,
  DURATION_BUCKETS_SECONDS,
  ERR_CATEGORY_AUTH,
  ERR_CATEGORY_CLIENT,
  ERR_CATEGORY_RATE_LIMIT,
  ERR_CATEGORY_SDK,
  ERR_CATEGORY_SERVER,
  ERR_CATEGORY_TIMEOUT,
  INSTRUMENTATION_NAME,
  METRIC_OPERATION_DURATION,
  METRIC_TIME_TO_FIRST_TOKEN,
  METRIC_TOKEN_USAGE,
  METRIC_TOOL_CALLS_PER_OPERATION,
  OP_CHAT,
  OP_CREATE_AGENT,
  OP_EMBEDDINGS,
  OP_EXECUTE_TOOL,
  OP_GENERATE_CONTENT,
  OP_INVOKE_AGENT,
  OP_INVOKE_WORKFLOW,
  OP_RETRIEVAL,
  OP_TEXT_COMPLETION,
  SDK_NAME,
  TOKEN_USAGE_BUCKETS,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
  type ErrorCategory,
  type OperationName,
  type TokenType,
} from './semconv.js';
