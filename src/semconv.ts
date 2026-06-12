/**
 * OpenTelemetry GenAI semantic-conventions attribute names and constants.
 *
 * All names mirror the OTel semconv proposal at
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/.  Library-specific
 * extensions live under the `genai.*` prefix to keep them clearly separated
 * from the standard `gen_ai.*` namespace.
 */

// -----------------------------------------------------------------------------
// Span attribute names
// -----------------------------------------------------------------------------

// Identity / routing
export const ATTR_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_CONVERSATION_ID = 'gen_ai.conversation.id';
export const ATTR_CONVERSATION_TITLE = 'genai.conversation.title';
export const ATTR_CONVERSATION_TURN_INDEX = 'gen_ai.conversation.turn_index';
export const ATTR_CONVERSATION_TURN_ROLE = 'gen_ai.conversation.turn_role';
export const ATTR_AGENT_NAME = 'gen_ai.agent.name';
export const ATTR_AGENT_VERSION = 'gen_ai.agent.version';
export const ATTR_AGENT_ID = 'gen_ai.agent.id';
export const ATTR_AGENT_DESCRIPTION = 'gen_ai.agent.description';
export const ATTR_AGENT_TASK = 'genai.agent.task';
export const ATTR_USER_ID = 'user.id';
export const ATTR_SDK_NAME = 'genai.sdk.name';
export const ATTR_GENERATION_ID = 'genai.generation.id';
export const ATTR_PARENT_GENERATION_IDS = 'genai.parent_generation_ids';

// Model
export const ATTR_PROVIDER_NAME = 'gen_ai.provider.name';
export const ATTR_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_RESPONSE_MODEL = 'gen_ai.response.model';
export const ATTR_RESPONSE_ID = 'gen_ai.response.id';

// Request controls
export const ATTR_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const ATTR_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
export const ATTR_REQUEST_TOP_P = 'gen_ai.request.top_p';
export const ATTR_REQUEST_FREQUENCY_PENALTY = 'gen_ai.request.frequency_penalty';
export const ATTR_REQUEST_PRESENCE_PENALTY = 'gen_ai.request.presence_penalty';
export const ATTR_REQUEST_STOP_SEQUENCES = 'gen_ai.request.stop_sequences';
export const ATTR_REQUEST_SEED = 'gen_ai.request.seed';
export const ATTR_REQUEST_CHOICE_COUNT = 'gen_ai.request.choice.count';
export const ATTR_REQUEST_TOOL_CHOICE = 'gen_ai.request.tool_choice';
export const ATTR_REQUEST_THINKING_ENABLED = 'gen_ai.request.thinking.enabled';
export const ATTR_REQUEST_THINKING_BUDGET = 'gen_ai.request.thinking.budget_tokens';
export const ATTR_REQUEST_ENCODING_FORMATS = 'gen_ai.request.encoding_formats';

// Response / usage
export const ATTR_FINISH_REASONS = 'gen_ai.response.finish_reasons';
export const ATTR_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const ATTR_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read_input_tokens';
export const ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS = 'gen_ai.usage.cache_write_input_tokens';
export const ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS = 'gen_ai.usage.cache_creation_input_tokens';
export const ATTR_USAGE_REASONING_TOKENS = 'gen_ai.usage.reasoning_tokens';

// Embedding
export const ATTR_EMBEDDING_INPUT_COUNT = 'gen_ai.embeddings.input_count';
export const ATTR_EMBEDDING_INPUT_TEXTS = 'gen_ai.embeddings.input_texts';
export const ATTR_EMBEDDING_DIMENSION_COUNT = 'gen_ai.embeddings.dimension.count';

// Tool
export const ATTR_TOOL_NAME = 'gen_ai.tool.name';
export const ATTR_TOOL_CALL_ID = 'gen_ai.tool.call.id';
export const ATTR_TOOL_TYPE = 'gen_ai.tool.type';
export const ATTR_TOOL_DESCRIPTION = 'gen_ai.tool.description';
export const ATTR_TOOL_CALL_ARGUMENTS = 'gen_ai.tool.call.arguments';
export const ATTR_TOOL_CALL_RESULT = 'gen_ai.tool.call.result';

