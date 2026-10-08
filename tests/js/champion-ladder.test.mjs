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

// End-of-round state is complete enough for the results view: champion,
// runner-up, and rejected history are all populated.
{
  const l = new ChampionLadder(imgs(['a', 'b', 'c']));
  l.keepChampion();
  l.keepChallenger();
  assert.ok(l.done);
  assert.ok(l.champion);
  assert.equal(l.champion.name, 'c');
  assert.ok(l.runnerUp);
  assert.equal(l.runnerUp.name, 'a'); // displaced champion becomes the partner
  assert.equal(l.rejected.length, l.total - 1); // one decision per challenger
  assert.equal(l.challenger, null);
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

// ── Curation redesign (2026-10-07s): ladder end-state feeds Pending Delete ──
import { readFileSync } from 'node:fs';

// End-state exposes gallery-root-relative paths for the manifest POST.
{
  const l = new ChampionLadder(imgs(['a', 'b', 'c']));
  l.keepChampion();
  l.keepChampion();
  assert.ok(l.done);
  assert.deepEqual(l.rejected.map(r => r.item.path), ['x/b', 'x/c']);
}

// The Ladder module wires the end-state send-rejected action to the pending
// manifest (user-facing rename: Review → Ladder; verdicts, never saves).
const reviewSrc = readFileSync(new URL('../../frontend/js/modules/review.js', import.meta.url), 'utf8');
assert.match(reviewSrc, /data-act="res-send-pending"/);
assert.match(reviewSrc, /'\/api\/pending'/);
assert.match(reviewSrc, /marked for delete/);
assert.match(reviewSrc, /label: 'Ladder'/);
assert.doesNotMatch(reviewSrc, /label: 'Review'/);
// No grid browsing on the Ladder tab; idle hint instead.
assert.match(reviewSrc, /Select images in Gallery, then Ladder N/);
assert.ok(!reviewSrc.includes('start-review'), 'no Review-tab launch button');
// Verdict language: keep-exit toast says Champion:, never "saved"/"kept"
assert.match(reviewSrc, /Champion: \$\{champ\.name\}/);
assert.ok(!/Champion kept/.test(reviewSrc));

// Gallery module: multi-select action bar + delete-mode + pending badge.
const gallerySrc = readFileSync(new URL('../../frontend/js/modules/gallery.js', import.meta.url), 'utf8');
assert.match(gallerySrc, /ellieedit:ladder-launch/);
assert.match(gallerySrc, /ellieedit:blend-launch/);
assert.match(gallerySrc, /deleteMode/);
assert.match(gallerySrc, /EllieEdit service worker|pending\/confirm|api\/pending/);
assert.match(gallerySrc, /api\/pending\/confirm/);

console.log('champion-ladder tests passed (incl. curation redesign)');
