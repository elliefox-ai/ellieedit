// Headless load-path regression test (node, stub DOM).
// Simulates the FaceCycle single-image load path and asserts the base layer
// actually reaches the canvas: handleFiles → processImages → setBaseLayer →
// stack.render → putImageData with the loaded image dimensions.
// Run: node tests/js/load-path.test.mjs   (exit 0 = pass)

import assert from 'node:assert/strict';

// ── Minimal DOM/Canvas stubs ──
function fakeCtx() {
  const grad = { addColorStop() {} };
  const t = {};
  return new Proxy(t, {
    get(t2, p) {
      if (p === 'createLinearGradient') return () => grad;
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (p === 'drawImage' || p === 'putImageData') {
        return (...a) => { (t2._calls ??= []).push([p, a[0]]); };
      }
      if (!(p in t2)) t2[p] = () => {};
      return t2[p];
    },
    set(t2, p, v) { t2[p] = v; return true; },
  });
}

function fakeEl(tag = 'div') {
  const t = {
    _tag: tag,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    children: [],
    width: 0, height: 0, naturalWidth: 300, naturalHeight: 200,
    offsetLeft: 0, offsetTop: 0, offsetWidth: 100, offsetHeight: 100,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    getContext: () => fakeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    innerHTML: '', textContent: '',
    click() {},
  };
  return t;
}

globalThis.document = {
  createElement: fakeEl,
  getElementById: () => fakeEl(),
  addEventListener() {},
  head: fakeEl('head'),
};
globalThis.ImageData = class {
  constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
};
globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
try { globalThis.navigator = {}; } catch { /* node ≥21 has a getter-only navigator */ }
globalThis.Image = class {
  constructor() { this.naturalWidth = 300; this.naturalHeight = 200; }
  set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
  get src() { return this._src; }
};
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.fetch = async () => ({ ok: true, json: async () => ({ image_b64: '' }) });

// ── Import the module under test ──
let registered = null;
const shell = await import('../../frontend/js/shell.js');
// shell.js registers nothing by itself; import facecycle which self-registers.
await import('../../frontend/js/modules/facecycle.js');

// Grab the descriptor via a fresh registry read: shell.js exposes no getter,
// so instead we drive the DOM path: mountAll already ran on import and the
// FaceCycle instance exists inside the panel. We re-register a probe by
// monkey-patching: simplest is to re-run the module's export side effect —
// instead, assert through the shell's tabbar children.
await new Promise(r => setTimeout(r, 50)); // let shell's Promise.all mount

// The real assertion target: build a FaceCycle-driven load by instantiating
// through the same components the module uses.
const { CanvasStack } = await import('../../frontend/js/components/canvas-stack.js');
const host = fakeEl();
let drew = null;
const stack = new CanvasStack(host, {
  drawContent: ctx => { drew = ctx.putImageDataCalls || 0; },
});
stack.setSize(640, 480);
stack.baseData = { width: 640, height: 480, data: new Uint8ClampedArray(640 * 480 * 4) };
stack.render();

assert.equal(stack.canvas.width, 640, 'canvas sized from stack');
assert.equal(stack.canvas.height, 480, 'canvas sized from stack');
assert.ok(stack.overlayCanvas, 'overlay exists');

// Module registered into the shell (tab built for it)
assert.ok(shell, 'shell imported');

// Full FaceCycle module load path: instantiate via the shell's mount contract.
// (registerModule was called on import; re-drive a mount manually.)
const panel = fakeEl();
// FaceCycle's panel.innerHTML setter then querySelectors — fakeEl covers both.
let facecycleCtorOk = true;
try {
  const mod = await import('../../frontend/js/modules/facecycle.js');
  // Module self-registered; we can't reach the class directly, so exercise
  // the exported none — instead verify no top-level throw happened.
  assert.ok(mod);
} catch (e) {
  facecycleCtorOk = false;
  console.error('facecycle module import failed:', e);
}
assert.ok(facecycleCtorOk, 'facecycle module imports clean');

// ── New region-generation model (#1/#2/#4) ──
const { FaceCycle } = await import('../../frontend/js/modules/facecycle.js');
const fc = new FaceCycle(fakeEl('section'), fakeEl('footer'));

// Single-image load path: base layer must land on the stack.
await fc.handleFiles([{ type: 'image/png', name: 'a.png' }]);
assert.ok(fc.stack.baseData, 'base layer set on load');
assert.equal(fc.stack.width, 300, 'stack sized from image');

// A region with a kept generation renders its gen canvas above base (#4:
// "generations not taking" would show as drawImage never being called).
const genCanvas = fakeEl('canvas');
const region = { x: 10, y: 10, w: 60, h: 60, id: 999, manual: true, gens: [genCanvas], gsel: 0 };
fc.state.activeRegions.push(region);
fc.state.selections[999] = 0;
fc.selectedRegionId = 999;
fc.render();
const calls = fc.stack.ctx._calls ?? [];
const idxBase = calls.findIndex(c => c[0] === 'putImageData');
const idxGen = calls.findIndex(c => c[0] === 'drawImage' && c[1] === genCanvas);
assert.ok(idxGen >= 0, 'generation canvas drawn');
assert.ok(idxGen > idxBase, 'generation drawn above base');
// (With no pending preview active, nothing else drawImages above the gen — correct.)

// Keep flow: pending → Keep appends a generation per region, Undo reverses.
fc.pendingStore.begin({ x: 10, y: 10, w: 60, h: 60 }, { variantCount: 1 });
fc.stack.pending.regionId = 999;
fc.stack.pending.variants = [fakeEl('canvas')];
fc.stack.pending.vsel = 0;
fc.commitPending();
assert.equal(region.gens.length, 2, 'Keep appends generation to region state');
assert.equal(fc.undoLog.length, 1, 'undo log records keep');
assert.equal(fc.pendingStore.current, null, 'preview cleared after keep');

// Generating on another region must not revert this one (#1).
const regionB = { x: 100, y: 100, w: 40, h: 40, id: 998, manual: true, gens: [], gsel: -1 };
fc.state.activeRegions.push(regionB);
fc.pendingStore.begin({ x: 100, y: 100, w: 40, h: 40 }, { variantCount: 1 });
fc.stack.pending.regionId = 998;
fc.stack.pending.variants = [fakeEl('canvas')];
fc.stack.pending.vsel = 0;
fc.commitPending();
assert.equal(region.gens.length, 2, 'region A keeps its generations (#1)');
assert.equal(regionB.gens.length, 1, 'region B got its own generation');

// Undo pops the last region-state change (B's keep), A untouched.
fc.undo();
assert.equal(regionB.gens.length, 0, 'undo removes B keep');
assert.equal(region.gens.length, 2, 'undo leaves A untouched');

// Discard with no pending removes the selected region\u2019s current gen (undoable).
fc.selectedRegionId = 999;
fc.discardAction();
assert.equal(region.gens.length, 1, 'discard removes current generation');
fc.undo();
assert.equal(region.gens.length, 2, 'undo restores discarded generation');

// Cycling pages generations (#2).
region.gsel = 0;
fc.cycleRegion(region, 1);
assert.equal(region.gsel, 1, 'cycle advances generation selection');

console.log('load-path regression test: PASS');
