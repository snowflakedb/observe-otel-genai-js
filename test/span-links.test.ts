import { TraceFlags } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { SpanLinkMap } from '../src/spans/links.js';
import { type Harness, createHarness } from './_harness.js';

describe('SpanLinkMap', () => {
  it('roundtrips a string id to its SpanContext', () => {
    const cfg = defaultConfig();
    const m = new SpanLinkMap(cfg.spanLinkMap, () => 0, cfg.logger);
    m.set('gen_abc', { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    const ctx = m.get('gen_abc');
    expect(ctx?.traceId).toBe('a'.repeat(32));
    expect(ctx?.spanId).toBe('b'.repeat(16));
  });

  it('returns undefined after TTL expires', () => {
    let now = 1000;
    const cfg = defaultConfig();
    const m = new SpanLinkMap({ maxEntries: 10, ttlMs: 5_000 }, () => now, cfg.logger);
    m.set('id-1', { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    now = 7_000;
    expect(m.get('id-1')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when over capacity', () => {
    const cfg = defaultConfig();
    const m = new SpanLinkMap({ maxEntries: 2, ttlMs: 60_000 }, () => 1, cfg.logger);
    m.set('a', { traceId: 'a'.repeat(32), spanId: 'a'.repeat(16), traceFlags: 1 });
    m.set('b', { traceId: 'b'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    m.set('c', { traceId: 'c'.repeat(32), spanId: 'c'.repeat(16), traceFlags: 1 });
    // 'a' should have been evicted.
    expect(m.get('a')).toBeUndefined();
    expect(m.get('b')).toBeDefined();
    expect(m.get('c')).toBeDefined();
  });

  it('resolveLinks accepts mixed string-id + SpanContextLike entries', () => {
    const cfg = defaultConfig();
    const m = new SpanLinkMap(cfg.spanLinkMap, () => 1, cfg.logger);
    const knownCtx = { traceId: 'd'.repeat(32), spanId: 'd'.repeat(16), traceFlags: 1 };
    m.set('known', knownCtx);

    const { links, parentIds } = m.resolveLinks([
      'known',
      'missing',
      { traceId: 'e'.repeat(32), spanId: 'e'.repeat(16) },
    ]);

    expect(links.length).toBe(2); // known + direct, missing dropped
    expect(parentIds).toEqual(['known', 'missing', `${'e'.repeat(32)}:${'e'.repeat(16)}`]);
  });
});

describe('Client wires links into generation spans', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('downstream generation links to upstream via parentGenerationIds', async () => {
    // Upstream
    const upstream = h.client.startGeneration({
      model: { provider: 'p', name: 'm1' },
      id: 'gen_upstream',
    });
    upstream.setResult({ usage: { inputTokens: 1, outputTokens: 1 } });
    await upstream.end();

    // Downstream — pass the string id; link should resolve via the map.
    const downstream = h.client.startGeneration({
      model: { provider: 'p', name: 'm2' },
      parentGenerationIds: ['gen_upstream'],
    });
    downstream.setResult({ usage: { inputTokens: 1, outputTokens: 1 } });
    await downstream.end();

    const spans = h.spans.getFinishedSpans();
    const down = spans.find((s) => (s.attributes['gen_ai.request.model'] as string) === 'm2');
    expect(down).toBeDefined();
    expect(down!.links.length).toBe(1);
    expect(down!.links[0]?.context.spanId.length).toBe(16);
    // The fallback attribute is always emitted.
    expect(down!.attributes['genai.parent_generation_ids']).toEqual(['gen_upstream']);
  });

  it('accepts a SpanContext-like directly for cross-process linkage', async () => {
    const ctx = { traceId: 'f'.repeat(32), spanId: 'f'.repeat(16), traceFlags: TraceFlags.SAMPLED };
    const rec = h.client.startGeneration({
      model: { provider: 'p', name: 'm' },
      parentGenerationIds: [ctx],
    });
    rec.setResult({ usage: { inputTokens: 1, outputTokens: 0 } });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span!.links.length).toBe(1);
    expect(span!.links[0]?.context.traceId).toBe('f'.repeat(32));
  });
});
