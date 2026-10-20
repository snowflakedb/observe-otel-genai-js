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

import type { Meter, Tracer } from '@opentelemetry/api';
import type { ContentCapture, ContentCaptureMode } from './content/capture.js';
import { defaultContentCapture } from './content/capture.js';
import type { ErrorClassifier } from './errors/classify.js';
/**
 * Optional logger interface. Compatible with `console` so most users can pass
 * that in directly.
 */
export interface Logger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/**
 * Tunables for the bounded in-memory generation_id → SpanContext map used by
 * the span-link resolver.
 */
export interface SpanLinkMapConfig {
  /** Maximum number of entries kept in memory. */
  maxEntries: number;
  /** Time-to-live for an entry, in milliseconds. */
  ttlMs: number;
}

/**
 * Embedding-capture knobs. Controls how many `inputTexts` and how many chars
 * per text are attached to the embedding span as
 * `gen_ai.embeddings.input_texts`.
 */
export interface EmbeddingCaptureConfig {
  captureInput: boolean;
  maxInputItems: number;
  maxTextLength: number;
}

/**
 * Optional attributes added to every metric data point. All are off by default
 * because each one is high-cardinality: turning on `conversationId` adds a new
 * time series per conversation to every histogram, and `userId` one per user.
 */
export interface MetricAttributesConfig {
  /** Add `gen_ai.conversation.id` when the operation has one. */
  conversationId: boolean;
  /** Add `user.id` when the operation has one. */
  userId: boolean;
}

/**
 * Client-wide configuration. All fields are optional; the library applies
 * sensible defaults when omitted via {@link resolveConfig}.
 */
export interface ClientConfig {
  /** Override the OTel tracer. Mainly used in tests. */
  tracer?: Tracer;
  /** Override the OTel meter. Mainly used in tests. */
  meter?: Meter;
  /** Override the clock. Mainly used in tests. */
  now?: () => number;
  /** Optional logger; defaults to `console`. */
  logger?: Logger;

  /** Default `gen_ai.agent.name` when not provided per call. */
  agentName?: string;
  /** Default `gen_ai.agent.version` when not provided per call. */
  agentVersion?: string;
  /** Default `user.id` when not provided per call or via context. */
  userId?: string;
  /** Tags merged into every `GenerationStart.tags`. Per-call wins on conflict. */
  tags?: Record<string, string>;

  /**
   * Default content-capture mode. Resolution order at recording time:
   *   per-call → context → this default.
   * Unset, or `default`, means `metadata_only`: no content is emitted unless
   * the caller opts in with `no_tool_content` or `full`.
   */
  contentCaptureMode?: ContentCaptureMode;
  /** Truncation / blob-store / use-events configuration. */
  contentCapture?: ContentCapture;

  /** Custom error classifier (overrides the built-in HTTP-status sniffer). */
  errorClassifier?: ErrorClassifier;

  /** Embedding-input capture knobs. */
  embeddingCapture?: EmbeddingCaptureConfig;

  /** Tunables for the in-memory parent-generation span map. */
  spanLinkMap?: SpanLinkMapConfig;

  /** Opt-in metric attributes. */
  metricAttributes?: Partial<MetricAttributesConfig>;
}

/**
 * Fully populated config used by the runtime — same shape as `ClientConfig`
 * but every field is required and represents the effective value after
 * defaults.
 */
export interface ResolvedClientConfig {
  tracer?: Tracer;
  meter?: Meter;
  now: () => number;
  logger: Logger;

  agentName: string;
  agentVersion: string;
  userId: string;
  tags: Record<string, string>;

  contentCaptureMode: ContentCaptureMode;
  contentCapture: ContentCapture;

  errorClassifier?: ErrorClassifier;

  embeddingCapture: EmbeddingCaptureConfig;
  spanLinkMap: SpanLinkMapConfig;
  metricAttributes: MetricAttributesConfig;
}

const defaultLogger: Logger = {
  warn: console.warn.bind(console),
  debug: () => {
    /* no-op by default */
  },
};

export function defaultConfig(): ResolvedClientConfig {
  return {
    now: () => Date.now(),
    logger: defaultLogger,
    agentName: '',
    agentVersion: '',
    userId: '',
    tags: {},
    contentCaptureMode: 'metadata_only',
    contentCapture: defaultContentCapture(),
    embeddingCapture: {
      captureInput: false,
      maxInputItems: 20,
      maxTextLength: 1024,
    },
    spanLinkMap: {
      maxEntries: 10_000,
      ttlMs: 5 * 60 * 1000,
    },
    metricAttributes: {
      conversationId: false,
      userId: false,
    },
  };
}

/**
 * Merges a user-supplied (partial) `ClientConfig` with defaults. The returned
 * object is the one the `Client` runtime reads from.
 */
export function resolveConfig(input?: ClientConfig): ResolvedClientConfig {
  const base = defaultConfig();
  if (!input) return base;
  return {
    tracer: input.tracer,
    meter: input.meter,
    now: input.now ?? base.now,
    logger: input.logger ?? base.logger,
    agentName: input.agentName ?? base.agentName,
    agentVersion: input.agentVersion ?? base.agentVersion,
    userId: input.userId ?? base.userId,
    tags: { ...base.tags, ...(input.tags ?? {}) },
    contentCaptureMode: input.contentCaptureMode ?? base.contentCaptureMode,
    contentCapture: { ...base.contentCapture, ...(input.contentCapture ?? {}) },
    errorClassifier: input.errorClassifier,
    embeddingCapture: { ...base.embeddingCapture, ...(input.embeddingCapture ?? {}) },
    spanLinkMap: { ...base.spanLinkMap, ...(input.spanLinkMap ?? {}) },
    metricAttributes: { ...base.metricAttributes, ...(input.metricAttributes ?? {}) },
  };
}
