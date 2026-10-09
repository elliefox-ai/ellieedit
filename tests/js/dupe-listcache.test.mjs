// Dupe families-list client cache — pure cache-key decision (2026-10-08n).
// The listing payload is cached in memory keyed by the server's index:ledger
// mtime key; 'reuse' must happen only when nothing changed.
import { listCacheDecision } from '../../frontend/js/modules/dupe-view.js';

let fails = 0;
function check(desc, got, want) {
  if (got !== want) { console.error(`FAIL ${desc}: got ${got}, want ${want}`); fails++; }
  else console.log(`ok ${desc}`);
}

// warm return, nothing changed -> reuse (the instant tab return)
check('unchanged key reuses', listCacheDecision('100.5:200.5', '100.5:200.5', false), 'reuse');
// verdict ledger moved (a commit elsewhere) -> refetch
check('key change refetches', listCacheDecision('100.5:200.5', '100.5:201.0', false), 'refetch');
// index rescanned -> refetch
check('index change refetches', listCacheDecision('100.5:200.5', '101.0:200.5', false), 'refetch');
// this session committed -> always refetch, even with identical keys
check('dirty forces refetch', listCacheDecision('100.5:200.5', '100.5:200.5', true), 'refetch');
// unknown keys (first visit, status failure) -> fail open to refetch
check('no cached key refetches', listCacheDecision(null, '100.5:200.5', false), 'refetch');
check('no fresh key refetches', listCacheDecision('100.5:200.5', null, false), 'refetch');

if (fails) { console.error(`${fails} failure(s)`); process.exit(1); }
console.log('dupe-listcache: all green');
