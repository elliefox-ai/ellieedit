import assert from 'node:assert/strict';
import { BATCH_MIN, BATCH_MAX, clampBatch, batchFromRockerDrag } from '../../frontend/js/modules/studio-pips.js';

// clampBatch: bounds + rounding + garbage safety
assert.equal(clampBatch(1), 1);
assert.equal(clampBatch(3), 3);
assert.equal(clampBatch(0), 1);
assert.equal(clampBatch(-2), 1);
assert.equal(clampBatch(5), 4);
assert.equal(clampBatch(2.4), 2);
assert.equal(clampBatch(2.6), 3);
assert.equal(clampBatch(NaN), 1);
assert.equal(clampBatch('3'), 3);
assert.equal(BATCH_MIN, 1);
assert.equal(BATCH_MAX, 4);

// batchFromRockerDrag: hold, then drag vertically — up adds, down subtracts,
// one step per 28px of travel from the drag start; clamped 1..4
assert.equal(batchFromRockerDrag(1, 200, 200), 1);   // no movement
assert.equal(batchFromRockerDrag(1, 200, 172), 2);   // 28px up = +1
assert.equal(batchFromRockerDrag(1, 200, 144), 3);   // 56px up = +2
assert.equal(batchFromRockerDrag(2, 200, 228), 1);   // 28px down = -1
assert.equal(batchFromRockerDrag(1, 200, 100), 4);   // far up clamps at 4
assert.equal(batchFromRockerDrag(4, 200, 300), 1);   // far down clamps at 1
assert.equal(batchFromRockerDrag(2, 200, 186), 3);   // 14px up rounds up to a step
assert.equal(batchFromRockerDrag(2, 200, 213), 2);   // 13px down stays
assert.equal(batchFromRockerDrag(2, 200, 100, 0), 4); // garbage step falls back to 28px
assert.equal(batchFromRockerDrag(2, 200, 100, -5), 4);

console.log('PASS studio-pips');
