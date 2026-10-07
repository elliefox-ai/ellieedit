// Champion-ladder state machine test. Run: node tests/js/champion-ladder.test.mjs
import assert from 'node:assert/strict';
import { ChampionLadder } from '../../frontend/js/champion-ladder.js';

const imgs = (names) => names.map(n => ({ name: n, path: 'x/' + n }));

// Champion is the first selection; challengers are the rest in order.
{
  const l = new ChampionLadder(imgs(['a', 'b', 'c', 'd']));
  assert.equal(l.champion.name, 'a');
  assert.equal(l.challenger.name, 'b');
  assert.equal(l.total, 4);
  assert.equal(l.k, 1);
}

// Champion wins every round: challenger discarded each time, a stays champion.
{
  const l = new ChampionLadder(imgs(['a', 'b', 'c']));
  l.keepChampion();
  assert.equal(l.champion.name, 'a');
  assert.equal(l.challenger.name, 'c');
  assert.equal(l.k, 2);
  assert.equal(l.runnerUp.name, 'b');
  l.keepChampion();
  assert.ok(l.done);
  assert.equal(l.challenger, null);
  assert.equal(l.champion.name, 'a');
  assert.equal(l.runnerUp.name, 'c');
  assert.deepEqual(l.rejected.map(r => r.item.name), ['b', 'c']);
}

// Challenger wins round 1: b becomes champion, a is discarded.
{
  const l = new ChampionLadder(imgs(['a', 'b', 'c']));
  l.keepChallenger();
  assert.equal(l.champion.name, 'b');
  assert.equal(l.challenger.name, 'c');
  assert.equal(l.runnerUp.name, 'a');
  l.keepChampion();
  assert.ok(l.done);
  assert.equal(l.champion.name, 'b');
  assert.equal(l.runnerUp.name, 'c');
  assert.deepEqual(l.rejected.map(r => r.item.name), ['a', 'c']);
}

// Operator can swap the runner-up to any rejected image for Blend.
{
  const l = new ChampionLadder(imgs(['a', 'b', 'c']));
  l.keepChampion();
  l.keepChampion();
  l.setRunnerUp(l.rejected[0].item);
  assert.equal(l.runnerUp.name, 'b');
}

// Too few images rejected.
assert.throws(() => new ChampionLadder(imgs(['a'])));
assert.throws(() => new ChampionLadder([]));

console.log('champion-ladder tests passed');
