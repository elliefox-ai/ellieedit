// Studio reapply-last-mask decisions (studio-mask.js): what is kept, and
// when a re-apply is allowed — parity with Update's size-must-match rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLast, lastMaskNote, planReapply } from '../../frontend/js/modules/studio-mask.js';

test('captureLast keeps only a painted mask with real dimensions and data', () => {
  assert.deepEqual(captureLast(10, 640, 480, 'data:image/png;base64,AA'),
    { dataUrl: 'data:image/png;base64,AA', width: 640, height: 480 });
  assert.equal(captureLast(0, 640, 480, 'data:x'), null);        // blank mask
  assert.equal(captureLast(5, 0, 480, 'data:x'), null);          // no width
  assert.equal(captureLast(5, 640, 480, ''), null);              // no data
  assert.equal(captureLast(undefined, 640, 480, 'data:x'), null);
});

test('planReapply: nothing kept / no canvas / size mismatch / ok', () => {
  const last = { dataUrl: 'd', width: 1024, height: 576 };
  assert.equal(planReapply(null, { width: 1024, height: 576 }).reason, 'none');
  assert.equal(planReapply(last, null).reason, 'no-canvas');
  const bad = planReapply(last, { width: 576, height: 1024 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'size');
  assert.match(bad.msg, /1024×576/);
  assert.match(bad.msg, /576×1024/);
  const ok = planReapply(last, { width: 1024, height: 576 });
  assert.equal(ok.ok, true);
});

test('lastMaskNote names the size, or says there is none yet', () => {
  assert.match(lastMaskNote({ width: 800, height: 600 }), /800×600/);
  assert.match(lastMaskNote(null), /No previous mask/);
});
