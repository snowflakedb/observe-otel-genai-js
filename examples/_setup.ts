/**
 * Shared example bootstrap. Examples use an in-memory exporter by default so
 * they run with zero network access; they switch to OTLP/HTTP when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the environment.
 */

import { metrics, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export function setupOtel(serviceName: string) {
  const hasOtlp = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const resource = resourceFromAttributes({
    'service.name': serviceName,
    'service.version': '0.1.0',
    'deployment.environment.name': process.env.OTEL_DEPLOYMENT_ENVIRONMENT_NAME ?? 'example',
  });

  const spanProcessors: SpanProcessor[] = hasOtlp
    ? [new BatchSpanProcessor(new OTLPTraceExporter())]
    : [new SimpleSpanProcessor(new ConsoleSpanExporter())];

  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  tracerProvider.register();

  const readers: MetricReader[] = hasOtlp
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 5_000,
        }),
      ]
    : [];

  const meterProvider = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    tracerProvider,
    meterProvider,
    isOtlp: hasOtlp,
    async shutdown() {
      try {
        await tracerProvider.shutdown();
      } catch {
        /* ignore */
      }
      try {
        await meterProvider.shutdown();
      } catch {
        /* ignore */
      }
      trace.disable();
      metrics.disable();
    },
  };
}
