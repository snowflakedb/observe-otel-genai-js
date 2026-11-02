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

import type { ContentCaptureMode } from '../content/capture.js';
import type { OperationName, OutputType } from '../semconv.js';
import type { Message } from './message.js';
import type { TokenUsage } from './usage.js';

/**
 * Provider + model name pair. Used as the model identity on every recorder.
 */
export interface ModelRef {
  provider: string;
  name: string;
}

/**
 * A tool definition exposed to the model. The schema is application-defined;
 * we just pass it through unchanged.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  type?: string;
  /** JSON-encoded schema (string). */
  inputSchemaJson?: string;
}

/**
 * `gen_ai.conversation.snapshot_kind` values — describes what view of the
 * conversation the current `input` represents. See blueprint
 * "Reconstructing conversations under pruning".
 */
export type ConversationSnapshotKind =
  | 'raw'
  | 'pruned'
  | 'summarized'
  | 'sliding_window'
  | 'rag_augmented';

/**
 * `GenerationMode` matches the OTel operation flavor.
 *  - `SYNC`   → non-streaming, default operation is `chat`.
 *  - `STREAM` → streaming, default operation is `chat` with TTFT support.
 */
export type GenerationMode = 'SYNC' | 'STREAM';

/**
 * Either a string generation id (looked up in Client's in-memory map) or a
 * SpanContext-like object passed directly (for cross-process linkage).
 */
export type ParentGenerationRef = string | SpanContextLike;

/**
 * Minimal duck-typed shape we accept for a parent SpanContext, matching the
 * fields on `@opentelemetry/api`'s `SpanContext`. Kept structural so callers
 * who already use the OTel API can hand us one directly.
 */
export interface SpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  isRemote?: boolean;
  traceState?: { serialize(): string } | string;
}

/**
 * Seed fields used when generation recording starts. Captures everything we
 * know at request time; the matching `setResult(...)` payload fills in
 * response-side fields before `end()`.
 */
export interface GenerationStart {
  model: ModelRef;
  id?: string;
  conversationId?: string;
  conversationTitle?: string;
  userId?: string;
  agentName?: string;
  agentVersion?: string;
  mode?: GenerationMode;
  /** Override `gen_ai.operation.name`. Defaults to `chat` for v1. */
  operationName?: OperationName;
  systemPrompt?: string;

  /**
   * Per-call content-capture override. Resolution order at recording time:
   * this per-call value -> ambient context -> client default. `'default'`
   * (or unset) falls through.
   */
  contentCapture?: ContentCaptureMode;

  // Request controls
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  seed?: number;
  choiceCount?: number;
  toolChoice?: string;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;

  /** Requested output modality (`gen_ai.output.type`). */
  outputType?: OutputType;

  /** GenAI provider endpoint host (`server.address`). */
  serverAddress?: string;
  /** GenAI provider endpoint port (`server.port`). */
  serverPort?: number;

  tools?: ToolDefinition[];

  // Multi-turn ordering
  turnIndex?: number;
  turnRole?: string;
  conversationSnapshotKind?: ConversationSnapshotKind;

  // Free-form correlation
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;

  parentGenerationIds?: ParentGenerationRef[];
  effectiveVersion?: string;
  startedAt?: Date | number;
}

/**
 * Final normalized generation payload, populated by the user via `setResult`.
 * The recorder merges this with the seed before emitting span attributes and
 * metrics.
 */
export interface Generation {
  id?: string;
  conversationId?: string;
  conversationTitle?: string;
  userId?: string;
  agentName?: string;
  agentVersion?: string;
  mode?: GenerationMode;
  operationName?: OperationName;

  /** Set automatically from the active span context. */
  traceId?: string;
  spanId?: string;

  model?: Partial<ModelRef>;
  responseId?: string;
  responseModel?: string;

  systemPrompt?: string;

  // Request controls (carried through for emission at end())
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  seed?: number;
  choiceCount?: number;
  toolChoice?: string;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;

  outputType?: OutputType;
  serverAddress?: string;
  serverPort?: number;

  input?: Message[];
  output?: Message[];
  tools?: ToolDefinition[];

  usage?: TokenUsage;
  stopReason?: string;

  startedAt?: Date | number;
  completedAt?: Date | number;

  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;

  callError?: string;

  parentGenerationIds?: string[];
  effectiveVersion?: string;
}
