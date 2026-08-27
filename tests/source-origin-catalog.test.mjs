import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHostOrigin, sourceOriginLabel } from '../scripts/source-origin.mjs';

test('aviationstack bare host matches the existing GB API-host origin', () => {
  const origin = resolveHostOrigin('aviationstack.com');
  assert.equal(origin, 'GB');
  assert.equal(sourceOriginLabel(origin), 'United Kingdom');
});
