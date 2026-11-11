// Fix round 1 (2026-11-11) — workflow select must survive tab re-activation.
// Regression: the Chunk A fix read the previous value AFTER replacing
// innerHTML, but assigning innerHTML resets a <select> to its first option,
// so loadConfig always re-pinned klein on tab-activate. The rebuild now
// captures the value BEFORE innerHTML (foxden-state.rebuildSelectPreserving).
// Run: node tests/js/foxden-workflow.test.mjs
import assert from 'node:assert/strict';
import { rebuildSelectPreserving } from '../../frontend/js/modules/foxden-state.js';

// Fake select that behaves like a real one: setting innerHTML wipes the
// options and resets the value to the first option — the exact browser
// behavior that caused the snap-back.
function fakeSelect(options) {
  const s = { options, value: options[0]?.value ?? '' };
  Object.defineProperty(s, 'innerHTML', {
    set(html) {
      s.options = [...s.options];  // value reset happens in the browser; here
      s.value = s.options[0]?.value ?? '';  // innerHTML assignment = reset to first
    },
  });
  return s;
}

const WF_HTML = ['klein', 'klein-q8', 'krea2']
  .map(id => `<option value="${id}">${id}</option>`).join('');

// The exact reported sequence: user picks a non-klein workflow, switches
// tabs away, switches back (tab-activate -> loadConfig rebuilds the select).
{
  const wf = fakeSelect([{ value: 'klein' }, { value: 'klein-q8' }, { value: 'krea2' }]);
  wf.value = 'klein-q8';                       // user's pick, saved to /last
  assert.equal(wf.value, 'klein-q8');          // selection held while away
  rebuildSelectPreserving(wf, WF_HTML, 'klein');  // tab-activate: loadConfig
  assert.equal(wf.value, 'klein-q8', 'workflow must survive tab-activate');
}

// Invalid/disabled previous choice still falls back to the default.
{
  const wf = fakeSelect([{ value: 'klein' }, { value: 'krea2', disabled: true }]);
  wf.value = 'krea2';
  rebuildSelectPreserving(wf, `<option value="klein"></option><option value="krea2" disabled></option>`, 'klein');
  assert.equal(wf.value, 'klein', 'disabled prior pick falls back to default');
  assert.ok(wf.options[1].disabled);
}

// First paint (empty select, no prior pick) lands on the default.
{
  const wf = fakeSelect([]);
  rebuildSelectPreserving(wf, WF_HTML, 'klein-q8');
  assert.equal(wf.value, 'klein-q8', 'first paint uses the default workflow');
}

console.log('PASS foxden-workflow');
