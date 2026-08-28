/**
 * Cross-span content-suppression test.
 *
 * `contentCaptureMode: 'metadata_only'` is the coarse control that replaces the
 * removed per-generation sanitizer hook. Unlike that hook (which only ever ran
 * on generation spans), the mode is honored by every recorder. This test proves
 * content is stripped from all four content-bearing span types: generation,
 * agent, tool, and embedding.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../src/models/message.js';
import {
  assistantTextMessage,
  textPart,
  toolCallPart,
  toolResultPart,
  userTextMessage,
} from '../src/models/message.js';
import {
  ATTR_EMBEDDING_INPUT_TEXTS,
  ATTR_INPUT_MESSAGES,
  ATTR_OUTPUT_MESSAGES,
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_RESULT,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('metadata_only strips content across all span types', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({
      contentCaptureMode: 'metadata_only',
      // captureInput on so we prove embedding input_texts are stripped by the
      // mode, not merely absent because capture is off.
      embeddingCapture: { captureInput: true, maxInputItems: 20, maxTextLength: 1024 },
    });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('strips generation input/output messages', async () => {
    const rec = h.client.startGeneration({ model: { provider: 'openai', name: 'gpt-4o' } });
    rec.setResult({
      input: [userTextMessage('secret prompt')],
      output: [assistantTextMessage('secret answer')],
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_INPUT_MESSAGES]).toBeUndefined();
    expect(span?.attributes[ATTR_OUTPUT_MESSAGES]).toBeUndefined();
  });

  it('strips agent input/output messages', async () => {
    const rec = h.client.invokeAgent({
      agentName: 'responder',
      input: [userTextMessage('secret prompt')],
    });
    rec.setOutput([assistantTextMessage('secret answer')]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_INPUT_MESSAGES]).toBeUndefined();
    expect(span?.attributes[ATTR_OUTPUT_MESSAGES]).toBeUndefined();
  });

  it('strips tool arguments and result', async () => {
    const rec = h.client.startToolExecution({ toolName: 'search' });
    rec.setResult({ arguments: { q: 'secret query' }, result: 'secret result' });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_CALL_ARGUMENTS]).toBeUndefined();
    expect(span?.attributes[ATTR_TOOL_CALL_RESULT]).toBeUndefined();
  });

  it('strips embedding input texts', async () => {
    const rec = h.client.startEmbedding({
      model: { provider: 'openai', name: 'text-embedding-3-large' },
    });
    rec.setResult({ inputCount: 1, inputTexts: ['secret text'] });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_EMBEDDING_INPUT_TEXTS]).toBeUndefined();
  });
});

/**
 * `no_tool_content` must strip tool payloads from the invoke_agent span the same
 * way the sibling execute_tool span does. The agent span mixes plain
 * prompt/completion text (kept) with tool_call / tool_result parts (payloads
 * cleared) — regression for the review comment where LangGraph ToolMessages and
 * assistant tool-call arguments leaked onto invoke_agent under the default
 * policy.
 */
describe('no_tool_content sanitizes tool payloads on the agent span', () => {
  let h: Harness;
  afterEach(async () => {
    await h.shutdown();
  });

  /** Agent input carrying text + a tool call + a tool result. */
  function agentInputWithTools(): Message[] {
    return [
      userTextMessage('user question'),
      {
        role: 'assistant',
        parts: [
          textPart('let me search'),
          toolCallPart({ name: 'search', id: 'call-1', inputJson: '{"q":"secret query"}' }),
        ],
      },
      {
        role: 'tool',
        parts: [toolResultPart({ toolCallId: 'call-1', name: 'search', content: 'secret result' })],
      },
    ];
  }

  /** Agent output: assistant text plus a follow-up tool call. */
  function agentOutputWithTool(): Message[] {
    return [
      {
        role: 'assistant',
        parts: [
          textPart('final answer'),
          toolCallPart({ name: 'search', id: 'call-2', inputJson: '{"q":"more"}' }),
        ],
      },
    ];
  }

  function agentSpanMessages(attr: string): SemconvLike[] {
    const [span] = h.spans.getFinishedSpans();
    const raw = span?.attributes[attr];
    return raw === undefined ? [] : (JSON.parse(raw as string) as SemconvLike[]);
  }

  it('clears tool arguments/results but keeps names, ids, and plain text', async () => {
    h = createHarness({ contentCaptureMode: 'no_tool_content' });
    const rec = h.client.invokeAgent({ agentName: 'responder', input: agentInputWithTools() });
    rec.setOutput(agentOutputWithTool());
    await rec.end();

    const input = agentSpanMessages(ATTR_INPUT_MESSAGES);
    // plain user text survives
    expect(input[0]).toEqual({ role: 'user', parts: [{ type: 'text', content: 'user question' }] });
    // assistant: text kept, tool_call keeps name + id but drops arguments
    const assistantParts = input[1]!.parts;
    expect(assistantParts[0]).toEqual({ type: 'text', content: 'let me search' });
    expect(assistantParts[1]).toEqual({ type: 'tool_call', name: 'search', id: 'call-1' });
    expect(assistantParts[1]).not.toHaveProperty('arguments');
    // tool result: correlation id kept, payload cleared to null
    expect(input[2]!.parts[0]).toEqual({
      type: 'tool_call_response',
      id: 'call-1',
      response: null,
    });

    const output = agentSpanMessages(ATTR_OUTPUT_MESSAGES);
    const outParts = output[0]!.parts;
    expect(outParts[0]).toEqual({ type: 'text', content: 'final answer' });
    expect(outParts[1]).toEqual({ type: 'tool_call', name: 'search', id: 'call-2' });
    expect(outParts[1]).not.toHaveProperty('arguments');
  });

  it('keeps tool arguments/results under full capture', async () => {
    h = createHarness({ contentCaptureMode: 'full' });
    const rec = h.client.invokeAgent({ agentName: 'responder', input: agentInputWithTools() });
    await rec.end();

    const input = agentSpanMessages(ATTR_INPUT_MESSAGES);
    expect(input[1]!.parts[1]).toEqual({
      type: 'tool_call',
      name: 'search',
      id: 'call-1',
      arguments: { q: 'secret query' },
    });
    expect(input[2]!.parts[0]).toEqual({
      type: 'tool_call_response',
      id: 'call-1',
      response: 'secret result',
    });
  });

  it('does not mutate the caller-provided input messages', async () => {
    h = createHarness({ contentCaptureMode: 'no_tool_content' });
    const input = agentInputWithTools();
    const rec = h.client.invokeAgent({ agentName: 'responder', input });
    await rec.end();

    // The sanitizer must deep-copy — the caller's original payload stays intact.
    expect(input[1]!.parts[1]!.toolCall?.inputJson).toBe('{"q":"secret query"}');
    expect(input[2]!.parts[0]!.toolResult?.content).toBe('secret result');
  });
});

interface SemconvLike {
  role: string;
  parts: Array<Record<string, unknown>>;
}
