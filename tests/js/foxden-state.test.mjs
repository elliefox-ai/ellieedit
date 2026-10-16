// Task 5 add.2 — form-state normalization, lock-seed semantics, debounce.
// Run: node tests/js/foxden-state.test.mjs
import assert from 'node:assert/strict';
import { normalizeState, presetState, debounce, cleanName } from '../../frontend/js/modules/foxden-state.js';

const full = { workflow: 'klein', prompt: 'a fox', aspect: 'portrait', seed: 42,
  loras: [{ name: 'a', strength_model: 0.5 }], suspended_loras: [{ name: 'b', strength_model: 1.25 }],
  steps: 6, denoise: 0.6, input_image: 'in.png' };

// every field round-trips (incl. suspended tray + input image ref)
assert.deepEqual(normalizeState(full), full);
assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(full))), full);

// garbage in -> safe defaults out (old/corrupt stored states never crash apply)
assert.deepEqual(normalizeState(null),
  { workflow: '', prompt: '', aspect: 'landscape', seed: null, loras: [], suspended_loras: [] });
const g = normalizeState({ aspect: 'diagonal', seed: 'abc', loras: [null, {}, { name: 'x', strength_model: 'z' }], steps: 'n/a' });
assert.equal(g.aspect, 'landscape'); assert.equal(g.seed, null);
assert.deepEqual(g.loras, [{ name: 'x', strength_model: 1 }]); assert.ok(!('steps' in g));

// lock seed: saved only when ticked; otherwise random (null)
assert.equal(presetState(full, true).seed, 42);
assert.equal(presetState(full, false).seed, null);
assert.equal(presetState(full, false).prompt, 'a fox');          // nothing else dropped

// debounce: trailing, collapses bursts, flush is immediate and clears pending
const q = []; let id = 0; const timers = { set: (fn) => { q.push(fn); return ++id; }, clear: () => { q.length = 0; } };
let calls = 0; const d = debounce(() => { calls++; }, 800, timers);
d(); d(); d();
assert.equal(calls, 0); assert.equal(d.pending(), true); assert.equal(q.length, 1);
q[0](); assert.equal(calls, 1); assert.equal(d.pending(), false);
d(); d.flush(); assert.equal(calls, 2); assert.equal(d.pending(), false);

assert.equal(cleanName('  couch   fox  '), 'couch fox');
assert.equal(cleanName(null), '');
assert.equal(cleanName('x'.repeat(80)).length, 60);

console.log('foxden-state: all contracts hold');
