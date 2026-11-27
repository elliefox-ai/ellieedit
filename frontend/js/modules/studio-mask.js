// Studio "reapply last mask" decisions (2026-11-27) — pure, no DOM, so node
// tests them. Mirrors Update's captureLastMask()/reapplyLastMask() contract:
// the last mask is ONE in-memory entry (global, not per source image; lost
// on reload), captured before a mask is dropped or when it is used for a
// run, and re-applied only when its pixel size equals the current mask
// canvas — on a mismatch the user is told and nothing is applied.

// Entry to keep, or null when there is nothing worth keeping (blank mask,
// no canvas, no encoded data).
export function captureLast(whiteCount, width, height, dataUrl) {
  if (!(whiteCount > 0) || !(width > 0) || !(height > 0) || !dataUrl) return null;
  return { dataUrl, width, height };
}

export function lastMaskNote(last) {
  return last ? `Re-apply the last used mask (${last.width}×${last.height}) to this image`
              : 'No previous mask yet — one is kept when you run a mask edit or move on';
}

// cur = { width, height } of the current mask canvas, or null if there is
// none (no working image / Mask verb never opened).
export function planReapply(last, cur) {
  if (!last) return { ok: false, reason: 'none', msg: 'no last mask kept yet' };
  if (!cur) return { ok: false, reason: 'no-canvas', msg: 'set a working image and open Mask first' };
  if (last.width !== cur.width || last.height !== cur.height) {
    return { ok: false, reason: 'size',
      msg: `last mask is ${last.width}×${last.height}, but this image is ` +
           `${cur.width}×${cur.height} — not applied. Paint a mask for this image instead.` };
  }
  return { ok: true, reason: 'ok', msg: 'last mask re-applied' };
}
