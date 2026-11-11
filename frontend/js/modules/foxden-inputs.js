// FoxDen input-image browser helpers (Chunk A UX, 2026-11-11). Pure — no
// DOM, no shell imports — so node can test them. The server returns input
// names plus a recency map (last-used timestamp per name, harvested from
// the provenance log); this module turns that into a browsable order.
//
// Defaults follow the operator's ask: recency first, a sane page count
// before "show more", and a basic sort/filter (recency, name).

export const INPUTS_PAGE = 24;   // chips shown before "show more"

function normName(n) { return typeof n === 'string' ? n : ''; }

// One comparable order key: recency mode sorts by last-used ts, newest
// first; names with no recorded use go last (alphabetical among
// themselves, so the tail is stable). Name mode is a plain A→Z sort.
export function orderInputs(names, recency, { sort = 'recent', q = '' } = {}) {
  const list = (Array.isArray(names) ? names : []).map(normName).filter(Boolean);
  const query = String(q || '').trim().toLowerCase();
  const filtered = query ? list.filter(n => n.toLowerCase().includes(query)) : list;
  if (sort === 'name') return filtered.sort((a, b) => a.localeCompare(b));
  if (sort !== 'recent') return filtered;   // unknown sort: stable passthrough
  const ts = n => {
    const v = recency && typeof recency === 'object' ? recency[n] : undefined;
    return typeof v === 'string' && v ? v : '';
  };
  return filtered
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (ts(b.n) || '').localeCompare(ts(a.n) || '') || a.i - b.i)
    .map(x => x.n);
}

// The visible window: the first `shown` entries of the ordered list, plus
// how many remain behind "show more" (0 means everything is visible).
export function pageInputs(ordered, shown = INPUTS_PAGE) {
  const list = Array.isArray(ordered) ? ordered : [];
  const n = Number.isFinite(shown) && shown > 0 ? Math.trunc(shown) : INPUTS_PAGE;
  return { items: list.slice(0, n), more: Math.max(0, list.length - n) };
}
