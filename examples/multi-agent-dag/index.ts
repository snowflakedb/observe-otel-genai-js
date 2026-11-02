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
