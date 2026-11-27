// Update tab version-stack state machine — pure logic tests.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStack, current, source, isOriginal, canRevert, compareEntry,
  pushRender, swap, setViewedAsBase, selectEntry, revert, revertToOriginal, saveable,
  stepBack, ancestry, lineage, parentOf, MAX_STACK_ENTRIES,
} from '../../frontend/js/modules/update-stack.js';

const orig = { url: 'blob:orig', name: 'original.png', path: 'folder/original.png' };
const r1 = { url: 'data:...1', name: 'render seed=1', path: 'ellieedit_tmp/update_00001_.png' };
const r2 = { url: 'data:...2', name: 'render seed=2', path: 'ellieedit_tmp/update_00002_.png' };

test('createStack starts on the original, source = original', () => {
  const s = createStack(orig);
  assert.equal(s.entries.length, 1);
  assert.equal(current(s), orig);
  assert.equal(source(s), orig);
  assert.ok(isOriginal(s));
  assert.ok(!canRevert(s));
  assert.throws(() => createStack(null));
});

test('pushRender appends and views the render; source stays put', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  assert.equal(s.entries.length, 2);
  assert.equal(current(s), r1);
  assert.equal(source(s), orig); // next run still renders FROM the original
  assert.ok(!isOriginal(s));
  assert.ok(canRevert(s));
});

test('swap: accepted render becomes the next source', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = swap(s);
  assert.equal(source(s), r1);
  assert.equal(current(s), r1); // view unchanged
  // render chained from the swapped source
  s = pushRender(s, r2);
  assert.equal(s.entries.length, 3);
  assert.equal(source(s), r1);
  assert.equal(current(s), r2);
});

test('setViewedAsBase: same as swap, viewed entry becomes the base', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = setViewedAsBase(s);
  assert.equal(source(s), r1);
  assert.equal(current(s), r1);
});

test('promote composition: pushRender + setViewedAsBase advances the run source', () => {
  // The ⬇ promote / advance (studio.js promoteCandidate): each stage
  // is pushed onto the stack first, then the run source moves to it — so
  // the next mask run renders FROM the promoted stage, not the original,
  // and the version history survives the advances.
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = setViewedAsBase(s);
  assert.equal(source(s), r1);
  assert.equal(compareEntry(s), orig); // the comparer keeps its before
  s = pushRender(s, r2);
  s = setViewedAsBase(s);
  assert.equal(source(s), r2);
  assert.equal(compareEntry(s), r1); // each stage compares against the previous one
  assert.equal(s.entries.length, 3);
});

test('selectEntry: forward cycling is viewed selection, clamped, no new entries', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = pushRender(s, r2);
  s = selectEntry(s, 0);
  assert.equal(current(s), orig);
  s = selectEntry(s, 1);
  assert.equal(current(s), r1);
  s = selectEntry(s, 99);
  assert.equal(current(s), r2);
  assert.equal(s.entries.length, 3);
  assert.equal(source(s), orig); // viewed selection never moves the base
});

test('revert steps back one entry and stops at the original', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = pushRender(s, r2);
  s = revert(s);
  assert.equal(current(s), r1);
  s = revert(s);
  assert.equal(current(s), orig);
  s = revert(s);
  assert.equal(current(s), orig); // floor
});

test('revert does not move the source pointer', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = swap(s);
  s = pushRender(s, r2);
  s = revert(s);
  assert.equal(source(s), r1);
});

test('revertToOriginal jumps to entry 0', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = swap(s);
  s = pushRender(s, r2);
  s = revertToOriginal(s);
  assert.equal(current(s), orig);
  assert.equal(source(s), r1); // swap survives
});

test('compareEntry: previous entry, self at the original', () => {
  let s = createStack(orig);
  assert.equal(compareEntry(s), orig);
  s = pushRender(s, r1);
  assert.equal(compareEntry(s), orig);
  s = pushRender(s, r2);
  assert.equal(compareEntry(s), r1);
});

test('saveable: only entries with a server path', () => {
  let s = createStack({ url: 'blob:x', name: 'no-path.png', path: '' });
  assert.ok(!saveable(s));
  s = pushRender(s, r1);
  assert.ok(saveable(s));
});

