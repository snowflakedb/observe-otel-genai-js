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
 * End-to-end proof that both instrumentations fire under the real CommonJS
 * require hook (require-in-the-middle).
 *
 * Every other test in this area applies the patch by hand, because vitest never
 * triggers OpenTelemetry's require/import hook. That leaves the biggest blind spot
 * uncovered: if a module name or version range in `init()` drifts out of sync with
 * the shipped packages, the hook never matches, production emits nothing, and
 * those tests stay green.
 *
 * So the fixture is bundled into a real CommonJS file with esbuild, with every
 * node_module kept external so the require hook can still intercept them, and run
 * under plain `node`.
 *
 * The version-range trap it guards: `@openai/agents-core` depends on `openai ^7`,
 * while this repo devDepends on v6. The fixture calls the v7 copy, as agent runs
 * do, so an `openai` range of `<7` would leave it with no chat span.
 *
 * It also covers the two patches vitest cannot apply, because vitest loads the SDK
 * as read-only ES modules: running tools in their span's context, and closing a
 * `withTrace` block that throws.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const fixture = path.resolve(here, 'fixtures/openai-agents-cjs-autopatch.cts');

let workdir: string;
let bundlePath: string;
let output: string;

describe('openai-agents + openai — CJS auto-patch (require-in-the-middle)', () => {
  beforeAll(async () => {
    // Bundle *inside* the repo (under the git-ignored `.test-dist`) so the emitted
    // `require('@openai/agents')` resolves against the repo's node_modules.
    // Resolution walks up from the file's directory, not from cwd.
    const scratchRoot = path.join(repoRoot, '.test-dist');
    mkdirSync(scratchRoot, { recursive: true });
    workdir = mkdtempSync(path.join(scratchRoot, 'agents-cjs-'));
    bundlePath = path.join(workdir, 'autopatch.cjs');
    await build({
      entryPoints: [fixture],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      // The adapters use `await using` for recorder cleanup. Node 22 has no
      // explicit-resource-management support, so esbuild has to lower it; with no
      // target it passes the syntax through and the bundle dies with
      // `SyntaxError: Unexpected identifier`.
      target: 'node20',
      // Keep node_modules external so the requires are real runtime requires the
      // OTel hook can intercept. Bundling them would inline the modules and the
      // hook would never see them.
      packages: 'external',
    });
    output = execFileSync(process.execPath, [bundlePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
  }, 180_000);

  afterAll(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it('runs the agent to completion', () => {
    expect(output).toContain('FINAL_OUTPUT=sunny in Tokyo');
  });

  it('emits the full span tree with no manual patching', () => {
    const tree = output
      .split('\n')
      .filter((line) => line.startsWith('SPAN='))
      .map((line) => line.slice('SPAN='.length));

    // Two model calls (tool request, then the answer), one tool execution with a
    // span of its own, one agent, one run container, and the failing block.
    expect(output).toContain('SPAN_COUNT=7');
    expect(
      tree.filter((l) => l.startsWith('chat gpt-4o-mini <- invoke_agent cjs-agent')),
    ).toHaveLength(2);
    expect(tree).toContain('execute_tool get_weather <- invoke_agent cjs-agent');
    expect(tree).toContain('invoke_agent cjs-agent <- Agent workflow');
    expect(tree).toContain('Agent workflow <- <root>');
    expect(tree).toContain('db.query <- execute_tool get_weather');
  });

  it('closes a withTrace block that throws as soon as it throws', () => {
    expect(output).toContain('FAILED_BLOCK_STATUS=2');
  });
});
