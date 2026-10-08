// Zoom view-filter logic (2026-10-08j, re-scoped) — pure tests.
// Run: node --test tests/js/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoomModeMatches, zoomMembers } from
  '../../frontend/js/modules/dupe-view.js';

const members = [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }];
const verdicts = { a: 'kept', b: 'rejected', c: 'melded' }; // d undeclared

test('all mode visits every member incl. undeclared', () => {
  assert.deepEqual(zoomMembers(members, verdicts, 'all').map(m => m.path),
    ['a', 'b', 'c', 'd']);
});

test('accepted mode = kept + melded only', () => {
  assert.deepEqual(zoomMembers(members, verdicts, 'accepted').map(m => m.path),
    ['a', 'c']);
});

test('rejected mode = rejected only', () => {
  assert.deepEqual(zoomMembers(members, verdicts, 'rejected').map(m => m.path),
    ['b']);
});

test('undeclared members never leak into accepted/rejected', () => {
  assert.equal(zoomMembers(members, {}, 'accepted').length, 0);
  assert.equal(zoomMembers(members, {}, 'rejected').length, 0);
});

test('null/undefined verdict treated as undeclared', () => {
  assert.equal(zoomModeMatches('accepted', null), false);
  assert.equal(zoomModeMatches('rejected', undefined), false);
  assert.equal(zoomModeMatches('all', null), true);
});

test('empty members -> empty set in every mode (zoom empty hint)', () => {
  for (const mode of ['all', 'accepted', 'rejected'])
    assert.deepEqual(zoomMembers([], verdicts, mode), []);
});
