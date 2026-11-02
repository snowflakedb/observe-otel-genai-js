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
 * Repository invariants enforced as CI gates.
 *
 *  1. Core purity: nothing under `src/` (except the opt-in `src/bootstrap/`
 *     submodule) may import from `@opentelemetry/sdk-*`, the OTLP exporters, or
 *     `@opentelemetry/resources`. The core depends only on `@opentelemetry/api`.
 *     This is the library's headline design promise; this test makes it
 *     impossible to regress silently.
 *  2. Version sync: `VERSION` in `src/version.ts` must match `package.json`'s
 *     `version` field — the two are hand-maintained and have drifted before.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const srcDir = join(repoRoot, 'src');
const bootstrapDir = join(srcDir, 'bootstrap');

/** Module specifiers that the core (outside bootstrap) must never import. */
const FORBIDDEN_SPECIFIER = /^@opentelemetry\/(sdk-|exporter-|resources)/;

/** Collects module specifiers from import/export-from, side-effect, and dynamic forms. */
function importedSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // import ... from 'x' / export ... from 'x'
    /\bimport\s+['"]([^'"]+)['"]/g, // import 'x' (side-effect)
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('x') / require('x')
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
    while ((m = re.exec(source)) != null) {
      if (m[1]) specs.push(m[1]);
    }
  }
  return specs;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('core purity', () => {
  it('no src/ file outside bootstrap/ imports @opentelemetry/sdk-*, exporters, or resources', () => {
    const coreFiles = listTsFiles(srcDir).filter((f) => !f.startsWith(bootstrapDir + sep));
    expect(coreFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of coreFiles) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importedSpecifiers(source)) {
        if (FORBIDDEN_SPECIFIER.test(spec)) {
          violations.push(`${relative(repoRoot, file)} imports ${spec}`);
        }
      }
    }

    expect(violations, `core-purity violations:\n${violations.join('\n')}`).toEqual([]);
  });
});

describe('version sync', () => {
  it('src/version.ts VERSION matches package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
