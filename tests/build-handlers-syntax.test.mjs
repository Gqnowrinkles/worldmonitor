import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const BUILD_HANDLERS = new URL('../docker/build-handlers.mjs', import.meta.url);

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
