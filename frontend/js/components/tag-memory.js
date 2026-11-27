// Recent / most-used tag memory shared by every place a tag is chosen for
// the Library (Gallery promote, Library retag, Studio save, Update promote,
// Filters save). Pure — no DOM — so node can test it; `storage` is
// injectable and defaults to localStorage.
//
// The storage key is the one Gallery's promote dialog has used since v1.5.1,
// so existing recents carry over untouched.

export const TAG_KEY = 'ellieedit.promote.tags';
const RECENT_MAX = 8;

function defStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function loadTagMemory(storage = defStorage()) {
  try {
    const m = JSON.parse((storage && storage.getItem(TAG_KEY)) || '{}');
    return {
      recent: Array.isArray(m.recent) ? m.recent.filter(t => typeof t === 'string' && t) : [],
      counts: (m.counts && typeof m.counts === 'object') ? m.counts : {},
    };
  } catch { return { recent: [], counts: {} }; }
}

// Record one tag, or several (a retag sets a list). Order within a list is
// kept so the first tag of a retag ends up most recent.
export function recordTags(tags, storage = defStorage()) {
  const list = (Array.isArray(tags) ? tags : [tags])
    .map(t => String(t || '').trim()).filter(Boolean);
  if (!list.length) return;
  const m = loadTagMemory(storage);
  for (const tag of [...list].reverse()) {
    m.recent = [tag, ...m.recent.filter(t => t !== tag)].slice(0, RECENT_MAX);
  }
  for (const tag of list) m.counts[tag] = (m.counts[tag] || 0) + 1;
  try { if (storage) storage.setItem(TAG_KEY, JSON.stringify(m)); } catch { /* private mode */ }
}

export const recordTag = (tag, storage) => recordTags([tag], storage);

// Chips to offer: the 5 most recent first, then most-used to fill up to `max`.
export function tagChips(mem, max = 8) {
  const seen = new Set();
  const out = [];
  for (const t of mem.recent.slice(0, 5)) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  for (const t of Object.entries(mem.counts).sort((a, b) => b[1] - a[1]).map(e => e[0])) {
    if (out.length >= max) break;
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// Comma-list helpers for the multi-tag (retag) mode.
export function splitTags(s) {
  return String(s || '').split(',').map(t => t.trim()).filter(Boolean);
}

export function toggleTagInList(s, tag) {
  const list = splitTags(s);
  const i = list.indexOf(tag);
  if (i >= 0) list.splice(i, 1); else list.push(tag);
  return list.join(', ');
}
