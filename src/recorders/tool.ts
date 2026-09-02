/**
 * `ToolExecutionRecorder` — wraps an `execute_tool` span.
 *
 * Tool arguments and results are serialized to JSON and emitted as span
 * attributes (`gen_ai.tool.call.arguments` / `.result`), subject to the
 * content-capture mode.
 */

import type { Span } from '@opentelemetry/api';
import { type ContentCaptureMode, applyContentAttribute } from '../content/capture.js';
import type { ToolExecutionEnd, ToolExecutionStart } from '../models/tool.js';
import {
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_RESULT,
  ERR_TYPE_TOOL_EXECUTION,
} from '../semconv.js';
import { applyToolAttributes } from '../spans/attributes.js';
import { toolSpanName } from '../spans/names.js';
import { RecorderBase, type RecorderHostContext } from './base.js';

export class ToolExecutionRecorder extends RecorderBase {
  private readonly seed: ToolExecutionStart;
  private result: ToolExecutionEnd | undefined;

  constructor(
    host: RecorderHostContext,
    span: Span,
    seed: ToolExecutionStart,
    startedAtMs: number,
    perCallContentCapture: ContentCaptureMode,
  ) {
    super(host, span, startedAtMs, perCallContentCapture);
    this.seed = seed;
  }

  setResult(end: ToolExecutionEnd): void {
    this.result = { ...(this.result ?? {}), ...end };
  }

  /** Overrides the tool name once known (from the tool-end `ToolMessage`); `finalize` re-derives the span name and `gen_ai.tool.name` from it. Ignored when empty. */
  setToolName(toolName: string | undefined): void {
    if (toolName == null || toolName === '') return;
    this.seed.toolName = toolName;
  }

  setToolCallId(toolCallId: string | undefined): void {
    if (toolCallId == null || toolCallId === '') return;
    this.seed.toolCallId = toolCallId;
  }

  /** Alias for `setCallError` that reads more naturally for tool executions. */
  setExecError(err: unknown): void {
    this.setCallError(err);
  }

  protected async finalize(): Promise<void> {
    const completedAtMs = this.host.now();
    this.completedAtMs = completedAtMs;

    const { mode, config: captureConfig } = this.resolveContentCapture();
    const stripped = mode === 'metadata_only';
    const allowToolContent = !stripped && mode !== 'no_tool_content';

    this.span.updateName(toolSpanName(this.seed.toolName));

    if (allowToolContent && captureConfig.enabled && this.result) {
      const argsStr = serializeToolPayload(this.result.arguments);
      const resStr = serializeToolPayload(this.result.result);
      if (argsStr) {
        applyContentAttribute(this.span, ATTR_TOOL_CALL_ARGUMENTS, argsStr, captureConfig);
      }
      if (resStr) {
        applyContentAttribute(this.span, ATTR_TOOL_CALL_RESULT, resStr, captureConfig);
      }
    }

    // Apply tool attributes (final pass).
    applyToolAttributes(this.span, this.seed);

    // Status + metrics.
    this.recordExceptionIfAny(this.callError, stripped);
    const classified =
      this.callError != null
        ? this.classify(this.callError, ERR_TYPE_TOOL_EXECUTION, stripped)
        : { errorType: '', errorCategory: '' as const, statusMessage: '' };
    this.setSpanStatus(classified);

    const durationSeconds = Math.max(0, (completedAtMs - this.startedAtMs) / 1000);
    this.host.metrics.recordToolExecutionDuration(durationSeconds, {
      providerName: this.seed.requestProvider ?? '',
      requestModel: this.seed.requestModel ?? '',
      toolName: this.seed.toolName,
      agentName: this.seed.agentName ?? '',
      errorType: classified.errorType,
      errorCategory: classified.errorCategory,
    });

    this.span.end(new Date(completedAtMs));
  }

  static applyStartAttributes(span: Span, seed: ToolExecutionStart): void {
    applyToolAttributes(span, seed);
  }
}

function serializeToolPayload(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return '';
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify(trimmed);
    }
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString('utf8').trim();
    if (text === '') return '';
    try {
      JSON.parse(text);
      return text;
    } catch {
      return JSON.stringify(text);
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
