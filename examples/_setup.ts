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

/**
 * Shared example bootstrap. Examples use an in-memory exporter by default so
 * they run with zero network access; they switch to OTLP/HTTP when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the environment.
 */

import { metrics, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
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

  // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES override these defaults.
  const resource = resourceFromAttributes({
    'service.name': serviceName,
    'service.version': '0.1.0',
    'deployment.environment.name': 'example',
  }).merge(detectResources({ detectors: [envDetector] }));

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
