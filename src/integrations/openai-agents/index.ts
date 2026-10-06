/**
 * OpenAI Agents SDK adapter (`@genai-otel/core/openai-agents`).
 *
 * {@link GenAIOtelTracingProcessor} turns the SDK's traces into GenAI spans:
 * `invoke_agent`, `execute_tool`, `chat` on the AI SDK model path, and a run
 * container. Register it with the SDK's `addTraceProcessor`.
 *
 * On its own it cannot make spans from other instrumentations, such as OpenAI
 * `chat` spans, nest under agent spans: the SDK keeps no OTel context active
 * between its span callbacks. That needs the SDK's model classes patched.
 */

export {
  GenAIOtelTracingProcessor,
  type GenAIOtelTracingProcessorOptions,
} from './processor.js';

export type { SdkModel, SdkSpan, SdkTrace, SdkTracingProcessor } from './_sdk-types.js';
