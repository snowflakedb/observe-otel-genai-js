import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultContentCapture,
  resolveContentCaptureMode,
  truncate,
} from '../src/content/capture.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_OUTPUT_MESSAGES,
  ATTR_SYSTEM_INSTRUCTIONS,
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

describe('content on span attributes', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'full' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits structured gen_ai.input/output.messages as JSON strings (no events)', async () => {
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
  });

  it('does not truncate by default (unlimited) — emits full valid JSON', async () => {
    const long = 'X'.repeat(100_000);
    const rec = h.client.startGeneration({ model: { provider: 'p', name: 'm' } });
    rec.setResult({ input: [{ role: 'user', parts: [{ kind: 'text', text: long }] }] });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const raw = span!.attributes[ATTR_INPUT_MESSAGES] as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual([{ role: 'user', parts: [{ type: 'text', content: long }] }]);
    expect(span!.attributes[`${ATTR_INPUT_MESSAGES}.truncated`]).toBeUndefined();
  });

  it('leaf-trims oversized content to fit a finite cap while staying valid JSON', async () => {
    await h.shutdown();
    h = createHarness({
      contentCaptureMode: 'full',
      contentCapture: { ...defaultContentCapture(), maxContentLength: 200 },
    });

    const long = 'X'.repeat(500);
    const rec = h.client.startGeneration({ model: { provider: 'p', name: 'm' } });
    rec.setResult({
      input: [{ role: 'user', parts: [{ kind: 'text', text: long }] }],
    });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const raw = span!.attributes[ATTR_INPUT_MESSAGES] as string;
    expect(raw.length).toBeLessThanOrEqual(200);
    // Still valid JSON with the message structure intact.
    const parsed = JSON.parse(raw);
    expect(parsed[0].role).toBe('user');
    expect(parsed[0].parts[0].type).toBe('text');
    expect(parsed[0].parts[0].content.length).toBeLessThan(500);
    expect(span!.attributes[`${ATTR_INPUT_MESSAGES}.truncated`]).toBe(true);
    expect(span!.attributes[`${ATTR_INPUT_MESSAGES}.original_size_bytes`]).toBeGreaterThan(500);
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
  });
});
