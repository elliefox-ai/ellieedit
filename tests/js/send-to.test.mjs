// Cross-tab "send to" router — pure logic (work order v1.4).
// Run: node --test tests/js/send-to.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeSend, normalizeSend, nameFromUrl, receiptText, gate,
  SEND_TARGETS, FACECYCLE_MAX } from '../../frontend/js/send-to.js';
import { planFaceCycleHandoff } from '../../frontend/js/handoff.js';

const G = '/api/gallery/file?path=out%2Fa.png';

test('targets: the four tabs the matrix touches', () => {
  assert.deepEqual([...SEND_TARGETS].sort(), ['facecycle', 'foxden', 'puppet', 'update']);
});

test('refuses unknown targets and empty / junk payloads', () => {
  assert.match(routeSend({ target: 'nope', urls: [G] }).error, /Unknown send target/);
  assert.match(routeSend({ target: 'puppet', urls: [] }).error, /Nothing to send/);
  assert.match(routeSend({ target: 'puppet' }).error, /Nothing to send/);
  assert.match(routeSend(null).error, /Unknown send target/);
});

test('data rule: data/blob/javascript urls are never routed', () => {
  for (const bad of ['data:image/png;base64,AAAA', 'blob:http://x/1', 'javascript:alert(1)', '']) {
    assert.match(routeSend({ target: 'foxden', urls: [bad] }).error, /Nothing to send/);
  }
  // a junk entry beside a good one is dropped, the good one survives
  const r = routeSend({ target: 'foxden', urls: ['data:x', G], names: ['bad', 'a.png'] });
  assert.deepEqual(r.events[0].detail.urls, [G]);
  assert.deepEqual(r.events[0].detail.names, ['a.png']);
});

test('puppet: layer is the default, background is explicit, junk "as" falls back to layer', () => {
  let r = routeSend({ target: 'puppet', urls: [G], names: ['a.png'], source: 'Gallery' });
  assert.equal(r.events[0].type, 'ellieedit:puppet-receive');
  assert.equal(r.events[0].detail.as, 'layer');
  assert.equal(r.as, 'layer');
  r = routeSend({ target: 'puppet', as: 'background', urls: [G] });
  assert.equal(r.events[0].detail.as, 'background');
  r = routeSend({ target: 'puppet', as: 'weird', urls: [G] });
  assert.equal(r.events[0].detail.as, 'layer');
  assert.equal(r.events[0].detail.source, '');
});

test('foxden: forwards {urls,names,source} on its own receive event', () => {
  const r = routeSend({ target: 'foxden', urls: [G], names: ['a.png'], source: 'Puppet Theater' });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'ellieedit:foxden-receive');
  assert.deepEqual(r.events[0].detail, { urls: [G], names: ['a.png'], source: 'Puppet Theater' });
});

test('BACK-COMPAT facecycle: maps onto the existing facecycle-handoff payload shape', () => {
  const plan = planFaceCycleHandoff([{ path: 'out/a.png', name: 'a.png' }]);
  const r = routeSend({ target: 'facecycle', urls: plan.urls, names: plan.names, provenance: plan.provenance });
  assert.equal(r.events[0].type, 'ellieedit:facecycle-handoff');
  const d = r.events[0].detail;
  assert.deepEqual(d.urls, plan.urls);
  assert.deepEqual(d.names, plan.names);
  assert.deepEqual(d.provenance, plan.provenance);   // Replace-sources provenance survives
  assert.equal(d.source, 'Gallery');                 // no source given → Gallery (old receipt)
  assert.equal(routeSend({ target: 'facecycle', urls: [G], source: 'FoxDen' }).events[0].detail.source, 'FoxDen');
  assert.ok(!('provenance' in routeSend({ target: 'facecycle', urls: [G] }).events[0].detail));
});

test('facecycle cap mirrors handoff.js; over-cap is a refusal, boundary is fine', () => {
  const many = n => Array.from({ length: n }, (_, i) => `/api/foxden/view?filename=${i}.png`);
  assert.equal(FACECYCLE_MAX, 8);
  assert.match(routeSend({ target: 'facecycle', urls: many(9) }).error, /at most 8 images \(got 9\)/);
  assert.equal(routeSend({ target: 'facecycle', urls: many(8) }).events[0].detail.urls.length, 8);
});

test('BACK-COMPAT update: single {url,name,path} on open-in-update', () => {
  const r = routeSend({ target: 'update', urls: [G, '/api/x'], names: ['a.png', 'b.png'],
    provenance: { kind: 'gallery', paths: ['out/a.png'] } });
  assert.equal(r.events[0].type, 'ellieedit:open-in-update');
  assert.deepEqual(r.events[0].detail, { url: G, name: 'a.png', path: 'out/a.png' });
  assert.deepEqual(routeSend({ target: 'update', urls: [G], names: ['a.png'] }).events[0].detail,
    { url: G, name: 'a.png' });
});

test('names fall back to the url (filename= query, path= query, last segment)', () => {
  assert.equal(nameFromUrl('/api/foxden/view?type=output&filename=r%201.png&subfolder='), 'r 1.png');
  assert.equal(nameFromUrl('/api/gallery/file?path=out%2Fsub%2Fx.png'), 'x.png');
  assert.equal(nameFromUrl('/api/puppet/projects/p1/export.png'), 'export.png');
  assert.equal(normalizeSend({ target: 'foxden', urls: [G] }).names[0], 'a.png');
});

test('receipt text names the source and the mode', () => {
  assert.equal(receiptText(1, 'Gallery'), '→ 1 image from Gallery');
  assert.equal(receiptText(3, 'FoxDen'), '→ 3 images from FoxDen');
  assert.equal(receiptText(1, 'Gallery', 'background'), '→ background from Gallery');
  assert.equal(receiptText(1, ''), '→ 1 image from another tab');
});

test('gate: a busy reason rejects, none accepts', () => {
  assert.deepEqual(gate(''), { ok: true });
  assert.deepEqual(gate('mid-render'), { ok: false, reason: 'mid-render' });
});
