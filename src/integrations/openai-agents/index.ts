/**
 * OpenAI Agents SDK adapter (`@genai-otel/core/openai-agents`).
 *
 * Most applications want `OpenAIAgentsInstrumentation` from
 * `@genai-otel/core/openai-agents/instrumentation`. The processor exported here is
 * for custom setups: on its own it emits agent, tool and AI SDK chat spans, but
 * spans from other instrumentations (such as OpenAI chat spans) will not nest
 * under them, and a run that rejects leaves its container span open until the
 * trace cap or `stop()` ends it.
 */

export {
  GenAIOtelTracingProcessor,
  type GenAIOtelTracingProcessorOptions,
} from './processor.js';

export type { SdkModel, SdkSpan, SdkTrace, SdkTracingProcessor } from './_sdk-types.js';
