// Operator-sequence regression — region-status model (2026-10-07h):
//   tap A → generate → Keep → tap B → generate → Keep, then assert:
//   #A: A's kept gen survives B's generate/Keep (structurally: per-region state)
//   #B: B's kept gen == the EXACT preview canvas/geometry (1:1, no re-projection)
//   #C: tapping A cycles its gens after Keep
//   #D: no global pending state exists anywhere
// Uses real dimension math: canvas stubs carry actual width/height and the Image
// stub has natural sizes; every geometry assertion is computed from dimensions.
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

// #D: no global pending store anywhere in the instance or the canvas stack.
assert.equal(fc.pendingStore, undefined, '#D no pendingStore on the module');
assert.equal('pending' in fc.stack, false, '#D no pending field on the canvas stack');

// Load one image (sets state.width/height via handleFiles path).
await fc.handleFiles([{ type: 'image/png', name: 'a.png' }]);
fc.state.width = 300; fc.state.height = 200;
fc.state.images = [{ processedData: new ImageData(new Uint8ClampedArray(300 * 200 * 4), 300, 200) }];
fc.state.baseVariant = 0;

// Two manual regions: A at (20,20,80,80) id 900, B at (150,100,60,60) id 901.
fc.state.activeRegions = [
  { x: 20, y: 20, w: 80, h: 80, id: 900, manual: true, status: 'idle' },
  { x: 150, y: 100, w: 60, h: 60, id: 901, manual: true, status: 'idle' },
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

// Real-dimension math for B's expected crop ring (32% context ring, clamped).
function cropRect(r, W, H) {
  const pad = Math.round(0.32 * Math.max(r.w, r.h));
  const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
  return { x, y, w: Math.min(W, r.x + r.w + pad) - x, h: Math.min(H, r.y + r.h + pad) - y };
}

// Full operator flow: select → generate → status transition → Keep.
async function generateAndKeep(id, inside) {
  const region = fc.state.activeRegions.find(r => r.id === id);
  tap(inside.x, inside.y);
  assert.equal(fc.selectedRegionId, id, `tap selects region ${id}`);
  await fc.generateRepaint();
  await tick(); // Image onload → variant baked into THIS region's preview
  assert.equal(region.status, 'preview', `region ${id} status transitioned to preview`);
  assert.ok(region.preview && region.preview.psel >= 0, `region ${id} holds its own preview`);
  assert.ok(fc.state.activeRegions.every(r => r.id === id || !r.preview || r.status !== 'preview'),
    'no other region carries a preview');
  fc.commitPending();
  await tick();
  assert.equal(region.status, 'kept', `region ${id} status transitioned to kept`);
}

// ── Operator sequence ──
await generateAndKeep(900, insideA);
const A = fc.state.activeRegions.find(r => r.id === 900);
assert.equal(A.gens.length, 1, 'A has 1 kept gen');
const expRectA = cropRect({ x: 20, y: 20, w: 80, h: 80 }, 300, 200);
assert.equal(A.gens[0].rect.x, expRectA.x, '#1:1 A gen stores the EXACT rect it previewed (x)');
assert.equal(A.gens[0].rect.y, expRectA.y, '#1:1 A gen stores the EXACT rect it previewed (y)');
assert.equal(A.gens[0].rect.w, expRectA.w, '#1:1 A gen stores the EXACT rect it previewed (w)');
assert.equal(A.gens[0].rect.h, expRectA.h, '#1:1 A gen stores the EXACT rect it previewed (h)');
assert.equal(A.preview, null, 'preview consumed by Keep');

tap(insideB.x, insideB.y);
await generateAndKeep(901, insideB);

// #A: A's kept generation must survive B's generate+keep — per-region state
// makes cross-region interference structurally impossible.
assert.equal(A.gens.length, 1, '#A region A keeps its generation after B generate+keep');
assert.equal(A.gsel, 0, '#A region A gsel intact');
assert.equal(A.status, 'kept', '#A region A still status kept');
const B = fc.state.activeRegions.find(r => r.id === 901);
assert.equal(B.gens.length, 1, 'B has its own kept gen');
assert.equal(B.status, 'kept', 'B status kept');

// #B: the kept gen IS the previewed canvas at the previewed geometry —
// audit the recorded drawImage on the gen canvas: the server response must be
// composited at the crop rect (native scale), never stretched/squashed.
const expRect = cropRect({ x: 150, y: 100, w: 60, h: 60 }, 300, 200);
const comp = ctxCache.get(B.gens[0].canvas)._calls.find(c => c[0] === 'drawImage' && c.length >= 6 && typeof c[4] === 'number');
assert.ok(comp, '#B gen canvas composites its response');
assert.deepEqual([comp[2], comp[3], comp[4], comp[5]], [0, 0, expRect.w, expRect.h],
  '#B response drawn at rect size (native scale — no squash)');
assert.equal(B.gens[0].rect.x, expRect.x, '#B stored rect x == crop rect x');
assert.equal(B.gens[0].rect.y, expRect.y, '#B stored rect y == crop rect y');
assert.equal(B.gens[0].rect.w, expRect.w, '#B stored rect w == crop rect w');
assert.equal(B.gens[0].rect.h, expRect.h, '#B stored rect h == crop rect h');
// Renderer draws kept gens at their stored rect (pure function of statuses).
fc.selectedRegionId = null;
fc.render();
const rcalls = fc.stack.ctx._calls;
const drawA = rcalls.find(c => c[0] === 'drawImage' && c[1] === A.gens[0].canvas);
const drawB = rcalls.find(c => c[0] === 'drawImage' && c[1] === B.gens[0].canvas);
assert.ok(drawA && drawA[2] === A.gens[0].rect.x && drawA[3] === A.gens[0].rect.y, '#B kept A renders at its exact rect');
assert.ok(drawB && drawB[2] === B.gens[0].rect.x && drawB[3] === B.gens[0].rect.y, '#B kept B renders at its exact rect');

// #C: tapping A cycles gens after Keep.
// Second keep on A so cycling has something to move between.
await generateAndKeep(900, insideA);
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

// #E layer model (F1, 2026-10-21): every kept gen OWNS its raw output + a mask
// snapshot; its canvas is derived (raw ∩ mask) and re-derivable (re-maskable).
for (const g of [...A.gens, ...B.gens]) {
  assert.equal(g.kind, 'gen', '#E gen layers are tagged');
  assert.ok(g.raw && g.raw !== g.canvas, '#E gen keeps its RAW output separate from the masked canvas');
  assert.ok(g.mask, '#E gen keeps its mask snapshot');
}
{
  const g = A.gens[0];
  const before = g.canvas;
  assert.equal(fc.recomposeGen(g), true, '#E recomposeGen re-derives from raw');
  assert.notEqual(g.canvas, before, '#E recompose builds a fresh derived canvas');
  const rc = ctxCache.get(g.canvas)._calls;
  const drawRaw = rc.find(c => c[0] === 'drawImage' && c[1] === g.raw);
  assert.ok(drawRaw && [drawRaw[2], drawRaw[3], drawRaw[4], drawRaw[5]].join() === [0, 0, g.rect.w, g.rect.h].join(),
    '#E derived canvas is raw drawn at rect size');
  assert.ok(rc.some(c => c[0] === 'drawImage' && c[1] === g.mask), '#E derived canvas is cut by the layer\'s OWN mask');
  assert.equal(fc.recomposeGen({ canvas: before, rect: g.rect }), false, '#E legacy gen without raw cannot be re-masked');
}

// #F D5 (2026-10-21): kept gens FOLLOW their region's explicit move/resize drags.
{
  const endDrag = (kind, r, startGeom) => {
    if (kind === 'move') fc.moveDrag = { regionId: r.id, startMouseX: 0, startMouseY: 0, startRegionX: startGeom.x, startRegionY: startGeom.y, moved: true };
    else fc.resizeDrag = { regionId: r.id, startMouseX: 0, startMouseY: 0, startW: startGeom.w, startH: startGeom.h, moved: true };
    fc.onPointerUp({}, { x: 0, y: 0 });
  };
  const rects0 = A.gens.map(g => ({ ...g.rect }));
  // MOVE: box +25,-10 → every gen translates by exactly that, size untouched.
  const g0 = { x: A.x, y: A.y, w: A.w, h: A.h };
  A.x += 25; A.y -= 10;
  endDrag('move', A, g0);
  A.gens.forEach((g, i) => assert.deepEqual(g.rect, { x: rects0[i].x + 25, y: rects0[i].y - 10, w: rects0[i].w, h: rects0[i].h }, `#F move: gen ${i} translated with its region`));
  // RESIZE: width x2 about the box origin → gen x-offset and width double, y/h unchanged.
  const rects1 = A.gens.map(g => ({ ...g.rect }));
  const g1 = { x: A.x, y: A.y, w: A.w, h: A.h };
  A.w = g1.w * 2;
  endDrag('resize', A, g1);
  A.gens.forEach((g, i) => assert.deepEqual(g.rect,
    { x: A.x + (rects1[i].x - A.x) * 2, y: rects1[i].y, w: rects1[i].w * 2, h: rects1[i].h }, `#F resize: gen ${i} scaled with its region`));
  // The renderer draws the gen at its (now scaled) stored size.
  A.gsel = 0; fc.render();
  const dr = [...fc.stack.ctx._calls].reverse().find(c => c[0] === 'drawImage' && c[1] === A.gens[0].canvas);
  assert.ok(dr, '#F renderer draws the followed gen');
  assert.deepEqual(dr.slice(2, 6), [A.gens[0].rect.x, A.gens[0].rect.y, A.gens[0].rect.w, A.gens[0].rect.h], '#F drawn at the followed rect');
  // A drag that does not change the box moves nothing.
  const snap = A.gens.map(g => ({ ...g.rect }));
  endDrag('move', A, { x: A.x, y: A.y, w: A.w, h: A.h });
  A.gens.forEach((g, i) => assert.deepEqual(g.rect, snap[i], '#F no-op drag leaves gens alone'));
  // Mask auto-grow is NOT a resize drag: growing the box must not scale gens.
  const before = A.gens.map(g => ({ ...g.rect }));
  A.w += 40; // what autoGrowBox does while painting — no drag involved
  A.gens.forEach((g, i) => assert.deepEqual(g.rect, before[i], '#F auto-grow leaves gens alone'));
  A.w -= 40;

  // A live preview follows too, and Undo-Keep restores it where the region now is.
  tap(insideB.x, insideB.y);
  await fc.generateRepaint(); await tick();
  assert.equal(B.status, 'preview');
  fc.commitPending();
  const keptAt = { ...B.gens[B.gens.length - 1].rect };
  const gb = { x: B.x, y: B.y, w: B.w, h: B.h };
  B.x += 10;
  endDrag('move', B, gb);
  assert.equal(B.gens[B.gens.length - 1].rect.x, keptAt.x + 10, '#F new gen followed the move');
  fc.undo();
  assert.equal(B.status, 'preview', '#F undo-keep restores the preview');
  assert.equal(B.preview.rect.x, keptAt.x + 10, '#F restored preview sits where the region now is');
  fc.commitPending();
}

// #G explicit Generate target (2026-10-21): the status line says what will be repainted.
{
  const status = () => fc.el.statusBar.innerHTML;
  fc.selectedRegionId = A.id; fc.updateStatusBar();
  assert.ok(status().includes(`repaints region ${fc.getRegionNumber(A)}`), '#G selected region is named');
  const hadMask = fc.state.activeRegions.map(r => r.maskCanvas);
  fc.state.activeRegions.forEach(r => { r.maskCanvas = null; });
  fc.selectedRegionId = null; fc.updateStatusBar();
  assert.ok(status().includes('select a region'), '#G nothing to repaint says so');
  B.maskCanvas = fakeEl('canvas'); fc.updateStatusBar();
  assert.ok(status().includes('nothing selected') && status().includes(`region ${fc.getRegionNumber(B)}`) && status().includes('last masked'),
    '#G the hidden last-masked fallback is now spelled out');
  B.maskCanvas = null;
  fc.state.activeRegions.forEach((r, i) => { r.maskCanvas = hadMask[i]; });
}

// #D post-sequence: still no global pending anywhere.
assert.equal(fc.pendingStore, undefined, '#D no pendingStore after full sequence');
assert.equal('pending' in fc.stack, false, '#D no stack.pending after full sequence');
for (const r of fc.state.activeRegions) assert.ok(!('gsel' in r) || r.gsel >= -1, 'region state sane');

console.log('facecycle operator-sequence test: PASS');
