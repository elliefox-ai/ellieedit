// Pure helpers for the Library module — node-testable, no DOM.

// Query string for /api/library/list from UI state.
export function buildListParams({ tag = '', cursor = 0 }) {
  const p = new URLSearchParams({ cursor: String(cursor) });
  if (tag) p.set('tag', tag);
  return p.toString();
}

// Cursor advance: server sends next_cursor (int) or null when exhausted.
// Returns the cursor for the next page, or null when done.
export function advanceCursor(serverNext, pageLen) {
  if (serverNext == null) return null;
  return serverNext;
}

// Count line: "showing X of Y — tag: <t>" (tag segment only when set).
export function countLine(shown, total, tag) {
  const base = `showing ${shown} of ${total}`;
  return tag ? `${base} — tag: ${tag}` : base;
}
