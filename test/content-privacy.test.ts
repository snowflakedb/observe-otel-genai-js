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

import { assistantTextMessage, userTextMessage } from '../src/models/message.js';
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
