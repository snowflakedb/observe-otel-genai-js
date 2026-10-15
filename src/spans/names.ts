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
 * Span name format helpers.
 *
 * Convention: `<operation> <model_or_target>` (e.g. `chat gpt-4o`,
 * `execute_tool search`). Falls back to just `<operation>` when the
 * model/target is empty.
 */

import {
  OP_CHAT,
  OP_CREATE_AGENT,
  OP_EMBEDDINGS,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
  OP_RETRIEVAL,
  type OperationName,
} from '../semconv.js';

export function generationSpanName(operationName: OperationName | undefined, modelName: string) {
  const op = (operationName ?? OP_CHAT).trim();
  const model = modelName.trim();
  if (model === '') return op;
  return `${op} ${model}`;
}

export function embeddingSpanName(modelName: string) {
  const model = modelName.trim();
  if (model === '') return OP_EMBEDDINGS;
  return `${OP_EMBEDDINGS} ${model}`;
}

export function toolSpanName(toolName: string) {
  const name = toolName.trim() || 'unknown';
  return `${OP_EXECUTE_TOOL} ${name}`;
}

export function agentSpanName(agentName: string) {
  const name = agentName.trim();
  if (name === '') return OP_INVOKE_AGENT;
  return `${OP_INVOKE_AGENT} ${name}`;
}

export function agentCreateSpanName(agentName: string) {
  const name = agentName.trim();
  if (name === '') return OP_CREATE_AGENT;
  return `${OP_CREATE_AGENT} ${name}`;
}

export function retrievalSpanName(dataSourceId: string) {
  const id = dataSourceId.trim();
  if (id === '') return OP_RETRIEVAL;
  return `${OP_RETRIEVAL} ${id}`;
}
