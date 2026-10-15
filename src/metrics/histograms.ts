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
 * The five GenAI client metrics.
 *
 * Wraps a {@link Meter} with helpers that record into the right histogram
 * with the right attribute set. Histograms are created lazily but only once
 * per client.
 *
 * Skip-on-zero rule: `recordTokenUsage` is a no-op when `value === 0` so
 * `cache_read=0` (etc.) never bloats time-series cardinality.
 *
 * `gen_ai.conversation.id` is added only when the client opts in through
 * `metricAttributes.conversationId`.
 */

import type { Attributes, Histogram, Meter } from '@opentelemetry/api';
import type { MetricAttributesConfig } from '../config.js';
import {
  ATTR_AGENT_NAME,
  ATTR_CONVERSATION_ID,
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
  conversationId?: string;
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
  conversationId?: string;
  errorType: string;
  errorCategory: string;
}

export class GenAIMetrics {
  readonly operationDuration: Histogram;
  readonly tokenUsage: Histogram;
  readonly timeToFirstToken: Histogram;
  readonly toolCallsPerOperation: Histogram;
  readonly toolExecutionDuration: Histogram;
  private readonly attributes: MetricAttributesConfig;

  constructor(meter: Meter, attributes: MetricAttributesConfig = { conversationId: false }) {
    this.attributes = attributes;
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
      ...this.optionalAttributes(labels),
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
      ...this.optionalAttributes(labels),
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
      ...this.optionalAttributes(labels),
    });
  }

  recordTimeToFirstToken(seconds: number, labels: OperationLabels): void {
    if (seconds < 0 || !Number.isFinite(seconds)) return;
    this.timeToFirstToken.record(seconds, {
      [ATTR_OPERATION_NAME]: labels.operationName,
      [ATTR_PROVIDER_NAME]: labels.providerName,
      [ATTR_REQUEST_MODEL]: labels.requestModel,
      [ATTR_AGENT_NAME]: labels.agentName,
      ...this.optionalAttributes(labels),
    });
  }

  recordToolCalls(count: number, labels: OperationLabels): void {
    this.toolCallsPerOperation.record(count, {
      [ATTR_OPERATION_NAME]: labels.operationName,
      [ATTR_PROVIDER_NAME]: labels.providerName,
      [ATTR_REQUEST_MODEL]: labels.requestModel,
      [ATTR_AGENT_NAME]: labels.agentName,
      ...this.optionalAttributes(labels),
    });
  }

  private optionalAttributes(labels: { conversationId?: string }): Attributes {
    if (this.attributes.conversationId && labels.conversationId) {
      return { [ATTR_CONVERSATION_ID]: labels.conversationId };
    }
    return {};
  }
}
