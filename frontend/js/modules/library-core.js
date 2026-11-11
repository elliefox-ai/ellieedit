// Pure helpers for the Library module — node-testable, no DOM.

// Sort modes shared with the server (backend LIBRARY_SORTS). 'new' is the
// default order, so it is never sent — omitting the param and 'new' must
// stay byte-identical requests.
export const LIBRARY_SORTS = ['new', 'old', 'name', 'name_desc', 'tag'];

export function sortParam(sort) {
  return LIBRARY_SORTS.includes(sort) && sort !== 'new' ? sort : '';
}

// Query string for /api/library/list from UI state.
export function buildListParams({ tag = '', cursor = 0, subject = '', shot = '', q = '', sort = 'new' }) {
  const p = new URLSearchParams({ cursor: String(cursor) });
  if (tag) p.set('tag', tag);
  if (subject) p.set('subject', subject);
  if (shot) p.set('shot', shot);
  if (q) p.set('q', q);
  const s = sortParam(sort);
  if (s) p.set('sort', s);
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
