// Studio batch-count drag pips (Stage 4, settled layout decision §10).
// Pure — no DOM — so node tests it directly. Batch = 1..4, default 1;
// 4 is the cap because the candidate strip is an explicit triage surface
// (consolidation decision #2). The pips control maps a pointer x across
// the control to the nearest pip; touch-action:none lives in the markup,
// the math lives here.

export const BATCH_MIN = 1;
export const BATCH_MAX = 4;

export function clampBatch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return BATCH_MIN;
  return Math.min(BATCH_MAX, Math.max(BATCH_MIN, Math.round(n)));
}

// Map a pointer position across the control box to a batch value.
// N pips span the box; the value is nearest-pip, so tapping a pip or
// dragging anywhere both land on 1..BATCH_MAX. Degenerate rect (zero
// width) -> BATCH_MIN, never a throw.
export function batchFromPointer(clientX, rect) {
  if (!rect || !rect.width) return BATCH_MIN;
  const frac = (clientX - rect.left) / rect.width;
  return clampBatch(Math.round(frac * (BATCH_MAX - BATCH_MIN)) + BATCH_MIN);
}
