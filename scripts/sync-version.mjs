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

// Regenerates src/version.ts from package.json#version.
//
// VERSION is exported so the client can tag the OTel tracer/meter
// (`getTracer(name, version)`), but it must never drift from the published
// package version. Rather than hand-syncing two files (which has drifted
// before), this script is the single source of truth — it runs on `prebuild`
// and `pretest`, and `test/invariants.test.ts` asserts the two stay equal as a
// CI backstop.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = join(root, 'src', 'version.ts');

const contents = `/*
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
 * Library version, exposed so the client can pass it to
 * \`trace.getTracer(name, version)\` / \`metrics.getMeter(name, version)\`.
 *
 * GENERATED FILE — do not edit by hand. Regenerated from package.json#version by
 * scripts/sync-version.mjs (runs on prebuild / pretest). test/invariants.test.ts
 * asserts this stays in sync.
 */
export const VERSION = '${pkg.version}';
`;

const current = (() => {
  try {
    return readFileSync(target, 'utf8');
  } catch {
    return '';
  }
})();

if (current !== contents) {
  writeFileSync(target, contents);
  process.stdout.write(`sync-version: wrote VERSION = ${pkg.version}\n`);
} else {
  process.stdout.write(`sync-version: VERSION already ${pkg.version}\n`);
}
