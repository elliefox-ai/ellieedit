import assert from 'node:assert/strict';
import { BATCH_MIN, BATCH_MAX, clampBatch, batchFromPointer } from '../../frontend/js/modules/studio-pips.js';

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

// batchFromPointer: four pips across the box; nearest-pip mapping
const rect = { left: 100, width: 400 };
assert.equal(batchFromPointer(100, rect), 1);   // far left
assert.equal(batchFromPointer(160, rect), 1);   // first pip zone (frac < 1/6)
assert.equal(batchFromPointer(235, rect), 2);   // ~1/3
assert.equal(batchFromPointer(300, rect), 3);   // exact mid maps to pip 3 (0.5 rounds up)
assert.equal(batchFromPointer(380, rect), 3);
assert.equal(batchFromPointer(500, rect), 4);   // past the right edge clamps
assert.equal(batchFromPointer(50, rect), 1);    // before the box clamps
assert.equal(batchFromPointer(200, null), 1);   // degenerate rect
assert.equal(batchFromPointer(200, { left: 100, width: 0 }), 1);

console.log('PASS studio-pips');
