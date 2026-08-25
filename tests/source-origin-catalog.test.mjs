import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHostOrigin, sourceOriginLabel } from '../scripts/source-origin.mjs';

test('aviationstack is catalogued as an international platform', () => {
  const origin = resolveHostOrigin('aviationstack.com');
  assert.equal(origin, null);
  assert.equal(sourceOriginLabel(origin), 'International');
});
