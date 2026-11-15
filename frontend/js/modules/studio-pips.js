// Studio batch-count rocker (Stage 4, settled layout decision §10;
// usability pass 2026-11-15: the drag pips are gone — the count is now a
// single rocker you hold ~1s to arm, then drag vertically).
// Pure — no DOM — so node tests it directly. Batch = 1..4, default 1;
// 4 is the cap because the candidate strip is an explicit triage surface
// (consolidation decision #2).

export const BATCH_MIN = 1;
export const BATCH_MAX = 4;

export function clampBatch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return BATCH_MIN;
  return Math.min(BATCH_MAX, Math.max(BATCH_MIN, Math.round(n)));
}

// Map a vertical rocker drag to a batch value: up adds, down subtracts,
// one step per stepPx of travel from the drag start. Clamped 1..4.
// A zero/negative/garbage step falls back to 28px, never a throw.
export function batchFromRockerDrag(startValue, startY, clientY, stepPx = 28) {
  const step = Number.isFinite(Number(stepPx)) && stepPx > 0 ? stepPx : 28;
  return clampBatch(startValue + Math.round((startY - clientY) / step));
}
