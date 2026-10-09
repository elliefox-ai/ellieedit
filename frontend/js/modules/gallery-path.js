// Pure breadcrumb-path helpers for Gallery folder navigation (2026-10-09e).
// Kept framework-free so tests/js can exercise them in plain node.
// `dir` is a gallery-root-relative POSIX path ('' = root, 'a', 'a/b', …).

export function segmentsOf(dir) {
  return (dir || '').split('/').filter(Boolean);
}

// crumbsFor('a/b') -> [{name:'/', dir:''}, {name:'a', dir:'a'}, {name:'b', dir:'a/b'}]
export function crumbsFor(dir) {
  const crumbs = [{ name: '/', dir: '' }];
  let acc = '';
  for (const seg of segmentsOf(dir)) {
    acc = acc ? `${acc}/${seg}` : seg;
    crumbs.push({ name: seg, dir: acc });
  }
  return crumbs;
}

export function parentOf(dir) {
  const segs = segmentsOf(dir);
  segs.pop();
  return segs.join('/');
}

export function joinDir(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

// True when the folder should be visible in listings. ellieedit_tmp/ holds
// repaint intermediates — never gallery content.
export function isBrowsableDir(name) {
  return !!name && !name.startsWith('.') && name !== 'ellieedit_tmp';
}
