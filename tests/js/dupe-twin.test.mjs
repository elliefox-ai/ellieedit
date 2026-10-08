// Twin-clearing loop helpers (2026-10-08m) — pure tests.
// Run: node --test tests/js/dupe-twin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TWIN_NEAR, dhashHamming, orderBySimilarity, twinInfo,
         nextUnhandled } from '../../frontend/js/modules/dupe-view.js';

const H = {
  // 16-hex-char (64-bit) dhash stand-ins with known Hamming distances
  zeros: '0000000000000000',
  ones:  'ffffffffffffffff',   // hamming(zeros, ones) = 64
  near0: '0000000000000001',   // hamming(zeros, near0) = 1
  near4: '000000000000000f',   // hamming(zeros, near4) = 4
  near5: '000000000000001f',   // hamming(zeros, near5) = 5
  mid:   '00000000000000ff',   // hamming(zeros, mid) = 8
};

test('dhashHamming: known distances on 16-hex strings', () => {
  assert.equal(dhashHamming(H.zeros, H.zeros), 0);
  assert.equal(dhashHamming(H.zeros, H.ones), 64);
  assert.equal(dhashHamming(H.zeros, H.near0), 1);
  assert.equal(dhashHamming(H.zeros, H.near4), 4);
  assert.equal(dhashHamming(H.zeros, H.near5), 5);
});

test('dhashHamming: missing/mismatched input is Infinity, never a guess', () => {
  assert.equal(dhashHamming(undefined, H.zeros), Infinity);
  assert.equal(dhashHamming('', H.zeros), Infinity);
  assert.equal(dhashHamming('abc', H.zeros), Infinity); // length mismatch
});

test('orderBySimilarity: greedy nearest-neighbor chain from member 0', () => {
  // chain start a(0) -> b(dist 1) -> c(dist 7 from b, 8 from a)
  const a = { path: 'a', dhash: H.zeros };
  const b = { path: 'b', dhash: H.near0 };
  const c = { path: 'c', dhash: H.mid };
  assert.deepEqual(orderBySimilarity([a, b, c]).map(m => m.path),
    ['a', 'b', 'c']);
  // start is member 0 of the input, whatever it is: [c, b, a] starts at c
  assert.deepEqual(orderBySimilarity([c, b, a]).map(m => m.path),
    ['c', 'b', 'a']);
});

test('orderBySimilarity: unhashed members appended in original order', () => {
  const a = { path: 'a', dhash: H.zeros };
  const x = { path: 'x' };                       // no dhash
  const y = { path: 'y', dhash: '' };            // empty dhash counts as none
  const b = { path: 'b', dhash: H.near4 };
  const out = orderBySimilarity([x, a, y, b]);
  assert.deepEqual(out.map(m => m.path), ['a', 'b', 'x', 'y']);
});

test('orderBySimilarity: empty/short inputs pass through', () => {
  assert.deepEqual(orderBySimilarity([]), []);
  assert.deepEqual(orderBySimilarity(undefined), []);
  const one = [{ path: 'a' }];
  assert.equal(orderBySimilarity(one)[0].path, 'a');
  assert.notEqual(orderBySimilarity(one), one);  // never mutates/aliases input
});

test('TWIN_NEAR is the tunable near threshold constant (4)', () => {
  assert.equal(TWIN_NEAR, 4);
});

test('twinInfo: exact edge tier marks kind exact', () => {
  const members = [{ path: 'a', dhash: H.zeros, size: 10 },
                   { path: 'b', dhash: H.near5, size: 12 }];
  const t = twinInfo(members, [{ a: 'a', b: 'b', tier: 'exact', distance: 5 }]);
  assert.deepEqual(t.get('a'), { twin: 'b', kind: 'exact', dist: 5 });
  assert.deepEqual(t.get('b'), { twin: 'a', kind: 'exact', dist: 5 });
});

test('twinInfo: pixel-identical tier is exact; same size+hashes is exact', () => {
  const members = [
    { path: 'a', dhash: H.zeros, phash: 'p0', size: 100 },
    { path: 'b', dhash: H.zeros, phash: 'p0', size: 100 },  // identical all
    { path: 'c', dhash: H.zeros, phash: 'p0', size: 200 },  // size differs
  ];
  // no edges at all: a-b must still be exact via size + dhash + phash
  const t = twinInfo(members, []);
  assert.equal(t.get('a').kind, 'exact');
  assert.equal(t.get('a').twin, 'b');
  // a-c differ in size → NOT exact; dist 0 > no... dist 0 ≤ TWIN_NEAR → near
  const t2 = twinInfo([members[0], members[2]], []);
  assert.equal(t2.get('a').kind, 'near');
});

test('twinInfo: near twin at Hamming ≤ TWIN_NEAR via computed distance', () => {
  const members = [{ path: 'a', dhash: H.zeros, size: 1 },
                   { path: 'b', dhash: H.near4, size: 2 }];
  const t = twinInfo(members, [{ a: 'a', b: 'b', tier: 'near-identical' }]);
  assert.deepEqual(t.get('a'), { twin: 'b', kind: 'near', dist: 4 });
  // one bit past the threshold → no twin invented
  const members2 = [{ path: 'a', dhash: H.zeros },
                    { path: 'b', dhash: H.near5 }];
  assert.equal(twinInfo(members2, [{ a: 'a', b: 'b', tier: 'related' }]).size, 0);
});

test('twinInfo: missing edge = never met threshold, not a twin', () => {
  const members = [{ path: 'a', dhash: H.zeros },
                   { path: 'b', dhash: H.ones }];
  assert.equal(twinInfo(members, []).size, 0);
  assert.equal(twinInfo(members, undefined).size, 0);
});

test('twinInfo: edge ends may be member indexes', () => {
  const members = [{ path: 'a', dhash: H.zeros, size: 3 },
                   { path: 'b', dhash: H.near4, size: 4 }];
  const t = twinInfo(members, [{ a: 0, b: 1, tier: 'near-identical', distance: 2 }]);
  assert.deepEqual(t.get('a'), { twin: 'b', kind: 'near', dist: 2 });
});

test('twinInfo: exact beats near; smaller distance wins ties', () => {
  const members = [
    { path: 'a', dhash: H.zeros, size: 1 },
    { path: 'b', dhash: H.near4, size: 2 },   // near (4)
    { path: 'c', dhash: H.near0, size: 3 },   // near (1)
  ];
  const t = twinInfo(members, [
    { a: 'a', b: 'b', tier: 'near-identical', distance: 4 },
    { a: 'a', b: 'c', tier: 'near-identical', distance: 1 },
    { a: 'a', b: 'b', tier: 'pixel-identical', distance: 4 }, // exact wins
  ]);
  assert.equal(t.get('a').kind, 'exact');
  assert.equal(t.get('a').twin, 'b');
});

test('nextUnhandled: forward wrap from current index', () => {
  const members = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
  const v = { a: 'kept', c: 'rejected' };
  assert.equal(nextUnhandled(members, v, 0), 1);   // b unhandled
  assert.equal(nextUnhandled(members, {}, 2), 0);  // wraps to a
  assert.equal(nextUnhandled(members, { a: 1, b: 1, c: 1 }, 0), -1); // all handled
  assert.equal(nextUnhandled([], {}, 0), -1);
});
