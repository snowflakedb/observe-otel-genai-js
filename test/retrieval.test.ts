import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTR_DATA_SOURCE_ID,
  ATTR_OPERATION_NAME,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RETRIEVAL_DOCUMENTS,
  ATTR_RETRIEVAL_QUERY_TEXT,
  ATTR_RETRIEVAL_TOP_K,
  OP_RETRIEVAL,
} from '../src/semconv.js';
import { type Harness, createHarness } from './_harness.js';

describe('RetrievalRecorder', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'full' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a CLIENT retrieval span named `retrieval {dataSourceId}`', async () => {
    const rec = h.client.startRetrieval({
      dataSourceId: 'docs-index',
      // `gen_ai.provider.name` is the embedding/inference provider, not the store.
      provider: 'openai',
      requestModel: 'text-embedding-3-large',
      topK: 4,
      queryText: 'what is otel?',
    });
    rec.setDocuments([
      { id: 'd1', content: 'OpenTelemetry is...', score: 0.91, metadata: { source: 'a.md' } },
      { id: 'd2', content: 'It defines...' },
    ]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('retrieval docs-index');
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_RETRIEVAL);
    expect(span?.attributes[ATTR_DATA_SOURCE_ID]).toBe('docs-index');
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('openai');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('text-embedding-3-large');
    expect(span?.attributes[ATTR_RETRIEVAL_TOP_K]).toBe(4);
    expect(span?.attributes[ATTR_RETRIEVAL_QUERY_TEXT]).toBe('what is otel?');

    const docs = JSON.parse(span?.attributes[ATTR_RETRIEVAL_DOCUMENTS] as string);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ id: 'd1', content: 'OpenTelemetry is...', score: 0.91 });
  });

  it('falls back to a bare `retrieval` name when no data source is set', async () => {
    const rec = h.client.startRetrieval({ queryText: 'q' });
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.name).toBe('retrieval');
    expect(span?.attributes[ATTR_DATA_SOURCE_ID]).toBeUndefined();
  });

  it('strips query text and documents under metadata_only capture', async () => {
    const rec = h.client.startRetrieval({
      dataSourceId: 'docs-index',
      queryText: 'secret query',
      contentCapture: 'metadata_only',
    });
    rec.setDocuments([{ content: 'secret doc' }]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_DATA_SOURCE_ID]).toBe('docs-index');
    expect(span?.attributes[ATTR_RETRIEVAL_QUERY_TEXT]).toBeUndefined();
    expect(span?.attributes[ATTR_RETRIEVAL_DOCUMENTS]).toBeUndefined();
  });

  it('strips query text and documents under no_tool_content capture', async () => {
    const rec = h.client.startRetrieval({
      dataSourceId: 'docs-index',
      queryText: 'secret query',
      contentCapture: 'no_tool_content',
    });
    rec.setDocuments([{ content: 'secret doc' }]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    // Structural attributes stay — no_tool_content only suppresses payloads.
    expect(span?.attributes[ATTR_DATA_SOURCE_ID]).toBe('docs-index');
    expect(span?.attributes[ATTR_RETRIEVAL_QUERY_TEXT]).toBeUndefined();
    expect(span?.attributes[ATTR_RETRIEVAL_DOCUMENTS]).toBeUndefined();
  });

  it('records a provider_call_error when the retrieval fails', async () => {
    const rec = h.client.startRetrieval({ dataSourceId: 'docs-index' });
    rec.setCallError(Object.assign(new Error('index unavailable'), { status: 503 }));
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.attributes['error.category']).toBe('server_error');
  });

  it('records the operation-duration metric with operation=retrieval', async () => {
    // provider is the embedding/inference provider, not the vector-store vendor.
    const rec = h.client.startRetrieval({ dataSourceId: 'docs-index', provider: 'openai' });
    await rec.end();

    const collected = await h.collectMetrics();
    const found = collected
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'gen_ai.client.operation.duration');
    expect(found).toBeDefined();
    const point = found!.dataPoints.find(
      (p) => (p.attributes as Record<string, unknown>)[ATTR_OPERATION_NAME] === OP_RETRIEVAL,
    );
    expect(point).toBeDefined();
    expect((point!.attributes as Record<string, unknown>)[ATTR_PROVIDER_NAME]).toBe('openai');
  });

  it('finalizes cleanly when document metadata is not JSON-serializable', async () => {
    // A bigint / circular reference in a retrieved document's metadata must not
    // make the content sink's JSON.stringify throw and abort finalize() before
    // status + the duration metric are recorded.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const rec = h.client.startRetrieval({ dataSourceId: 'docs-index', provider: 'openai' });
    rec.setDocuments([
      { id: 'd1', content: 'ok', metadata: { big: 10n, ref: circular, when: new Date(0) } },
    ]);
    await rec.end(); // must not throw

    const [span] = h.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.OK);

    // Documents still emitted as valid JSON, with the bad values normalized.
    const docs = JSON.parse(span!.attributes[ATTR_RETRIEVAL_DOCUMENTS] as string);
    expect(docs[0].metadata.big).toBe('10');
    expect(docs[0].metadata.ref.self).toBe('[Circular]');
    expect(docs[0].metadata.when).toBe('1970-01-01T00:00:00.000Z');

    // Duration metric was still recorded despite the awkward content.
    const collected = await h.collectMetrics();
    const found = collected
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'gen_ai.client.operation.duration');
    const point = found?.dataPoints.find(
      (p) => (p.attributes as Record<string, unknown>)[ATTR_OPERATION_NAME] === OP_RETRIEVAL,
    );
    expect(point).toBeDefined();
  });

  // Metadata whose property access throws on its own. A replacer can't rescue
  // these, so the documents attribute is dropped — but finalize() must still
  // record the span status and the duration metric.
  const hostileMetadata: Array<[string, () => Record<string, unknown>]> = [
    [
      'a throwing getter',
      () => {
        const meta: Record<string, unknown> = { ok: 'kept' };
        Object.defineProperty(meta, 'boom', {
          enumerable: true,
          get() {
            throw new Error('getter blew up');
          },
        });
        return meta;
      },
    ],
    [
      'a proxy array with a throwing length',
      () => ({
        arr: new Proxy([] as unknown[], {
          get(target, prop, recv) {
            if (prop === 'length') throw new Error('no length');
            return Reflect.get(target, prop, recv);
          },
        }),
      }),
    ],
    [
      'a revoked proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return { bad: proxy };
      },
    ],
  ];

  for (const [label, makeMetadata] of hostileMetadata) {
    it(`omits documents but still finalizes with ${label}`, async () => {
      const rec = h.client.startRetrieval({ dataSourceId: 'docs-index' });
      rec.setDocuments([{ id: 'd1', content: 'ok', metadata: makeMetadata() }]);
      await rec.end(); // must not throw

      const [span] = h.spans.getFinishedSpans();
      expect(span?.status.code).toBe(SpanStatusCode.OK);
      expect(span?.attributes[ATTR_RETRIEVAL_DOCUMENTS]).toBeUndefined();

      const collected = await h.collectMetrics();
      const point = collected
        .flatMap((rm) => rm.scopeMetrics)
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === 'gen_ai.client.operation.duration')
        ?.dataPoints.find(
          (p) => (p.attributes as Record<string, unknown>)[ATTR_OPERATION_NAME] === OP_RETRIEVAL,
        );
      expect(point).toBeDefined();
    });
  }

  it('matches native JSON.stringify for toJSON-bearing metadata', async () => {
    // Encoding defers to native JSON.stringify, so key-dependent toJSON and the
    // "toJSON is called once" rule hold. Guards against a hand-rolled walker
    // being reintroduced and diverging from these semantics.
    const documents = [
      {
        id: 'd1',
        content: 'ok',
        metadata: {
          secret: { toJSON: (k: string) => `key=${k}` },
          list: [{ toJSON: (k: string) => `key=${k}` }],
          boxed: { toJSON: () => new Date(0) },
        },
      },
    ];

    const rec = h.client.startRetrieval({ dataSourceId: 'docs-index' });
    rec.setDocuments(documents);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span!.attributes[ATTR_RETRIEVAL_DOCUMENTS]).toBe(JSON.stringify(documents));

    const docs = JSON.parse(span!.attributes[ATTR_RETRIEVAL_DOCUMENTS] as string);
    expect(docs[0].metadata.secret).toBe('key=secret');
    expect(docs[0].metadata.list[0]).toBe('key=0');
    expect(docs[0].metadata.boxed).toEqual({});
  });

  it('preserves an own __proto__ metadata field instead of dropping it', async () => {
    const meta = JSON.parse('{"__proto__":{"tenant":"acme"},"source":"a.md"}');

    const rec = h.client.startRetrieval({ dataSourceId: 'docs-index' });
    rec.setDocuments([{ id: 'd1', content: 'ok', metadata: meta }]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    const raw = span!.attributes[ATTR_RETRIEVAL_DOCUMENTS] as string;
    expect(raw).toContain('"__proto__":{"tenant":"acme"}');
    expect(raw).toContain('"source":"a.md"');
  });
});

