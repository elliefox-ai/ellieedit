// Puppet Theater pure-logic tests (work order 2026-10-22): transform math,
// z-order ops, mask compositing, the denoise fence, state shape, history.
// Run: node --test tests/js/puppet-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampDenoise, presetSize, normalizeLayer, normalizeState, defaultState,
  fitPlacement, moveLayerZ, paintOrder, layerCenter, stageToLocal, localToStage,
  hitLayer, topmostAt, handlePositions, resizeRect, rotationFromPointer,
  pointerAngle, applyMaskToAlpha, brushAlpha, History,
  DENOISE_MIN, DENOISE_MAX } from '../../frontend/js/modules/puppet-core.js';

const L = (id, over = {}) => normalizeLayer({ id, x: 0, y: 0, w: 100, h: 50, ...over });

test('denoise fence: clamps into 0.4..0.5, defaults on garbage', () => {
  assert.equal(clampDenoise(0.8), DENOISE_MAX);       // the forbidden default
  assert.equal(clampDenoise(0.1), DENOISE_MIN);
  assert.equal(clampDenoise(0.45), 0.45);
  assert.equal(clampDenoise(null), 0.45);
  assert.equal(clampDenoise('mud'), 0.45);
  assert.equal(clampDenoise(NaN), 0.45);
});

test('presets + last-used fallback', () => {
  assert.deepEqual(presetSize('16:9'), { width: 1280, height: 720 });
  assert.deepEqual(presetSize('bogus', { width: 800, height: 600 }), { width: 800, height: 600 });
  assert.deepEqual(presetSize('last', null), { width: 1024, height: 1024 });
});

test('normalizeState: bounds canvas, strips path-y assets, dedupes ids', () => {
  const s = normalizeState({ canvas: { width: 99999, height: 10 },
    layers: [{ id: 'a', asset: '../evil.png' }, { id: 'a', asset: 'ok.png' }] });
  assert.equal(s.canvas.width, 8192);
  assert.equal(s.canvas.height, 16);
  assert.equal(s.layers[0].asset, null);              // traversal stripped
  assert.equal(s.layers[1].asset, 'ok.png');
  assert.notEqual(s.layers[0].id, s.layers[1].id);
  assert.equal(defaultState().layers.length, 0);
});

test('fitPlacement centers at natural size, shrinks only', () => {
  const p = fitPlacement({ width: 1000, height: 1000 }, 200, 100);
  assert.deepEqual(p, { x: 400, y: 450, w: 200, h: 100 });
  const big = fitPlacement({ width: 1000, height: 500 }, 2000, 1000);
  assert.equal(big.w, 900); assert.equal(big.h, 450);
  assert.equal(big.x, 50); assert.equal(big.y, 25);
});

test('z-order ops move without mutating', () => {
  const ls = [L('a'), L('b'), L('c')];
  assert.deepEqual(moveLayerZ(ls, 'a', 'up').map(l => l.id), ['b', 'a', 'c']);
  assert.deepEqual(moveLayerZ(ls, 'c', 'down').map(l => l.id), ['a', 'c', 'b']);
  assert.deepEqual(moveLayerZ(ls, 'a', 'front').map(l => l.id), ['b', 'c', 'a']);
  assert.deepEqual(moveLayerZ(ls, 'c', 'back').map(l => l.id), ['c', 'a', 'b']);
  assert.deepEqual(moveLayerZ(ls, 'a', 'down').map(l => l.id), ['a', 'b', 'c']); // already bottom
  assert.deepEqual(moveLayerZ(ls, 'b', 'up').map(l => l.id), ['a', 'c', 'b']);
  assert.deepEqual(ls.map(l => l.id), ['a', 'b', 'c']);                         // untouched
  assert.deepEqual(moveLayerZ(ls, 'zzz', 'front').map(l => l.id), ['a', 'b', 'c']);
  assert.deepEqual(paintOrder([L('a', { visible: false }), L('b')]).map(l => l.id), ['b']);
});

test('local<->stage round-trips at any rotation; center is invariant', () => {
  for (const rot of [0, 30, 90, 200]) {
    const l = L('r', { x: 100, y: 40, w: 200, h: 80, rotation: rot });
    const p = localToStage(l, 37, 21);
    const back = stageToLocal(l, p.x, p.y);
    assert.ok(Math.abs(back.x - 37) < 1e-9 && Math.abs(back.y - 21) < 1e-9, `rot ${rot}`);
    assert.deepEqual(localToStage(l, 100, 40), layerCenter(l));
  }
});

test('hit testing respects rotation; topmost wins', () => {
  const flat = L('flat', { x: 0, y: 0, w: 100, h: 100 });
  const tall = L('tall', { x: 0, y: 0, w: 20, h: 100, rotation: 90 }); // rotated: lies along x
  assert.equal(hitLayer(flat, 50, 50), true);
  assert.equal(hitLayer(flat, 150, 50), false);
  assert.equal(hitLayer(tall, 50, 50), true);          // center band after 90° turn
  assert.equal(hitLayer(tall, 10, 5), false);
  const over = L('over', { x: 25, y: 25, w: 50, h: 50 });
  assert.equal(topmostAt([flat, over], 50, 50).id, 'over');
  assert.equal(topmostAt([flat, over], 10, 10).id, 'flat');
  assert.equal(topmostAt([flat], 500, 500), null);
  assert.equal(topmostAt([L('hid', { visible: false, w: 500, h: 500 })], 10, 10), null);
});

