// Inc.3 frontend helpers — membership proposal badge/panel + Dates grouping.
// Pure tests. Run: node --test tests/js/dupe-proposal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalChip, proposalPanelHtml, PROPOSAL_HINT, familyMtime,
  dayKey, groupByDate } from '../../frontend/js/modules/dupe-view.js';

test('chip only for proposal families; id is escaped', () => {
  assert.equal(proposalChip({ id: 'fam-a' }), '');
  assert.equal(proposalChip(null), '');
  assert.equal(proposalChip({ proposed_merge: null }), '');
  const h = proposalChip({ proposed_merge: { family_id: 'fam-111111111111' } });
  assert.match(h, /proposed merge → fam-111111111111/);
  assert.match(h, /ghost-chip proposal/);
  assert.match(proposalChip({ proposed_merge: { family_id: '<x>' } }), /&lt;x&gt;/);
});

test('panel: both thumbs side by side, hint uses existing verdict words', () => {
  const pm = { family_id: 'fam-1', distance: 3, matched_member: 'F1.png',
    matched: { name: 'F1.png', thumb: '/api/dupe/thumb?path=F1.png' } };
  const h = proposalPanelHtml(pm, [{ name: 'new.png', thumb: '/t/new' }]);
  assert.match(h, /Proposed merge into <b>fam-1<\/b>/);
  assert.match(h, /distance 3/);
  assert.match(h, /src="\/t\/new"/);
  assert.match(h, /src="\/api\/dupe\/thumb\?path=F1\.png"/);
  assert.match(h, /new: new\.png/);
  assert.match(h, /in family: F1\.png/);
  assert.ok(h.includes(PROPOSAL_HINT));
  assert.match(PROPOSAL_HINT, /Meld = merge/);
  assert.match(PROPOSAL_HINT, /Keep = stays separate/);
});

test('panel: missing thumbs degrade, cluster proposals say +N, no pm -> empty', () => {
  assert.equal(proposalPanelHtml(null, []), '');
  const pm = { family_id: 'fam-1', matched_member: 'F1.png', matched: { name: 'F1.png', thumb: null } };
  const h = proposalPanelHtml(pm, [{ name: 'a', thumb: '/a' }, { name: 'b' }]);
  assert.match(h, /no preview/);
  assert.match(h, /\(\+1 more\)/);
});

const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).getTime() / 1000;

test('familyMtime = median of valid member mtimes, null when none', () => {
  assert.equal(familyMtime({ members: [{ mtime: 10 }, { mtime: 30 }, { mtime: 20 }] }), 20);
  assert.equal(familyMtime({ members: [{ mtime: 10 }, { mtime: 20 }] }), 15);
  assert.equal(familyMtime({ members: [{ mtime: 0 }, { mtime: null }, {}] }), null);
  assert.equal(familyMtime({}), null);
});

test('groupByDate: newest day first, newest family first, undated last, lossless', () => {
  const a = { id: 'a', members: [{ mtime: at(2026, 10, 14, 9) }] };
  const b = { id: 'b', members: [{ mtime: at(2026, 10, 14, 18) }] };
  const c = { id: 'c', members: [{ mtime: at(2026, 10, 20) }] };
  const u = { id: 'u', members: [{}] };
  const g = groupByDate([a, u, b, c]);
  assert.deepEqual(g.map(x => x.day), ['2026-10-20', '2026-10-14', null]);
  assert.deepEqual(g[1].items.map(f => f.id), ['b', 'a']);
  assert.deepEqual(g[2].items.map(f => f.id), ['u']);
  assert.equal(g.flatMap(x => x.items).length, 4);          // never drops a row
  assert.deepEqual(groupByDate(null), []);
  assert.equal(dayKey(at(2026, 1, 5)), '2026-01-05');
});

test('groupByDate does not mutate its input', () => {
  const rows = [{ id: 'x', members: [{ mtime: at(2026, 10, 1) }] },
    { id: 'y', members: [{ mtime: at(2026, 10, 2) }] }];
  const copy = JSON.stringify(rows);
  groupByDate(rows);
  assert.equal(JSON.stringify(rows), copy);
});
