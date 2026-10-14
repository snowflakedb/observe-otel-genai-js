/**
 * Local types for the parts of `@openai/agents-core`'s tracing surface we read.
 *
 * They are declared here rather than imported so the published `.d.ts` does not
 * require `@openai/agents` to typecheck, and they name only the fields we use, so
 * a new SDK span type falls through to "ignored" instead of breaking the build.
 * `test/integrations/openai-agents-contract.test.ts` checks them against the real
 * SDK types.
 */

/** The SDK's per-span error record. */
export interface SdkSpanError {
  message: string;
  data?: Record<string, unknown>;
}

export interface SdkGenerationUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

export interface SdkAgentSpanData {
  type: 'agent';
  name: string;
}

export interface SdkFunctionSpanData {
  type: 'function';
  name: string;
  input: string;
  output: string;
  mcp_data?: string;
}

export interface SdkGenerationSpanData {
  type: 'generation';
  input?: Array<Record<string, unknown>>;
  output?: Array<Record<string, unknown>>;
  model?: string;
  model_config?: Record<string, unknown>;
  usage?: SdkGenerationUsage;
}

export interface SdkResponseSpanData {
  type: 'response';
  /** The request's input items, in the Agents protocol shape. */
  _input?: string | Array<Record<string, unknown>>;
  /** The complete OpenAI `Response` object. */
  _response?: Record<string, unknown>;
}

/** Every other span type. Only `type` is read. */
export interface SdkOtherSpanData {
  type: string;
  [key: string]: unknown;
}

export type SdkSpanData =
  | SdkAgentSpanData
  | SdkFunctionSpanData
  | SdkGenerationSpanData
  | SdkResponseSpanData
  | SdkOtherSpanData;

/** The SDK's `Span`. `startedAt` / `endedAt` are ISO-8601 strings. */
export interface SdkSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId: string | null;
  readonly spanData: SdkSpanData;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly error: SdkSpanError | null;
  /** The span that was current when this one started, normally its parent. */
  readonly previousSpan?: SdkSpan;
}

/** The SDK's `Trace`. `groupId` is the SDK's name for a conversation id. */
export interface SdkTrace {
  readonly traceId: string;
  readonly name: string;
  readonly groupId: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface SdkTracingProcessor {
  onTraceStart(trace: SdkTrace): Promise<void>;
  onTraceEnd(trace: SdkTrace): Promise<void>;
  onSpanStart(span: SdkSpan): Promise<void>;
  onSpanEnd(span: SdkSpan): Promise<void>;
  shutdown(timeout?: number): Promise<void>;
  forceFlush(): Promise<void>;
}

/** The two `Model` methods the context wrapper patches. */
export interface SdkModel {
  getResponse(request: unknown): Promise<unknown>;
  getStreamedResponse(request: unknown): AsyncIterable<unknown>;
}

/** Epoch ms from an SDK timestamp, or undefined when absent or unparseable. */
export function parseSdkTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
