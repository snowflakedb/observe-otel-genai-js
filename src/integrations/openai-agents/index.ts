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
