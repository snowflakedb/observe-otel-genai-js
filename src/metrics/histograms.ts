/**
 * The five GenAI client metrics.
 *
 * Wraps a {@link Meter} with helpers that record into the right histogram
 * with the right attribute set. Histograms are created lazily but only once
 * per client.
 *
 * Skip-on-zero rule: `recordTokenUsage` is a no-op when `value === 0` so
 * `cache_read=0` (etc.) never bloats time-series cardinality.
 */

import type { Histogram, Meter } from '@opentelemetry/api';
import {
  ATTR_AGENT_NAME,
  ATTR_ERROR_CATEGORY,
  ATTR_ERROR_TYPE,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_TOOL_NAME,
  DURATION_BUCKETS_SECONDS,
  METRIC_ATTR_TOKEN_TYPE,
  METRIC_OPERATION_DURATION,
  METRIC_TIME_TO_FIRST_TOKEN,
  METRIC_TOKEN_USAGE,
  METRIC_TOOL_CALLS_PER_OPERATION,
  METRIC_TOOL_EXECUTION_DURATION,
  TOKEN_USAGE_BUCKETS,
  type TokenType,
} from '../semconv.js';

export interface OperationLabels {
  operationName: string;
  providerName: string;
  requestModel: string;
  agentName: string;
}

export interface DurationLabels extends OperationLabels {
  errorType: string;
  errorCategory: string;
}

export interface ToolDurationLabels {
  providerName: string;
  requestModel: string;
  toolName: string;
  agentName: string;
  errorType: string;
  errorCategory: string;
}

export class GenAIMetrics {
  readonly operationDuration: Histogram;
  readonly tokenUsage: Histogram;
  readonly timeToFirstToken: Histogram;
  readonly toolCallsPerOperation: Histogram;
  readonly toolExecutionDuration: Histogram;

  constructor(meter: Meter) {
    this.operationDuration = meter.createHistogram(METRIC_OPERATION_DURATION, {
      unit: 's',
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_SECONDS] },
    });
    this.tokenUsage = meter.createHistogram(METRIC_TOKEN_USAGE, {
      unit: 'token',
      advice: { explicitBucketBoundaries: [...TOKEN_USAGE_BUCKETS] },
    });
    this.timeToFirstToken = meter.createHistogram(METRIC_TIME_TO_FIRST_TOKEN, {
      unit: 's',
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_SECONDS] },
    });
    this.toolCallsPerOperation = meter.createHistogram(METRIC_TOOL_CALLS_PER_OPERATION, {
      unit: 'count',
    });
    this.toolExecutionDuration = meter.createHistogram(METRIC_TOOL_EXECUTION_DURATION, {
      unit: 's',
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_SECONDS] },
    });
  }

  recordOperationDuration(durationSeconds: number, labels: DurationLabels): void {
    if (durationSeconds < 0 || !Number.isFinite(durationSeconds)) return;
    this.operationDuration.record(durationSeconds, {
      [ATTR_OPERATION_NAME]: labels.operationName,
      [ATTR_PROVIDER_NAME]: labels.providerName,
      [ATTR_REQUEST_MODEL]: labels.requestModel,
      [ATTR_AGENT_NAME]: labels.agentName,
      [ATTR_ERROR_TYPE]: labels.errorType,
      [ATTR_ERROR_CATEGORY]: labels.errorCategory,
    });
  }

  /**
   * Records into the dedicated `gen_ai.client.tool_execution.duration` histogram
   * so `gen_ai.tool.name` cardinality is isolated from chat/embedding durations.
   */
  recordToolExecutionDuration(durationSeconds: number, labels: ToolDurationLabels): void {
    if (durationSeconds < 0 || !Number.isFinite(durationSeconds)) return;
    this.toolExecutionDuration.record(durationSeconds, {
      [ATTR_OPERATION_NAME]: 'execute_tool',
      [ATTR_PROVIDER_NAME]: labels.providerName,
      [ATTR_REQUEST_MODEL]: labels.requestModel,
      [ATTR_TOOL_NAME]: labels.toolName,
      [ATTR_AGENT_NAME]: labels.agentName,
      [ATTR_ERROR_TYPE]: labels.errorType,
      [ATTR_ERROR_CATEGORY]: labels.errorCategory,
    });
  }

  recordTokenUsage(value: number, type: TokenType, labels: OperationLabels): void {
    if (!value || value <= 0) return;
    this.tokenUsage.record(value, {
      [ATTR_OPERATION_NAME]: labels.operationName,
      [ATTR_PROVIDER_NAME]: labels.providerName,
      [ATTR_REQUEST_MODEL]: labels.requestModel,
      [ATTR_AGENT_NAME]: labels.agentName,
      [METRIC_ATTR_TOKEN_TYPE]: type,
    });
  }

  recordTimeToFirstToken(seconds: number, labels: OperationLabels): void {
    if (seconds < 0 || !Number.isFinite(seconds)) return;
    this.timeToFirstToken.record(seconds, {
      [ATTR_OPERATION_NAME]: labels.operationName,
      [ATTR_PROVIDER_NAME]: labels.providerName,
      [ATTR_REQUEST_MODEL]: labels.requestModel,
      [ATTR_AGENT_NAME]: labels.agentName,
    });
  }

  recordToolCalls(count: number, labels: OperationLabels): void {
    this.toolCallsPerOperation.record(count, {
      [ATTR_OPERATION_NAME]: labels.operationName,
      [ATTR_PROVIDER_NAME]: labels.providerName,
      [ATTR_REQUEST_MODEL]: labels.requestModel,
      [ATTR_AGENT_NAME]: labels.agentName,
    });
  }
}
