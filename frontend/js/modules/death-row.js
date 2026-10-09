// Death-row rehydration (2026-10-09b) — pure selection/sort/count logic.
// Resolved majority-rejected families re-enter the normal unresolved queue
// as PRE-MARKED UNCOMMITTED drafts. This module holds the pure parts the
// dupe module consumes: majority test, queue ordering, count/byte totals.
// No DOM, no fetch — node-tested in tests/js/death-row.test.mjs.

// Majority-rejected over ONE verdict map (latest-verdict-wins upstream):
// rejected >= kept and rejected > 0. kept/rejected counted; melded and
// deferred members count toward neither side.
export function majorityRejected(members = {}) {
  let kept = 0;
  let rejected = 0;
  for (const v of Object.values(members || {})) {
    if (v === 'kept') kept++;
    else if (v === 'rejected') rejected++;
  }
  return rejected > 0 && rejected >= kept;
}

// verdictsByFamily: fid -> latest verdict {members:{path:v}} | undefined.
// Returns rehydrated rows (state 'unresolved', rehydrated flag) sorted by
// rejected desc, id asc tiebreak — biggest families first, that's where
// the purge bytes live.
export function selectDeathRow(families, verdictsByFamily) {
  const fams = Array.isArray(families) ? families : [];
  const verdicts = verdictsByFamily || {};
  return fams
    .filter(f => f && f.id && majorityRejected((verdicts[f.id] || {}).members))
    .map(f => {
      const m = (verdicts[f.id].members || {});
      let kept = 0;
      let rejected = 0;
      for (const v of Object.values(m)) {
        if (v === 'kept') kept++;
        else if (v === 'rejected') rejected++;
      }
      return {
        id: f.id, size: f.size, tiers: f.tiers || [],
        state: 'unresolved', rehydrated: true,
        rejected, kept,
      };
    })
    .sort((a, b) => (b.rejected - a.rejected) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Sum the queue a mass commit would enqueue: files + bytes over summary
// rows (each carrying rejected_files / rejected_bytes from a stat pass).
export function queueCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    files: list.reduce((a, r) => a + (r.rejected_files || 0), 0),
    bytes: list.reduce((a, r) => a + (r.rejected_bytes || 0), 0),
  };
}

// Bytes -> honest GB string (binary GB, same convention as the deletion view).
export function gb(bytes) {
  return (Number(bytes || 0) / 1073741824).toFixed(2);
}
