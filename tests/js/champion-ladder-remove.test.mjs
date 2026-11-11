// Ladder corner-X removal (Chunk C) — removed image is NOT a verdict: it must
// never enter `rejected` (so never marked pending-deletion), and the
// comparison continues with the remainder.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ChampionLadder } from '../../frontend/js/champion-ladder.js';

const item = name => ({ path: `p/${name}.png`, name: `${name}.png` });

test('remove challenger: dropped without rejected entry, ladder continues', () => {
  const l = new ChampionLadder([item('a'), item('b'), item('c'), item('d')]);
  const gone = l.remove('b');
  assert.equal(gone.name, 'b.png');
  assert.equal(l.challenger.name, 'c.png');
  assert.equal(l.k, 1); // idx unchanged — c is now challenger 1 of 3
  assert.equal(l.total, 3);
  assert.equal(l.rejected.length, 0); // removal is NOT a verdict
  assert.ok(!l.done);
  l.keepChampion(); // normal duel continues over the remainder
  assert.equal(l.rejected.length, 1);
  assert.equal(l.rejected[0].item.name, 'c.png');
});

test('remove champion: current challenger promoted with no duel', () => {
  const l = new ChampionLadder([item('a'), item('b'), item('c')]);
  const gone = l.remove('a');
  assert.equal(gone.name, 'a.png');
  assert.equal(l.champion.name, 'b.png');
  assert.equal(l.challenger.name, 'c.png');
  assert.equal(l.rejected.length, 0);
  assert.ok(!l.done);
});

test('remove champion with one duel left: promotion finishes the ladder', () => {
  const l = new ChampionLadder([item('a'), item('b')]);
  const gone = l.remove('a');
  assert.equal(gone.name, 'a.png');
  assert.equal(l.champion.name, 'b.png');
  assert.ok(l.done); // b never dueled — nothing left to duel
  assert.ok(!l.challenger);
});

test('removed image never reaches rejected even after later verdicts', () => {
  const l = new ChampionLadder([item('a'), item('b'), item('c')]);
  l.remove('b');
  l.keepChampion();
  l.keepChampion();
  const names = l.rejected.map(r => r.item.name);
  assert.deepEqual(names, ['c.png']);
  assert.ok(!names.includes('b.png'));
});

test('removals never disturb the rejected pile or the blend partner', () => {
  const l = new ChampionLadder([item('a'), item('b'), item('c')]);
  l.keepChampion(); // b rejected, runnerUp = b
  assert.equal(l.runnerUp.name, 'b.png');
  // Drop the champion (a): c promotes, rejected pile untouched.
  const gone = l.remove('a');
  assert.equal(gone.name, 'a.png');
  assert.equal(l.champion.name, 'c.png');
  assert.equal(l.runnerUp.name, 'b.png'); // blend partner survives removals
  assert.deepEqual(l.rejected.map(r => r.item.name), ['b.png']);
});

test('remove is blocked once the ladder is done', () => {
  const l = new ChampionLadder([item('a'), item('b')]);
  l.keepChampion();
  assert.ok(l.done);
  assert.equal(l.remove('a'), null);
  assert.equal(l.remove('b'), null);
});
