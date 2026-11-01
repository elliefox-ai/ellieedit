// Update tab version stack — pure state machine (DOM-free, node-testable).
//
// Session state per source image: original → render(s).
//   entries   : stack of {url, name, path?, recipe?, masked?} — index 0
//                 is always the original; renders note their recipe
//                 (preset file, or 'masked-inpaint') for save-family
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
// All functions are pure: they return a NEW state, never mutate.

export function createStack(originalEntry) {
  if (!originalEntry) throw new Error('original entry required');
  return { entries: [originalEntry], idx: 0, sourceIdx: 0 };
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
  return { ...s, entries: [...s.entries, renderEntry], idx: s.entries.length };
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

// Saveable: any entry that carries a server-side path. Renders carry their
// gallery-tmp path; the original carries its gallery path.
export function saveable(s) {
  const e = current(s);
  return !!(e && e.path);
}
