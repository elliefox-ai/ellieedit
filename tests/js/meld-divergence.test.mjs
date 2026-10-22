// Meld divergence pre-seed (Increment 1, SALVAGE §3): algorithm contract test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { divergenceMask, gaussianBlur, median, toGray } from '../../frontend/js/modules/meld-divergence.js';

function makeImg(w, h) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

function solid(w, h, r, g, b) {
  const d = makeImg(w, h);
  for (let p = 0; p < d.data.length; p += 4) {
    d.data[p] = r; d.data[p + 1] = g; d.data[p + 2] = b; d.data[p + 3] = 255;
  }
  return d;
}

function withSquare(img, w, h, x0, y0, sw, sh) {
  const d = { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  for (let y = y0; y < y0 + sh; y++) {
    for (let x = x0; x < x0 + sw; x++) {
      const p = (y * w + x) * 4;
      d.data[p] = 255; d.data[p + 1] = 255; d.data[p + 2] = 255;
    }
  }
  return d;
}

test('identical images produce an empty divergence mask', () => {
  const a = solid(64, 64, 40, 80, 120);
  const { mask, count } = divergenceMask(a, a, 64, 64);
  assert.equal(count, 0);
  assert.ok(mask.every(v => v === 0));
});

test('a differing region is flagged, noise is not (8.0 floor), and the mask is dilated', () => {
  const w = 128, h = 128;
  const a = solid(w, h, 30, 30, 30);
  // +4 gray noise everywhere: below the absolute 8.0 floor → no sparks.
  const noisy = solid(w, h, 34, 34, 34);
  assert.equal(divergenceMask(a, noisy, w, h).count, 0);
  // A 20×20 bright square: real divergence, and dilation must grow it.
  const b = withSquare(a, w, h, 50, 50, 20, 20);
  const { mask, count } = divergenceMask(a, b, w, h);
  assert.ok(count > 20 * 20, `dilated mask (${count}) exceeds the 20×20 core`);
  assert.ok(count < 40 * 40, `dilated mask (${count}) stays near the core`);
  // The dilate pass is a 9×9 max filter: a pixel 3px outside the square is on.
  assert.equal(mask[47 * w + 60], 255);
  // …and a pixel far away is not.
  assert.equal(mask[5 * w + 5], 0);
});

test('blur, median, and gray helpers behave per contract', () => {
  const g = toGray(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
  assert.equal(g[0], 0);
  const arr = new Float32Array([3, 1, 2, 4]);
  assert.equal(median(arr), 2.5);
  assert.equal(median(new Float32Array([1, 9, 2])), 2);
  // Constant field survives the σ=2 blur unchanged (normalized kernel).
  const flat = gaussianBlur(new Float32Array(100).fill(7), 10, 10, 2);
  for (const v of flat) assert.ok(Math.abs(v - 7) < 1e-4);
});
