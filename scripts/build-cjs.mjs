import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Emit a CommonJS build into dist/cjs/ alongside the ESM build in dist/.
//
// We deliberately do a PER-FILE transform (bundle: false) rather than bundling
// each entry point. The SDK keeps process-global state in single modules — most
// importantly the AsyncLocalStorage instance in src/context.ts. Bundling each
// public entry (".", "./vercel-ai-sdk", ...) separately would duplicate that
// module and fork the context store, breaking span parenting between the agent
// recorder and the integration hooks. A per-file transform preserves the
// one-module-per-file layout, so every entry in a given format shares the same
// context.js instance.
//
// The ESM tsc output (dist/**/*.js) is the input; esbuild only rewrites
// import/export syntax to require/module.exports and leaves the (relative,
// .js-suffixed) specifiers untouched, so dist/cjs/foo.js requires dist/cjs/bar.js.
// A dist/cjs/package.json with {"type":"commonjs"} marks the whole subtree as CJS
// even though the root package is "type": "module".
import { build } from 'esbuild';

const SRC_DIR = 'dist';
const OUT_DIR = 'dist/cjs';

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // Skip the CJS output dir itself on rebuilds.
    if (full === OUT_DIR) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const entryPoints = collectJsFiles(SRC_DIR);

await build({
  entryPoints,
  outdir: OUT_DIR,
  outbase: SRC_DIR,
  bundle: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  logLevel: 'info',
});

// Mark dist/cjs as CommonJS so Node treats the .js files as CJS despite the
// package's top-level "type": "module".
writeFileSync(join(OUT_DIR, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

console.log(`Emitted CJS build for ${entryPoints.length} files into ${OUT_DIR}/`);
