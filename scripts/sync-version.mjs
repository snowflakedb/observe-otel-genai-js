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

const contents = `/**
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