// Errors
export const ATTR_ERROR_TYPE = 'error.type';
export const ATTR_ERROR_CATEGORY = 'error.category';

// Content (events)
export const ATTR_CONTENT_ROLE = 'gen_ai.content.role';
export const ATTR_CONTENT_INDEX = 'gen_ai.content.index';
export const ATTR_CONTENT_TRUNCATED = 'gen_ai.content.truncated';
export const ATTR_CONTENT_ORIGINAL_SIZE_BYTES = 'gen_ai.content.original_size_bytes';
export const ATTR_CONTENT_TRUNCATION_STRATEGY = 'gen_ai.content.truncation_strategy';
export const ATTR_CONTENT_URI = 'gen_ai.content.uri';

// Content (structured messages on span attributes — OTel GenAI semconv 1.37+).
// These hold the chat history / model responses / system instructions in the
// spec's structured message shape. Per the semconv, when recorded on spans they
// MAY be a JSON string if structured (nested) attribute values are not supported
// by the SDK — which is the case for OpenTelemetry JS today (see content/encode.ts).
export const ATTR_INPUT_MESSAGES = 'gen_ai.input.messages';
export const ATTR_OUTPUT_MESSAGES = 'gen_ai.output.messages';
export const ATTR_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';

// Content previews (library-specific extension, `genai.*` namespace). Short flat
// strings so consumers can render a content preview in a span table without
// decoding the full `gen_ai.*.messages` payload.
export const ATTR_INPUT_PREVIEW = 'genai.input.preview';
export const ATTR_OUTPUT_PREVIEW = 'genai.output.preview';

// -----------------------------------------------------------------------------
// Span event names
// -----------------------------------------------------------------------------

// Spec-compliant GenAI semconv content event names (current proposal).
// Role-keyed events for prompts; `gen_ai.choice` for completions; `gen_ai.tool.message`
// for tool results. The body of each event lives in `gen_ai.content.body`
// (library-specific extension under the `genai.*`-adjacent body key — the OTel
// spec recommends a structured body field but the JS API does not yet expose
// one, so we stash it on a single attribute).
export const EVENT_GENAI_SYSTEM_MESSAGE = 'gen_ai.system.message';
export const EVENT_GENAI_USER_MESSAGE = 'gen_ai.user.message';
export const EVENT_GENAI_ASSISTANT_MESSAGE = 'gen_ai.assistant.message';
export const EVENT_GENAI_TOOL_MESSAGE = 'gen_ai.tool.message';
export const EVENT_GENAI_CHOICE = 'gen_ai.choice';

// Body attribute on content events. Library-specific extension under the
// `genai.*` namespace so it does not collide with the spec.
export const ATTR_CONTENT_BODY = 'genai.content.body';

// Legacy event names kept for the recorder's internal `ContentEventKind` union.
// The wire-level event names are derived from message role at emit time.
export const EVENT_CONTENT_PROMPT = 'gen_ai.content.prompt';
export const EVENT_CONTENT_COMPLETION = 'gen_ai.content.completion';
export const EVENT_CONTENT_TOOL_CALL = 'gen_ai.content.tool_call';
export const EVENT_CONTENT_TOOL_RESULT = 'gen_ai.content.tool_result';

// -----------------------------------------------------------------------------
// `gen_ai.operation.name` values
// -----------------------------------------------------------------------------

export const OP_CHAT = 'chat';
export const OP_TEXT_COMPLETION = 'text_completion';
export const OP_GENERATE_CONTENT = 'generate_content';
export const OP_EMBEDDINGS = 'embeddings';
export const OP_EXECUTE_TOOL = 'execute_tool';
export const OP_INVOKE_AGENT = 'invoke_agent';
export const OP_CREATE_AGENT = 'create_agent';

