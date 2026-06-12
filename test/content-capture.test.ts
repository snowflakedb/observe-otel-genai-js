import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsBlobStore } from '../src/content/blob-store.js';
import {
  defaultContentCapture,
  resolveContentCaptureMode,
  truncate,
} from '../src/content/capture.js';
import {
  ATTR_CONTENT_BODY,
  ATTR_CONTENT_TRUNCATED,
  ATTR_CONTENT_TRUNCATION_STRATEGY,
  ATTR_CONTENT_URI,
  ATTR_INPUT_MESSAGES,
  ATTR_INPUT_PREVIEW,
  ATTR_OUTPUT_MESSAGES,
  ATTR_OUTPUT_PREVIEW,
  ATTR_SYSTEM_INSTRUCTIONS,
  EVENT_GENAI_USER_MESSAGE,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('content capture: truncation strategies', () => {
  it('returns input verbatim when under maxContentLength', () => {
    const { text, truncated } = truncate('short', 100);
    expect(text).toBe('short');
    expect(truncated).toBe(false);
  });

  it('middle strategy keeps head + tail with a marker', () => {
    const input = `${'a'.repeat(50)}BBB${'c'.repeat(50)}`;
    const { text, truncated, truncationStrategy } = truncate(input, 60, 'middle');
    expect(truncated).toBe(true);
    expect(truncationStrategy).toBe('middle');
    expect(text).toContain('...[truncated');
    expect(text.length).toBeLessThanOrEqual(70);
  });

  it('end strategy keeps the head and trims the tail', () => {
    const { text } = truncate('a'.repeat(200), 40, 'end');
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.endsWith('...')).toBe(true);
  });

  it('head_tail strategy keeps both edges', () => {
    const input = `${'X'.repeat(20)}${'Y'.repeat(80)}${'Z'.repeat(20)}`;
    const { text, truncated } = truncate(input, 80, 'head_tail');
    expect(truncated).toBe(true);
    expect(text).toContain('...[truncated');
  });
});

describe('content capture mode resolution', () => {
  it('per-call value wins over context and client default', () => {
    expect(resolveContentCaptureMode('metadata_only', 'full', 'no_tool_content')).toBe(
      'metadata_only',
    );
  });
  it('context wins over client default when per-call is default', () => {
    expect(resolveContentCaptureMode('default', 'full', 'no_tool_content')).toBe('full');
  });
  it('default mode falls through to no_tool_content', () => {
    expect(resolveContentCaptureMode('default', undefined, 'default')).toBe('no_tool_content');
  });
});

describe('content events on the generation span (span_events carrier)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({
      contentCaptureMode: 'full',
      contentCapture: { ...defaultContentCapture(), carrier: 'span_events' },
    });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits gen_ai.content.prompt events for input messages', async () => {
    const rec = h.client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
    });
    rec.setResult({
      input: [{ role: 'user', parts: [{ kind: 'text', text: 'hi there' }] }],
      output: [{ role: 'assistant', parts: [{ kind: 'text', text: 'hello!' }] }],
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const promptEvents = span!.events.filter((e) => e.name === EVENT_GENAI_USER_MESSAGE);
    expect(promptEvents.length).toBe(1);
    expect(promptEvents[0]?.attributes?.[ATTR_CONTENT_BODY]).toBe('hi there');
  });

  it('truncates content over maxContentLength with explicit metadata', async () => {
    await h.shutdown();
    h = createHarness({
      contentCaptureMode: 'full',
      contentCapture: { ...defaultContentCapture(), carrier: 'span_events', maxContentLength: 50 },
    });

    const long = 'X'.repeat(500);
    const rec = h.client.startGeneration({ model: { provider: 'p', name: 'm' } });
    rec.setResult({ input: [{ role: 'user', parts: [{ kind: 'text', text: long }] }] });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const ev = span!.events.find((e) => e.name === EVENT_GENAI_USER_MESSAGE);
    expect(ev?.attributes?.[ATTR_CONTENT_TRUNCATED]).toBe(true);
    expect(ev?.attributes?.[ATTR_CONTENT_TRUNCATION_STRATEGY]).toBe('middle');
  });

  it('offloads to BlobStore when configured and over threshold; emits gen_ai.content.uri', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genai-otel-blob-'));
    const blob = new LocalFsBlobStore(dir);

    await h.shutdown();
    h = createHarness({
      contentCaptureMode: 'full',
      contentCapture: {
        ...defaultContentCapture(),
        carrier: 'span_events',
        maxContentLength: 100,
        blobStore: blob,
      },
    });

    const long = 'A'.repeat(5_000);
    const rec = h.client.startGeneration({ model: { provider: 'p', name: 'm' } });
    rec.setResult({ input: [{ role: 'user', parts: [{ kind: 'text', text: long }] }] });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const ev = span!.events.find((e) => e.name === EVENT_GENAI_USER_MESSAGE);
    expect(ev?.attributes?.[ATTR_CONTENT_URI]).toBeDefined();
    expect((ev!.attributes![ATTR_CONTENT_URI] as string).startsWith('file://')).toBe(true);
  });

  it('strips content entirely under metadata_only', async () => {
    await h.shutdown();
    h = createHarness({
      contentCaptureMode: 'metadata_only',
      contentCapture: { ...defaultContentCapture(), carrier: 'span_events' },
    });
    const rec = h.client.startGeneration({
      model: { provider: 'p', name: 'm' },
      conversationTitle: 'sensitive title',
    });
    rec.setResult({
      input: [{ role: 'user', parts: [{ kind: 'text', text: 'secret prompt' }] }],
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span!.events.length).toBe(0);
    expect(span!.attributes['genai.conversation.title']).toBe('');
  });
});

