// Chunk D: Library sort param assembly — pure, node-tested.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildListParams, sortParam, LIBRARY_SORTS } from '../../frontend/js/modules/library-core.js';

test('sortParam passes non-default sorts through', () => {
  assert.equal(sortParam('old'), 'old');
  assert.equal(sortParam('name'), 'name');
  assert.equal(sortParam('name_desc'), 'name_desc');
  assert.equal(sortParam('tag'), 'tag');
});

test("sortParam omits 'new' and unknown values — request stays byte-identical to pre-Chunk-D", () => {
  assert.equal(sortParam('new'), '');
  assert.equal(sortParam('garbage'), '');
  assert.equal(sortParam(undefined), '');
});

test('buildListParams carries sort only when non-default', () => {
  const plain = buildListParams({ cursor: 40 });
  assert.equal(plain, 'cursor=40');
  assert.equal(buildListParams({ cursor: 0, sort: 'name' }), 'cursor=0&sort=name');
  assert.equal(buildListParams({ cursor: 80, tag: 'zengosoft', sort: 'old' }),
    'cursor=80&tag=zengosoft&sort=old');
  assert.equal(buildListParams({ cursor: 0, sort: 'new' }), 'cursor=0');
});

test('LIBRARY_SORTS matches the server contract', () => {
  assert.deepEqual(LIBRARY_SORTS, ['new', 'old', 'name', 'name_desc', 'tag']);
});

console.log('PASS');
