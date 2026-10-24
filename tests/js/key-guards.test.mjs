// Shared shortcut guards (v1.5 workorder) — pure, DOM-free checks.
import { isTypingTarget, shouldIgnoreShortcut } from '../../frontend/js/key-guards.js';

let failed = 0;
function eq(actual, expected, label) {
  if (actual !== expected) { console.error(`FAIL ${label}: got ${actual}, want ${expected}`); failed++; }
  else console.log(`ok ${label}`);
}

const ev = (target) => ({ target });

eq(isTypingTarget(ev({ tagName: 'INPUT' })), true, 'typing: input');
eq(isTypingTarget(ev({ tagName: 'TEXTAREA' })), true, 'typing: textarea');
eq(isTypingTarget(ev({ tagName: 'SELECT' })), true, 'typing: select');
eq(isTypingTarget(ev({ tagName: 'DIV', isContentEditable: true })), true, 'typing: contenteditable');
eq(isTypingTarget(ev({ tagName: 'BODY' })), false, 'not typing: body');
eq(isTypingTarget(ev({ tagName: 'BUTTON' })), false, 'not typing: button');
eq(isTypingTarget(ev({ tagName: 'DIV', isContentEditable: false })), false, 'not typing: div');
eq(isTypingTarget(ev(null)), false, 'not typing: null target');
eq(isTypingTarget({}), false, 'not typing: no target');
eq(shouldIgnoreShortcut(ev({ tagName: 'INPUT' })), true, 'alias: input ignored');
eq(shouldIgnoreShortcut(ev({ tagName: 'BODY' })), false, 'alias: body kept');

if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log('PASS key-guards: all green');