test('purity: operations never mutate the input state', () => {
  const s0 = createStack(orig);
  const s1 = pushRender(s0, r1);
  const s2 = swap(s1);
  const s3 = revert(s2);
  const s4 = revertToOriginal(s3);
  assert.equal(s0.entries.length, 1);
  assert.equal(s1.entries.length, 2);
  assert.equal(s0.idx, 0);
  assert.equal(s0.sourceIdx, 0);
  assert.equal(s2.sourceIdx, 1);
  assert.equal(s3.idx, 0);
  assert.equal(s4.idx, 0);
  assert.notEqual(s1, s0);
  assert.notEqual(s2, s1);
});

test('pushRender records the base as the render parent, entry untouched', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);            // base is the original (0)
  assert.equal(parentOf(s, 1), 0);
  s = swap(s);                      // base moves to r1
  s = pushRender(s, r2);            // r2 was generated from r1
  assert.equal(parentOf(s, 2), 1);
  assert.equal(parentOf(s, 0), null);
  assert.ok(!('parent' in r1) && !('parent' in r2)); // parents live beside the entries, never on them
  assert.deepEqual(s.parents, [null, 0, 1]);
});

test('explicit parent on the entry wins over the base', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = swap(s);
  s = pushRender(s, { ...r2, parent: 0 }); // caller knows better
  assert.equal(parentOf(s, 2), 0);
});

test('stepBack moves the view AND the base', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = swap(s);
  s = pushRender(s, r2);
  s = swap(s);
  assert.equal(current(s), r2);
  assert.equal(source(s), r2);
  s = stepBack(s);                  // revert alone would leave source on r2
  assert.equal(current(s), r1);
  assert.equal(source(s), r1);
  s = stepBack(s);
  assert.equal(current(s), orig);
  assert.equal(source(s), orig);
  s = stepBack(s);                  // floor: no-op at the original
  assert.equal(current(s), orig);
  assert.equal(source(s), orig);
});

test('ancestry walks parents, excludes a branch sibling', () => {
  // A -> B -> C, then D branched from B (base never moved past B).
  let s = createStack(orig);
  s = pushRender(s, r1);            // B, parent 0
  s = swap(s);                      // base = B
  s = pushRender(s, r2);            // C, parent 1
  const r3 = { url: 'data:...3', name: 'render seed=3', path: 'ellieedit_tmp/update_00003_.png' };
  s = pushRender(s, r3);            // D, parent 1 — branched from B, not from C
  assert.deepEqual(ancestry(s, 3), [r1]);       // D's intermediates: B only
  assert.deepEqual(ancestry(s, 2), [r1]);       // C's intermediates: B only
  assert.deepEqual(ancestry(s, 1), []);         // B's intermediates: none
  assert.deepEqual(ancestry(s), [r1]);          // default idx = viewed (D)
  // The old flat slice(1, idx) would have listed C as an intermediate of D.
  assert.deepEqual(s.entries.slice(1, s.idx), [r1, r2]);
});

test('lineage rows carry parent + current/base markers', () => {
  let s = createStack(orig);
  s = pushRender(s, r1);
  s = swap(s);
  s = pushRender(s, r2);
  const rows = lineage(s);
  assert.deepEqual(rows.map(r => r.index), [0, 1, 2]);
  assert.deepEqual(rows.map(r => r.parent), [null, 0, 1]);
  assert.deepEqual(rows.map(r => r.isCurrent), [false, false, true]);
  assert.deepEqual(rows.map(r => r.isBase), [false, true, false]);
  assert.equal(rows[2].entry, r2);
});

test('parentOf falls back to linear on pre-parent stacks', () => {
  const s = { entries: [orig, r1, r2], idx: 2, sourceIdx: 0 }; // no parents array
  assert.equal(parentOf(s, 2), 1);
  assert.equal(parentOf(s, 1), 0);
  assert.equal(parentOf(s, 0), null);
  assert.deepEqual(ancestry(s), [r1]);
});

