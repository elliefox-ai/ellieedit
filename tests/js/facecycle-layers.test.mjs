// FaceCycle layer model — pure logic (F1, 2026-10-21).
import assert from 'node:assert/strict';
import { makeGenLayer, isRemaskable, layerMask, ringEntries, activePosition, stepRing,
  remapRect, followRegion, pickRepaintTarget, activeLayer, describeLayer }
  from '../../frontend/js/modules/facecycle-layers.js';

// ── factory: owns raw + mask snapshot; rect is copied, not aliased ──
const rect = { x: 5, y: 6, w: 40, h: 30 };
const raw = { id: 'raw' }, mask = { id: 'mask' }, canvas = { id: 'cv' };
const g = makeGenLayer({ raw, mask, rect, canvas });
assert.equal(g.kind, 'gen');
assert.equal(g.raw, raw); assert.equal(g.mask, mask); assert.equal(g.canvas, canvas);
assert.deepEqual(g.rect, rect); assert.notEqual(g.rect, rect, 'rect is copied');
assert.equal(isRemaskable(g), true);
assert.equal(isRemaskable(makeGenLayer({ rect, canvas })), false, 'no raw → not re-maskable');
assert.equal(isRemaskable(null), false);

// ── mask ownership: gen → its snapshot; photo → the region mask ──
const region = { maskCanvas: { id: 'region-mask' }, gens: [g], gsel: 0 };
assert.equal(layerMask(region, g), mask);
assert.equal(layerMask(region, { kind: 'photo', variant: 0 }), region.maskCanvas);
assert.equal(layerMask({ gens: [] }, { kind: 'photo' }), null);
assert.equal(layerMask(region, makeGenLayer({ rect, canvas })), null, 'gen with no mask → feathered');

// ── ring: gens first, then photo variants ──
assert.deepEqual(ringEntries({ gens: [1, 2] }, 2).map(e => e.kind + (e.index ?? e.variant)),
  ['gen0', 'gen1', 'photo0', 'photo1']);
assert.deepEqual(ringEntries({}, 1), [{ kind: 'photo', variant: 0 }]);
assert.equal(activePosition({ gens: [1, 2], gsel: 1 }, 0), 1);
assert.equal(activePosition({ gens: [1, 2], gsel: -1 }, 1), 3);
assert.equal(activePosition({ gens: [1, 2] }, 0), 2, 'gsel undefined → photo variant');

// ── stepRing must match the pre-refactor inline algorithm EXACTLY ──
function legacy(region, n, sel, dir) {
  const gens = region.gens?.length ?? 0; const total = gens + n;
  if (total <= 1) return null;
  let pos = (region.gsel ?? -1) >= 0 ? region.gsel : gens + sel;
  pos = ((pos + dir) % total + total) % total;
  return pos < gens ? { gsel: pos, photoSel: sel } : { gsel: -1, photoSel: pos - gens };
}
let cases = 0;
for (let gens = 0; gens <= 4; gens++) for (let n = 1; n <= 4; n++)
  for (let gsel = -1; gsel < gens; gsel++) for (let sel = 0; sel < n; sel++)
    for (const dir of [1, -1]) {
      const r = { gens: new Array(gens).fill(0), gsel };
      assert.deepEqual(stepRing(r, n, sel, dir), legacy(r, n, sel, dir), `gens=${gens} n=${n} gsel=${gsel} sel=${sel} dir=${dir}`);
      cases++;
    }
// single-entry ring has nothing to cycle
assert.equal(stepRing({ gens: [] }, 1, 0, 1), null);
// full wrap: 2 gens + 1 photo, starting on gen1, forward x3 visits photo, gen0, gen1
{
  const r = { gens: [0, 0], gsel: 1 }; const seen = [];
  let sel = 0;
  for (let i = 0; i < 3; i++) { const st = stepRing(r, 1, sel, 1); r.gsel = st.gsel; sel = st.photoSel; seen.push(r.gsel); }
  assert.deepEqual(seen, [-1, 0, 1]);
}
// ── D5: remapRect / followRegion ──
const box = { x: 100, y: 50, w: 80, h: 40 };
// pure translation
assert.deepEqual(remapRect({ x: 90, y: 40, w: 100, h: 60 }, box, { x: 130, y: 45, w: 80, h: 40 }),
  { x: 120, y: 35, w: 100, h: 60 });
