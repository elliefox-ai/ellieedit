// Shared tag-entry UI: a modal dialog (askTag) and an inline chip row for an
// existing input (attachTagChips). Both show recent + most-used tags from
// tag-memory.js. Replaces the per-tab prompt()s / the Gallery-only dialog.
//
// mode 'single' — one tag/project (promote): chip click REPLACES the value;
//                 result is trimmed + lowercased, '' if left blank.
// mode 'list'   — comma-separated tags (retag): chip click TOGGLES that tag
//                 in the list; result is an array.
// Both resolve/return null on cancel.

import { loadTagMemory, tagChips, splitTags, toggleTagInList } from './tag-memory.js';

export { loadTagMemory, recordTag, recordTags, tagChips } from './tag-memory.js';

function chipRow(input, mode, mem) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  const buttons = [];
  const sync = () => {
    const have = new Set(mode === 'list' ? splitTags(input.value) : [input.value.trim()]);
    for (const b of buttons) b.style.outline = have.has(b.dataset.tag) ? '1px solid #8a7acf' : '';
  };
  for (const t of tagChips(mem)) {
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'ee-btn'; c.textContent = t; c.dataset.tag = t;
    c.style.cssText = 'font-size:12px;padding:4px 10px;';
    c.addEventListener('click', () => {
      input.value = mode === 'list' ? toggleTagInList(input.value, t) : t;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
    buttons.push(c); row.appendChild(c);
  }
  input.addEventListener('input', sync);
  sync();
  return row;
}

// Inline: add the chip row right after an input that already lives in the DOM.
// Re-reads memory each call, so call it again (or use refresh()) after a save
// to pick up the newly recorded tag. Returns { el, refresh }.
export function attachTagChips(input, { mode = 'single' } = {}) {
  let row = null;
  const refresh = () => {
    const next = chipRow(input, mode, loadTagMemory());
    if (row) row.replaceWith(next); else (input.closest('label') || input).after(next);
    row = next;
  };
  refresh();
  return { get el() { return row; }, refresh };
}

// Modal: resolves to a string (single) / string[] (list), or null on cancel.
export function askTag({ title = 'Tag:', def = '', okLabel = 'OK', mode = 'single', mem } = {}) {
  mem = mem || loadTagMemory();
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(8,8,16,0.8);z-index:300;' +
      'display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1d1d33;border:1px solid #4a4a6c;border-radius:10px;' +
      'padding:18px;max-width:420px;width:90vw;display:flex;flex-direction:column;gap:10px;';
    const lab = document.createElement('div');
    lab.textContent = title;
    lab.style.cssText = 'font-size:13px;color:#b0b0d0;';
    const input = document.createElement('input');
    input.value = Array.isArray(def) ? def.join(', ') : (def || '');
    if (mode === 'list') input.placeholder = 'tag, tag, …';
    input.style.cssText = 'background:#22223a;color:#e8e8f4;border:1px solid #4a4a6c;' +
      'border-radius:6px;padding:8px;font-size:14px;width:100%;box-sizing:border-box;';
    const chips = chipRow(input, mode, mem);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const ok = document.createElement('button');
    ok.className = 'ee-btn primary'; ok.textContent = okLabel;
    const cancel = document.createElement('button');
    cancel.className = 'ee-btn'; cancel.textContent = 'Cancel';
    row.append(ok, cancel);
    box.append(lab, input, chips, row);
    ov.appendChild(box);
    document.body.appendChild(ov);
    const value = () => (mode === 'list' ? splitTags(input.value) : input.value.trim().toLowerCase());
    const done = v => { ov.remove(); resolve(v); };
    ok.addEventListener('click', () => done(value()));
    cancel.addEventListener('click', () => done(null));
    ov.addEventListener('click', e => { if (e.target === ov) done(null); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') done(value());
      else if (e.key === 'Escape') done(null);
    });
    input.focus(); input.select();
  });
}