export type OperationName =
  | typeof OP_CHAT
  | typeof OP_TEXT_COMPLETION
  | typeof OP_GENERATE_CONTENT
  | typeof OP_EMBEDDINGS
  | typeof OP_EXECUTE_TOOL
  | typeof OP_INVOKE_AGENT
  | typeof OP_CREATE_AGENT;

// -----------------------------------------------------------------------------
// Metric names + bucket boundaries
// -----------------------------------------------------------------------------

export const METRIC_OPERATION_DURATION = 'gen_ai.client.operation.duration';
export const METRIC_TOKEN_USAGE = 'gen_ai.client.token.usage';
export const METRIC_TIME_TO_FIRST_TOKEN = 'gen_ai.client.time_to_first_token';
export const METRIC_TOOL_CALLS_PER_OPERATION = 'gen_ai.client.tool_calls_per_operation';
export const METRIC_TOOL_EXECUTION_DURATION = 'gen_ai.client.tool_execution.duration';

export const METRIC_ATTR_TOKEN_TYPE = 'gen_ai.token.type';

export const TOKEN_TYPE_INPUT = 'input';
export const TOKEN_TYPE_OUTPUT = 'output';
export const TOKEN_TYPE_CACHE_READ = 'cache_read';
export const TOKEN_TYPE_CACHE_WRITE = 'cache_write';
export const TOKEN_TYPE_CACHE_CREATION = 'cache_creation';
export const TOKEN_TYPE_REASONING = 'reasoning';

export type TokenType =
  | typeof TOKEN_TYPE_INPUT
  | typeof TOKEN_TYPE_OUTPUT
  | typeof TOKEN_TYPE_CACHE_READ
  | typeof TOKEN_TYPE_CACHE_WRITE
  | typeof TOKEN_TYPE_CACHE_CREATION
  | typeof TOKEN_TYPE_REASONING;

/**
 * Duration buckets in seconds — powers of 2 from 10ms to ~82s.
 * Used as `explicitBucketBoundariesAdvisory` on operation.duration and TTFT.
 */
export const DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

/**
 * Token-usage buckets — powers of 4 from 1 to ~67M.
 * Used as `explicitBucketBoundariesAdvisory` on token.usage.
 */
export const TOKEN_USAGE_BUCKETS: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216,
  67_108_864,
];

// -----------------------------------------------------------------------------
// Error.category values
// -----------------------------------------------------------------------------

export const ERR_CATEGORY_TIMEOUT = 'timeout';
export const ERR_CATEGORY_RATE_LIMIT = 'rate_limit';
export const ERR_CATEGORY_AUTH = 'auth_error';
export const ERR_CATEGORY_SERVER = 'server_error';
export const ERR_CATEGORY_CLIENT = 'client_error';
export const ERR_CATEGORY_SDK = 'sdk_error';

export type ErrorCategory =
  | typeof ERR_CATEGORY_TIMEOUT
  | typeof ERR_CATEGORY_RATE_LIMIT
  | typeof ERR_CATEGORY_AUTH
  | typeof ERR_CATEGORY_SERVER
  | typeof ERR_CATEGORY_CLIENT
  | typeof ERR_CATEGORY_SDK
  | '';

// Error.type values
export const ERR_TYPE_PROVIDER_CALL = 'provider_call_error';
export const ERR_TYPE_MAPPING = 'mapping_error';
export const ERR_TYPE_TOOL_EXECUTION = 'tool_execution_error';
export const ERR_TYPE_VALIDATION = 'validation_error';
export const ERR_TYPE_BLOB_STORE = 'blob_store_error';

// -----------------------------------------------------------------------------
// Identity
// -----------------------------------------------------------------------------

export const INSTRUMENTATION_NAME = '@genai-otel/core';
export const SDK_NAME = 'genai-otel-ts';
