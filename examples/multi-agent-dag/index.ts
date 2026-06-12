/**
 * Multi-agent DAG example.
 *
 * Three agents (planner → executor → responder). The responder declares both
 * upstream generations as its `parentGenerationIds`. The library resolves
 * those string IDs into OTel span links via the in-memory map and also emits
 * the fallback `genai.parent_generation_ids` attribute.
 *
 * Wrapped in `invokeAgent(seed, async () => {...})` to demonstrate the
 * callback variant that auto-parents nested generations under the agent span.
 *
 * Run:
 *   pnpm exec tsx examples/multi-agent-dag/index.ts
 */

import { Client } from '../../src/index.js';
import { setupOtel } from '../_setup.js';

const otel = setupOtel('multi-agent-dag-example');

async function main() {
  const client = new Client();

  await client.invokeAgent(
    { agentName: 'orchestrator', task: 'answer the user via planner/executor/responder' },
    async () => {
      // Step 1: planner
      const planner = client.startGeneration({
        model: { provider: 'openai', name: 'gpt-4o' },
        agentName: 'planner',
      });
      planner.setResult({ usage: { inputTokens: 15, outputTokens: 5 } });
      await planner.end();
      const plannerId = planner.last?.id ?? '';

      // Step 2: executor (depends on planner)
      const executor = client.startGeneration({
        model: { provider: 'openai', name: 'gpt-4o-mini' },
        agentName: 'executor',
        parentGenerationIds: [plannerId],
      });
      executor.setResult({ usage: { inputTokens: 20, outputTokens: 30 } });
      await executor.end();
      const executorId = executor.last?.id ?? '';

      // Step 3: responder (depends on both planner + executor)
      const responder = client.startGeneration({
        model: { provider: 'anthropic', name: 'claude-3-5-sonnet' },
        agentName: 'responder',
        parentGenerationIds: [plannerId, executorId],
      });
      responder.setResult({ usage: { inputTokens: 25, outputTokens: 12 } });
      await responder.end();
    },
  );
}

await main();
await otel.shutdown();
