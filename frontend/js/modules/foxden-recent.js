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
