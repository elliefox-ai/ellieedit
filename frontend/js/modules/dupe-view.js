// Pure zoom view-filter logic (2026-10-08j, re-scoped) — no DOM, node-tested.
//
// The zoom viewer's mode (all | accepted | rejected) selects which family
// members the cycle traverses, from the members' verdicts:
//   accepted = kept or melded;  rejected = rejected;  all = everything
// Filtering only changes the visited set — never verdicts or layout.
// No new verdict states are invented; undeclared members appear only in All.

// ── TWIN-CLEARING LOOP (2026-10-08m) ─────────────────────────────────
// Pure helpers for the twin-clearing zoom loop: similarity ordering,
// twin detection from family edges, and next-unhandled advance.
// No DOM — node-tested in tests/js/dupe-twin.test.mjs.
//
// Verified data facts (external review, hashes confirmed): members carry
// dhash/phash (16-hex strings) + size through _member_view; family edges
// have keys a, b, tier (exact, pixel-identical, near-identical, related,
// regional) plus graded distance/color_distance fields. A missing edge
// means the pair never met a threshold — it is NOT 'far', and no twin is
// ever invented for it.

// Hamming distance at or below this makes a pair a 'near' twin (tunable).
export const TWIN_NEAR = 4;

// Popcount(XOR) of two equal-length hex strings; Infinity when either is
// missing or the lengths disagree (never guessed).
export function dhashHamming(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' ||
      !a.length || a.length !== b.length) return Infinity;
  let x;
  try { x = BigInt('0x' + a) ^ BigInt('0x' + b); } catch (_) { return Infinity; }
  let n = 0;
  while (x) { x &= x - 1n; n++; }
  return n;
}

// Greedy nearest-neighbor chain on dhash Hamming distance: start at the
// first hashed member, repeatedly append its nearest remaining neighbor
// (first-index wins ties). Members without a usable dhash keep their
// original relative order, appended at the end. Never mutates the input.
export function orderBySimilarity(members) {
  const list = Array.isArray(members) ? members.slice() : [];
  const hashed = list.filter(m => m && typeof m.dhash === 'string' && m.dhash);
  if (hashed.length <= 1) return list;   // original order
  const rest = hashed.slice(1);
  const chain = [hashed[0]];
  while (rest.length) {
    const cur = chain[chain.length - 1];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const d = dhashHamming(cur.dhash, rest[i].dhash);
      if (d < bd) { bd = d; bi = i; }
    }
    chain.push(rest.splice(bi, 1)[0]);
  }
  const bare = list.filter(m => !(m && typeof m.dhash === 'string' && m.dhash));
  return [...chain, ...bare];
}

// Twin map: member path -> {twin, kind, dist}. kind='exact' when the edge
// tier is exact/pixel-identical OR both hashes and the size agree;
// kind='near' when the (graded-or-computed) distance is <= TWIN_NEAR.
// The best edge wins: exact beats near, then smaller distance. Edge ends
// may be member paths or member indexes (both appear in real indexes).
export function twinInfo(members, edges) {
  const list = Array.isArray(members) ? members : [];
  const byPath = new Map(list.map(m => [m.path, m]));
  const resolve = v =>
    typeof v === 'number' ? (list[v] ? list[v].path : null)
      : (typeof v === 'string' && byPath.has(v) ? v : null);
  const rank = { exact: 0, near: 1 };
  const best = new Map();
  const consider = (path, twinPath, kind, dist) => {
    if (!path || !twinPath || path === twinPath) return;
    const prev = best.get(path);
    if (!prev || rank[kind] < rank[prev.kind] ||
        (rank[kind] === rank[prev.kind] && dist < prev.dist))
      best.set(path, { twin: twinPath, kind, dist });
  };
  // near twins come from the raw hashes themselves: any pair with
  // Hamming <= TWIN_NEAR; identical-hash pairs (same size + both hashes)
  // are exact even with no edge recorded. Edges then upgrade pairs to
  // exact by tier and may carry a graded distance.
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const mi = list[i], mj = list[j];
      if (mi.size !== undefined && mi.size === mj.size &&
          !!mi.dhash && mi.dhash === mj.dhash &&
          !!mi.phash && mi.phash === mj.phash) {
        consider(mi.path, mj.path, 'exact', 0);
        consider(mj.path, mi.path, 'exact', 0);
        continue;
      }
      const d = dhashHamming(mi.dhash, mj.dhash);
      if (d <= TWIN_NEAR) {
        consider(mi.path, mj.path, 'near', d);
        consider(mj.path, mi.path, 'near', d);
      }
    }
  }
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e) continue;
    const pa = resolve(e.a), pb = resolve(e.b);
    const ma = byPath.get(pa), mb = byPath.get(pb);
    if (!ma || !mb) continue;
    const dist = typeof e.distance === 'number' && isFinite(e.distance)
      ? e.distance : dhashHamming(ma.dhash, mb.dhash);
    const exact = e.tier === 'exact' || e.tier === 'pixel-identical' ||
      (ma.size !== undefined && ma.size === mb.size &&
       !!ma.dhash && ma.dhash === mb.dhash && !!ma.phash && ma.phash === mb.phash);
    if (exact) {
      consider(pa, pb, 'exact', dist); consider(pb, pa, 'exact', dist);
    } else if (dist <= TWIN_NEAR) {
      consider(pa, pb, 'near', dist); consider(pb, pa, 'near', dist);
    }
  }
  return best;
}

// Index of the next member (searching forward from fromIdx, wrapping)
// with no verdict; -1 when every member is handled.
export function nextUnhandled(members, verdicts, fromIdx = -1) {
  const list = Array.isArray(members) ? members : [];
  const v = verdicts || {};
  const n = list.length;
  for (let s = 1; s <= n; s++) {
    const i = (((fromIdx + s) % n) + n) % n;
    if (!v[list[i].path]) return i;
  }
  return -1;
}

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

// Dupe list cache decision (2026-10-08n): pure cache-key logic so the
// client-side families-list cache is unit-testable. 'reuse' only when a
// cached key exists, the server key is known, and nothing dirtyied the
// cache since (a commit). Anything unknown refetches — fail open.
export function listCacheDecision(cachedKey, freshKey, dirty) {
  if (dirty) return "refetch";
  if (!cachedKey || !freshKey) return "refetch";
  return cachedKey === freshKey ? "reuse" : "refetch";
}
