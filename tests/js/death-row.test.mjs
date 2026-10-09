// Death-row rehydration pure logic (2026-10-09b): majority test, sort,
// queue counts, GB formatting. Mirrors backend _death_row_rows semantics.
import { majorityRejected, selectDeathRow, queueCounts, gb } from
  '../../frontend/js/modules/death-row.js';
import assert from 'node:assert/strict';

// ── majorityRejected ──────────────────────────────────────────────────
assert.equal(majorityRejected({ a: 'rejected', b: 'rejected', c: 'kept' }), true);
assert.equal(majorityRejected({ a: 'rejected', b: 'kept', c: 'kept' }), false);   // 1 < 2
assert.equal(majorityRejected({ a: 'rejected', b: 'kept' }), true);               // 1 >= 1 tie → majority
assert.equal(majorityRejected({ a: 'kept', b: 'melded', c: 'deferred' }), false); // zero rejects
assert.equal(majorityRejected({}), false);
assert.equal(majorityRejected(), false);

// ── selectDeathRow: filter + latest-verdict-wins + sort ──────────────
const fams = [
  { id: 'fam-c', size: 5 },
  { id: 'fam-a', size: 3 },
  { id: 'fam-b', size: 2 },
  { id: 'fam-d', size: 9 },   // never verdicts → excluded
];
const v = {
  'fam-a': { members: { p1: 'rejected', p2: 'rejected', p3: 'kept' } },          // 2 rej
  'fam-b': { members: { x: 'rejected' } },                                        // 1 rej
  'fam-c': { members: { m1: 'kept', m2: 'kept', m3: 'rejected', m4: 'melded' } }, // 1 < 2 → excluded
};
const rows = selectDeathRow(fams, v);
assert.deepEqual(rows.map(r => r.id), ['fam-a', 'fam-b']);           // rejected desc
assert.ok(rows.every(r => r.state === 'unresolved' && r.rehydrated === true));
assert.equal(rows[0].rejected, 2);
assert.equal(rows[0].kept, 1);
assert.equal(rows[1].rejected, 1);

// sort tie (equal rejects): stable id asc
const tied = selectDeathRow(
  [{ id: 'fam-z' }, { id: 'fam-y' }],
  { 'fam-z': { members: { a: 'rejected' } }, 'fam-y': { members: { b: 'rejected' } } });
assert.deepEqual(tied.map(r => r.id), ['fam-y', 'fam-z']);

// LATEST verdict wins: an overriding flip drops the family out
const overridden = selectDeathRow(fams, {
  ...v,
  'fam-a': { members: { p1: 'kept', p2: 'kept', p3: 'rejected' } },  // now majority kept
});
assert.deepEqual(overridden.map(r => r.id), ['fam-b']);

// a flip INTO majority-rejected pulls a resolved family back in
const pulled = selectDeathRow(fams, {
  ...v,
  'fam-c': { members: { m1: 'rejected', m2: 'rejected', m3: 'rejected', m4: 'kept' } },
});
assert.deepEqual(pulled.map(r => r.id), ['fam-c', 'fam-a', 'fam-b']);

// ── queueCounts + gb ─────────────────────────────────────────────────
const q = queueCounts([
  { rejected_files: 3, rejected_bytes: 2 * 1073741824 },
  { rejected_files: 0, rejected_bytes: 0 },                      // everything pardoned
  { rejected_files: 1, rejected_bytes: 0.5 * 1073741824 },
]);
assert.deepEqual(q, { files: 4, bytes: 2.5 * 1073741824 });
assert.equal(queueCounts([]).files, 0);
assert.equal(gb(2.5 * 1073741824), '2.50');
assert.equal(gb(0), '0.00');
assert.equal(gb(null), '0.00');

console.log('death-row.test.mjs: all assertions passed');
