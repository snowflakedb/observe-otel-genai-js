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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTR_OPERATION_NAME,
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_ID,
  ATTR_TOOL_CALL_RESULT,
  ATTR_TOOL_NAME,
  ATTR_TOOL_TYPE,
  OP_EXECUTE_TOOL,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('ToolExecutionRecorder', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'full' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits execute_tool span with tool attributes and INTERNAL kind', async () => {
    const rec = h.client.startToolExecution({
      toolName: 'search',
      toolCallId: 'call_123',
      toolType: 'function',
      agentName: 'responder',
    });
    rec.setResult({ arguments: { q: 'hello' }, result: { hits: 3 } });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('execute_tool search');
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_EXECUTE_TOOL);
    expect(span?.attributes[ATTR_TOOL_NAME]).toBe('search');
    expect(span?.attributes[ATTR_TOOL_CALL_ID]).toBe('call_123');
    expect(span?.attributes[ATTR_TOOL_TYPE]).toBe('function');
    expect(span?.kind).toBe(0 /* INTERNAL */);
  });

  it('emits tool_call arguments/result span attributes when content capture is full', async () => {
    const rec = h.client.startToolExecution({ toolName: 'search' });
    rec.setResult({
      arguments: { q: 'what is otel' },
      result: 'OpenTelemetry is...',
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_CALL_ARGUMENTS]).toBeDefined();
    expect(span?.attributes[ATTR_TOOL_CALL_RESULT]).toBeDefined();
    expect(span!.events.length).toBe(0);
  });

  it('skips tool content when capture mode is no_tool_content', async () => {
    await h.shutdown();
    h = createHarness({ contentCaptureMode: 'no_tool_content' });

    const rec = h.client.startToolExecution({ toolName: 'search' });
    rec.setResult({ arguments: { q: 'secret' }, result: 'redacted' });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_CALL_ARGUMENTS]).toBeUndefined();
    expect(span?.attributes[ATTR_TOOL_CALL_RESULT]).toBeUndefined();
  });

  it('classifies tool execution errors as tool_execution_error', async () => {
    const rec = h.client.startToolExecution({ toolName: 'search' });
    rec.setExecError(new Error('boom'));
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('tool_execution_error');
    expect(span?.status.code).toBe(2 /* ERROR */);
  });
});
