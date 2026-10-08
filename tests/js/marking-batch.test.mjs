// Deferred marking batch planner (2026-10-08i) — pure helpers.
import { planMarkBatch, toggleMark } from '../../frontend/js/modules/marking-batch.js';

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) { failures++; console.error(`✗ ${label}: got ${a}, want ${b}`); }
  else console.log(`✓ ${label}`);
}

const manifest = new Set(['a.png', 'b.png']);

eq(planMarkBatch(manifest, new Map([['c.png', true]])), { toAdd: ['c.png'], toRemove: [] },
  'new mark goes to toAdd');
eq(planMarkBatch(manifest, new Map([['a.png', true]])), { toAdd: [], toRemove: [] },
  'marking an already-pending path is a no-op');
eq(planMarkBatch(manifest, new Map([['a.png', false]])), { toAdd: [], toRemove: ['a.png'] },
  'unmarking a pending path goes to toRemove');
eq(planMarkBatch(manifest, new Map([['x.png', false]])), { toAdd: [], toRemove: [] },
  'unmarking a non-pending path is a no-op');
eq(planMarkBatch(manifest, new Map([['c.png', true], ['a.png', true], ['b.png', false]])),
  { toAdd: ['c.png'], toRemove: ['b.png'] },
  'mixed batch splits correctly');
// Tap-toggle cycles: mark → unmark → mark must net to add.
const taps = new Map();
for (const on of [true, false, true]) taps.set('z.png', on);
eq(planMarkBatch(manifest, taps), { toAdd: ['z.png'], toRemove: [] },
  'tap toggle cycle nets to a single add');
eq(planMarkBatch(manifest, new Map()), { toAdd: [], toRemove: [] }, 'no touches, no writes');
eq([toggleMark(false), toggleMark(true)], [true, false], 'toggleMark flips');

if (failures) { console.error(`${failures} failures`); process.exit(1); }
console.log('marking-batch: all green');
