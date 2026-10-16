// Task 5 add.6 — LoRA pin state: pin / suspend / restore / remove, strengths,
// filter-never-hides-pins, faithful Reuse restore. Run: node tests/js/foxden-loras.test.mjs
import assert from 'node:assert/strict';
import { createPins } from '../../frontend/js/modules/foxden-loras.js';

const all = ['a.safetensors', 'b.safetensors', 'style_x.safetensors'];
const p = createPins();

p.pin('a.safetensors', 0.8); p.pin('b.safetensors');
assert.deepEqual(p.payload(), [
  { name: 'a.safetensors', strength_model: 0.8 }, { name: 'b.safetensors', strength_model: 1 }]);

// suspend parks WITH its strength, removes it from the submitted payload
p.suspend('a.safetensors');
assert.deepEqual(p.payload(), [{ name: 'b.safetensors', strength_model: 1 }]);
assert.deepEqual(p.suspendedPayload(), [{ name: 'a.safetensors', strength_model: 0.8 }]);
// strength edits work while parked; restore brings the (edited) value back
p.setStrength('a.safetensors', 1.4);
p.restore('a.safetensors');
assert.equal(p.active.get('a.safetensors'), 1.4);
assert.equal(p.suspended.size, 0);

// filter narrows the pick list only; pins never filtered, never duplicated in it
p.suspend('b.safetensors');
assert.deepEqual(p.pickList(all, ''), ['style_x.safetensors']);          // a active, b parked
assert.deepEqual(p.pickList(all, 'STYLE'), ['style_x.safetensors']);
assert.deepEqual(p.pickList(all, 'zzz'), []);
assert.equal(p.payload().length, 1);                                      // pin survives any filter

// pinning a parked LoRA un-parks it (no dupes)
p.pin('b.safetensors', 0.3);
assert.equal(p.suspended.size, 0); assert.equal(p.active.get('b.safetensors'), 0.3);

// remove clears from either place
p.suspend('b.safetensors'); p.remove('b.safetensors'); p.remove('a.safetensors');
assert.equal(p.count(), 0); assert.equal(p.suspended.size, 0);

// strengths clamp to the slider range
p.pin('a.safetensors', 9); assert.equal(p.active.get('a.safetensors'), 2);
p.pin('a.safetensors', -9); assert.equal(p.active.get('a.safetensors'), -1);

// Reuse settings: faithful restore of pins + suspended; old entries have no tray
const q = createPins();
q.restoreFrom([{ name: 'a.safetensors', strength_model: 0.5 }],
              [{ name: 'b.safetensors', strength_model: 1.25 }]);
assert.deepEqual(q.payload(), [{ name: 'a.safetensors', strength_model: 0.5 }]);
assert.deepEqual(q.suspendedPayload(), [{ name: 'b.safetensors', strength_model: 1.25 }]);
q.restoreFrom([{ name: 'a.safetensors', strength_model: 1 }], undefined);
assert.equal(q.suspended.size, 0);
// a name in both lists resolves to active (never submitted AND parked)
q.restoreFrom([{ name: 'a.safetensors', strength_model: 1 }], [{ name: 'a.safetensors', strength_model: 0.1 }]);
assert.equal(q.suspended.size, 0);

console.log('foxden-loras: all pin-state contracts hold');
