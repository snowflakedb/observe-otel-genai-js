/**
 * Spawned by `langchain-cjs-autopatch.test.ts` via `tsx`.
 *
 * Proves the *production* auto-patch path: `registerInstrumentations` installs
 * OpenTelemetry's require hook, and a later CommonJS `require('@langchain/core')`
 * is intercepted so a genai-otel handler is injected into a bare `invoke()`
 * that passes NO callbacks. This is the path the in-process vitest tests can't
 * cover (vitest never fires the require/import hook), so it's the real guard
 * against the module-file name (`.cjs`) drifting out of sync with the package.
 *
 * On success it prints `INVOKE_AGENT_SPANS=<n>`; the parent test asserts on it.
 */

const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const {
  LangChainInstrumentation,
} = require('../../../src/integrations/langchain/instrumentation.ts');

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

// Register BEFORE @langchain/core is required, so the hook can intercept it.
registerInstrumentations({
  instrumentations: [new LangChainInstrumentation({ agentName: 'cjs-auto' })],
});

// Only now pull in @langchain/core. This require is what the hook patches.
const { RunnableLambda } = require('@langchain/core/runnables');
const { awaitAllCallbacks } = require('@langchain/core/callbacks/promises');

async function main() {
  const echo = RunnableLambda.from((x: unknown) => x);
  await echo.invoke({ q: 'hello' });
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
