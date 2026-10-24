// "Send to ▸" submenu — one consistent control for every surface that can
// hand an image to another tab (work order v1.4). The pure routing lives in
// ../send-to.js; this only renders a button + popup and dispatches
// 'ellieedit:send-to'. Nothing here knows about any target's internals.
//
//   const m = createSendMenu({
//     entries: [{ label: 'Puppet Theater — new layer', target: 'puppet', as: 'layer' }, …],
//     getPayload: () => ({ urls: [..], names: [..], source: 'Gallery' }),
//     className: 'ee-btn',          // button class (matches the host bar)
//   });
//   bar.appendChild(m.el);

export function createSendMenu({ entries, getPayload, className = 'ee-btn', label = 'Send to ▸', up = false }) {
  const wrap = document.createElement('span');
  wrap.className = 'ee-sendmenu';
  wrap.style.cssText = 'position:relative;display:inline-block';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Send this image to another tab';

  const pop = document.createElement('div');
  pop.setAttribute('role', 'menu');
  pop.hidden = true;
  pop.style.cssText = 'position:absolute;z-index:300;min-width:210px;padding:4px;' +
    'background:#2d2d44;border:1px solid #5a5a7a;border-radius:8px;' +
    'box-shadow:0 6px 18px rgba(0,0,0,.5);' + (up ? 'bottom:100%;margin-bottom:4px;' : 'top:100%;margin-top:4px;') +
    'right:0;text-align:left';

  function close() {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onOutside(e) { if (!wrap.contains(e.target)) close(); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  function open() {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  for (const ent of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.textContent = ent.label;
    item.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:0;' +
      'color:#e8e8f4;padding:8px 10px;border-radius:6px;font-size:13px;cursor:pointer;white-space:nowrap';
    item.addEventListener('pointerenter', () => { item.style.background = '#4a4a6c'; });
    item.addEventListener('pointerleave', () => { item.style.background = 'none'; });
    item.addEventListener('click', async e => {
      e.stopPropagation();
      close();
      let payload;
      try { payload = await getPayload(); } catch (err) { payload = { error: err.message }; }
      if (!payload || payload.error || !payload.urls || !payload.urls.length) {
        window.dispatchEvent(new CustomEvent('ellieedit:send-to',
          { detail: { target: ent.target, urls: [], names: [] } }));   // shell toasts the refusal
        return;
      }
      window.dispatchEvent(new CustomEvent('ellieedit:send-to', {
        detail: { target: ent.target, as: ent.as, urls: payload.urls, names: payload.names,
          source: payload.source, provenance: payload.provenance },
      }));
    });
    pop.appendChild(item);
  }

  btn.addEventListener('click', e => { e.stopPropagation(); pop.hidden ? open() : close(); });
  wrap.append(btn, pop);
  return { el: wrap, close };
}
