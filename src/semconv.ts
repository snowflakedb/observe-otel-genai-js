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
/**
 * True when the effective context for this operation is a compacted view of a
 * longer conversation. Only ever set to `true` — leave unset otherwise.
 */
export const ATTR_CONVERSATION_COMPACTED = 'gen_ai.conversation.compacted';
/** Reasoning/thinking effort requested, verbatim as sent to the provider. */
export const ATTR_REQUEST_REASONING_LEVEL = 'gen_ai.request.reasoning.level';
export const ATTR_CONVERSATION_TITLE = 'genai.conversation.title';
export const ATTR_CONVERSATION_TURN_INDEX = 'genai.conversation.turn_index';
export const ATTR_CONVERSATION_TURN_ROLE = 'genai.conversation.turn_role';
export const ATTR_AGENT_NAME = 'gen_ai.agent.name';
export const ATTR_AGENT_VERSION = 'gen_ai.agent.version';
export const ATTR_AGENT_ID = 'gen_ai.agent.id';
export const ATTR_AGENT_DESCRIPTION = 'gen_ai.agent.description';
export const ATTR_USER_ID = 'user.id';
export const ATTR_SDK_NAME = 'genai.sdk.name';
export const ATTR_GENERATION_ID = 'genai.generation.id';
export const ATTR_PARENT_GENERATION_IDS = 'genai.parent_generation_ids';

/**
 * Provider-reported cost of an operation, in USD. GenAI semconv defines no cost
 * attribute, so this is a library extension. Only a few providers report real
 * cost (the Claude Agent SDK's `modelUsage[*].costUSD`, Bedrock); emit it when
 * the number comes from the provider, never when it is estimated locally.
 */
export const ATTR_USAGE_COST_USD = 'genai.usage.cost_usd';
/**
 * Marks token counts that are the provider's mid-stream figures rather than its
 * final ones, so a consumer knows not to trust them as authoritative totals.
 */
export const ATTR_USAGE_IS_PARTIAL = 'genai.usage.is_partial';

// Model
export const ATTR_PROVIDER_NAME = 'gen_ai.provider.name';
export const ATTR_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_RESPONSE_MODEL = 'gen_ai.response.model';
export const ATTR_RESPONSE_ID = 'gen_ai.response.id';
/** Seconds from request issuance to the first streamed chunk. */
export const ATTR_RESPONSE_TIME_TO_FIRST_CHUNK = 'gen_ai.response.time_to_first_chunk';

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
export const ATTR_REQUEST_STREAM = 'gen_ai.request.stream';
export const ATTR_OUTPUT_TYPE = 'gen_ai.output.type';

// Server (OTel general semconv — the GenAI provider endpoint).
export const ATTR_SERVER_ADDRESS = 'server.address';
export const ATTR_SERVER_PORT = 'server.port';

/** `gen_ai.output.type` well-known values. */
export type OutputType = 'text' | 'json' | 'image' | 'speech';

// Response / usage
export const ATTR_FINISH_REASONS = 'gen_ai.response.finish_reasons';
export const ATTR_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const ATTR_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
export const ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS = 'gen_ai.usage.cache_creation.input_tokens';
/**
 * Current semconv name for cache-write tokens; `cache_creation` above is the
 * older spelling this library still emits from its recorders. Adapters written
 * against current conventions should emit this one.
 */
export const ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS = 'gen_ai.usage.cache_write.input_tokens';
export const ATTR_USAGE_REASONING_TOKENS = 'gen_ai.usage.reasoning.output_tokens';

// Embedding
export const ATTR_EMBEDDING_INPUT_COUNT = 'gen_ai.embeddings.input_count';
export const ATTR_EMBEDDING_INPUT_TEXTS = 'gen_ai.embeddings.input_texts';
export const ATTR_EMBEDDING_DIMENSION_COUNT = 'gen_ai.embeddings.dimension.count';

// Retrieval (RAG context fetch from a vector DB / search system).
export const ATTR_DATA_SOURCE_ID = 'gen_ai.data_source.id';
export const ATTR_RETRIEVAL_TOP_K = 'gen_ai.retrieval.top_k';
export const ATTR_RETRIEVAL_DOCUMENTS = 'gen_ai.retrieval.documents';
export const ATTR_RETRIEVAL_QUERY_TEXT = 'gen_ai.retrieval.query.text';

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

// Content (truncation markers, applied as `<key>.truncated` siblings by the
// content sink; see content/capture.ts and content/sink.ts).

// Content (structured messages on span attributes — OTel GenAI semconv 1.37+).
// These hold the chat history / model responses / system instructions in the
// spec's structured message shape. Per the semconv, when recorded on spans they
// MAY be a JSON string if structured (nested) attribute values are not supported
// by the SDK — which is the case for OpenTelemetry JS today.
export const ATTR_INPUT_MESSAGES = 'gen_ai.input.messages';
export const ATTR_OUTPUT_MESSAGES = 'gen_ai.output.messages';
export const ATTR_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';

export const ATTR_TOOL_DEFINITIONS = 'gen_ai.tool.definitions';

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
export const OP_RETRIEVAL = 'retrieval';

export type OperationName =
  | typeof OP_CHAT
  | typeof OP_TEXT_COMPLETION
  | typeof OP_GENERATE_CONTENT
  | typeof OP_EMBEDDINGS
  | typeof OP_EXECUTE_TOOL
  | typeof OP_INVOKE_AGENT
  | typeof OP_CREATE_AGENT
  | typeof OP_RETRIEVAL;

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
export const TOKEN_TYPE_CACHE_CREATION = 'cache_creation';
export const TOKEN_TYPE_REASONING = 'reasoning';

export type TokenType =
  | typeof TOKEN_TYPE_INPUT
  | typeof TOKEN_TYPE_OUTPUT
  | typeof TOKEN_TYPE_CACHE_READ
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

// -----------------------------------------------------------------------------
// Identity
// -----------------------------------------------------------------------------

export const INSTRUMENTATION_NAME = '@genai-otel/core';
export const SDK_NAME = 'genai-otel-ts';
