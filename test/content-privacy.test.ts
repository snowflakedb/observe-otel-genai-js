/**
 * Cross-span content-suppression test.
 *
 * `contentCaptureMode: 'metadata_only'` is the coarse control that replaces the
 * removed per-generation sanitizer hook. Unlike that hook (which only ever ran
 * on generation spans), the mode is honored by every recorder. This test proves
 * content is stripped from all four content-bearing span types: generation,
 * agent, tool, and embedding.
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContentCaptureMode } from '../src/content/capture.js';
import { withContentCaptureMode } from '../src/context.js';
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
import { type Harness, createHarness, expectErrorTextDropped } from './_harness.js';

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
 * An error message can quote the prompt, so modes that capture no content keep
 * only the error type and the ERROR status: no exception event, and a status
 * description that names the error category instead of the message.
 */
describe('metadata_only keeps error text off every span type', () => {
  const SECRET = 'secret prompt quoted in the error';
  const MODEL = { provider: 'openai', name: 'gpt-4o' };
  let h: Harness;
  afterEach(async () => {
    await h.shutdown();
  });

  /** Fails one span of each type and returns the finished spans. */
  async function failEverySpanType(contentCapture?: ContentCaptureMode): Promise<ReadableSpan[]> {
    const generation = h.client.startGeneration({ model: MODEL, contentCapture });
    generation.setCallError(new Error(SECRET));
    await generation.end();
    const mapping = h.client.startGeneration({ model: MODEL, contentCapture });
    mapping.setMappingError(new Error(SECRET));
    await mapping.end();
    const agent = h.client.invokeAgent({ agentName: 'responder', contentCapture });
    agent.setError(new Error(SECRET));
    await agent.end();
    const created = h.client.createAgent({ agentName: 'responder' });
    created.setError(new Error(SECRET));
    await created.end();
    const tool = h.client.startToolExecution({ toolName: 'search', contentCapture });
    tool.setExecError(new Error(SECRET));
    await tool.end();
    const embedding = h.client.startEmbedding({ model: MODEL, contentCapture });
    embedding.setCallError(new Error(SECRET));
    await embedding.end();
    const retrieval = h.client.startRetrieval({ queryText: 'q', contentCapture });
    retrieval.setCallError(new Error(SECRET));
    await retrieval.end();

    const spans = h.spans.getFinishedSpans();
    expect(spans).toHaveLength(7);
    return spans;
  }

  it('drops the message when metadata_only is set per call', async () => {
    h = createHarness({ contentCaptureMode: 'full' });
    const spans = await failEverySpanType('metadata_only');
    // create_agent takes no per-call mode.
    for (const span of spans.filter((s) => !s.name.startsWith('create_agent'))) {
      expectErrorTextDropped(span, SECRET);
    }
  });

  it('drops the message when metadata_only is set on the context', async () => {
    h = createHarness({ contentCaptureMode: 'full' });
    const spans = await withContentCaptureMode('metadata_only', () => failEverySpanType());
    for (const span of spans) expectErrorTextDropped(span, SECRET);
  });

  it.each(['full', 'no_tool_content'] as const)(
    'keeps the message and exception under %s',
    async (mode) => {
      h = createHarness({ contentCaptureMode: mode });
      for (const span of await failEverySpanType()) {
        expect(span.status.message, span.name).toBe(SECRET);
        const exception = span.events.find((e) => e.name === 'exception');
        expect(exception?.attributes?.['exception.message'], span.name).toBe(SECRET);
      }
    },
  );
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

describe('no_tool_content sanitizes tool payloads on the chat span', () => {
  let h: Harness;
  afterEach(async () => {
    await h.shutdown();
  });

  it('clears tool arguments and results in chat input and output', async () => {
    h = createHarness({ contentCaptureMode: 'no_tool_content' });
    const rec = h.client.startGeneration({ model: { provider: 'anthropic', name: 'm' } });
    rec.setResult({
      input: [
        userTextMessage('user question'),
        {
          role: 'tool',
          parts: [
            toolResultPart({ toolCallId: 'call-1', name: 'search', content: 'secret result' }),
          ],
        },
      ],
      output: [
        {
          role: 'assistant',
          parts: [toolCallPart({ name: 'search', id: 'call-2', inputJson: '{"q":"secret"}' })],
        },
      ],
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const input = String(span?.attributes[ATTR_INPUT_MESSAGES]);
    const output = String(span?.attributes[ATTR_OUTPUT_MESSAGES]);
    expect(input).toContain('user question');
    expect(input).not.toContain('secret');
    expect(output).toContain('call-2');
    expect(output).not.toContain('secret');
  });
});