describe('RetrievalRecorder — document truncation', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({
      contentCaptureMode: 'full',
      contentCapture: { enabled: true, maxContentLength: 60, truncationStrategy: 'end' },
    });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('drops lowest-ranked documents from the end, preserving the best-first prefix', async () => {
    // Documents are ordered best-first; truncation must keep the highest-ranked
    // prefix (d1...) and drop from the end (d4 first), unlike chat messages.
    const rec = h.client.startRetrieval({ dataSourceId: 'docs-index' });
    rec.setDocuments([
      { id: 'd1', content: 'A'.repeat(30) },
      { id: 'd2', content: 'B'.repeat(30) },
      { id: 'd3', content: 'C'.repeat(30) },
      { id: 'd4', content: 'D'.repeat(30) },
    ]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[`${ATTR_RETRIEVAL_DOCUMENTS}.truncated`]).toBe(true);
    const docs = JSON.parse(span!.attributes[ATTR_RETRIEVAL_DOCUMENTS] as string);
    expect(Array.isArray(docs)).toBe(true);
    expect(docs[0].id).toBe('d1');
    expect(docs.some((d: { id?: string }) => d.id === 'd4')).toBe(false);
  });
});

describe('RetrievalRecorder — tiny content cap', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({
      contentCaptureMode: 'full',
      contentCapture: { enabled: true, maxContentLength: 1, truncationStrategy: 'end' },
    });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('omits the documents attribute when even [] exceeds the cap', async () => {
    // cap=1 truncates the array to `[]` (2 chars) — over the cap, so the
    // attribute is omitted rather than emitted above the configured limit.
    const rec = h.client.startRetrieval({ dataSourceId: 'docs-index' });
    rec.setDocuments([{ id: 'd1', content: 'hello world' }]);
    await rec.end();

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RETRIEVAL_DOCUMENTS]).toBeUndefined();
    expect(span?.attributes[`${ATTR_RETRIEVAL_DOCUMENTS}.truncated`]).toBeUndefined();
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });
});
