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
  type GenerationSanitizer,
  type Logger,
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
  withAgentName,
  withAgentVersion,
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
export {
  toSemconvInputMessages,
  toSemconvOutputMessages,
  toSystemInstructions,
  type SemconvInstruction,
  type SemconvMessage,
  type SemconvPart,
} from './content/messages-schema.js';

// Recorder types (the user receives instances; the types are needed for
// generics in their own code).
export type {
  AgentCreationRecorder,
  AgentInvocationRecorder,
} from './recorders/agent.js';
export type { EmbeddingRecorder } from './recorders/embedding.js';
export type { GenerationRecorder } from './recorders/generation.js';
export type { ToolExecutionRecorder } from './recorders/tool.js';

// Models
export type { AgentCreationStart, AgentInvocationStart } from './models/agent.js';
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
  ATTR_CONVERSATION_ID,
  ATTR_GENERATION_ID,
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_MODEL,
  ATTR_SYSTEM_INSTRUCTIONS,
  ATTR_USAGE_INPUT_TOKENS,
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
  OP_TEXT_COMPLETION,
  SDK_NAME,
  TOKEN_USAGE_BUCKETS,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
  type ErrorCategory,
  type OperationName,
  type TokenType,
} from './semconv.js';
