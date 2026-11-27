// Update tab version stack — pure state machine (DOM-free, node-testable).
//
// Session state per source image: original → render(s).
//   entries   : stack of {url, name, path?, recipe?, masked?} — index 0
//                 is always the original; renders note their recipe
//                 (preset file, or 'masked-inpaint') for save-family
//   parents   : parallel array — parents[i] is the index of the entry
//                 entry i was generated FROM (null for the original).
//                 Stored beside the entries, not on them: entry objects
//                 keep their identity (pinned by tests) and the module's
//                 purity contract — pushRender never mutates its input.
//                 A missing parents array (pre-parent stacks) falls back
//                 to the linear assumption, parent = i - 1.
//   idx       : the entry being VIEWED (save + compare act on this)
//   sourceIdx : the entry the NEXT run renders FROM (Swap moves this)
//
// Interactions:
//   pushRender        — a finished render is appended and becomes the view
//   setViewedAsBase   — accept the viewed entry as the next run's source
//                       (replaces the old "Swap" action; swap() is kept
//                       as a deprecated alias for existing callers/tests)
//   selectEntry       — view jumps to an existing generation (forward
//                       cycling is just viewed selection, no new mode)
//   revert            — step the view back one stack entry
//   revertToOriginal  — view jumps to the original (index 0)
//   stepBack          — go back one entry AND re-base to it (revert alone
//                       moves only the view; the next run would still
//                       render from the newer entry)
//   ancestry          — the viewed entry's ancestors (parent walk), for
//                       save-family intermediates (a branch's siblings
//                       are NOT intermediates — the flat slice was wrong)
//   lineage           — display rows for the History pop-up / Provenance
// All functions are pure: they return a NEW state, never mutate.

export function createStack(originalEntry) {
  if (!originalEntry) throw new Error('original entry required');
  return { entries: [originalEntry], parents: [null], idx: 0, sourceIdx: 0 };
}

export function current(s) { return s.entries[s.idx]; }
export function source(s) { return s.entries[s.sourceIdx]; }
export function isOriginal(s) { return s.idx === 0; }
export function canRevert(s) { return s.idx > 0; }

// Compare target: the previous stack entry (the viewed render's input
// baseline); at the original there is nothing earlier — compare to itself.
export function compareEntry(s) {
  return s.idx > 0 ? s.entries[s.idx - 1] : s.entries[s.idx];
}

export function pushRender(s, renderEntry) {
  if (!renderEntry) throw new Error('render entry required');
  // The parent is the base the render was generated from — the sourceIdx
  // at push time. An explicit parent on the entry wins (a caller that
  // knows better); otherwise the base. The entry object itself is never
  // mutated or copied — its identity is pinned by tests.
  const parent = renderEntry.parent != null ? renderEntry.parent : s.sourceIdx;
  const parents = Array.isArray(s.parents) ? s.parents : s.entries.map((_, i) => (i === 0 ? null : i - 1));
  return { ...s, entries: [...s.entries, renderEntry], parents: [...parents, parent], idx: s.entries.length };
}

// Parent index of entry i (null for the original). Pre-parent stacks
// (no parents array) fall back to the linear assumption.
export function parentOf(s, i) {
  if (i <= 0) return null;
  if (Array.isArray(s.parents) && i < s.parents.length) return s.parents[i];
  return i - 1;
}

export function setViewedAsBase(s) {
  return { ...s, sourceIdx: s.idx };
}

// Deprecated alias: the old Swap action. New code uses setViewedAsBase.
export function swap(s) {
  return setViewedAsBase(s);
}

// Viewed selection through existing generations only. Out-of-range
// indices clamp to the stack; no new entries are created here.
export function selectEntry(s, idx) {
  const clamped = Math.max(0, Math.min(s.entries.length - 1, idx));
  return { ...s, idx: clamped };
}

export function revert(s) {
  return s.idx > 0 ? { ...s, idx: s.idx - 1 } : s;
}

export function revertToOriginal(s) {
  return { ...s, idx: 0 };
}

// Back: step the view back one entry AND re-base to it, in one action.
// revert alone moves only the view — the next run would still render
// from the newer entry, so a go-back that stopped there would view B
// but save/run from C. No-op at the original (revert floors there, and
// the base is already 0).
export function stepBack(s) {
  return setViewedAsBase(revert(s));
}

// Ancestors of the entry at idx (default: the viewed entry), oldest
// first, excluding the entry itself and the original. Walks parent
// links, so a branch's siblings are NOT ancestors — the old flat
// slice(1, idx) wrongly listed them as intermediates. Guarded against
// a malformed parent cycle.
export function ancestry(s, idx = s.idx) {
  const out = [];
  const seen = new Set([idx]);
  let i = parentOf(s, idx);
  while (i != null && i > 0 && !seen.has(i)) {
    seen.add(i);
    out.push(s.entries[i]);
    i = parentOf(s, i);
  }
  return out.reverse();
}

// Display rows for the History pop-up / Provenance lineage: one row
// per entry, oldest first, with its parent and current/base markers.
export function lineage(s) {
  return s.entries.map((entry, i) => ({
    index: i,
    entry,
    parent: parentOf(s, i),
    isCurrent: i === s.idx,
    isBase: i === s.sourceIdx,
  }));
}

// Saveable: any entry that carries a server-side path. Renders carry their
// gallery-tmp path; the original carries its gallery path.
export function saveable(s) {
  const e = current(s);
  return !!(e && e.path);
}
