// Signal-conflict surfacing (2026-10-08d) — pure helpers in dupe-signals.js.
import { sigIsOverride, sigChipText } from '../../frontend/js/modules/dupe-signals.js';

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) { failures++; console.error(`✗ ${label}: got ${a}, want ${b}`); }
  else console.log(`✓ ${label}`);
}

const sug = { keep: 'a.png', reject: ['b.png', 'c.png'], label: 'keep a.png, reject rest' };

// overrides
eq(sigIsOverride(sug, 'b.png', 'kept'), true, 'keeping a suggested-reject is an override');
eq(sigIsOverride(sug, 'a.png', 'rejected'), true, 'rejecting the suggested keep is an override');
eq(sigIsOverride(sug, 'a.png', 'kept'), false, 'keeping the suggested keep is not an override');
eq(sigIsOverride(sug, 'b.png', 'rejected'), false, 'rejecting a suggested-reject is not an override');
eq(sigIsOverride(sug, 'b.png', 'deferred'), false, 'non keep/reject verdicts never override');
eq(sigIsOverride(null, 'b.png', 'kept'), false, 'no suggestion, no override');

// history chips
eq(sigChipText({ kept: 2, rejected: 0 }), 'kept ×2', 'kept-only chip');
eq(sigChipText({ kept: 0, rejected: 1 }), 'rejected ×1', 'rejected-only chip');
eq(sigChipText({ kept: 3, rejected: 1 }), 'kept ×3 · rejected ×1', 'mixed chip');
eq(sigChipText({ kept: 0, rejected: 0 }), null, 'no history, no chip');
eq(sigChipText(null), null, 'null member, no chip');

if (failures) { console.error(`${failures} failures`); process.exit(1); }
console.log('dupe-signals: all green');
