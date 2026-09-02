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
