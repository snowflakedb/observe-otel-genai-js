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
 * Spawned by `langchain-cjs-autopatch.test.ts` via `tsx`.
 *
 * Proves the *production* auto-patch path: `registerInstrumentations` installs
 * OpenTelemetry's require hook, and a later CommonJS `require('@langchain/core')`
 * is intercepted so an observe-otel-genai handler is injected into a bare `invoke()`
 * that passes NO callbacks. This is the path the in-process vitest tests can't
 * cover (vitest never fires the require/import hook), so it's the real guard
 * against the module-file name (`.cjs`) drifting out of sync with the package.
 *
 * On success it prints `INVOKE_AGENT_SPANS=<n>`; the parent test asserts on it.
 */

const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { context, trace } = require('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
// OpenTelemetry SDK 3.x replaced sdk-trace-base with sdk-trace; see test/_otel-sdk.ts.
let sdk3: any;
try {
  sdk3 = require('@opentelemetry/sdk-trace');
} catch {}
const sdk = sdk3 ?? require('@opentelemetry/sdk-trace-base');
const {
  LangChainInstrumentation,
} = require('../../../src/integrations/langchain/instrumentation.ts');

const exporter = new sdk.InMemorySpanExporter();
const provider = sdk3
  ? new sdk3.TracerProvider({ spanProcessors: [new sdk3.SimpleSpanProcessor({ exporter })] })
  : new sdk.BasicTracerProvider({ spanProcessors: [new sdk.SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// Register BEFORE @langchain/core is required, so the hook can intercept it.
registerInstrumentations({
  instrumentations: [new LangChainInstrumentation()],
});

// Only now pull in @langchain/core. This require is what the hook patches.
const { RunnableLambda } = require('@langchain/core/runnables');
const { awaitAllCallbacks } = require('@langchain/core/callbacks/promises');

async function main() {
  const echo = RunnableLambda.from((x: unknown) => x);
  await echo.withConfig({ runName: 'cjs-auto' }).invoke({ q: 'hello' });
  await awaitAllCallbacks();

  const spans = exporter
    .getFinishedSpans()
    .filter((s: { attributes: Record<string, unknown> }) => {
      return s.attributes['gen_ai.operation.name'] === 'invoke_agent';
    });

  const agentName = spans[0]?.attributes['gen_ai.agent.name'];
  console.log(`INVOKE_AGENT_SPANS=${spans.length}`);
  console.log(`AGENT_NAME=${agentName ?? ''}`);
  await provider.shutdown();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
