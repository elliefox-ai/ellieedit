// Signal-conflict surfacing (2026-10-08d) — pure, no DOM, node-testable.
// The dupe tab renders two curation signals: dupelib's hash tiers and the
// operator's prior verdict history. Where they disagree, surface it — never
// auto-apply. (Duel history is NOT available: duel-curator's state.json does
// not exist on this host and is not path-addressable to dupe members.)

// True when a manual draft action CONTRADICTS a shown suggestion — that
// override is calibration data and gets logged, once per suggestion.
export function sigIsOverride(suggestion, path, verdict) {
  if (!suggestion || !path || !verdict) return false;
  if (verdict === 'kept') return path !== suggestion.keep;
  if (verdict === 'rejected') return path === suggestion.keep;
  return false;
}

// Per-member history chip text ("kept ×2", "rejected ×1", or null).
export function sigChipText(m) {
  if (!m || (!m.kept && !m.rejected)) return null;
  if (m.kept && !m.rejected) return `kept ×${m.kept}`;
  if (m.rejected && !m.kept) return `rejected ×${m.rejected}`;
  return `kept ×${m.kept} · rejected ×${m.rejected}`;
}
