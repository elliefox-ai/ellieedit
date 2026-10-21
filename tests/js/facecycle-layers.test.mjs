// FaceCycle layer model — pure logic (F1, 2026-10-21).
import assert from 'node:assert/strict';
import { makeGenLayer, isRemaskable, layerMask, ringEntries, activePosition, stepRing }
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
console.log(`facecycle-layers.test.mjs: PASS (${cases} ring cases)`);
