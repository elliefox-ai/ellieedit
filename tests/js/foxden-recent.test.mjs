// FoxDen recent-strip helpers: collapse persistence + count label.
import { COLLAPSE_KEY, readCollapsed, writeCollapsed, recentLabel, flattenRecent, cycleIndex } from
  '../../frontend/js/modules/foxden-recent.js';
import assert from 'node:assert/strict';

const mem = () => { const m = new Map(); return {
  getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }; };

// default: expanded when nothing stored
assert.equal(readCollapsed(mem()), false);

// round-trip, and it survives a "fresh client" sharing the same storage
const st = mem();
assert.equal(writeCollapsed(st, true), true);
assert.equal(st._m.get(COLLAPSE_KEY), '1');
assert.equal(readCollapsed(st), true);
writeCollapsed(st, false);
assert.equal(readCollapsed(st), false);

// storage that throws (Safari private mode) or is missing must not break anything
const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
assert.equal(readCollapsed(boom), false);
assert.equal(writeCollapsed(boom, true), false);
assert.equal(readCollapsed(undefined), false);
assert.equal(writeCollapsed(null, true), false);

// junk stored values read as expanded
const junk = mem(); junk.setItem(COLLAPSE_KEY, 'banana');
assert.equal(readCollapsed(junk), false);

// label: count always visible, garbage totals clamp to 0, extras append
assert.equal(recentLabel(12), 'recent · 12');
assert.equal(recentLabel(0), 'recent · 0');
assert.equal(recentLabel(undefined), 'recent · 0');
assert.equal(recentLabel(NaN), 'recent · 0');
assert.equal(recentLabel(3, ' · adopted 1'), 'recent · 3 · adopted 1');

// flatten: server order, urls in order, entry carried per url; junk skipped
const a = { workflow: 'w', seed: 1, prompt: 'p', urls: ['u1', 'u2'] };
const b = { workflow: 'w', seed: 2, prompt: 'q', urls: ['u3'] };
assert.deepEqual(flattenRecent([a, b]),
  [{ url: 'u1', entry: a }, { url: 'u2', entry: a }, { url: 'u3', entry: b }]);
assert.deepEqual(flattenRecent([]), []);
assert.deepEqual(flattenRecent(null), []);
assert.deepEqual(flattenRecent([{ urls: null }, { noUrls: true }, a]),
  [{ url: 'u1', entry: a }, { url: 'u2', entry: a }]);

// cycle: plain steps plus wrap-around both ways, empty list is -1
assert.equal(cycleIndex(0, 1, 3), 1);
assert.equal(cycleIndex(2, 1, 3), 0);
assert.equal(cycleIndex(0, -1, 3), 2);
assert.equal(cycleIndex(1, -1, 3), 0);
assert.equal(cycleIndex(0, 0, 1), 0);
assert.equal(cycleIndex(0, 1, 0), -1);
assert.equal(cycleIndex(0, 1, -2), -1);
assert.equal(cycleIndex(NaN, 1, 3), 0);
assert.equal(cycleIndex(NaN, -1, 3), 2);

console.log('PASS foxden-recent');
