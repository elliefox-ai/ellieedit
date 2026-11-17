// Viewer zoom gesture math (2026-10-29, viewers first; swipe removed
// 2026-11-16 — no drag ever changes images, so swipeDir is gone).
import assert from 'node:assert/strict';
import { dist, pinchScale, clampPan, wheelScale }
  from '../../frontend/js/modules/zoom-viewer.js';

// Pinch: scale follows distance ratio, clamped to 1..4.
assert.equal(pinchScale(1, 100, 200), 2);
assert.equal(pinchScale(2, 100, 50), 1);
assert.equal(pinchScale(1, 100, 900), 4, 'clamped at max');
assert.equal(pinchScale(1, 100, 10), 1, 'clamped at min');
assert.equal(pinchScale(1.5, 0, 200), 1.5, 'zero start distance is a no-op');

// No swipe: the swipe detector is gone entirely (2026-11-16). A drag
// never changes images — cycling is tap/click on the nav zones or
// buttons, or the keyboard arrows. Pinch math above is the only
// two-finger rule left, and it runs wherever the fingers land
// (viewer-root tracking, so a finger on a nav zone still pinches).

// Pan clamp: at fit there is nowhere to pan; at 2x on a 400-wide
// stage showing a 400-wide image, pan is limited to 200 each way.
assert.deepEqual(clampPan(0, 0, 400, 300, 400, 300, 1), { tx: 0, ty: 0 });
assert.deepEqual(clampPan(500, 500, 400, 300, 400, 300, 2), { tx: 200, ty: 150 });
assert.deepEqual(clampPan(-500, -500, 400, 300, 400, 300, 2), { tx: -200, ty: -150 });

// Wheel: scroll down zooms in, scroll up zooms out, clamped.
assert.ok(wheelScale(1, -100) > 1);
assert.ok(wheelScale(2, 100) < 2);
assert.equal(wheelScale(4, -1000), 4);
assert.equal(wheelScale(1, 1000), 1);

// Distance helper.
assert.equal(dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);

console.log('zoom-viewer gesture math OK');
