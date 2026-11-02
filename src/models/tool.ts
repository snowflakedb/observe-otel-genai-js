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

/**
 * Seed fields used when execute_tool recording starts.
 */
export interface ToolExecutionStart {
  toolName: string;
  toolCallId?: string;
  /** e.g. `"function"`, `"computer_use"`. */
  toolType?: string;
  toolDescription?: string;
  conversationId?: string;
  conversationTitle?: string;
  agentName?: string;
  agentVersion?: string;
  userId?: string;
  /** Provider/model that requested this tool (carried through for filters). */
  requestModel?: string;
  requestProvider?: string;
  /** Per-call content capture override; defaults to client config. */
  contentCapture?: ContentCaptureMode;
  startedAt?: Date | number;
}

/**
 * Completion payload for an execute_tool span.
 */
export interface ToolExecutionEnd {
  /** Arbitrary arguments object (will be JSON-stringified for span attrs). */
  arguments?: unknown;
  /** Arbitrary tool result (will be JSON-stringified for span attrs). */
  result?: unknown;
  completedAt?: Date | number;
}

/**
 * Options accepted by the optional `Client.executeToolCalls(...)` helper.
 * Reserved for forward compatibility; not used by core lifecycle.
 */
export interface ExecuteToolCallsOptions {
  conversationId?: string;
  conversationTitle?: string;
  agentName?: string;
  agentVersion?: string;
  contentCapture?: ContentCaptureMode;
  requestModel?: string;
  requestProvider?: string;
  toolType?: string;
  tags?: Record<string, string>;
}
