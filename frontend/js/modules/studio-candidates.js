// FoxDen candidate strip state (Stage 2, decision #2). Pure — no DOM — so
// node tests exercise the lifecycle; foxden.js renders it. One generation
// run's outputs become candidates; the cleanup rule: the NEXT run replaces
// the strip entirely (unretrieved candidates die — keep them by saving).
// Promote = the operator clicks a candidate -> it becomes the working
// image; promotion never saves and never mutates the strip.

export function createCandidates() {
  let items = [];               // [{path, url}] — this run's outputs
  return {
    // startRun(candidates): the cleanup rule — whatever existed is gone.
    // Non-shape entries are dropped, never invented.
    startRun(candidates) {
      items = (Array.isArray(candidates) ? candidates : [])
        .filter(c => c && typeof c.path === 'string' && c.path
                  && typeof c.url === 'string' && c.url)
        .map(c => ({ path: c.path, url: c.url }));
      return this.get();
    },
    get() { return [...items]; },
    count() { return items.length; },
    has(path) { return items.some(i => i.path === path); },
    find(path) { return items.find(i => i.path === path) || null; },
    clear() { items = []; },
  };
}

// A /status output view URL -> the provenance-style output path
// (`subfolder/name`, the key /api/foxden/provenance is addressed by).
// Unparseable -> null: the candidate has no identity and is not shown.
export function pathFromViewUrl(url) {
  try {
    const u = new URL(url, 'http://x');   // absolute or /api-relative both parse
    const filename = u.searchParams.get('filename');
    if (!filename) return null;
    const sub = (u.searchParams.get('subfolder') || '').replace(/^\/+|\/+$/g, '');
    return sub ? `${sub}/${filename}` : filename;
  } catch {
    return null;
  }
}
