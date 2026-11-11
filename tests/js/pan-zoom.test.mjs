// Pan/zoom + mirrored-view math (Chunk C) — pure helpers, no DOM.
// Run: node --test tests/js/pan-zoom.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  viewCenter, viewTranslate, mirrorView, clampView, zoomAt, panBy,
  pinchTo, fitBox, ZOOM_MIN, ZOOM_MAX,
} from '../../frontend/js/modules/pan-zoom.js';

// Round-trip: center → translate → center must be identity.
test('viewCenter/viewTranslate round-trip', () => {
  const fit = { fitW: 800, fitH: 500 };
  const v = { scale: 2.4, tx: -371, ty: 88 };
  const { cx, cy } = viewCenter(fit.fitW, fit.fitH, v.scale, v.tx, v.ty);
  const t = viewTranslate(fit.fitW, fit.fitH, v.scale, cx, cy);
  assert.ok(Math.abs(t.tx - v.tx) < 1e-9);
  assert.ok(Math.abs(t.ty - v.ty) < 1e-9);
});

test('fit view has centre (0.5, 0.5) and zero translate', () => {
  const { cx, cy } = viewCenter(600, 400, 1, 0, 0);
  assert.equal(cx, 0.5);
  assert.equal(cy, 0.5);
});

// Mirroring: different image dims, same relative viewport.
// Image A: 2000x1000 in a 1000x800 stage. Image B: 800x2000 in the same.
const stage = { stageW: 1000, stageH: 800 };

test('mirrorView shares zoom and normalized centre across aspect ratios', () => {
  // A: 2000x1000; B: 2400x1000 — different aspect, both wider than stage so
  // the shared centre stays inside B's clamp range (no edge clamping).
  const a = { ...stage, ...fitBox(2000, 1000, stage.stageW, stage.stageH),
              scale: 2, tx: -250, ty: 10 };
  const dstFit = fitBox(2400, 1000, stage.stageW, stage.stageH);
  const m = mirrorView(a, { ...stage, ...dstFit });
  assert.equal(m.scale, 2);
  const { cx, cy } = viewCenter(a.fitW, a.fitH, a.scale, a.tx, a.ty);
  const back = viewCenter(dstFit.fitW, dstFit.fitH, m.scale, m.tx, m.ty);
  assert.ok(Math.abs(back.cx - cx) < 1e-9);
  assert.ok(Math.abs(back.cy - cy) < 1e-9);
});

// Edge case: when the shared viewport would fall off B's image, mirrorView
// clamps to the edge — the closest legal view.
test('mirrorView clamps to image edge when the shared viewport exceeds bounds', () => {
  const a = { ...stage, ...fitBox(2000, 1000, stage.stageW, stage.stageH),
              scale: 3, tx: -250, ty: 0 }; // cx ≈ 0.583, near right edge
  const dst = { ...stage, ...fitBox(800, 2000, stage.stageW, stage.stageH) };
  const m = mirrorView(a, dst); // B fit 320x800; at 3x width 960 < stage 1000
  assert.equal(Object.is(m.tx, 0) || m.tx === 0, true); // clamped: B cannot pan horizontally at all
});

test('mirrorView at fit is exact fit for any aspect ratio', () => {
  const a = { ...stage, ...fitBox(2000, 1000, stage.stageW, stage.stageH),
              scale: 1, tx: 0, ty: 0 };
  const m = mirrorView(a, { ...stage, ...fitBox(800, 2000, stage.stageW, stage.stageH) });
  assert.equal(m.scale, 1);
  assert.equal(m.tx, 0);
  assert.equal(m.ty, 0);
});

test('zoomAt keeps the cursor point fixed', () => {
  const v = { scale: 2, tx: -300, ty: -100 };
  const relX = 120, relY = -60;
  const v2 = zoomAt(v, relX, relY, 4, 1000, 800, 500, 400);
  assert.equal(v2.scale, 4);
  // Point under cursor: centre + rel/scale before == centre + rel/scale after,
  // in fit-relative coords: tx + rel == tx2 + rel * (scale2/scale1)/… — use the
  // standard invariant: tx2 = tx + rel * (1 - k), k = 4/2.
  const k = 2;
  assert.ok(Math.abs(v2.tx - (v.tx + relX * (1 - k))) < 1e-9);
  assert.ok(Math.abs(v2.ty - (v.ty + relY * (1 - k))) < 1e-9);
});

test('zoomAt below min snaps to exact fit', () => {
  const v2 = zoomAt({ scale: 1.04, tx: -20, ty: 5 }, 0, 0, 0.9, 1000, 800, 500, 400);
  assert.equal(v2.scale, ZOOM_MIN);
  assert.equal(v2.tx, 0);
  assert.equal(v2.ty, 0);
});

test('zoomAt clamps at ZOOM_MAX', () => {
  const v2 = zoomAt({ scale: 7.9, tx: -10, ty: 0 }, 0, 0, 99, 1000, 800, 500, 400);
  assert.equal(v2.scale, ZOOM_MAX);
});

test('panBy clamps to the zoomed overflow', () => {
  const fit = fitBox(2000, 1000, 1000, 800); // fit 1000x500
  const v = panBy({ scale: 2, tx: 0, ty: 0 }, 5000, -5000,
    1000, 800, fit.fitW, fit.fitH);
  assert.ok(Math.abs(v.tx) <= ((fit.fitW * 2 - 1000) / 2) + 1e-9);
  assert.ok(Math.abs(v.ty) <= ((fit.fitH * 2 - 800) / 2) + 1e-9);
});

test('pinchTo scales from gesture start and pans with the pinch midpoint', () => {
  const v = pinchTo({ scale: 1, tx: 0, ty: 0 }, 100, 200, 30, -20, 1000, 800, 1000, 500);
  assert.equal(v.scale, 2);
  assert.equal(v.tx, 30);
  assert.equal(v.ty, -20);
});

test('pinchTo settling at/below min snaps to fit', () => {
  const v = pinchTo({ scale: 1.5, tx: -40, ty: 0 }, 100, 60, 5, 5, 1000, 800, 1000, 500);
  assert.equal(v.scale, ZOOM_MIN);
  assert.equal(v.tx, 0);
  assert.equal(v.ty, 0);
});

test('fitBox contains arbitrary image sizes', () => {
  assert.deepEqual(fitBox(2000, 1000, 1000, 800), { fitW: 1000, fitH: 500 });
  assert.deepEqual(fitBox(500, 2000, 1000, 800), { fitW: 200, fitH: 800 });
  assert.equal(fitBox(0, 100, 100, 100), null);
});

test('clampView keeps the view inside overflow bounds', () => {
  const fit = fitBox(4000, 2000, 1000, 800);
  const v = clampView({ scale: 4, tx: 9999, ty: -9999 }, 1000, 800, fit.fitW, fit.fitH);
  assert.ok(Math.abs(v.tx) <= (fit.fitW * 4 - 1000) / 2);
  assert.ok(Math.abs(v.ty) <= (fit.fitH * 4 - 800) / 2);
});
