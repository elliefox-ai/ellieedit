// Pure marking-batch planner for Gallery delete-marking mode (2026-10-08i).
// Marking taps stay local (visual only); on "Done marking" the net desired
// state per touched path is diffed against the live manifest set into ONE
// batched write. Pure so it can be unit-tested in node without a DOM.

// marks: iterable of [path, desiredOn] (e.g. a Map). pendingSet: Set of
// paths currently on the server manifest. Returns {toAdd, toRemove}.
export function planMarkBatch(pendingSet, marks) {
  const toAdd = [];
  const toRemove = [];
  for (const [path, on] of marks) {
    const cur = pendingSet.has(path);
    if (on && !cur) toAdd.push(path);
    else if (!on && cur) toRemove.push(path);
  }
  return { toAdd, toRemove };
}

// Toggle helper for the local visual state: returns the new on-value so the
// cell class flip and the touched-map update share one source of truth.
export function toggleMark(currentOn) {
  return !currentOn;
}
