// Straggler import-batch pure logic (2026-10-09g) — node-tested.
import { listQuery, stragglerChips, stragglerProgressText } from '../../frontend/js/modules/dupe-view.js';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failed = 0;
const check = (name, cond) => { if (!cond) { failed++; console.error(`FAIL ${name}`); } };

// ── listQuery: pill filter -> query params ──
check('straggler pill queries both states with the source marker',
  eq(listQuery('straggler'), { state: 'all', source: 'straggler' }));
check('plain filters keep their state and no source narrowing',
  eq(listQuery('unresolved'), { state: 'unresolved', source: '' }) &&
  eq(listQuery('resolved'), { state: 'resolved', source: '' }) &&
  eq(listQuery('all'), { state: 'all', source: '' }));

// ── stragglerChips: provenance badge + library reference chip ──
check('non-straggler rows render no chips',
  stragglerChips(null) === '' &&
  stragglerChips({ source: '' }) === '' &&
  stragglerChips({ source: 'dupelib' }) === '');
const withLib = stragglerChips({ source: 'straggler-scan', library_matches: 2 });
check('straggler row gets the badge', withLib.includes('straggler'));
check('library matches get the ✓ in Library reference chip',
  withLib.includes('✓ in Library ×2'));
check('zero library matches get no reference chip',
  !stragglerChips({ source: 'straggler-scan', library_matches: 0 })
    .includes('in Library'));
check('chip marks the library copy as reference, not member',
  withLib.includes('reference only'));

// ── stragglerProgressText: progress line from /scan-stragglers/status ──
check('idle scan renders no progress line',
  stragglerProgressText(null) === null &&
  stragglerProgressText({ running: false }) === null &&
  stragglerProgressText({ running: true, progress: null }) !== null);
check('running scan reports phase and counts',
  stragglerProgressText({ running: true,
    progress: { phase: 'hash:dupe', done: 12, total: 6300 } })
    .includes('hash:dupe 12/6300'));

if (failed) { console.error(`${failed} failures`); process.exit(1); }
console.log('dupe-straggler: all checks passed');
