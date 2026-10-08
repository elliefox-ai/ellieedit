// Gallery → FaceCycle multi-select handoff — pure planning logic.
// Contract: Gallery dispatches 'ellieedit:facecycle-handoff'
//   { detail: { urls: [..], names: [..] } }
// where every url is a jailed /api/gallery/file?path=… URL. FaceCycle
// fetches them and loads the results through its normal handleFiles path
// as a fresh variant stack (resetAll first). No backend endpoint involved.
// Kept DOM-free so tests/js can import it directly.

export const FACECYCLE_MIN = 1;
export const FACECYCLE_MAX = 8;   // bigger stacks get unwieldy in the thumb strip

export function facecycleFileUrl(path) {
  return `/api/gallery/file?path=${encodeURIComponent(path)}`;
}

// items: gallery selection values ({ path, name, ... }). Returns
// { urls, names } on success or { error, count } on refusal.
export function planFaceCycleHandoff(items) {
  const clean = (items || []).filter(it => it && typeof it.path === 'string' && it.path);
  const count = clean.length;
  if (count < FACECYCLE_MIN) return { error: 'Select at least one image first.', count };
  if (count > FACECYCLE_MAX) {
    return { error: `FaceCycle accepts at most ${FACECYCLE_MAX} images (got ${count}).`, count };
  }
  return {
    urls: clean.map(it => facecycleFileUrl(it.path)),
    names: clean.map(it => it.name || it.path.split('/').pop() || 'image.png'),
  };
}
