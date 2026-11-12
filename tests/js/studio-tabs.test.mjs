// Stage 3: hash deep-link redirect — #foxden/#update land on Studio.
import { strict as assert } from 'node:assert';
import { HASH_ALIASES, resolveHash } from '../../frontend/js/modules/studio-tabs.js';

const available = ['gallery', 'facecycle', 'review', 'dupe', 'puppet', 'library', 'filters', 'studio'];

// retired tabs redirect to studio
assert.equal(resolveHash('#foxden', available), 'studio');
assert.equal(resolveHash('#update', available), 'studio');
assert.equal(resolveHash('foxden', available), 'studio');
// live tabs still resolve to themselves
assert.equal(resolveHash('#studio', available), 'studio');
assert.equal(resolveHash('#gallery', available), 'gallery');
// junk/absent hashes resolve to nothing (no activation)
assert.equal(resolveHash('', available), null);
assert.equal(resolveHash(null, available), null);
assert.equal(resolveHash('#nonsense', available), null);
// an unregistered target never activates
assert.equal(resolveHash('#foxden', []), null);
assert.equal(resolveHash('#studio', ['gallery']), null);
// alias map shape pinned
assert.deepEqual(HASH_ALIASES, { foxden: 'studio', update: 'studio' });

console.log('studio-tabs: all assertions passed');
