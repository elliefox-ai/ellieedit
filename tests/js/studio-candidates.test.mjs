// Stage 2 candidate strip (decision #2): pure lifecycle — no DOM. The
// cleanup rule is the contract: the NEXT generation run replaces the strip
// entirely; unretrieved candidates die there unless saved explicitly.

import { createCandidates, pathFromViewUrl } from '../../frontend/js/modules/studio-candidates.js';

let fails = 0;
const eq = (a, b, msg) => {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.error(`FAIL: ${msg}\n  got: ${ja}\n  want: ${jb}`); }
  else console.log(`ok: ${msg}`);
};

// startRun replaces the strip — the cleanup rule
{
  const c = createCandidates();
  c.startRun([{ path: 'a.png', url: '/api/comfy/view?filename=a.png' }]);
  c.startRun([{ path: 'b.png', url: '/api/comfy/view?filename=b.png' }]);
  eq(c.get(), [{ path: 'b.png', url: '/api/comfy/view?filename=b.png' }],
    'next run replaces the strip entirely');
}

// startRun drops non-shape entries, never invents
{
  const c = createCandidates();
  c.startRun([null, { path: '', url: 'x' }, { path: 'ok.png', url: 'y' }, 'junk', undefined]);
  eq(c.get(), [{ path: 'ok.png', url: 'y' }], 'malformed candidates dropped');
  c.startRun(undefined);
  eq(c.get(), [], 'non-array argument clears, never throws');
}

// read-only accessors
{
  const c = createCandidates();
  c.startRun([{ path: 's/f.png', url: 'u' }, { path: 't/g.png', url: 'v' }]);
  eq(c.count(), 2, 'count');
  eq(c.has('t/g.png'), true, 'has hit');
  eq(c.has('nope.png'), false, 'has miss');
  eq(c.find('s/f.png'), { path: 's/f.png', url: 'u' }, 'find hit');
  eq(c.find('nope.png'), null, 'find miss');
  const snapshot = c.get();
  snapshot.push({ path: 'mutated.png', url: 'm' });
  eq(c.count(), 2, 'get returns a copy — external mutation cannot leak in');
}

// promotion never mutates the strip (implied by no remove API, but pin it)
{
  const c = createCandidates();
  c.startRun([{ path: 'p.png', url: 'u' }]);
  c.clear();
  eq(c.get(), [], 'clear empties');
  eq(c.count(), 0, 'count after clear');
}

// pathFromViewUrl: view URL -> provenance-style output path
{
  eq(pathFromViewUrl('/api/comfy/view?filename=a.png&subfolder=run_01&type=output'),
    'run_01/a.png', 'subfolder + filename join');
  eq(pathFromViewUrl('/api/comfy/view?filename=a.png'), 'a.png', 'no subfolder');
  eq(pathFromViewUrl('/api/comfy/view?subfolder=x&type=output'), null,
    'missing filename -> null (no identity, not shown)');
  eq(pathFromViewUrl('not a url %%'), null, 'garbage -> null');
  eq(pathFromViewUrl(''), null, 'empty -> null');
  eq(pathFromViewUrl('https://other.host/api/comfy/view?filename=abs.png&subfolder=/lead/'),
    'lead/abs.png', 'absolute URL parses; subfolder slashes trimmed');
}

if (fails) {
  console.error(`${fails} failure(s)`);
  process.exit(1);
}
console.log('ALL PASS');
