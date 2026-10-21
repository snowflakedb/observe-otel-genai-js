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
import type { Message } from './message.js';

/**
 * Seed fields used when invoke_workflow recording starts. A workflow runs a fixed
 * sequence of steps (model calls, tools, agents) and decides nothing on its own,
 * so it has no agent name.
 */
export interface WorkflowInvocationStart {
  /** Emitted as `gen_ai.workflow.name` and in the span name. */
  workflowName?: string;
  /**
   * The workflow's input as structured chat messages. Emitted as the standard
   * `gen_ai.input.messages` attribute (subject to content-capture config).
   */
  input?: Message[];
  /** When unset, taken from the enclosing scope or the client config. */
  conversationId?: string;
  /** When unset, taken from the enclosing scope or the client config. */
  userId?: string;
  contentCapture?: ContentCaptureMode;
  startedAt?: Date | number;
}
