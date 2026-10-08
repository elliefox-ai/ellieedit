// Gallery → FaceCycle handoff planner — pure logic, no DOM.
// Run: node tests/js/facecycle-handoff.test.mjs

import assert from 'node:assert/strict';
import { planFaceCycleHandoff, FACECYCLE_MAX, facecycleFileUrl } from '../../frontend/js/handoff.js';

// url building is jailed like the rest of gallery file access
assert.equal(facecycleFileUrl('out/a b.png'), '/api/gallery/file?path=out%2Fa%20b.png');

// refusal: empty selection
let r = planFaceCycleHandoff([]);
assert.equal(r.error, 'Select at least one image first.');
assert.ok(!r.urls);

// refusal: junk entries filtered before counting
r = planFaceCycleHandoff([null, {}, { path: '' }]);
assert.equal(r.error, 'Select at least one image first.');
assert.equal(r.count, 0);

// acceptance: 1..MAX map paths → jailed urls, name falls back to basename
r = planFaceCycleHandoff([{ path: 'out/x.png', name: 'x.png' }, { path: 'out/y.png' }]);
assert.deepEqual(r.urls, ['/api/gallery/file?path=out%2Fx.png', '/api/gallery/file?path=out%2Fy.png']);
assert.deepEqual(r.names, ['x.png', 'y.png']);

// refusal: over cap
const many = Array.from({ length: FACECYCLE_MAX + 1 }, (_, i) => ({ path: `out/${i}.png` }));
r = planFaceCycleHandoff(many);
assert.equal(r.error, `FaceCycle accepts at most ${FACECYCLE_MAX} images (got ${FACECYCLE_MAX + 1}).`);
assert.equal(r.count, FACECYCLE_MAX + 1);
assert.ok(!r.urls);

// boundary: exactly MAX is fine
r = planFaceCycleHandoff(many.slice(0, FACECYCLE_MAX));
assert.equal(r.urls.length, FACECYCLE_MAX);

console.log('facecycle-handoff: all assertions passed');
