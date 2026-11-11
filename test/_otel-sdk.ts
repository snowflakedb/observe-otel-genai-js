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
 * The trace SDK the tests collect spans with, on either OpenTelemetry SDK 2.x or
 * 3.x. The dev install uses 2.x (`@opentelemetry/sdk-trace-base`); a CI job
 * swaps in 3.x, which replaced that package with `@opentelemetry/sdk-trace` and
 * changed two constructors. `SdkTrace2` and `SdkTrace3` list what the tests use
 * from each; the types come from 2.x because only 2.x is installed for dev.
 */

import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { Resource } from '@opentelemetry/resources';
import type {
  BasicTracerProvider,
  InMemorySpanExporter as InMemorySpanExporterType,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

type TracerProviderConfig = {
  resource?: Resource;
  spanProcessors: SpanProcessor[];
};

interface SdkTrace2 {
  BasicTracerProvider: typeof BasicTracerProvider;
  SimpleSpanProcessor: new (exporter: SpanExporter) => SpanProcessor;
  InMemorySpanExporter: typeof InMemorySpanExporterType;
}

interface SdkTrace3 {
  TracerProvider: new (config: TracerProviderConfig) => BasicTracerProvider;
  SimpleSpanProcessor: new (config: { exporter: SpanExporter }) => SpanProcessor;
  InMemorySpanExporter: typeof InMemorySpanExporterType;
}

async function importIfInstalled<T>(name: string): Promise<T | undefined> {
  try {
    return (await import(name)) as T;
  } catch {
    return undefined;
  }
}

const sdk3 = await importIfInstalled<SdkTrace3>('@opentelemetry/sdk-trace');
const sdk2 = sdk3 ? undefined : await importIfInstalled<SdkTrace2>('@opentelemetry/sdk-trace-base');

export type InMemorySpanExporter = InMemorySpanExporterType;
export const InMemorySpanExporter: typeof InMemorySpanExporterType = (sdk3 ?? sdk2)!
  .InMemorySpanExporter;

export type TracerProvider = BasicTracerProvider;

export function createTracerProvider(config: TracerProviderConfig): TracerProvider {
  return sdk3 ? new sdk3.TracerProvider(config) : new sdk2!.BasicTracerProvider(config);
}

export function simpleSpanProcessor(exporter: SpanExporter): SpanProcessor {
  return sdk3
    ? new sdk3.SimpleSpanProcessor({ exporter })
    : new sdk2!.SimpleSpanProcessor(exporter);
}

/** Makes `provider` global, with the context manager that span nesting needs. */
export function registerTracerProvider(provider: TracerProvider): void {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}
