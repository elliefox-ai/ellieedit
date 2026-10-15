// FoxDen recent-strip helpers: collapse persistence + count label.
import { COLLAPSE_KEY, readCollapsed, writeCollapsed, recentLabel } from
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

console.log('PASS foxden-recent');
