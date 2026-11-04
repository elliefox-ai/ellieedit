// Details lines for Gallery + Library viewers (issue #6).
import { galleryDetails, libraryDetails }
  from '../../frontend/js/modules/viewer-details.js';

let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: got ${a}, want ${e}`); failed++; }
  else console.log(`ok ${label}`);
}
function has(actual, sub, label) {
  if (!actual.includes(sub)) { console.error(`FAIL ${label}: ${JSON.stringify(actual)} lacks ${JSON.stringify(sub)}`); failed++; }
  else console.log(`ok ${label}`);
}

// Gallery: folder + position, no duplication of the bar's name/dims/date.
eq(galleryDetails({ path: 'sub/inner/a.png', pending: false }, 2, 24),
  'sub/inner · 3 of 24', 'gallery: folder + position');
eq(galleryDetails({ path: 'a.png', pending: false }, 0, 1),
  '1 of 1', 'gallery: root file has no folder part');
eq(galleryDetails({ path: 'sub/a.png', pending: true }, 0, 5),
  'sub · 1 of 5 · marked for deletion', 'gallery: pending flag');
eq(galleryDetails({ path: 'a.png' }, 0, 0), '', 'gallery: no total, no parts');
eq(galleryDetails(null, 0, 3), '1 of 3', 'gallery: null item tolerates');

// Library: meta labels + path + date + position.
const lib = libraryDetails(
  { path: 'woman/a.png', mtime: 1762300000,
    meta: { subject: 'woman', shot: 'full', figures: '1', detail: 'red dress' } },
  4, 30);
has(lib, 'subject: woman', 'library: subject');
has(lib, 'shot: full', 'library: shot');
has(lib, 'figures: 1', 'library: figures');
has(lib, 'detail: red dress', 'library: detail');
has(lib, 'woman/a.png', 'library: path');
has(lib, '5 of 30', 'library: position');
eq(libraryDetails({ path: 'a.png', meta: {} }, 0, 2), 'a.png · 1 of 2',
  'library: empty meta contributes nothing');
eq(libraryDetails({ path: 'a.png' }, 0, 1), 'a.png · 1 of 1', 'library: missing meta tolerates');
eq(libraryDetails({ meta: { subject: 'car' } }, 0, 1), 'subject: car · 1 of 1',
  'library: meta without path');

if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log('PASS viewer-details: all green');
