// Studio working-image store — pure logic tests (Stage 1, design doc §3).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStudioState, galleryFileUrl, WORKING_STORAGE_KEY,
} from '../../frontend/js/modules/studio-state.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map,
  };
}

function okFetch(status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({ record: true, status }) });
}

test('set/get/clear: basic store shape per design §3', () => {
  const s = createStudioState({ now: () => 1234 });
  assert.equal(s.get().path, null);
  s.set('a/b/c.png', 'gallery', { name: 'c.png' });
  const st = s.get();
  assert.equal(st.path, 'a/b/c.png');
  assert.equal(st.name, 'c.png');
  assert.equal(st.origin, 'gallery');
  assert.equal(st.ts, 1234);
  assert.equal(st.provenance, null);
  assert.deepEqual(st.dirty, { provenance: false });
  s.clear();
  assert.equal(s.get().path, null);
});

test('set(null) and empty path clear the store', () => {
  const s = createStudioState();
  s.set('x.png', 'gallery');
  s.set(null);
  assert.equal(s.get().path, null);
  s.set('', 'gallery');
  assert.equal(s.get().path, null);
});

test('subscribe fires on set/clear; unsubscribe works', () => {
  const s = createStudioState();
  const seen = [];
  const off = s.subscribe(d => seen.push({ path: d.path, reason: d.reason }));
  s.set('a.png', 'gallery');
  s.clear();
  off();
  s.set('b.png', 'gallery');
  assert.deepEqual(seen, [{ path: 'a.png', reason: 'set' }, { path: null, reason: 'clear' }]);
});

test('broken subscriber never kills other subscribers or the store', () => {
  const s = createStudioState();
  let good = false;
  s.subscribe(() => { throw new Error('boom'); });
  s.subscribe(() => { good = true; });
  s.set('a.png', 'gallery');
  assert.equal(s.get().path, 'a.png');
  assert.ok(good);
});

test('persistence: set/clear write sessionStorage under the pinned key', () => {
  const storage = fakeStorage();
  const s = createStudioState({ storage });
  s.set('a/b.png', 'gallery', { settingsSnapshot: { prompt: 'hi' } });
  const saved = JSON.parse(storage.getItem(WORKING_STORAGE_KEY));
  assert.equal(saved.path, 'a/b.png');
  assert.equal(saved.origin, 'gallery');
  assert.deepEqual(saved.settingsSnapshot, { prompt: 'hi' });
  assert.equal(saved.provenance, undefined); // provenance never persisted
  s.clear();
  assert.equal(storage.getItem(WORKING_STORAGE_KEY), null);
});

test('restore: rehydrates path/origin/snapshot, lazily refetches provenance', async () => {
  const storage = fakeStorage({
    [WORKING_STORAGE_KEY]: JSON.stringify({
      path: 'a/keep.png', name: 'keep.png', origin: 'gallery',
      settingsSnapshot: { prompt: 'x' }, ts: 42,
    }),
  });
  const seen = [];
  const s = createStudioState({ storage, fetchImpl: okFetch(), now: () => 99 });
  s.subscribe(d => seen.push(d));
  const st = s.restore();
  assert.equal(st.path, 'a/keep.png');
  assert.equal(st.name, 'keep.png');
  assert.equal(st.origin, 'gallery');
  assert.equal(st.ts, 42);          // not clobbered by now()
  await new Promise(r => setTimeout(r, 0)); // let the lazy fetch settle
  assert.equal(s.get().provenance.record, true);
  assert.deepEqual(seen.map(d => d.reason), ['restored', 'provenance']);
});

test('restore invalidation: missing file clears the store with reason missing', async () => {
  const storage = fakeStorage({
    [WORKING_STORAGE_KEY]: JSON.stringify({ path: 'gone.png', origin: 'gallery', ts: 1 }),
  });
  const s = createStudioState({ storage, fetchImpl: async () => ({ ok: false, status: 404 }) });
  const seen = [];
  s.subscribe(d => seen.push(d));
  const st = s.restore();
  assert.equal(st.path, 'gone.png');           // restored first...
  await new Promise(r => setTimeout(r, 0));    // ...then validity check
  assert.equal(s.get().path, null);            // ...cleared when 404
  assert.equal(seen.at(-1).reason, 'missing');
  assert.equal(storage.getItem(WORKING_STORAGE_KEY), null);
});

test('restore validity: network error is not proof of absence — path kept', async () => {
  const storage = fakeStorage({
    [WORKING_STORAGE_KEY]: JSON.stringify({ path: 'a.png', origin: 'gallery', ts: 1 }),
  });
  const s = createStudioState({ storage, fetchImpl: async () => { throw new Error('net'); } });
  s.restore();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(s.get().path, 'a.png');
});

test('provenance fetch failure marks dirty, never clears; refreshProvenance retries', async () => {
  let fail = true;
  const s = createStudioState({
    fetchImpl: async () => {
      if (fail) return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({ recipe: { prompt: 'p' } }) };
    },
  });
  s.set('a.png', 'gallery');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(s.get().dirty.provenance, true);
  assert.equal(s.get().provenance, null);
  fail = false;
  const rec = await s.refreshProvenance();
  assert.deepEqual(rec, { recipe: { prompt: 'p' } });
  assert.equal(s.get().dirty.provenance, false);
});

test('same path set refreshes ts and re-emits (subscribers dedupe if they care)', () => {
  let t = 1000;
  const s = createStudioState({ now: () => t });
  s.set('a.png', 'gallery');
  const first = s.get().ts;
  t = 2000;
  const seen = [];
  s.subscribe(d => seen.push(d.reason));
  s.set('a.png', 'gallery');
  assert.equal(s.get().ts, 2000);
  assert.notEqual(s.get().ts, first);
  assert.deepEqual(seen, ['set']);
});

test('galleryFileUrl: jailed URL shape matches Gallery.fileUrl primary branch', () => {
  assert.equal(galleryFileUrl('a b/c.png'), '/api/gallery/file?path=' + encodeURIComponent('a b/c.png'));
});
