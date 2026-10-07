// Unit test: edge-stop containment mask math (ported from Meld).
// Run: node tests/js/edge-stop.test.mjs   (exit 0 = pass)

import assert from 'node:assert/strict';
import { computeEdgeMap, applyEdgeStop, buildRectMask, gaussianBlur, percentile } from '../../frontend/js/edge-stop.js';

// ── helpers ──
function solidRGBA(w, h, r, g, b) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; }
  return d;
}
function verticalStepRGBA(w, h) {
  // black left half, white right half → one strong vertical edge down the middle
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? 0 : 255;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  return d;
}

// ── percentile ──
assert.equal(percentile(new Float32Array([3, 1, 2]), 90), 3);
assert.equal(percentile(new Float32Array([1, 2, 3, 4]), 50), 3); // round-half-up index 1.5→2

// ── gaussianBlur: constant field stays constant, sum ≈ 1 ──
{
  const f = new Float32Array(64).fill(7);
  const b = gaussianBlur(f, 8, 8, 2);
  for (const v of b) assert.ok(Math.abs(v - 7) < 1e-3, 'blur preserves constant field');
}

// ── computeEdgeMap: flat image → near-zero edges ──
{
  const e = computeEdgeMap(solidRGBA(64, 64, 128, 128, 128), 64, 64);
  const maxE = Math.max(...e);
  assert.ok(maxE < 0.05, `flat image edge max ${maxE} should be ~0`);
}

// ── computeEdgeMap: step image → strong edge only near the boundary ──
{
  const w = 128, h = 64;
  const e = computeEdgeMap(verticalStepRGBA(w, h), w, h);
  const at = (x, y) => e[y * w + x];
  const edgeMax = Math.max(...Array.from({ length: h }, (_, y) => at(Math.floor(w / 2), y)));
  assert.ok(edgeMax > 0.5, `boundary edge ${edgeMax} should be strong`);
  const flatMax = Math.max(at(5, 5), at(w - 6, 5));
  assert.ok(flatMax < 0.2, `far-from-edge value ${flatMax} should be weak`);
}

// ── applyEdgeStop: cap = 1 - edge*estop, multiplicative ──
{
  const mask = new Float32Array([1, 1, 1]);
  const edge = new Float32Array([0, 0.5, 1]);
  const out = applyEdgeStop(mask, edge, 0.8);
  assert.ok(Math.abs(out[0] - 1) < 1e-6 && Math.abs(out[1] - 0.6) < 1e-6 && Math.abs(out[2] - 0.2) < 1e-6, 'cap is multiplicative');
}

// ── buildRectMask: hard rect + estop 0 = plain blurred rect (old behavior) ──
{
  const w = 100, h = 100;
  const flat = computeEdgeMap(solidRGBA(w, h, 0, 0, 0), w, h); // all ~0
  const m = buildRectMask(w, h, { x: 20, y: 20, w: 60, h: 60 }, flat, 0, 6);
  assert.equal(m[50 * w + 50], 1, 'rect center fully opaque');
  assert.equal(m[2 * w + 2], 0, 'outside rect fully transparent');
  // blur falloff: value just outside the rect edge is between 0 and 1
  const justOutside = m[(18) * w + 50];
  assert.ok(justOutside > 0 && justOutside < 1, `feather at ${justOutside}`);
}

// ── buildRectMask: edge across the rect suppresses the feather there ──
{
  const w = 256, h = 64;
  const e = computeEdgeMap(verticalStepRGBA(w, h), w, h);
  // rect spans the vertical edge at x=128
  const r = { x: 16, y: 16, w: 200, h: 32 };
  const m0 = buildRectMask(w, h, r, e, 0, 6);
  const m8 = buildRectMask(w, h, r, e, 1.0, 6);
  const onEdge = 32 * w + 128; // a deep-interior pixel that sits on the edge line
  assert.ok(m8[onEdge] < m0[onEdge], `edge-stopped ${m8[onEdge]} < plain ${m0[onEdge]}`);
  // interior far from any edge (>40px, beyond feather+cap reach) is unaffected
  const offEdge = 32 * w + 40;
  assert.ok(Math.abs(m8[offEdge] - m0[offEdge]) < 1e-3, `containment only bites on edges (${m8[offEdge]} vs ${m0[offEdge]})`);
}

console.log('edge-stop.test.mjs: all assertions passed');
