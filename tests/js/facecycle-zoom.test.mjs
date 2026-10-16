// Task 6 — zoom/pan invariants for CanvasStack (the module FaceCycle draws on).
//  #A pointer math: eventToWorld() gives identical world coords at fit and 300%
//  #B lockstep: overlay CSS box == canvas CSS box at every zoom, incl. extremes
//  #C fit restores the original (max-100%, no explicit px) behavior
//  #D zoom is clamped to [0.25, 3]; fit (1) is the default
// Run: node tests/js/facecycle-zoom.test.mjs

import assert from 'node:assert/strict';

function fakeEl(tag) {
  const el = {
    tag, style: {}, children: [], width: 0, height: 0, _fit: { w: 400, h: 300 },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, setPointerCapture() {},
    getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); },
    get offsetWidth() { return this.style.width ? parseFloat(this.style.width) : this._fit.w; },
    get offsetHeight() { return this.style.height ? parseFloat(this.style.height) : this._fit.h; },
    get offsetLeft() { return 0; }, get offsetTop() { return 0; },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: this.offsetWidth, height: this.offsetHeight };
    },
  };
  return el;
}
globalThis.document = { createElement: fakeEl };
globalThis.window = { devicePixelRatio: 1 };

const { CanvasStack } = await import('../../frontend/js/components/canvas-stack.js');
const host = fakeEl('div');
const st = new CanvasStack(host, {});
assert.equal(st.zoom, 1, 'fresh stack = fit');
st.setSize(1600, 1200);           // world 1600x1200 shown at 400x300 fit (4:1)

const ev = { clientX: 10 + 200, clientY: 20 + 150 };   // centre of the canvas box

// #A pointer invariant: same on-canvas fraction -> same world point at any zoom
const fit = st.eventToWorld(ev);
assert.deepEqual(fit, { x: 800, y: 600 });
for (const z of [0.25, 0.5, 1.5, 2, 3]) {
  st.setZoom(z);
  const rectW = st.canvas.getBoundingClientRect().width;
  assert.equal(rectW, 400 * z, `canvas CSS width at ${z}x`);
  // pointer at the same FRACTION of the (now larger) box
  const e2 = { clientX: 10 + rectW / 2, clientY: 20 + (300 * z) / 2 };
  assert.deepEqual(st.eventToWorld(e2), fit, `world coords unchanged at ${z}x`);
  // and an off-centre point: 25% / 75%
  const q = st.eventToWorld({ clientX: 10 + rectW * 0.25, clientY: 20 + 300 * z * 0.75 });
  assert.deepEqual(q, { x: 400, y: 900 }, `quarter point at ${z}x`);
}

// #B lockstep at extremes
for (const z of [0.25, 0.5, 1, 1.1, 3]) {
  st.setZoom(z);
  assert.equal(st.overlayCanvas.style.width, st.canvas.offsetWidth + 'px');
  assert.equal(st.overlayCanvas.style.height, st.canvas.offsetHeight + 'px');
  assert.equal(st.overlayCanvas.style.left, st.canvas.offsetLeft + 'px');
  assert.equal(st.overlayCanvas.style.top, st.canvas.offsetTop + 'px');
}

// #C fit restores max-100% behavior, bitmap untouched
st.setZoom(1);
assert.equal(st.canvas.style.width, '');
assert.equal(st.canvas.style.maxWidth, '100%');
assert.equal(st.canvas.style.maxHeight, '100%');
assert.equal(st.canvas.width, 1600);   // zoom is CSS-only

// Task 6 revision: sub-fit SHRINKS (overview/margin) with explicit px; max unlocked
st.setZoom(0.5);
assert.equal(st.canvas.style.width, '200px');
assert.equal(st.canvas.style.height, '150px');
assert.equal(st.canvas.width, 1600);                 // bitmap untouched
// zoom>1 uses explicit px + unlocks max so the container can scroll
st.setZoom(2);
assert.equal(st.canvas.style.maxWidth, 'none');
assert.equal(st.canvas.style.width, '800px');

// #D clamping
assert.equal(st.setZoom(9), 3);
assert.equal(st.setZoom(0.1), 0.25);                 // floor is 25%
assert.equal(st.setZoom(0.25), 0.25);
assert.equal(st.setZoom('junk'), 1);                 // garbage -> fit

console.log('facecycle-zoom: all invariants hold');
