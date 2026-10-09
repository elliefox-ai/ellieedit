// Update tab version-stack state machine — pure logic tests.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStack, current, source, isOriginal, canRevert, compareEntry,
  pushRender, swap, revert, revertToOriginal, saveable,
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
