/**
 * OpenAI Agents SDK: automatic instrumentation.
 *
 * Shows the arrangement the integration is designed around: two instrumentations
 * registered together, producing one nested trace.
 *
 *   triage-workflow                      <- the run container (invoke_agent), from RunConfig.workflowName
 *     invoke_agent triage-agent
 *       chat gpt-4o-mini                 <- from OpenAIInstrumentation
 *     invoke_agent spanish-agent         <- the handoff; no span of its own
 *       chat gpt-4o-mini
 *       execute_tool get_weather
 *
 * The `chat` spans are the interesting part: they come from a different
 * instrumentation than the agent spans, and they still nest under them, because the
 * agents instrumentation activates the agent span's OTel context around the model
 * call. Nothing in this file wires that up.
 *
 * Runs with no API key and no network: a local HTTP server plays the part of the
 * OpenAI API so the example is reproducible. To use the real API, set
 * `OPENAI_API_KEY` and build the model without the local `baseURL`.
 *
 *   pnpm exec tsx examples/openai-agents/index.ts
 *
 * ## Why this file calls `manuallyInstrument`
 *
 * This is a single ESM module run without the OpenTelemetry loader hook. ESM
 * `import` statements are hoisted and evaluated before any statement in the module
 * body, so `@openai/agents` and `openai` are already loaded by the time
 * `registerInstrumentations` runs. The require/import hook never sees them, and the
 * run emits nothing.
 *
 * Real applications have two better options and do not need this call:
 *
 *  - **CommonJS**: `registerInstrumentations(...)` in an entry file, then `require`
 *    the SDKs. The hook fires on its own.
 *  - **ESM**: put the setup in a preload and start with
 *    `node --import ./instrument.mjs ./app.mjs`, where the preload calls
 *    `register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)`. The
 *    hook then intercepts the app's own imports with no application code.
 */

import { createServer } from 'node:http';

import * as Agents from '@openai/agents';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import * as OpenAIModule from 'openai';

import { OpenAIAgentsInstrumentation } from '../../src/integrations/openai-agents/instrumentation.js';
import { OpenAIInstrumentation } from '../../src/integrations/openai/instrumentation.js';
import { setupOtel } from '../_setup.js';

const { tracerProvider, meterProvider } = setupOtel('openai-agents-example');

const agents = new OpenAIAgentsInstrumentation({
  // Tool arguments and results are stripped under the default capture mode.
  contentCapture: 'full',
});

const openai = new OpenAIInstrumentation();

// Register both. The agents instrumentation emits no model-call span on the
// OpenAI model paths; that is the openai instrumentation's job, since it sees the
// HTTP call and can also record time-to-first-token.
registerInstrumentations({ instrumentations: [agents, openai] });

// See the module doc: the imports above already ran, so hand the namespaces over
// here. One call covers the Agents SDK's core APIs and its model classes, because
// `@openai/agents` re-exports both.
agents.manuallyInstrument(Agents);
openai.manuallyInstrument(OpenAIModule);

// The Agents SDK turns tracing off under NODE_ENV=test, which would leave this
// example emitting nothing from a test runner. Flip its own switch; the
// instrumentation has no config for it, because this is process-wide state.
Agents.setTracingDisabled(false);

// ---------------------------------------------------------------------------
// A local stand-in for the OpenAI Responses API
// ---------------------------------------------------------------------------

const usage = {
  input_tokens: 24,
  output_tokens: 9,
  total_tokens: 33,
  input_tokens_details: { cached_tokens: 8, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 3 },
};

/** Script: hand off to Spanish, call the weather tool, then answer. */
function scriptedResponse(callIndex: number, toolNames: string[]): Record<string, unknown> {
  const base = { object: 'response', model: 'gpt-4o-mini', status: 'completed', usage };
  if (callIndex === 0) {
    const handoff = toolNames.find((n) => n.startsWith('transfer_to')) ?? 'transfer';
    return {
      ...base,
      id: 'resp-handoff',
      created_at: 1,
      output: [
        {
          type: 'function_call',
          id: 'fc-0',
          call_id: 'call-0',
          name: handoff,
          arguments: '{}',
          status: 'completed',
        },
      ],
    };
  }
  if (callIndex === 1) {
    return {
      ...base,
      id: 'resp-tool',
      created_at: 2,
      output: [
        {
          type: 'function_call',
          id: 'fc-1',
          call_id: 'call-1',
          name: 'get_weather',
          arguments: JSON.stringify({ city: 'Madrid' }),
          status: 'completed',
        },
      ],
    };
  }
  return {
    ...base,
    id: 'resp-final',
    created_at: 3,
    output: [
      {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hace sol en Madrid.', annotations: [] }],
      },
    ],
  };
}

async function startFakeOpenAI() {
  let callIndex = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const toolNames = ((body.tools ?? []) as Array<{ name?: string }>)
        .map((t) => t.name)
        .filter((n): n is string => typeof n === 'string');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(scriptedResponse(callIndex++, toolNames)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// The agents
// ---------------------------------------------------------------------------

async function main() {
  const server = await startFakeOpenAI();

  const OpenAI = ((OpenAIModule as any).OpenAI ?? (OpenAIModule as any).default) as any;
  const model = new Agents.OpenAIResponsesModel(
    new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'example', baseURL: server.baseURL }),
    'gpt-4o-mini',
  );

  const getWeather = Agents.tool({
    name: 'get_weather',
    description: 'Get the current weather for a city',
    // A plain JSON schema, so the example does not pin a zod major.
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    strict: true,
    // A JSON-schema tool receives untyped input.
    execute: async (input) => {
      const { city } = input as { city: string };
      return `sunny in ${city}`;
    },
  });

  const spanish = new Agents.Agent({
    name: 'spanish-agent',
    instructions: 'Answer only in Spanish. Use the weather tool when asked about weather.',
    model,
    tools: [getWeather],
  });

  const triage = new Agents.Agent({
    name: 'triage-agent',
    instructions: 'Hand off to the Spanish agent for Spanish-language requests.',
    model,
    handoffs: [spanish],
  });

  // The tracing identity lives on `RunConfig`, which means the `Runner`
  // constructor. `run()`'s own options are per-invocation (`stream`, `maxTurns`, …).
  const runner = new Agents.Runner({
    // Names the run container span.
    workflowName: 'triage-workflow',
    // The SDK documents this as a chat-thread identifier, which is what
    // `gen_ai.conversation.id` means. Nothing below the agents layer can see it: a
    // model-provider instrumentation sees one isolated HTTP call.
    groupId: 'chat-thread-1',
    // Lands on the container span as `genai.metadata.*`.
    traceMetadata: { tenant: 'acme', channel: 'web' },
  });

  const result = await runner.run(triage, '¿Qué tiempo hace en Madrid?');

  console.log(`\nfinal output: ${result.finalOutput}`);

  // Drain the processor before shutting the providers down, so the container
  // span and any in-flight spans are exported.
  await agents.shutdown();
  await server.close();
  await tracerProvider.forceFlush();
  await meterProvider.forceFlush();
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