describe('content on span attributes (default carrier)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'full' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits structured gen_ai.input/output.messages as JSON strings and previews (no events)', async () => {
    const rec = h.client.startGeneration({
      model: { provider: 'openai', name: 'gpt-4o' },
      systemPrompt: 'You are helpful',
    });
    rec.setResult({
      input: [{ role: 'user', parts: [{ kind: 'text', text: 'hi there' }] }],
      output: [{ role: 'assistant', parts: [{ kind: 'text', text: 'hello!' }] }],
      stopReason: 'stop',
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span!.events.length).toBe(0);

    const input = JSON.parse(span!.attributes[ATTR_INPUT_MESSAGES] as string);
    expect(input).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'hi there' }] }]);

    const output = JSON.parse(span!.attributes[ATTR_OUTPUT_MESSAGES] as string);
    expect(output).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'hello!' }], finish_reason: 'stop' },
    ]);

    const system = JSON.parse(span!.attributes[ATTR_SYSTEM_INSTRUCTIONS] as string);
    expect(system).toEqual([{ type: 'text', content: 'You are helpful' }]);

    expect(span!.attributes[ATTR_INPUT_PREVIEW]).toBe('hi there');
    expect(span!.attributes[ATTR_OUTPUT_PREVIEW]).toBe('hello!');
  });

  it('truncates oversized content and records per-key truncation flags', async () => {
    await h.shutdown();
    h = createHarness({
      contentCaptureMode: 'full',
      contentCapture: { ...defaultContentCapture(), maxContentLength: 50 },
    });

    const long = 'X'.repeat(500);
    const rec = h.client.startGeneration({ model: { provider: 'p', name: 'm' } });
    rec.setResult({ input: [{ role: 'user', parts: [{ kind: 'text', text: long }] }] });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect((span!.attributes[ATTR_INPUT_MESSAGES] as string).length).toBeLessThanOrEqual(60);
    expect(span!.attributes[`${ATTR_INPUT_MESSAGES}.truncated`]).toBe(true);
    expect(span!.attributes[`${ATTR_INPUT_MESSAGES}.original_size_bytes`]).toBeGreaterThan(50);
  });

  it('offloads oversized content to BlobStore and sets <key>.uri', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genai-otel-blob-attr-'));
    const blob = new LocalFsBlobStore(dir);
    await h.shutdown();
    h = createHarness({
      contentCaptureMode: 'full',
      contentCapture: { ...defaultContentCapture(), maxContentLength: 100, blobStore: blob },
    });

    const long = 'A'.repeat(5_000);
    const rec = h.client.startGeneration({ model: { provider: 'p', name: 'm' } });
    rec.setResult({ input: [{ role: 'user', parts: [{ kind: 'text', text: long }] }] });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const uri = span!.attributes[`${ATTR_INPUT_MESSAGES}.uri`] as string | undefined;
    expect(uri).toBeDefined();
    expect(uri!.startsWith('file://')).toBe(true);
  });

  it('strips all content under metadata_only', async () => {
    await h.shutdown();
    h = createHarness({ contentCaptureMode: 'metadata_only' });
    const rec = h.client.startGeneration({ model: { provider: 'p', name: 'm' } });
    rec.setResult({
      input: [{ role: 'user', parts: [{ kind: 'text', text: 'secret prompt' }] }],
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span!.attributes[ATTR_INPUT_MESSAGES]).toBeUndefined();
    expect(span!.attributes[ATTR_INPUT_PREVIEW]).toBeUndefined();
  });
});
