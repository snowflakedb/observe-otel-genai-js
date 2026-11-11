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
 * Spawned by `openai-agents-cjs-autopatch.test.ts`.
 *
 * Proves the *production* auto-instrumentation path: `registerInstrumentations`
 * installs OpenTelemetry's require hook, and the later `require('@openai/agents')`
 * and `require('openai')` are intercepted with no manual patching anywhere. The
 * in-process vitest suite cannot cover that, because vitest never fires the hook,
 * so those tests would stay green even if the module names or version ranges in
 * `init()` stopped matching the shipped packages.
 *
 * The hook matches it checks:
 *
 *  - `@openai/agents` registers the trace processor and patches the model
 *    prototypes.
 *  - `@openai/agents-core/dist/tool.js` runs tools inside their `execute_tool`
 *    span, so a span the tool creates nests under it.
 *  - `withTrace` closes a block that throws.
 *  - `openai` emits the chat span. The client is built from the copy
 *    `@openai/agents-core` depends on, which can be a different major from the
 *    repo's own devDependency, so a version range that misses it shows up here.
 *
 * On success it prints the span tree the parent test asserts on.
 */

const http = require('node:http');
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
  OpenAIAgentsInstrumentation,
} = require('../../../src/integrations/openai-agents/instrumentation.ts');
const { OpenAIInstrumentation } = require('../../../src/integrations/openai/instrumentation.ts');

const exporter = new sdk.InMemorySpanExporter();
const provider = sdk3
  ? new sdk3.TracerProvider({ spanProcessors: [new sdk3.SimpleSpanProcessor({ exporter })] })
  : new sdk.BasicTracerProvider({ spanProcessors: [new sdk.SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const agentsInstrumentation = new OpenAIAgentsInstrumentation({
  contentCapture: 'full',
});

// Register BEFORE either package is required, so the hook can intercept them.
registerInstrumentations({
  instrumentations: [agentsInstrumentation, new OpenAIInstrumentation()],
});

// Only now pull the SDKs in. These requires are what the hooks patch.
const path = require('node:path');
const Agents = require('@openai/agents');
const agentsCoreDir = path.dirname(require.resolve('@openai/agents-core'));
const openaiEntry = require.resolve('openai', { paths: [agentsCoreDir] });
const OpenAIModule = require(openaiEntry);

// The SDK disables tracing under NODE_ENV=test. This fixture runs under plain
// `node`; setting the switch here keeps it independent of the environment.
Agents.setTracingDisabled(false);

interface FakeResponse {
  id: string;
  object: string;
  model: string;
  status: string;
  created_at: number;
  output: unknown[];
  usage: Record<string, unknown>;
}

const usage = {
  input_tokens: 11,
  output_tokens: 4,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};

function toolCallResponse(name: string): FakeResponse {
  return {
    id: 'resp-1',
    object: 'response',
    model: 'gpt-4o-mini',
    status: 'completed',
    created_at: 1,
    output: [
      {
        type: 'function_call',
        id: 'fc-1',
        call_id: 'call-1',
        name,
        arguments: JSON.stringify({ city: 'Tokyo' }),
        status: 'completed',
      },
    ],
    usage,
  };
}

function messageResponse(): FakeResponse {
  return {
    id: 'resp-2',
    object: 'response',
    model: 'gpt-4o-mini',
    status: 'completed',
    created_at: 2,
    output: [
      {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'sunny in Tokyo', annotations: [] }],
      },
    ],
    usage,
  };
}

async function main() {
  let call = 0;
  const server = http.createServer(
    (req: { on: (e: string, cb: (c?: unknown) => void) => void }, res: Record<string, any>) => {
      let raw = '';
      req.on('data', (chunk?: unknown) => {
        raw += chunk;
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const body = raw ? JSON.parse(raw) : {};
        const payload =
          call++ === 0
            ? toolCallResponse(
                (body.tools ?? []).find((t: { name?: string }) => t.name === 'get_weather')?.name ??
                  'get_weather',
              )
            : messageResponse();
        res.end(JSON.stringify(payload));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const OpenAI = OpenAIModule.OpenAI ?? OpenAIModule.default;
  const model = new Agents.OpenAIResponsesModel(
    new OpenAI({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}/v1` }),
    'gpt-4o-mini',
  );

  const agent = new Agents.Agent({
    name: 'cjs-agent',
    instructions: 'Be helpful.',
    model,
    tools: [
      Agents.tool({
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        strict: true,
        execute: async ({ city }: { city: string }) => {
          trace.getTracer('fixture').startSpan('db.query').end();
          return `sunny in ${city}`;
        },
      }),
    ],
  });

  const result = await new Agents.Runner().run(agent, 'weather in Tokyo?');

  await Agents.withTrace('failing-block', async () => {
    throw new Error('block failed');
  }).catch(() => {});
  let failed: any;
  for (let i = 0; i < 50 && !failed; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    failed = exporter.getFinishedSpans().find((s: any) => s.name === 'invoke_workflow failing-block');
  }
  console.log(`FAILED_BLOCK_STATUS=${failed?.status.code ?? 'still open'}`);

  await agentsInstrumentation.shutdown();
  server.close();

  const spans = exporter.getFinishedSpans();
  const byId = new Map(spans.map((s: any) => [s.spanContext().spanId, s]));
  const line = (s: any) => {
    const parentId = s.parentSpanContext?.spanId;
    const parent = parentId ? (byId.get(parentId)?.name ?? '<external>') : '<root>';
    return `${s.name} <- ${parent}`;
  };

  console.log(`FINAL_OUTPUT=${result.finalOutput}`);
  console.log(`SPAN_COUNT=${spans.length}`);
  for (const span of spans) console.log(`SPAN=${line(span)}`);
  await provider.shutdown();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
