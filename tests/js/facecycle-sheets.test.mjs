// Task 7 rev.2 — bottom-sheet controller contract (open/close/toggle, exclusivity,
// ARIA, and "touches nothing but class/aria state"). Run: node tests/js/facecycle-sheets.test.mjs
import assert from 'node:assert/strict';
import { createSheetController } from '../../frontend/js/modules/facecycle-sheets.js';

const el = () => {
  const cls = new Set(); const attrs = {}; const writes = [];
  return { cls, attrs, writes,
    classList: { toggle(n, on) { on ? cls.add(n) : cls.delete(n); writes.push(['class', n, !!on]); } },
    setAttribute(k, v) { attrs[k] = v; writes.push(['attr', k, v]); } };
};
const backdrop = el(), repaint = el(), detect = el(), oR = el(), oD = el();
const c = createSheetController({ backdrop, sheets: { repaint, detect }, openers: { repaint: oR, detect: oD } });

// starts closed
assert.equal(c.isOpen(), false); assert.equal(backdrop.cls.has('open'), false);
assert.equal(repaint.attrs['aria-hidden'], 'true');

// open repaint: sheet + backdrop + opener state; detect untouched-closed
assert.equal(c.open('repaint'), true);
assert.ok(repaint.cls.has('open') && backdrop.cls.has('open') && !detect.cls.has('open'));
assert.equal(oR.attrs['aria-expanded'], 'true'); assert.equal(oD.attrs['aria-expanded'], 'false');
assert.equal(repaint.attrs['aria-hidden'], 'false');

// exclusivity: opening detect closes repaint
c.open('detect');
assert.ok(detect.cls.has('open') && !repaint.cls.has('open'));
assert.equal(c.current(), 'detect');

// toggle: same name closes; unknown names are ignored
assert.equal(c.toggle('detect'), false); assert.equal(c.isOpen(), false);
assert.equal(c.open('nope'), false); assert.equal(c.isOpen(), false);
assert.equal(c.close(), false);                  // closing when closed is a no-op

// only class/aria writes ever happen (nothing canvas-ish can be reached)
const kinds = new Set([...backdrop.writes, ...repaint.writes, ...oR.writes].map(w => w[0]));
assert.deepEqual([...kinds].sort(), ['attr', 'class']);

console.log('facecycle-sheets: controller contract holds');
