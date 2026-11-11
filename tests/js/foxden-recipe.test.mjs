// FoxDen recipe helpers (Chunk A UX, 2026-11-11): provenance-over-entry
// mapping, display lines, clipboard helper.
import { recipeSettings, recipeLines, copyText } from
  '../../frontend/js/modules/foxden-recipe.js';
import assert from 'node:assert/strict';

const entry = { prompt: 'old prompt', workflow: 'klein-basic', seed: 1, denoise: 1,
  loras: [], width: 768, height: 432 };
const rec = { prompt: 'new prompt', workflow: 'klein-q8', seed: 42, steps: 4,
  width: 1024, height: 1024, loras: [{ name: 'detail', strength_model: 0.8 }],
  denoise: 0.55, input_image: 'in.png', path: 'x.png', ts: 'now' };

// provenance record wins where it knows a field
const s = recipeSettings(entry, rec);
assert.equal(s.prompt, 'new prompt');
assert.equal(s.workflow, 'klein-q8');
assert.equal(s.steps, 4);
assert.equal(s.denoise, 0.55);
assert.deepEqual(s.loras, [{ name: 'detail', strength_model: 0.8 }]);

// entry fills the gaps (record field null/absent)
const partial = recipeSettings(entry, { prompt: 'p', steps: null });
assert.equal(partial.prompt, 'p');
assert.equal(partial.workflow, 'klein-basic');
assert.ok(!('steps' in partial));   // neither source knows steps: absent, never invented

// entry alone (pre-provenance fallback) still works
assert.equal(recipeSettings(entry, null).seed, 1);
// nothing known anywhere -> null, nothing invented
assert.equal(recipeSettings(null, null), null);
assert.equal(recipeSettings({}, {}), null);
assert.equal(recipeSettings({}, { loras: [] }), null);      // empty loras is not knowledge
// junk inputs
assert.equal(recipeSettings('banana', 3), null);

// display lines: short facts only, no prompt line
const lines = recipeLines(s).join('\n');
assert.match(lines, /workflow: klein-q8/);
assert.match(lines, /seed: 42/);
assert.match(lines, /steps: 4/);
assert.match(lines, /size: 1024×1024/);
assert.match(lines, /loras: detail @0\.80/);
assert.match(lines, /denoise: 0\.55/);
assert.match(lines, /input: in\.png/);
assert.ok(!/prompt/.test(lines));
// unknown fields produce no line
assert.deepEqual(recipeLines({ workflow: 'w' }), ['workflow: w']);
assert.deepEqual(recipeLines(null), []);

// clipboard helper: writes through the injected navigator
const writes = [];
const nav = { clipboard: { writeText: async t => { writes.push(t); } } };
assert.equal(await copyText('hello', nav), true);
assert.deepEqual(writes, ['hello']);
// empty text is a no-op false
assert.equal(await copyText('', nav), false);
assert.equal(await copyText(null, nav), false);
// failing navigator falls back to execCommand path
let execRan = false;
const saved = globalThis.document;
globalThis.document = {
  createElement: () => ({ select() {}, style: {}, remove() {} }),
  body: { appendChild() {} },
  execCommand: () => { execRan = true; return true; },
};
assert.equal(await copyText('legacy', { clipboard: { writeText: async () => { throw new Error('denied'); } } }), true);
assert.equal(execRan, true);
globalThis.document = saved;

console.log('PASS foxden-recipe');
