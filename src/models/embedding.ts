import type { ModelRef } from './generation.js';

/**
 * Seed fields used when embedding recording starts.
 */
export interface EmbeddingStart {
  model: ModelRef;
  agentName?: string;
  agentVersion?: string;
  dimensions?: number;
  /** e.g. `"float"`, `"base64"`. */
  encodingFormat?: string;
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
