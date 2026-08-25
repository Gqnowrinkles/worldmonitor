/**
 * Compiles API handlers into an isolated runtime tree so source-parsing build
 * checks can continue reading the pristine repository files under api/.
 *
 * Two passes:
 *   1. TypeScript handlers under api/ subdirectories → bundled .js in build/api
 *   2. Plain JS handlers at the api/ root → bundled .js in build/api
 *
 * The completed runtime tree is mirrored under api/.runtime-scan so the existing
 * source-attribution walker sees compiled-bundle URLs without requiring it to
 * overwrite or replace the source files that docs-stats parses later.
 *
 * Run: node docker/build-handlers.mjs
 */

import { build } from 'esbuild';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const apiRoot = path.join(projectRoot, 'api');
const runtimeApiRoot = path.join(projectRoot, 'build', 'api');
const attributionMirrorRoot = path.join(apiRoot, '.runtime-scan');

// Inventory facts intentionally do not exist yet when Docker compiles handlers:
// they are generated only after source attribution scans the compiled bundles.
// Externalize the import by specifier rather than filesystem path so the bundle
// keeps the same relative runtime import after its output moves to build/api.
const runtimeGeneratedExternalPlugin = {
  name: 'runtime-generated-externals',
  setup(buildContext) {
    buildContext.onResolve(
      { filter: /^\.\/_inventory-facts\.generated\.js$/ },
      (args) => ({ path: args.path, external: true }),
    );
  },
};

// ── Pass 1: TypeScript handlers in subdirectories ─────────────────────────
async function findTsHandlers(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const handlers = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath === attributionMirrorRoot) continue;
      handlers.push(...await findTsHandlers(fullPath));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.startsWith('_') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      handlers.push(fullPath);
    }
  }
  return handlers;
}

// ── Pass 2: Plain JS handlers at api/ root level ──────────────────────────
async function findJsHandlers(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(e =>
      e.isFile() &&
      e.name.endsWith('.js') &&
      !e.name.startsWith('_') &&
      !e.name.endsWith('.test.js') &&
      !e.name.endsWith('.test.mjs')
    )
    .map(e => path.join(dir, e.name));
}

function runtimeOutfile(entryPoint) {
  const relativePath = path.relative(apiRoot, entryPoint).replace(/\.ts$/, '.js');
  return path.join(runtimeApiRoot, relativePath);
}

async function compileHandlers(handlers, label) {
  if (handlers.length === 0) {
    console.log(`${label}: nothing to compile`);
    return 0;
  }
  console.log(`${label}: compiling ${handlers.length} handlers...`);

  const results = await Promise.allSettled(
    handlers.map(async (entryPoint) => {
      const outfile = runtimeOutfile(entryPoint);
      await build({
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        treeShaking: true,
        plugins: [runtimeGeneratedExternalPlugin],
        loader: { '.ts': 'ts' },
      });
      const { size } = await stat(outfile);
      return { file: path.relative(projectRoot, outfile), size };
    })
  );

  let ok = 0, failed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { file, size } = result.value;
      console.log(`  ✓ ${file}  (${(size / 1024).toFixed(1)} KB)`);
      ok++;
    } else {
      console.error(`  ✗ ${result.reason?.message || result.reason}`);
      failed++;
    }
  }
  return failed;
}

// Rebuild both generated trees from pristine source on every invocation. This
// makes repeated local/CI runs deterministic and prevents stale compiled files
// from becoming source-attribution evidence.
await rm(attributionMirrorRoot, { recursive: true, force: true });
await rm(runtimeApiRoot, { recursive: true, force: true });
await mkdir(path.dirname(runtimeApiRoot), { recursive: true });
await cp(apiRoot, runtimeApiRoot, { recursive: true });

const tsHandlers = await findTsHandlers(apiRoot);
const jsHandlers = await findJsHandlers(apiRoot);

const tsFailed = await compileHandlers(tsHandlers, 'build-handlers [TS]');
const jsFailed = await compileHandlers(jsHandlers, 'build-handlers [JS]');

const totalFailed = tsFailed + jsFailed;
if (totalFailed > 0) {
  console.log(`\nbuild-handlers: complete (${totalFailed} failures)`);
  process.exit(1);
}

// The source-attribution walker already scans api/ recursively. A hidden mirror
// is intentionally ignored by docs-stats' top-level API endpoint count while
// remaining visible to attribution, so compiled URLs stay in the manifest scan.
await cp(runtimeApiRoot, attributionMirrorRoot, { recursive: true });

console.log('\nbuild-handlers: complete (0 failures)');
