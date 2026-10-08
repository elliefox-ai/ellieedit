// Pure dupe view-mode classification (2026-10-08j) — no DOM, node-tested.
//
// Mirrors backend/routers/dupe.py::_family_views, but runs client-side from
// the per-row `verdict_counts` tally the /families listing now carries, so
// card rendering (accepted/rejected chips, DELETION dimming) never needs a
// second server round-trip. Semantics, from the LATEST ledger entry only:
//   accepted = kept or melded ≥1 member
//   rejected = rejected ≥1 member
// A split verdict lands in BOTH views. Unresolved/all-deferred in neither.
// No new verdict states are invented.

export function familyVerdictState(counts) {
  const c = counts || {};
  return {
    accepted: (c.kept || 0) + (c.melded || 0) > 0,
    rejected: (c.rejected || 0) > 0,
  };
}

// A family whose rejected files are already queued for deletion (any of the
// latest entry's rejects sit in the pending manifest) — render dimmed with
// a DELETION badge, still visible and reversible until Delete all.
export function inDeletionManifest(row) {
  return (row && row.pending || 0) > 0;
}
