// Breadcrumb path helpers for Gallery folder navigation (2026-10-09e).
import { segmentsOf, crumbsFor, parentOf, joinDir, isBrowsableDir }
  from '../../frontend/js/modules/gallery-path.js';

let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: got ${a}, want ${e}`); failed++; }
  else console.log(`ok ${label}`);
}

eq(segmentsOf(''), [], 'segments: root is empty');
eq(segmentsOf('a/b/c'), ['a', 'b', 'c'], 'segments: nested split');
eq(segmentsOf('a//b'), ['a', 'b'], 'segments: double slash tolerated');

eq(crumbsFor(''), [{ name: '/', dir: '' }], 'crumbs: root only');
eq(crumbsFor('a/b'), [
  { name: '/', dir: '' }, { name: 'a', dir: 'a' }, { name: 'b', dir: 'a/b' },
], 'crumbs: cumulative dirs');

eq(parentOf(''), '', 'parent: root stays root');
eq(parentOf('a'), '', 'parent: first level → root');
eq(parentOf('a/b'), 'a', 'parent: nested');

eq(joinDir('', 'sub'), 'sub', 'join: from root');
eq(joinDir('a', 'b'), 'a/b', 'join: nested');

eq(isBrowsableDir('ellieedit_tmp'), false, 'browsable: tmp hidden');
eq(isBrowsableDir('.thumbs'), false, 'browsable: dotdirs hidden');
eq(isBrowsableDir('zengostyle'), true, 'browsable: normal folder');
eq(isBrowsableDir(''), false, 'browsable: empty is not a folder');

if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log('PASS gallery-path: all green');
