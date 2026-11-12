// Hash deep-link compatibility (Stage 3, design §5 pulled forward): the
// FoxDen and Update tabs are unrouted; saved bookmarks pointing at
// #foxden / #update must land on Studio, never on a dead hash. Pure —
// no DOM — so node tests it directly; shell.js wires hashchange.
export const HASH_ALIASES = { foxden: 'studio', update: 'studio' };

// Resolve a location.hash to a routable tab name, or null when nothing
// applies (empty hash, unknown tab, or the resolved target not registered
// — e.g. a hash arriving before modules load).
export function resolveHash(hash, available = []) {
  const name = String(hash || '').replace(/^#/, '');
  if (!name) return null;
  const target = HASH_ALIASES[name] || name;
  return available.includes(target) ? target : null;
}