// scale about the box origin: x2 wide, same tall
assert.deepEqual(remapRect({ x: 90, y: 40, w: 100, h: 60 }, box, { x: 100, y: 50, w: 160, h: 40 }),
  { x: 80, y: 40, w: 200, h: 60 });
// identity + degenerate source box never produce NaN/0-size
assert.deepEqual(remapRect({ x: 1, y: 2, w: 3, h: 4 }, box, box), { x: 1, y: 2, w: 3, h: 4 });
assert.deepEqual(remapRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 0, y: 0, w: 0, h: 0 }, { x: 5, y: 5, w: 10, h: 10 }),
  { x: 6, y: 7, w: 3, h: 4 });
assert.ok(remapRect({ x: 0, y: 0, w: 1, h: 1 }, box, { x: 100, y: 50, w: 1, h: 1 }).w >= 1, 'never collapses to 0');
{
  const r = { gens: [makeGenLayer({ rect: { x: 90, y: 40, w: 100, h: 60 }, canvas: 1 })], preview: { rect: { x: 10, y: 10, w: 20, h: 20 } } };
  assert.equal(followRegion(r, box, box), false, 'unchanged box → nothing to do');
  assert.equal(followRegion(r, box, { x: 110, y: 50, w: 80, h: 40 }), true);
  assert.deepEqual(r.gens[0].rect, { x: 100, y: 40, w: 100, h: 60 });
  assert.deepEqual(r.preview.rect, { x: 20, y: 10, w: 20, h: 20 }, 'live preview follows too');
  assert.equal(followRegion({}, box, { x: 0, y: 0, w: 80, h: 40 }), true, 'region with no gens/preview is fine');
}

// ── explicit Generate target: selected → paint → last mask → none ──
{
  const a = { id: 1, maskCanvas: null }, b = { id: 2, maskCanvas: { m: 1 } }, c = { id: 3, maskCanvas: { m: 2 } };
  const regs = [a, b, c];
  assert.deepEqual(pickRepaintTarget({ regions: regs, selectedId: 1, paintBBox: { x: 0 } }), { kind: 'selected', region: a });
  assert.equal(pickRepaintTarget({ regions: regs, selectedId: null, paintBBox: { x: 1, y: 2, w: 3, h: 4 } }).kind, 'paint');
  assert.equal(pickRepaintTarget({ regions: regs, selectedId: null }).region, c, 'last masked region wins');
  assert.equal(pickRepaintTarget({ regions: [a], selectedId: null }).kind, 'none');
  assert.equal(pickRepaintTarget({ regions: [], selectedId: 9 }).kind, 'none', 'stale selection id → falls through');
  let scanned = 0;
  pickRepaintTarget({ regions: regs, selectedId: 1, paintBBox: () => { scanned++; return null; } });
  assert.equal(scanned, 0, 'paint scan is lazy — not paid when a region is selected');
  pickRepaintTarget({ regions: regs, selectedId: null, paintBBox: () => { scanned++; return null; } });
  assert.equal(scanned, 1);
}

// ── F2b: the paint target is the region's ACTIVE ring layer ──
{
  const gens = [makeGenLayer({ rect, canvas: 1 }), makeGenLayer({ rect, canvas: 2 }), makeGenLayer({ rect, canvas: 3 })];
  const r = { gens, gsel: 1 };
  assert.deepEqual(activeLayer(r, 0), { kind: 'gen', index: 1, gen: gens[1] });
  assert.equal(describeLayer(r, 0), 'gen 2 of 3');
  r.gsel = -1;
  assert.deepEqual(activeLayer(r, 2), { kind: 'photo', variant: 2 });
  assert.equal(describeLayer(r, 2), 'photo 3');
  delete r.gsel;
  assert.equal(activeLayer(r, 0).kind, 'photo', 'gsel undefined → photo layer (matches the renderer)');
  r.gsel = 7;
  assert.equal(activeLayer(r, 1).kind, 'photo', 'stale gsel → photo, never a phantom gen');
  assert.equal(activeLayer({}, 0).kind, 'photo', 'region with no gens');
}

console.log(`facecycle-layers.test.mjs: PASS (${cases} ring cases)`);