test('handles sit on the rect corners (rotated with it)', () => {
  const l = L('h', { x: 10, y: 20, w: 100, h: 50 });
  const hp = handlePositions(l);
  assert.deepEqual(hp.nw, { x: 10, y: 20 });
  assert.deepEqual(hp.se, { x: 110, y: 70 });
  const r = L('h', { x: 0, y: 0, w: 100, h: 100, rotation: 90 });
  const hr = handlePositions(r);
  assert.ok(Math.abs(hr.nw.x - 100) < 1e-9 && Math.abs(hr.nw.y - 0) < 1e-9);
});

test('resize: SE corner, aspect locked, anchor (NW) never moves', () => {
  const start = { x: 100, y: 100, w: 200, h: 100, rotation: 0 };
  const out = resizeRect(start, 'se', { x: 300, y: 140 }); // local coords vs start rect
  assert.equal(out.w, 300); assert.equal(out.h, 150);     // dominant axis + aspect
  assert.equal(out.x, 100); assert.equal(out.y, 100);
  // pointer mostly DOWN: the height ratio dominates and width follows aspect
  const tall = resizeRect(start, 'se', { x: 300, y: 250 });
  assert.equal(tall.w, 500); assert.equal(tall.h, 250);
  assert.equal(tall.x, 100); assert.equal(tall.y, 100);
});

test('resize: NW corner drag keeps the SE anchor fixed', () => {
  const start = { x: 100, y: 100, w: 200, h: 100, rotation: 0 };
  const out = resizeRect(start, 'nw', { x: -50, y: 0 });
  assert.equal(out.w, 250); assert.equal(out.h, 125);
  assert.equal(out.x + out.w, 300); assert.equal(out.y + out.h, 200);
});

test('resize: free-stretch (shift) changes both axes independently', () => {
  const start = { x: 0, y: 0, w: 200, h: 100, rotation: 0 };
  const out = resizeRect(start, 'se', { x: 260, y: 180 }, { lockAspect: false });
  assert.equal(out.w, 260); assert.equal(out.h, 180);
});

test('resize: min size is enforced', () => {
  const start = { x: 0, y: 0, w: 200, h: 100, rotation: 0 };
  const out = resizeRect(start, 'se', { x: 2, y: 1 });
  assert.ok(out.w >= 8 && out.h >= 8);
});

test('resize: anchor holds under rotation', () => {
  const start = { x: 100, y: 100, w: 200, h: 100, rotation: 45 };
  const anchorBefore = localToStage(start, 0, 0);
  const out = resizeRect(start, 'se', stageToLocal(start,
    ...Object.values(localToStage(start, 260, 130))));
  // local target (260,130) against the start rect: w grows to 260-ish scale
  const anchorAfter = localToStage({ ...start, ...out }, 0, 0);
  assert.ok(Math.abs(anchorAfter.x - anchorBefore.x) < 1e-6);
  assert.ok(Math.abs(anchorAfter.y - anchorBefore.y) < 1e-6);
});

test('rotation from pointer is relative and wraps cleanly', () => {
  const l = L('r', { x: 0, y: 0, w: 100, h: 100 });      // center 50,50
  const startA = pointerAngle(l, 150, 50);               // pointing +x = 0deg
  assert.equal(rotationFromPointer(l, 50, 150, startA, 10), 100);  // +90 sweep
  assert.equal(rotationFromPointer(l, 150, 50, startA, 350), 350);
  assert.equal(rotationFromPointer(l, 50, -50, startA, 0), 270);    // wraps, no negatives
});

test('mask compositing multiplies alpha, never touches color or inputs', () => {
  const rgba = new Uint8ClampedArray([10, 20, 30, 200, 40, 50, 60, 100]);
  const mask = new Uint8Array([255, 128]);
  const out = applyMaskToAlpha(rgba, mask, 2, 1);
  assert.equal(out[3], 200);
  assert.equal(out[7], Math.floor(100 * 128 / 255));
  assert.equal(out[0], 10); assert.equal(out[4], 40);    // RGB untouched
  assert.equal(rgba[7], 100);                            // input untouched
  const erased = applyMaskToAlpha(rgba, new Uint8Array([0, 0]), 2, 1);
  assert.equal(erased[3], 0); assert.equal(erased[7], 0);
});

test('brush stamp: hard core, soft rim, zero outside', () => {
  assert.equal(brushAlpha(0, 10, 0.5), 1);
  assert.equal(brushAlpha(5, 10, 0.5), 1);               // core = hardness*radius
  assert.equal(brushAlpha(10, 10, 0.5), 0);
  assert.equal(brushAlpha(7.5, 10, 0.5), 0.5);
  assert.equal(brushAlpha(3, 10, 1), 1);                 // hard brush
  assert.equal(brushAlpha(9.9, 10, 1), 1);
  assert.equal(brushAlpha(0, 10, 0), 1);
  assert.ok(brushAlpha(5, 10, 0) < 1);
});

test('history: push/undo/redo, redo branch cleared on new push', () => {
  const hst = new History(3);
  hst.init('s0');
  assert.equal(hst.canUndo, false);
  hst.push('s1'); hst.push('s2');
  assert.equal(hst.undo(), 's1');
  assert.equal(hst.undo(), 's0');
  assert.equal(hst.undo(), null);
  assert.equal(hst.redo(), 's1');
  hst.push('sX');
  assert.equal(hst.canRedo, false);
  assert.equal(hst.current, 'sX');
  hst.push('sX');                                        // duplicate push is a no-op
  assert.equal(hst.undo(), 's1');
});
