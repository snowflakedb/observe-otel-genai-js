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
 * End-to-end proof that the LangChain auto-patch actually fires under the real
 * CommonJS require hook (require-in-the-middle), not just when the module patch
 * is invoked by hand.
 *
 * The other LangChain instrumentation tests apply the patch manually because
 * vitest never triggers OpenTelemetry's require/import hook. That leaves the
 * biggest blind spot uncovered: if the module-file name (`manager.cjs`) drifts
 * out of sync with the shipped `@langchain/core` layout, the hook silently
 * never matches and production emits nothing — while those tests stay green.
 *
 * To exercise the genuine path we bundle a fixture (which `require`s
 * `@langchain/core` *after* `registerInstrumentations`) into a real CommonJS
 * file with esbuild — keeping every node_module external so the require hook
 * can still intercept `@langchain/core` — then run it with plain `node`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const fixture = path.resolve(here, 'fixtures/langchain-cjs-autopatch.cts');

let workdir: string;
let bundlePath: string;

describe('LangChainInstrumentation — CJS auto-patch (require-in-the-middle)', () => {
  beforeAll(async () => {
    // Bundle *inside* the repo (under the git-ignored `.test-dist`) so the
    // emitted `require('@langchain/core')` etc. resolve against the repo's
    // node_modules (module resolution walks up from the file's directory, not
    // from cwd).
    const scratchRoot = path.join(repoRoot, '.test-dist');
    mkdirSync(scratchRoot, { recursive: true });
    workdir = mkdtempSync(path.join(scratchRoot, 'lc-cjs-'));
    bundlePath = path.join(workdir, 'autopatch.cjs');
    await build({
      entryPoints: [fixture],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      // Keep node_modules external so `require('@langchain/core')` is a real
      // runtime require the OTel hook can intercept — bundling it would defeat
      // the entire point of the test.
      packages: 'external',
    });
  }, 60_000);

  afterAll(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it('injects the handler into a bare require + invoke with no manual patch', () => {
    const output = execFileSync(process.execPath, [bundlePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(output).toContain('INVOKE_AGENT_SPANS=1');
    expect(output).toContain('AGENT_NAME=cjs-auto');
  }, 60_000);
});
