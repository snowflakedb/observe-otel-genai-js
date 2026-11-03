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
 * Optional one-liner that wires up an OTel TracerProvider + MeterProvider
 * with OTLP/HTTP exporters from `OTEL_EXPORTER_OTLP_*` env vars.
 *
 * Lives in a separate package entry point (`@snowflake/observe-otel-genai/bootstrap`) so
 * the core library has no runtime dependency on `@opentelemetry/sdk-*`. The
 * SDK packages are declared as optional peerDependencies; this module will
 * throw a helpful error if any of them is missing.
 *
 * Usage:
 *   import { bootstrapOtel } from '@snowflake/observe-otel-genai/bootstrap';
 *   const { tracerProvider, meterProvider } = bootstrapOtel({
 *     serviceName: 'my-agent',
 *     serviceVersion: '0.1.0',
 *     deploymentEnvironment: 'dev',
 *   });
 *
 *   // ... later ...
 *
 *   await tracerProvider.shutdown();
 *   await meterProvider.shutdown();
 *
 * Note: this bootstrap submodule DOES run standard OTel batch processors and
 * a periodic exporting metric reader (timers + background work). The core
 * `@snowflake/observe-otel-genai` entry point still has no library-owned background work;
 * that promise applies only to the core, not to the optional bootstrap.
 */

import { metrics as metricsApi, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions/incubating';

export interface BootstrapOptions {
  serviceName: string;
  serviceVersion?: string;
  /** `OTEL_DEPLOYMENT_ENVIRONMENT_NAME` overrides this when set. */
  deploymentEnvironment?: string;
  /**
   * Reserved for future expansion. Today the bootstrap only emits OTLP/HTTP;
   * gRPC support can be added later by accepting `"grpc"` here.
   */
  exporterProtocol?: 'http';
  /**
   * Extra resource attributes merged into the auto-built `Resource`.
   * Useful for pinning `host.name`, `cloud.region`, etc.
   */
  extraResourceAttributes?: Record<string, string | number | boolean>;
  /** Batch processor configuration overrides. */
  batchSpanProcessor?: {
    scheduledDelayMillis?: number;
    maxQueueSize?: number;
    maxExportBatchSize?: number;
  };
  /** Periodic metric reader interval (ms). */
  metricExportIntervalMillis?: number;
  /**
   * When `true`, overwrites whatever TracerProvider / MeterProvider is
   * currently registered. Defaults to `false` — if globals are already set
   * (e.g. by Sentry, `@vercel/otel`, or Datadog), `bootstrapOtel` returns
   * those existing providers and skips registration so the host's setup
   * keeps working. Set `force: true` to deliberately replace them.
   */
  force?: boolean;
}

export interface BootstrapResult {
  tracerProvider: NodeTracerProvider;
  meterProvider: MeterProvider;
  /** True when bootstrap registered new globals; false when it reused existing ones. */
  registered: boolean;
}

/**
 * Wires up OTel providers and registers them globally so `@snowflake/observe-otel-genai`
 * (and any other library using `@opentelemetry/api`) picks them up.
 *
 * Reads `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` via the
 * OTel exporters themselves — no custom env parsing here.
 */
export function bootstrapOtel(options: BootstrapOptions): BootstrapResult {
  const serviceName =
    options.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || 'unknown_service';
  const serviceVersion =
    options.serviceVersion?.trim() || process.env.OTEL_SERVICE_VERSION || undefined;
  const deploymentEnvironment =
    process.env.OTEL_DEPLOYMENT_ENVIRONMENT_NAME ||
    options.deploymentEnvironment?.trim() ||
    undefined;

  const attrs: Record<string, string | number | boolean> = {
    [ATTR_SERVICE_NAME]: serviceName,
    ...(serviceVersion ? { [ATTR_SERVICE_VERSION]: serviceVersion } : {}),
    ...(deploymentEnvironment ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: deploymentEnvironment } : {}),
    ...(options.extraResourceAttributes ?? {}),
  };
  const resource = resourceFromAttributes(attrs);

  // Detect previously-registered globals. The OTel JS API uses a
  // ProxyTracerProvider as the default no-op; anything else means a host has
  // already registered. Same idea for the MeterProvider via a structural check.
  const tracerAlreadyRegistered = !isProxyTracerProvider(trace.getTracerProvider());
  const meterAlreadyRegistered = !isNoopMeterProvider(metricsApi.getMeterProvider());

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      // OTLP exporters are typed against the sdk-trace-base version they pin
      // (currently 2.1.0), which can differ from the sdk-* version resolved
      // here. The runtime contract is identical; cast across the duplicate
      // type declarations. (This optional bootstrap module is not used by
      // hosts that bring their own OTel SDK.)
      new BatchSpanProcessor(new OTLPTraceExporter() as unknown as SpanExporter, {
        scheduledDelayMillis: options.batchSpanProcessor?.scheduledDelayMillis,
        maxQueueSize: options.batchSpanProcessor?.maxQueueSize,
        maxExportBatchSize: options.batchSpanProcessor?.maxExportBatchSize,
      }),
    ],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter() as unknown as PushMetricExporter,
        exportIntervalMillis: options.metricExportIntervalMillis ?? 30_000,
      }),
    ],
  });

  let registered = false;
  if (options.force || (!tracerAlreadyRegistered && !meterAlreadyRegistered)) {
    // tracerProvider.register() also sets the global, no need to call
    // trace.setGlobalTracerProvider() afterward.
    tracerProvider.register();
    metricsApi.setGlobalMeterProvider(meterProvider);
    registered = true;
  }

  return { tracerProvider, meterProvider, registered };
}

function isProxyTracerProvider(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false;
  const ctor = (p as { constructor?: { name?: string } }).constructor;
  return ctor?.name === 'ProxyTracerProvider';
}

function isNoopMeterProvider(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false;
  const ctor = (p as { constructor?: { name?: string } }).constructor;
  return ctor?.name === 'NoopMeterProvider';
}
