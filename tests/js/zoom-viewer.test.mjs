// Viewer zoom gesture math (2026-10-29, viewers first).
import assert from 'node:assert/strict';
import { dist, pinchScale, swipeDir, clampPan, wheelScale }
  from '../../frontend/js/modules/zoom-viewer.js';

// Pinch: scale follows distance ratio, clamped to 1..4.
assert.equal(pinchScale(1, 100, 200), 2);
assert.equal(pinchScale(2, 100, 50), 1);
assert.equal(pinchScale(1, 100, 900), 4, 'clamped at max');
assert.equal(pinchScale(1, 100, 10), 1, 'clamped at min');
assert.equal(pinchScale(1.5, 0, 200), 1.5, 'zero start distance is a no-op');

// Swipe: only at fit, horizontal, > 50px, dominant over vertical.
assert.equal(swipeDir(-80, 10, 1), 1);
assert.equal(swipeDir(80, 10, 1), -1);
assert.equal(swipeDir(40, 0, 1), 0, 'below threshold');
assert.equal(swipeDir(-80, 80, 1), 0, 'diagonal is not a swipe');
assert.equal(swipeDir(-80, 10, 2), 0, 'zoomed: swipe disabled, drag pans');
assert.equal(swipeDir(-80, 10, 1.5), 0, 'any zoom disables swipe');

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
