// FoxDen input-image browser helpers (Chunk A UX, 2026-11-11):
// recency-first ordering, name sort, filter, paging.
import { orderInputs, pageInputs, INPUTS_PAGE } from
  '../../frontend/js/modules/foxden-inputs.js';
import assert from 'node:assert/strict';

const names = ['alpha.png', 'beta.png', 'gamma.png', 'delta.png'];
const recency = { 'alpha.png': '2026-11-10T10:00:00-08:00', 'beta.png': '2026-11-11T09:00:00-08:00' };

// default: recency first (used inputs newest-first), never-used last in
// their original order
assert.deepEqual(orderInputs(names, recency, {}),
  ['beta.png', 'alpha.png', 'gamma.png', 'delta.png']);

// explicit 'recent' behaves the same
assert.deepEqual(orderInputs(names, recency, { sort: 'recent' })[0], 'beta.png');

// name sort: plain A→Z, recency ignored
assert.deepEqual(orderInputs(names, recency, { sort: 'name' }),
  ['alpha.png', 'beta.png', 'delta.png', 'gamma.png']);

// filter is case-insensitive substring
assert.deepEqual(orderInputs(names, recency, { q: 'AM' }), ['gamma.png']);
assert.deepEqual(orderInputs(names, recency, { sort: 'name', q: 'a' }),
  ['alpha.png', 'beta.png', 'delta.png', 'gamma.png']);

// junk inputs never throw
assert.deepEqual(orderInputs(null, null, {}), []);
assert.deepEqual(orderInputs([1, 'ok', ''], null, {}), ['ok']);
assert.deepEqual(orderInputs(names, 'banana', {}), names);   // no recency info: original order
assert.deepEqual(orderInputs(names, recency, { sort: 'banana' }), names); // unknown sort: stable passthrough

// paging: first page + remaining count
const page = pageInputs(names, 2);
assert.deepEqual(page.items, ['alpha.png', 'beta.png']);
assert.equal(page.more, 2);

// default page size, empty list, junk
assert.equal(INPUTS_PAGE > 0, true);
assert.deepEqual(pageInputs([], 24), { items: [], more: 0 });
assert.deepEqual(pageInputs(null), { items: [], more: 0 });
const big = Array.from({ length: INPUTS_PAGE + 7 }, (_, i) => `n${i}.png`);
assert.deepEqual(pageInputs(big).items.length, INPUTS_PAGE);
assert.deepEqual(pageInputs(big).more, 7);

console.log('PASS foxden-inputs');