const render = i => ({ url: `data:...${i}`, name: `render seed=${i}`, path: `ellieedit_tmp/update_${String(i).padStart(5, '0')}_.png` });
// A linear chain of n renders (each generated from the last, as
// promoteCandidate does): push + re-base after every render.
function chain(n) {
  let s = createStack(orig);
  for (let i = 1; i <= n; i++) {
    s = pushRender(s, render(i));
    s = swap(s);
  }
  return s;
}

test('ring cap is 50 and the original is never dropped', () => {
  assert.equal(MAX_STACK_ENTRIES, 50);
  const s = chain(120); // 121 entries → 71 trimmed, one per push past 50
  assert.equal(s.entries.length, 50);
  assert.equal(s.entries[0], orig);
  assert.equal(s.entries[1].name, 'render seed=72'); // r1..r71 dropped
  assert.equal(s.entries[49].name, 'render seed=120');
  assert.equal(s.idx, 49);
  assert.equal(s.sourceIdx, 49);
  assert.equal(current(s).name, 'render seed=120');
  assert.equal(source(s).name, 'render seed=120');
});

test('ring trims the oldest non-original render and remaps indices + parents', () => {
  // 50 pushes onto the original = 51 entries → exactly one trim (r1).
  const s = chain(50);
  assert.equal(s.entries.length, 50);
  assert.equal(s.entries[0], orig);
  assert.equal(s.entries[1].name, 'render seed=2'); // r1 dropped
  assert.equal(s.entries[49].name, 'render seed=50');
  assert.equal(s.idx, 49);
  assert.equal(s.sourceIdx, 49);
  assert.equal(current(s).name, 'render seed=50');
  assert.equal(source(s).name, 'render seed=50');
  // Parents remapped by the same shift: r2's parent was r1 (dropped) so
  // it falls back to the original; r3's parent r2 is now index 1.
  assert.deepEqual(s.parents, [null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]);
  assert.equal(parentOf(s, 1), 0);
  // Ancestry still correct after the trim: the dropped render is gone,
  // so it is not an intermediate of the newest entry.
  assert.deepEqual(ancestry(s).map(e => e.name), Array.from({ length: 48 }, (_, i) => `render seed=${i + 2}`));
});

test('ring remaps a non-latest base and view when trimming', () => {
  let s = chain(49); // 50 entries, no trim yet; idx 49, base 49
  s = selectEntry(s, 2);
  s = setViewedAsBase(s); // view + base on r2 (old index 2)
  s = pushRender(s, render(50)); // 51 entries → r1 trimmed
  assert.equal(s.entries.length, 50);
  assert.equal(s.entries[0], orig);
  assert.equal(s.entries[1].name, 'render seed=2'); // r1 dropped
  assert.equal(s.idx, 49); // the new render is viewed
  assert.equal(s.sourceIdx, 1); // the base (r2) shifted with the trim
  assert.equal(current(s).name, 'render seed=50');
  assert.equal(source(s).name, 'render seed=2');
});

test('ring: a kept entry whose parent was dropped falls back to the original', () => {
  let s = chain(49); // 50 entries, no trim yet
  // New render with an explicit parent of r1 (old index 1); the push
  // trims r1, so the parent falls back to the original.
  s = pushRender(s, { ...render(50), parent: 1 });
  assert.equal(s.entries.length, 50);
  assert.equal(parentOf(s, 49), 0);
  assert.deepEqual(ancestry(s), []); // parent is the original — no intermediates
  // The same fallback applies to a pre-existing kept entry, not just the
  // new one: r2's parent was r1, dropped by the same trim.
  assert.equal(parentOf(s, 1), 0);
});

test('ring: no trim below the cap, and trim drops several at once if forced', () => {
  const s49 = chain(49);
  assert.equal(s49.entries.length, 50); // exactly at the cap — nothing dropped
  assert.equal(s49.entries[1].name, 'render seed=1');
  const s55 = chain(55); // 56 entries → 6 trimmed, one per push past 50
  assert.equal(s55.entries.length, 50);
  assert.equal(s55.entries[0], orig);
  assert.equal(s55.entries[1].name, 'render seed=7'); // r1..r6 dropped
  assert.equal(s55.entries[49].name, 'render seed=55');
  assert.equal(parentOf(s55, 1), 0); // r7's parent r6 was dropped
  assert.equal(parentOf(s55, 2), 1); // r8's parent r7 kept, shifted
});
