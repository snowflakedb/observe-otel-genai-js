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
import type { ModelRef } from './generation.js';

/**
 * Seed fields used when embedding recording starts.
 */
export interface EmbeddingStart {
  model: ModelRef;
  agentName?: string;
  agentVersion?: string;
  conversationId?: string;
  userId?: string;
  dimensions?: number;
  /** e.g. `"float"`, `"base64"`. */
  encodingFormat?: string;
  /** GenAI provider endpoint host (`server.address`). */
  serverAddress?: string;
  /** GenAI provider endpoint port (`server.port`). */
  serverPort?: number;
  /** Per-call content-capture override (see `GenerationStart.contentCapture`). */
  contentCapture?: ContentCaptureMode;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  startedAt?: Date | number;
}

/**
 * Completion payload for an embedding span.
 */
export interface EmbeddingResult {
  inputCount?: number;
  inputTokens?: number;
  /** Optional sample of input texts (config-gated). */
  inputTexts?: string[];
  responseModel?: string;
  dimensions?: number;
}
