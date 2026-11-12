// Studio working-image store (Stage 1, design doc §3, 2026-11-11). Pure —
// no DOM — so node can test it via createStudioState with injected deps;
// browsers use the `studioState` singleton. One selected image with
// provenance that Studio operations act on. The store lives OUTSIDE any
// tab's module lifecycle: switching tabs never clears it, which kills the
// chunk-A bug class (per-tab loadConfig resets) structurally.
//
// Persistence: sessionStorage key 'ellieedit.studio.working' (decision #3 —
// the working image survives a reload; reload must never be the cleanup
// point). Provenance is NOT persisted — it is lazily refetched from
// GET /api/foxden/provenance?path= on restore/set (cheap, always fresh).
//
// Invalidation: on restore the path is validity-checked (gallery file
// endpoint must answer ok); a missing file clears the store and reports
// reason 'missing' so the shell can toast. Settings snapshots are copies —
// they never auto-invalidate.

export const WORKING_STORAGE_KEY = 'ellieedit.studio.working';

// Build the jailed gallery file URL from a stored rel path (same shape as
// Gallery.fileUrl's primary-bank branch — kept here so Update and the shell
// can load a stored path without importing the Gallery class).
export function galleryFileUrl(path) {
  return `/api/gallery/file?path=${encodeURIComponent(String(path))}`;
}

export function createStudioState({
  storage = null,
  fetchImpl = null,
  dispatch = null,
  now = () => Date.now(),
} = {}) {
  let state = emptyState();
  const listeners = new Set();

  function emptyState() {
    return {
      path: null,            // jailed gallery rel path; null = no working image
      name: null,            // display name (falls back to path basename)
      origin: null,          // 'gallery' | 'update' | 'filters' | 'ladder' | ...
      provenance: null,      // GET /api/foxden/provenance?path= record
      settingsSnapshot: null,// normalized recipe copy — never auto-invalidates
      ts: 0,                 // set time, for staleness checks
      dirty: { provenance: false }, // provenance fetch failed → refetchable
    };
  }

  function snapshot() { return readState(); }
  function readState() {
    return {
      path: state.path, name: state.name, origin: state.origin,
      provenance: state.provenance, settingsSnapshot: state.settingsSnapshot,
      ts: state.ts, dirty: { ...state.dirty },
    };
  }

  function emit(extra = {}) {
    const detail = { ...readState(), ...extra };
    if (dispatch) {
      try { dispatch({ type: 'ellieedit:working-changed', detail }); } catch { /* listener errors never break the store */ }
    }
    for (const fn of listeners) {
      try { fn(detail); } catch { /* a broken subscriber must not kill the rest */ }
    }
    return detail;
  }

  function persist() {
    if (!storage) return;
    try {
      if (state.path === null) storage.removeItem(WORKING_STORAGE_KEY);
      else storage.setItem(WORKING_STORAGE_KEY, JSON.stringify({
        path: state.path, name: state.name, origin: state.origin,
        settingsSnapshot: state.settingsSnapshot, ts: state.ts,
      }));
    } catch { /* storage full/unavailable — the store still works in memory */ }
  }

  // Lazy provenance: fetch fires after set/restore; a failure marks
  // state.dirty.provenance (retryable via refreshProvenance) but never
  // clears the working image.
  async function refreshProvenance() {
    if (!state.path) return null;
    if (!fetchImpl) return null;
    try {
      const r = await fetchImpl(`/api/foxden/provenance?path=${encodeURIComponent(state.path)}`);
      if (!r.ok) throw new Error(String(r.status));
      const record = await r.json();
      state.provenance = record;
      state.dirty.provenance = false;
      emit({ reason: 'provenance' });
      return record;
    } catch {
      state.dirty.provenance = true;
      emit({ reason: 'provenance-failed' });
      return null;
    }
  }

  // Validity check for a restored path: a DEFINITIVE non-ok status from
  // the gallery file endpoint means the file is missing/moved → clear
  // (reason 'missing'). Network errors are not proof of absence — the
  // path stays; one retry guards against a transient blip.
  async function checkValid() {
    if (!state.path || !fetchImpl) return true;
    let definitive = false;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetchImpl(galleryFileUrl(state.path), { method: 'HEAD' });
        if (r.ok) return true;
        definitive = true;   // server answered: absence is proven
      } catch { /* network error — retry once, then keep the path */ }
    }
    if (definitive) {
      doClear({ reason: 'missing' });
      return false;
    }
    return true;
  }

  function doClear({ reason = 'clear' } = {}) {
    const had = state.path !== null;
    state = emptyState();
    persist();
    if (had || reason !== 'clear') emit({ reason });
    return snapshot();
  }

  return {
    // set(path, origin, extras) — the single entry verb. Setting the SAME
    // path refreshes ts and re-fires (subscribers dedupe if they care).
    set(path, origin, { name, settingsSnapshot } = {}) {
      const p = typeof path === 'string' && path ? path : null;
      if (!p) return doClear();
      state = emptyState();
      state.path = p;
      state.name = name || String(p).split('/').pop();
      state.origin = origin || 'unknown';
      state.settingsSnapshot = settingsSnapshot && typeof settingsSnapshot === 'object'
        ? settingsSnapshot : null;
      state.ts = now();
      persist();
      emit({ reason: 'set' });
      refreshProvenance();
      return snapshot();
    },
    clear: doClear,
    get: snapshot,
    // Refresh the provenance record on demand (initial load retries).
    refreshProvenance,

    // Restore from storage at load time: rehydrate, then validity-check +
    // refetch provenance lazily. Returns the restored snapshot (or empty).
    restore() {
      if (!storage) return snapshot();
      let raw = null;
      try { raw = storage.getItem(WORKING_STORAGE_KEY); } catch { /* private mode etc. */ }
      if (!raw) return snapshot();
      let saved;
      try { saved = JSON.parse(raw); } catch { storage.removeItem(WORKING_STORAGE_KEY); return snapshot(); }
      if (!saved || typeof saved.path !== 'string' || !saved.path) {
        try { storage.removeItem(WORKING_STORAGE_KEY); } catch { /* ignore */ }
        return snapshot();
      }
      state = emptyState();
      state.path = saved.path;
      state.name = typeof saved.name === 'string' ? saved.name : saved.path.split('/').pop();
      state.origin = typeof saved.origin === 'string' ? saved.origin : 'restored';
      state.settingsSnapshot = saved.settingsSnapshot && typeof saved.settingsSnapshot === 'object'
        ? saved.settingsSnapshot : null;
      state.ts = Number.isFinite(Number(saved.ts)) ? Number(saved.ts) : now();
      emit({ reason: 'restored' });
      checkValid();
      refreshProvenance();
      return snapshot();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// Browser singleton: sessionStorage + window primitives wired once. Node
// tests always use createStudioState with fakes — never this.
let _singleton = null;
export function studioState() {
  if (_singleton) return _singleton;
  _singleton = createStudioState({
    storage: typeof sessionStorage !== 'undefined' ? sessionStorage : null,
    fetchImpl: typeof fetch !== 'undefined' ? (...a) => fetch(...a) : null,
    dispatch: typeof window !== 'undefined'
      ? ({ type, detail }) => window.dispatchEvent(new CustomEvent(type, { detail }))
      : null,
  });
  return _singleton;
}
