// Gallery manifest-change plan + scroll-anchor helpers.
import { diffManifest, planManifestChange, pickSurvivor, scrollDeltaFor } from
  '../../frontend/js/modules/gallery-scroll.js';
import assert from 'node:assert/strict';

const S = (...a) => new Set(a);

// ── diffManifest ──────────────────────────────────────────────────────
assert.deepEqual(diffManifest(S('a', 'b'), S('b', 'c')), { added: ['c'], removed: ['a'] });
assert.deepEqual(diffManifest(S(), S()), { added: [], removed: [] });
assert.deepEqual(diffManifest(S('a'), S('a')), { added: [], removed: [] });

// ── planManifestChange: the "don't rebuild the grid" contract ─────────
const none = { added: [], removed: [] };
// Active view: marking rejects in Ladder -> they leave the grid, NO reload.
let p = planManifestChange('active', { added: ['x', 'y'], removed: [] });
assert.deepEqual([...p.removeLocal], ['x', 'y']);
assert.equal(p.reload, false);
// Active view: an image returned to Active must be re-inserted -> reload.
p = planManifestChange('active', { added: [], removed: ['x'] });
assert.equal(p.removeLocal.size, 0);
assert.equal(p.reload, true);
// Active, both at once: still remove locally AND reload.
p = planManifestChange('active', { added: ['a'], removed: ['b'] });
assert.deepEqual([...p.removeLocal], ['a']); assert.equal(p.reload, true);
// Pending view is the mirror image.
p = planManifestChange('pending', { added: [], removed: ['x'] });
assert.deepEqual([...p.removeLocal], ['x']); assert.equal(p.reload, false);
p = planManifestChange('pending', { added: ['n'], removed: [] });
assert.equal(p.reload, true); assert.equal(p.removeLocal.size, 0);
// 'all' view only re-badges.
p = planManifestChange('all', { added: ['x'], removed: ['y'] });
assert.equal(p.removeLocal.size, 0); assert.equal(p.reload, false);
// No change -> nothing, in every view.
for (const v of ['all', 'active', 'pending']) {
  p = planManifestChange(v, none);
  assert.equal(p.removeLocal.size, 0); assert.equal(p.reload, false);
}

// ── pickSurvivor ──────────────────────────────────────────────────────
const order = [null, 'a', 'b', 'c', 'd', 'e'];   // null = folder card
assert.equal(pickSurvivor(order, 'c', S('x')), 'c');            // anchor survives
assert.equal(pickSurvivor(order, 'c', S('c')), 'd');            // next slides in
assert.equal(pickSurvivor(order, 'c', S('c', 'd')), 'e');       // skip a removed run
assert.equal(pickSurvivor(order, 'e', S('e')), 'd');            // at the end: previous
assert.equal(pickSurvivor(order, 'd', S('d', 'e')), 'c');
assert.equal(pickSurvivor(order, 'a', S('a', 'b', 'c', 'd', 'e')), null);  // nothing left
assert.equal(pickSurvivor(order, 'zzz', S('a')), null);         // anchor not in grid
assert.equal(pickSurvivor([], 'a', S('a')), null);
assert.equal(pickSurvivor([null, 'a'], 'a', S('a')), null);     // folder cards never anchor

// ── scrollDeltaFor ────────────────────────────────────────────────────
// Cell is 300px below the grid top but we want it 120px below -> scroll down 180.
assert.equal(scrollDeltaFor(400, 100, 120), 180);
assert.equal(scrollDeltaFor(220, 100, 120), 0);                 // already in place
assert.equal(scrollDeltaFor(150, 100, 120), -70);               // too low -> scroll up

console.log('PASS gallery-scroll');
