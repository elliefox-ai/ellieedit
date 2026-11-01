// Task 5 add.2 — form-state normalization, lock-seed semantics, debounce.
// Run: node tests/js/foxden-state.test.mjs
import assert from 'node:assert/strict';
import { normalizeState, presetState, debounce, cleanName, nextSeed, sizeFor, SIZES } from '../../frontend/js/modules/foxden-state.js';

const full = { workflow: 'klein', prompt: 'a fox', aspect: 'portrait', seed: 42,
  loras: [{ name: 'a', strength_model: 0.5 }], suspended_loras: [{ name: 'b', strength_model: 1.25 }],
  steps: 6, denoise: 0.6, input_image: 'in.png' };

// every field round-trips (incl. suspended tray + input image ref)
assert.deepEqual(normalizeState(full), full);
assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(full))), full);

// garbage in -> safe defaults out (old/corrupt stored states never crash apply)
assert.deepEqual(normalizeState(null),
  { workflow: '', prompt: '', aspect: 'landscape', seed: null, loras: [], suspended_loras: [], denoise: 1 });
// denoise is ALWAYS present: defaults to 1, clamps to 0..1, survives presets
assert.equal(normalizeState({ denoise: '0.45' }).denoise, 0.45);
assert.equal(normalizeState({ denoise: 7 }).denoise, 1);
assert.equal(normalizeState({ denoise: 'junk' }).denoise, 1);
assert.equal(presetState({ ...full, denoise: 0.3 }, false).denoise, 0.3);
const g = normalizeState({ aspect: 'diagonal', seed: 'abc', loras: [null, {}, { name: 'x', strength_model: 'z' }], steps: 'n/a' });
assert.equal(g.aspect, 'landscape'); assert.equal(g.seed, null);
assert.deepEqual(g.loras, [{ name: 'x', strength_model: 1 }]); assert.ok(!('steps' in g));

// square aspect + stepped sizes (issue #3): step 1 is the old default for
// every aspect, ratios are exact, out-of-range / unknown inputs clamp safely
assert.equal(normalizeState({ aspect: 'square' }).aspect, 'square');
assert.deepEqual(sizeFor('landscape', 1), [1024, 576]);
assert.deepEqual(sizeFor('portrait', 1), [576, 1024]);
assert.deepEqual(sizeFor('square', 1), [1024, 1024]);
assert.deepEqual(sizeFor('square', 0), [768, 768]);
assert.deepEqual(sizeFor('square', 3), [1536, 1536]);
assert.deepEqual(sizeFor('square', 99), [1536, 1536]);
assert.deepEqual(sizeFor('square', -1), [768, 768]);
assert.deepEqual(sizeFor('diagonal', 1), [1024, 576]);
assert.equal(normalizeState({ size_idx: 3 }).size_idx, 3);
assert.equal(normalizeState({ size_idx: 99 }).size_idx, 3);
assert.equal(normalizeState({ size_idx: 'junk' }).size_idx, undefined);
assert.ok(!('size_idx' in normalizeState({})));
for (const [aspect, list] of Object.entries(SIZES)) {
  assert.equal(list.length, 4, aspect);
  assert.ok(list.every(([w, h]) => Number.isInteger(w) && Number.isInteger(h) && w % 16 === 0 && h % 16 === 0), aspect);
}

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

// seed-roll for Generate (2026-10-26, fx-send-seed item 2): lock keeps the
// typed seed, unlocked rolls fresh every time, locked-but-empty rolls once.
const realRandom = Math.random;
Math.random = () => 0.5;
const half = Math.floor(0.5 * 2 ** 31);
assert.equal(nextSeed({ locked: false, current: 42 }), half);   // unlocked ignores the field
assert.equal(nextSeed({ locked: true, current: '' }), half);    // locked-but-empty rolls once
assert.equal(nextSeed({ locked: true, current: 'junk' }), half); // garbage never pins
Math.random = realRandom;
assert.equal(nextSeed({ locked: true, current: 42 }), 42);
assert.equal(nextSeed({ locked: true, current: '7' }), 7);       // string field value pins as int
// three unlocked rolls are three different seeds, all in dice range
let i = 0; const seq = [0.1, 0.5, 0.9];
Math.random = () => seq[i++ % seq.length];
const rolled = [nextSeed({ locked: false }), nextSeed({ locked: false }), nextSeed({ locked: false })];
assert.equal(new Set(rolled).size, 3);
assert.ok(rolled.every(x => Number.isInteger(x) && x >= 0 && x < 2 ** 31));
Math.random = realRandom;
console.log('PASS foxden-state (incl. nextSeed)');
