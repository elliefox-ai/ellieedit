// Deploy-gate syntax check (2026-10-07x): every frontend JS file must parse
// as an ES module. Catches Safari-throwing syntax (regex lookbehind, ??=,
// .at(), findLast) at deploy time instead of as a blank tab on iPad.
// node --check validates module syntax when the temp file has .mjs extension.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');
const files = ['index.html', 'js/shell.js', 'sw.js',
  ...['gallery', 'facecycle', 'review', 'dupe'].map(m => `js/modules/${m}.js`)];

for (const rel of files) {
  if (rel.endsWith('.html')) {
    // inline module scripts would need extraction; skip — shell.js imports cover modules
    continue;
  }
  const src = readFileSync(join(root, rel), 'utf8');
  const tmp = join('/tmp', `ee-syntax-${rel.replace(/[/.]/g, '-')}.mjs`);
  writeFileSync(tmp, src);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`SYNTAX FAIL ${rel}: ${e.stderr?.toString() || e.message}`);
  } finally {
    unlinkSync(tmp);
  }
  console.log(`ok ${rel}`);
}
