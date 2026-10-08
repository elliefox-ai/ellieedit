// Pure zoom view-filter logic (2026-10-08j, re-scoped) — no DOM, node-tested.
//
// The zoom viewer's mode (all | accepted | rejected) selects which family
// members the cycle traverses, from the members' verdicts:
//   accepted = kept or melded;  rejected = rejected;  all = everything
// Filtering only changes the visited set — never verdicts or layout.
// No new verdict states are invented; undeclared members appear only in All.

const ACCEPTED = new Set(["kept", "melded"]);

export function zoomModeMatches(mode, verdict) {
  if (mode === "all") return true;
  if (mode === "accepted") return ACCEPTED.has(verdict);
  if (mode === "rejected") return verdict === "rejected";
  return false;
}

// members: [{path,...}], verdicts: path -> verdict string | null
export function zoomMembers(members, verdicts, mode = "all") {
  return (members || []).filter(m =>
    zoomModeMatches(mode, (verdicts || {})[m.path] || null));
}
