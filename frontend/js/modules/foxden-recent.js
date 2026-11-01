// FoxDen recent-strip pure helpers (Task 5, 2026-10-14). No DOM / shell
// imports so node can test them (foxden.js itself pulls in shell.js).

export const COLLAPSE_KEY = 'foxden.recentCollapsed';

// localStorage can throw (Safari private mode, storage disabled) or be absent:
// persistence is a convenience and must never break the page.
export function readCollapsed(storage) {
  try { return storage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; }
}

export function writeCollapsed(storage, on) {
  try { storage.setItem(COLLAPSE_KEY, on ? '1' : '0'); return true; } catch (e) { return false; }
}

// Header text for the strip; this is what stays visible when collapsed.
export function recentLabel(total, extra = '') {
  const n = Number.isFinite(total) && total > 0 ? total : 0;
  return `recent · ${n}${extra}`;
}

// Flatten the /recent items into the zoom viewer's cycle order: items in
// server order, each item's urls in order, carrying the item as the entry
// (workflow / seed / prompt for the viewer meta). Non-array input and
// items without urls contribute nothing.
export function flattenRecent(items) {
  const out = [];
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || !Array.isArray(it.urls)) continue;
    for (const url of it.urls) out.push({ url, entry: it });
  }
  return out;
}

// Step through a cycle list with wrap-around: 0 -> len-1 going back, and
// len-1 -> 0 going forward. Empty list: -1. A non-finite start lands on
// the first item going forward, the last going back.
export function cycleIndex(idx, delta, len) {
  if (!Number.isFinite(len) || len <= 0) return -1;
  if (!Number.isFinite(idx)) return delta < 0 ? len - 1 : 0;
  return ((idx + delta) % len + len) % len;
}
