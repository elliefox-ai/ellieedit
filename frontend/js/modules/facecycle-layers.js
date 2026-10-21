// FaceCycle layer model — pure logic, no DOM (work order 2026-10-20, F1).
//
// Rulings D1–D3 (2026-10-21): layers are per-region ALTERNATIVES (a ring the
// user cycles), every layer owns its mask relationship explicitly, and
// generated layers stay re-maskable (raw output + mask snapshot are kept; the
// masked canvas is DERIVED, never the source of truth).
//
// A region's ring is: its kept generations (region.gens[0..n)) followed by
// one photo layer per loaded image variant. Field names (region.gens /
// region.gsel / state.selections) are unchanged on purpose — they are pinned
// by the existing node tests.
//
// Mask ownership — who cuts what:
//   gen layer   → layer.mask      snapshot of the mask used at generation time,
//                                 local to layer.rect (never the region's mask)
//   photo layer → region.maskCanvas  the region's shared "paint once" mask,
//                                 local to the region box; null = feathered box
// layer.canvas on a gen is a CACHE of (raw ∩ mask). Anything that changes
// raw/mask must re-derive it (FaceCycle.recomposeGen).

/** Build a generated layer. `canvas` is the derived (masked) cache. */
export function makeGenLayer({ raw = null, mask = null, rect, canvas }) {
  return {
    kind: 'gen',
    raw,                 // unmasked model output at rect size, or null for legacy gens
    mask,                // mask snapshot local to rect, or null (feathered edges)
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    canvas,              // derived: raw ∩ mask (what the renderer draws)
  };
}

/** A gen can be re-masked only if its raw output was kept. */
export function isRemaskable(layer) {
  return !!(layer && layer.raw);
}

/** Which mask cuts this layer? (gen → its own snapshot; photo → region mask.) */
export function layerMask(region, layer) {
  if (layer && layer.kind === 'gen') return layer.mask ?? null;
  return region.maskCanvas ?? null;
}

/** The ring as explicit entries: gens first, then one photo entry per image. */
export function ringEntries(region, nImages) {
  const out = [];
  const gens = region.gens?.length ?? 0;
  for (let i = 0; i < gens; i++) out.push({ kind: 'gen', index: i });
  for (let v = 0; v < nImages; v++) out.push({ kind: 'photo', variant: v });
  return out;
}

/** Index of the layer currently showing in the ring. gsel >= 0 → that gen;
 *  gsel -1/undefined → the selected photo variant. */
export function activePosition(region, photoSel) {
  const gens = region.gens?.length ?? 0;
  return (region.gsel ?? -1) >= 0 ? region.gsel : gens + photoSel;
}

/** Step the ring by dir (±1), wrapping. Returns { gsel, photoSel } to apply,
 *  or null when the ring has nothing to cycle (<= 1 entry). */
export function stepRing(region, nImages, photoSel, dir) {
  const gens = region.gens?.length ?? 0;
  const total = gens + nImages;
  if (total <= 1) return null;
  let pos = activePosition(region, photoSel);
  pos = ((pos + dir) % total + total) % total;
  return pos < gens
    ? { gsel: pos, photoSel }
    : { gsel: -1, photoSel: pos - gens };
}
