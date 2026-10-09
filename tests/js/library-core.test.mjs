// Library core pure-logic tests: list params, cursor advance, count line.
import { buildListParams, advanceCursor, countLine } from '../../frontend/js/modules/library-core.js';

let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: got ${a}, want ${e}`); failed++; }
  else console.log(`ok ${label}`);
}

eq(buildListParams({ tag: '', cursor: 0 }), 'cursor=0', 'params: untagged first page');
eq(buildListParams({ tag: 'flatdeep', cursor: 40 }), 'cursor=40&tag=flatdeep', 'params: tagged page 2');
eq(buildListParams({ tag: 'toon', cursor: 0 }), 'cursor=0&tag=toon', 'params: tag filter');

eq(advanceCursor(40, 40), 40, 'cursor: next page');
eq(advanceCursor(null, 20), null, 'cursor: exhausted → null (hide Load more)');

eq(countLine(5, 120, ''), 'showing 5 of 120', 'count: unfiltered');
eq(countLine(5, 12, 'flatdeep'), 'showing 5 of 12 — tag: flatdeep', 'count: tag filter');

if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log('library-core: all green');
