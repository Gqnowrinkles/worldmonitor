import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const BUILD_HANDLERS = new URL('../docker/build-handlers.mjs', import.meta.url);
const BUILD_HANDLERS_SOURCE = readFileSync(BUILD_HANDLERS, 'utf8');

test('docker build-handlers script parses under Node', () => {
  const result = spawnSync(process.execPath, ['--check', BUILD_HANDLERS.pathname], {
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `docker/build-handlers.mjs must parse before Docker executes it:\n${result.stderr || result.stdout}`,
  );
});

test('docker build-handlers emits runtime bundles outside the source api tree', () => {
  assert.match(
    BUILD_HANDLERS_SOURCE,
    /const runtimeApiRoot = path\.join\(projectRoot, 'build', 'api'\);/,
    'handler compilation must target a separate build/api runtime tree',
  );
  assert.match(
    BUILD_HANDLERS_SOURCE,
    /path\.join\(runtimeApiRoot, relativePath\)/,
    'handler output paths must be rooted under build/api',
  );
  assert.doesNotMatch(
    BUILD_HANDLERS_SOURCE,
    /const outfile = entryPoint\.replace\(\/\\\.ts\$\//,
    'handler compilation must not overwrite source entrypoints in api/',
  );
});
