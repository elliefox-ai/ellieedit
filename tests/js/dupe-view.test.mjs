// View-mode classification (2026-10-08j) — pure logic tests.
// Run: node --test tests/js/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyVerdictState, inDeletionManifest } from
  '../../frontend/js/modules/dupe-view.js';

test('empty/missing verdict tally -> neither view', () => {
  assert.deepEqual(familyVerdictState(null), { accepted: false, rejected: false });
  assert.deepEqual(familyVerdictState({}), { accepted: false, rejected: false });
  assert.deepEqual(familyVerdictState({ deferred: 3 }),
    { accepted: false, rejected: false });
});

test('kept / melded -> accepted', () => {
  assert.equal(familyVerdictState({ kept: 1 }).accepted, true);
  assert.equal(familyVerdictState({ melded: 2 }).accepted, true);
  assert.equal(familyVerdictState({ kept: 1 }).rejected, false);
});

test('rejected -> rejected view', () => {
  const vs = familyVerdictState({ rejected: 2 });
  assert.equal(vs.rejected, true);
  assert.equal(vs.accepted, false);
});

test('split verdict (kept AND rejected) lands in BOTH views', () => {
  const vs = familyVerdictState({ kept: 1, rejected: 3 });
  assert.equal(vs.accepted, true);
  assert.equal(vs.rejected, true);
});

test('deferred alone never counts as accepted', () => {
  const vs = familyVerdictState({ deferred: 4, melded: 0 });
  assert.equal(vs.accepted, false);
  assert.equal(vs.rejected, false);
});

test('inDeletionManifest: any pending reject > 0 dims', () => {
  assert.equal(inDeletionManifest({ pending: 0 }), false);
  assert.equal(inDeletionManifest({ pending: 2 }), true);
  assert.equal(inDeletionManifest(undefined), false);
  assert.equal(inDeletionManifest({}), false);
});
