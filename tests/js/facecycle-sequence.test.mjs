// Operator-sequence regression (2026-10-07f):
//   tap A → generate → Keep → tap B → generate → Keep, then assert:
//   #A: A's kept gen survives B's generate/keep
//   #B: stored gen geometry == preview geometry (1:1 crop composite)
//   #C: tapping A cycles its gens after Keep
// Run: node tests/js/facecycle-sequence.test.mjs

import assert from 'node:assert/strict';

// ── DOM/canvas stubs with per-element cached, recording contexts ──
function fakeCtx(el) {
  const t = { _el: el, _calls: [] };
  const grad = { addColorStop() {} };
  return new Proxy(t, {
    get(t2, p) {
      if (p === 'createLinearGradient') return () => grad;
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
      if (p === 'drawImage' || p === 'putImageData') return (...a) => { t2._calls.push([p, ...a]); };
      if (!(p in t2)) t2[p] = () => {};
      return t2[p];
    },
    set(t2, p, v) { t2[p] = v; return true; },
  });
}
const ctxCache = new Map();
function fakeEl(tag = 'div') {
  const t = {
    _tag: tag, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    children: [], width: 0, height: 0, naturalWidth: 300, naturalHeight: 200,
    offsetLeft: 0, offsetTop: 0, offsetWidth: 100, offsetHeight: 100,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    getContext() { if (!ctxCache.has(t)) ctxCache.set(t, fakeCtx(t)); return ctxCache.get(t); },
    toDataURL: () => 'data:image/png;base64,AAAA',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    innerHTML: '', textContent: '', click() {},
  };
  return t;
}
globalThis.document = {
  createElement: fakeEl, getElementById: () => fakeEl(),
  addEventListener() {}, head: fakeEl('head'),
};
globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
try { globalThis.navigator = {}; } catch {}
globalThis.Image = class {
  constructor() { this.naturalWidth = 300; this.naturalHeight = 200; }
  set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
  get src() { return this._src; }
};
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.confirm = () => true;
globalThis.alert = () => {};
// Mock repaint endpoint: returns a PNG (content irrelevant — geometry is what we audit).
globalThis.fetch = async () => ({ ok: true, json: async () => ({ image_b64: 'AAAA' }) });

const { FaceCycle } = await import('../../frontend/js/modules/facecycle.js');
const fc = new FaceCycle(fakeEl('section'), fakeEl('footer'));

// Load one image (sets state.width/height via handleFiles path).
await fc.handleFiles([{ type: 'image/png', name: 'a.png' }]);
fc.state.width = 300; fc.state.height = 200;
fc.state.images = [{ processedData: new ImageData(new Uint8ClampedArray(300 * 200 * 4), 300, 200) }];
fc.state.baseVariant = 0;

// Two manual regions: A at (20,20,80,80) id 900, B at (150,100,60,60) id 901.
fc.state.activeRegions = [
  { x: 20, y: 20, w: 80, h: 80, id: 900, manual: true },
  { x: 150, y: 100, w: 60, h: 60, id: 901, manual: true },
];
fc.state.selections = { 900: 0, 901: 0 };

const tap = (x, y) => fc.onPointerDown({ button: 0, preventDefault() {} }, { x, y });
fc.el.detailCrop = { checked: false };
fc.el.repaintPromptInput = { value: '' };
fc.el.denoiseSlider = { value: '0.5' };
fc.el.variantCountSelect = { value: '1' };
fc.el.randomizeSeed = { checked: false };
fc.el.seedInput = { value: '42' };
fc.el.generateBtn = fakeEl('button');
const insideA = { x: 60, y: 60 }, insideB = { x: 170, y: 120 };
const tick = () => new Promise(r => setTimeout(r, 10));

async function generateAndKeep() {
  await fc.generateRepaint();
  await tick(); // Image onload → addPendingVariant
  assert.ok(fc.pendingStore.current && fc.pendingStore.current.vsel >= 0, 'variant arrived');
  fc.commitPending();
  await tick();
}

// ── Operator sequence ──
tap(insideA.x, insideA.y);
assert.equal(fc.selectedRegionId, 900, 'tap selects A');
await generateAndKeep();
const A = fc.state.activeRegions.find(r => r.id === 900);
assert.equal(A.gens.length, 1, 'A has 1 kept gen');
assert.equal(A.gens[0].width, 300, 'gen canvas is full-image sized');
assert.equal(A.gens[0].height, 200, 'gen canvas is full-image sized');

tap(insideB.x, insideB.y);
assert.equal(fc.selectedRegionId, 901, 'tap selects B');
await generateAndKeep();

// BUG A: A's kept generation must survive B's generate+keep.
assert.equal(A.gens.length, 1, '#A region A keeps its generation after B generate+keep');
assert.equal(A.gsel, 0, '#A region A gsel intact');
const B = fc.state.activeRegions.find(r => r.id === 901);
assert.equal(B.gens.length, 1, 'B has its own kept gen');
assert.equal(B.gens[0].width, 300, '#B B gen canvas full-image sized');
assert.equal(B.gens[0].height, 200, '#B B gen canvas full-image sized');

// BUG B: audit the gen canvas's recorded drawImage geometry — the variant must
// be composited at the crop rect at natural scale (cw×ch), never stretched.
const genCtx = ctxCache.get(B.gens[0]);
const comp = genCtx._calls.find(c => c[0] === 'drawImage' && typeof c[4] === 'number');
assert.ok(comp, '#B gen composites its variant');
const pending = { x: 144, y: 94, w: 72, h: 72 }; // expected crop ring for B (0.32 ring) — recomputed below
const padB = Math.round(0.32 * Math.max(60, 60));
const expX = Math.max(0, 150 - padB), expY = Math.max(0, 100 - padB);
const expW = Math.min(300, 150 + 60 + padB) - expX, expH = Math.min(200, 100 + 60 + padB) - expY;
assert.deepEqual([comp[2], comp[3], comp[4], comp[5]], [expX, expY, expW, expH],
  '#B stored gen composited at exact crop rect (native scale)');

// BUG C: tapping A cycles gens after Keep.
assert.equal(A.gens.length, 1, 'single gen before cycle test');
// Second keep on A so cycling has something to move between.
tap(insideA.x, insideA.y);
await generateAndKeep();
assert.equal(A.gens.length, 2, 'A has 2 gens now');
assert.equal(A.gsel, 1, 'latest gen selected after keep');
tap(insideA.x, insideA.y);
// Ring semantics: gens first, then photo variants, then wrap. 2 gens + 1
// image = 3 positions: after keep gsel=1 → tap 1 shows photo variant, tap 2
// wraps to gen 0, tap 3 back to gen 1.
assert.equal(A.gsel, -1, '#C tap past last gen shows the photo variant');
tap(insideA.x, insideA.y);
assert.equal(A.gsel, 0, '#C tap cycles wraps to gen 1');
tap(insideA.x, insideA.y);
assert.equal(A.gsel, 1, '#C tap cycles forward to gen 2');
tap(insideA.x, insideA.y);
assert.equal(A.gsel, -1, '#C cycle wraps through variant again');

console.log('facecycle operator-sequence test: PASS');
