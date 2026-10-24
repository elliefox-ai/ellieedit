// Shared keyboard-shortcut guards (suite-wide, v1.5 workorder).
//
// Single-key shortcuts (P for promote, letter keys in Dupe/FaceCycle, …)
// must NEVER fire while the operator is typing. Every document-level
// keydown handler routes through isTypingTarget first — one helper, not
// per-tab patches. Pure function of the event target, so it is unit
// testable without a DOM.
export function isTypingTarget(e) {
  const t = e && e.target;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Alias that reads as the handler-side question: "should this shortcut
// be ignored because the operator is typing?"
export function shouldIgnoreShortcut(e) {
  return isTypingTarget(e);
}
