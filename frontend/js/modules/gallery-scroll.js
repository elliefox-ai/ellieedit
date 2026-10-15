// Gallery manifest-change + scroll-anchor pure logic (2026-10-15).
// No DOM / shell imports so node can test it (gallery.js pulls in shell.js).
//
// Problem this solves: any pending-manifest change used to trigger a full
// reload() of the grid (wipe, refetch page 1, scroll lost). Now a change is
// applied surgically wherever possible and the user's place is anchored by
// the image they were looking at, not by a pixel offset.

// Set diff of the pending manifest: what was newly marked, what left it
// (returned to Active, or deleted by a confirm).
export function diffManifest(oldSet, freshSet) {
  const added = [], removed = [];
  for (const p of freshSet) if (!oldSet.has(p)) added.push(p);
  for (const p of oldSet) if (!freshSet.has(p)) removed.push(p);
  return { added, removed };
}

// What the grid must do about a manifest change, per server-filtered view.
//   all     — nothing structural (badges only)
//   active  — newly pending images simply leave the grid; an image that came
//             BACK to Active must be inserted at its sorted place -> reload
//   pending — images that left the manifest simply leave the grid; newly
//             pending ones need inserting -> reload
// reload=true always means "refetch but keep the user's place".
export function planManifestChange(view, { added, removed }) {
  if (view === 'active') {
    return { removeLocal: new Set(added), reload: removed.length > 0 };
  }
  if (view === 'pending') {
    return { removeLocal: new Set(removed), reload: added.length > 0 };
  }
  return { removeLocal: new Set(), reload: false };
}

// `paths` is the grid's cell order (null for non-image cells such as folder
// cards). If the anchor cell is about to be removed, pick the nearest cell
// that survives: the next one first (it slides into the freed spot), else the
// previous one. Returns null if nothing survives or the anchor isn't present.
export function pickSurvivor(paths, anchorPath, removed) {
  const i = paths.indexOf(anchorPath);
  if (i < 0) return null;
  if (!removed.has(anchorPath)) return anchorPath;
  for (let j = i + 1; j < paths.length; j++) {
    if (paths[j] && !removed.has(paths[j])) return paths[j];
  }
  for (let j = i - 1; j >= 0; j--) {
    if (paths[j] && !removed.has(paths[j])) return paths[j];
  }
  return null;
}

// How far to scroll the grid so the anchor cell sits `wantedOffset` px below
// the grid's top edge (all values are viewport coordinates).
export function scrollDeltaFor(cellTop, gridTop, wantedOffset) {
  return (cellTop - gridTop) - wantedOffset;
}
