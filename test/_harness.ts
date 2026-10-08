/**
 * Shared test harness — wires up in-memory OTel exporters so each test can
 * assert on emitted spans / metrics without hitting the network.
 *
 * Each test creates a `Harness` in `beforeEach` and disposes it in `afterEach`
 * so providers are clean between runs.
 */

import { SpanStatusCode, context, metrics as metricsApi, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { expect } from 'vitest';

import { Client } from '../src/client.js';
import type { ClientConfig } from '../src/config.js';

export interface Harness {
  client: Client;
  spans: InMemorySpanExporter;
  metricsExporter: InMemoryMetricExporter;
  metricReader: PeriodicExportingMetricReader;
  tracerProvider: NodeTracerProvider;
  meterProvider: MeterProvider;
  /** Flushes everything and shuts the harness down. */
  shutdown(): Promise<void>;
  /** Collects the latest metric snapshot. */
  collectMetrics(): Promise<ReturnType<InMemoryMetricExporter['getMetrics']>>;
  /** Resets the span exporter (useful when reusing a single harness). */
  resetSpans(): void;
  /** Spans started but not yet ended. */
  openSpanCount(): number;
}

/**
 * Builds a fresh harness with isolated providers. Each call replaces the
 * globally-registered providers — tests must not run concurrently against
 * separate harnesses in the same process.
 */
export function createHarness(input?: ClientConfig): Harness {
  const spans = new InMemorySpanExporter();
  const open = new Set<string>();
  const openTracker: SpanProcessor = {
    onStart: (span) => open.add(span.spanContext().spanId),
    onEnd: (span) => open.delete(span.spanContext().spanId),
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const tracerProvider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'genai-otel-test' }),
    spanProcessors: [openTracker, new SimpleSpanProcessor(spans)],
  });
  tracerProvider.register();
  trace.setGlobalTracerProvider(tracerProvider);

  const metricsExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricsExporter,
    exportIntervalMillis: 60_000, // we trigger flushes manually
  });
  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'genai-otel-test' }),
    readers: [metricReader],
  });
  metricsApi.setGlobalMeterProvider(meterProvider);

  const client = new Client(input);

  return {
    client,
    spans,
    metricsExporter,
    metricReader,
    tracerProvider,
    meterProvider,
    openSpanCount: () => open.size,
    async shutdown() {
      await client.shutdown();
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
      // Unregister the globally-registered providers so the NEXT call to
      // `createHarness` can re-install fresh ones. Without these, the OTel
      // API silently refuses to overwrite the existing globals and the next
      // test's spans/metrics go to dead providers.
      trace.disable();
      metricsApi.disable();
      context.disable();
    },
    async collectMetrics() {
      await meterProvider.forceFlush();
      return metricsExporter.getMetrics();
    },
    resetSpans() {
      spans.reset();
      metricsExporter.reset();
    },
  };
}

/**
 * Convenience: returns the first span whose name matches `predicate`.
 */
export function findSpan(spans: InMemorySpanExporter, predicate: (name: string) => boolean) {
  return spans.getFinishedSpans().find((s) => predicate(s.name));
}

/**
 * Asserts a failed span kept its `error.type` and ERROR status but none of the
 * error's text: no exception event, and `text` nowhere in the exported span.
 */
export function expectErrorTextDropped(span: ReadableSpan | undefined, text: string): void {
  expect(span?.status.code, span?.name).toBe(SpanStatusCode.ERROR);
  expect(span?.attributes['error.type'], span?.name).toBeTruthy();
  expect(
    span?.events.filter((e) => e.name === 'exception'),
    span?.name,
  ).toEqual([]);
  const exported = JSON.stringify([span?.attributes, span?.events, span?.links, span?.status]);
  expect(exported, span?.name).not.toContain(text);
}
