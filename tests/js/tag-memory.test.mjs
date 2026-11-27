// Shared recent-tag memory (components/tag-memory.js): recency order, cap,
// counts, chip selection, comma-list helpers, and carry-over of the stored
// shape Gallery's promote dialog wrote before the extraction.
import test from 'node:test';
import assert from 'node:assert/strict';

import { TAG_KEY, loadTagMemory, recordTag, recordTags, tagChips, splitTags, toggleTagInList }
  from '../../frontend/js/components/tag-memory.js';

const mem = () => {
  const d = new Map();
  return { getItem: k => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)) };
};

test('empty / corrupt storage yields an empty memory', () => {
  assert.deepEqual(loadTagMemory(mem()), { recent: [], counts: {} });
  const s = mem(); s.setItem(TAG_KEY, '{not json');
  assert.deepEqual(loadTagMemory(s), { recent: [], counts: {} });
});

test('recordTag: most recent first, de-duplicated, counted', () => {
  const s = mem();
  recordTag('a', s); recordTag('b', s); recordTag('a', s);
  const m = loadTagMemory(s);
  assert.deepEqual(m.recent, ['a', 'b']);
  assert.equal(m.counts.a, 2);
  assert.equal(m.counts.b, 1);
});

test('recent list is capped at 8', () => {
  const s = mem();
  for (let i = 0; i < 12; i++) recordTag(`t${i}`, s);
  const m = loadTagMemory(s);
  assert.equal(m.recent.length, 8);
  assert.equal(m.recent[0], 't11');
});

test('recordTags (retag list): first tag ends up most recent', () => {
  const s = mem();
  recordTags(['x', 'y', 'z'], s);
  assert.deepEqual(loadTagMemory(s).recent, ['x', 'y', 'z']);
  recordTags(['z', 'q'], s);
  assert.deepEqual(loadTagMemory(s).recent.slice(0, 2), ['z', 'q']);
});

test('blank tags are ignored', () => {
  const s = mem();
  recordTag('  ', s); recordTags(['', ' '], s);
  assert.deepEqual(loadTagMemory(s), { recent: [], counts: {} });
});

test('tagChips: 5 recent first, then most-used, no duplicates, max 8', () => {
  const m = { recent: ['a', 'b', 'c', 'd', 'e', 'f'],
    counts: { a: 1, z: 9, y: 8, x: 7, w: 6, v: 5 } };
  const c = tagChips(m);
  assert.deepEqual(c.slice(0, 5), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(new Set(c).size, c.length);
  assert.equal(c.length, 8);
  assert.deepEqual(c.slice(5), ['z', 'y', 'x']);
});

test('the pre-extraction Gallery storage shape loads as-is', () => {
  const s = mem();
  s.setItem(TAG_KEY, JSON.stringify({ recent: ['zengosoft', 'portraits'], counts: { zengosoft: 4 } }));
  const m = loadTagMemory(s);
  assert.deepEqual(m.recent, ['zengosoft', 'portraits']);
  assert.equal(m.counts.zengosoft, 4);
});

test('splitTags / toggleTagInList', () => {
  assert.deepEqual(splitTags(' a, b ,, c '), ['a', 'b', 'c']);
  assert.equal(toggleTagInList('a, b', 'c'), 'a, b, c');
  assert.equal(toggleTagInList('a, b, c', 'b'), 'a, c');
  assert.equal(toggleTagInList('', 'a'), 'a');
});
