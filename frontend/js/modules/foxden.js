// FoxDen — simple ComfyUI generation shell (work order 2026-10-13).
// One page: workflow, prompt, LoRA toggles + strengths, seed, aspect presets,
// Generate -> poll status -> inline outputs (tap to enlarge) + recent strip.
// Backend: /api/foxden/*. No frameworks, no build step.
import { registerModule, registerReceiver } from '../shell.js';
import { createSendMenu } from '../components/send-menu.js';
import { nameFromUrl, receiptText } from '../send-to.js';
import { readCollapsed, writeCollapsed, recentLabel } from './foxden-recent.js';
import { createPins } from './foxden-loras.js';
import { normalizeState, presetState, debounce, cleanName, nextSeed } from './foxden-state.js';

const API = '/api/foxden';
const PRESETS = { landscape: [1024, 576], portrait: [576, 1024] };
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

registerModule({
  name: 'foxden',
  label: 'FoxDen',
  icon: '🦊',
  order: 20,
  mount(panel, jobbar) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('./foxden.css', import.meta.url).href;
    document.head.appendChild(css);

    panel.innerHTML = `
    <div class="fx-wrap">
      <div class="fx-body">
        <div class="fx-panel">
          <div class="fx-status" data-id="conn">connecting…</div>
          <div class="fx-topbar">
            <button class="ee-btn primary fx-go" data-id="go">⚡ Generate</button>
            <div class="fx-status" data-id="status"></div>
          </div>
          <div><label>Prompt</label><textarea data-id="prompt" placeholder="describe the image…"></textarea></div>
          <div class="fx-row fx-seedrow">
            <div style="flex:1;min-width:140px"><label>Seed</label><input type="number" data-id="seed" placeholder="random"></div>
            <label class="fx-lock" title="Lock seed across generates"><input type="checkbox" data-id="preset-lock"> 🔒</label>
            <button class="ee-btn fx-btn" data-id="dice">🎲 Random</button>
          </div>
          <div class="fx-denoise"><label>Denoise <span data-id="dval">1.00</span></label>
            <input type="range" data-id="denoise" min="0.1" max="1" step="0.05" value="1" aria-label="Denoise">
          </div>
          <div class="fx-row" data-id="aspects">
            <button class="ee-btn fx-btn on" data-a="landscape">▭ 1024×576</button>
            <button class="ee-btn fx-btn" data-a="portrait">▯ 576×1024</button>
          </div>
          <div class="fx-inputs">
            <label>Input image (img2img) <span data-id="icount"></span> <span data-id="ireceipt" class="fx-receipt" style="color:#8ad08a"></span></label>
            <div class="fx-chips" data-id="ichips"></div>
            <div class="fx-row">
              <button class="ee-btn fx-btn" data-id="iup">⬆ Upload</button>
              <button class="ee-btn fx-btn" data-id="iclear" title="Back to text-to-image">✕ None</button>
              <input type="file" accept="image/*" data-id="ifile" style="display:none">
            </div>
          </div>
          <div class="fx-row fx-presets">
            <select data-id="preset-pick" style="flex:1;min-width:140px"><option value="">Presets…</option></select>
            <button class="ee-btn fx-btn" data-id="preset-save" title="Save current form as a preset">💾</button>
            <button class="ee-btn fx-btn" data-id="preset-del" title="Delete the selected preset">🗑</button>
          </div>
          <div><label>Workflow</label><select data-id="wf"></select></div>
          <div><label>LoRAs <span data-id="lcount"></span></label>
            <div class="fx-pins" data-id="pins"></div>
            <div class="fx-susp" data-id="susp"></div>
            <input type="text" data-id="lfilter" placeholder="filter…" style="margin-bottom:6px">
            <div class="fx-loras" data-id="loras"></div></div>
        </div>
        <div class="fx-out" data-id="out"></div>
      </div>
      <div class="fx-recentwrap" data-id="recentwrap">
        <div class="fx-rbar">
          <button class="ee-btn fx-btn" data-id="refresh" aria-label="Refresh recent renders" title="Refresh">⟳</button>
          <button class="ee-btn fx-btn" data-id="rtoggle" aria-expanded="true" aria-label="Collapse recent renders">▾</button>
          <span class="lbl" data-id="rcount">recent</span>
        </div>
        <div class="fx-recent" data-id="recent"></div>
      </div>
      <div class="fx-big" data-id="big">
        <div class="bar"><span class="meta" data-id="bigmeta"></span>
          <button class="ee-btn fx-btn" data-id="reuse">↺ Reuse settings</button>
          <button class="ee-btn fx-btn" data-id="bigclose">✕</button></div>
        <div class="stage"><img data-id="bigimg" alt=""></div>
      </div>
    </div>`;
    const $ = id => panel.querySelector(`[data-id="${id}"]`);
    const el = Object.fromEntries(['conn', 'wf', 'prompt', 'aspects', 'seed', 'dice',
      'lcount', 'lfilter', 'loras', 'pins', 'susp',
      'preset-pick', 'preset-lock', 'preset-save', 'preset-del',
      'icount', 'ireceipt', 'ichips', 'iup', 'iclear', 'ifile', 'denoise', 'dval', 'go', 'status', 'out', 'recent', 'recentwrap',
      'refresh', 'rtoggle', 'rcount', 'big', 'bigmeta', 'reuse', 'bigclose', 'bigimg'].map(k => [k, $(k)]));

    let aspect = 'landscape';
    let allLoras = [];
    const pins = createPins();      // active pins + suspended tray (foxden-loras.js)
    let suspOpen = false;
    let bigEntry = null;
    let busy = false;

    const say = (msg, cls = '') => { el.status.textContent = msg; el.status.className = 'fx-status ' + cls; };
    async function api(path, opts) {
      const r = await fetch(API + path, opts);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
      return j;
    }

    // ── config ──
    async function loadConfig() {
      try {
        const c = await api('/config');
        el.conn.textContent = c.comfy_reachable ? '● ComfyUI connected' : '○ ComfyUI unreachable';
        el.conn.className = 'fx-status ' + (c.comfy_reachable ? 'ok' : 'err');
        el.wf.innerHTML = c.workflows.map(w =>
          `<option value="${w.id}" ${w.available ? '' : 'disabled'}>${esc(w.id)}${w.available ? '' : ' (file missing)'}</option>`).join('');
        el.wf.value = c.default_workflow;
        allLoras = c.loras;
        renderLoras();
      } catch (e) { el.conn.textContent = 'config failed: ' + e.message; el.conn.className = 'fx-status err'; }
    }

    function chip(n, strength, parked) {
      const c = document.createElement('div');
      c.className = 'fx-chip' + (parked ? ' parked' : '');
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.title = n; nm.textContent = n;
      const val = document.createElement('span');
      val.className = 'fx-status val'; val.textContent = Number(strength).toFixed(2);
      const rg = document.createElement('input');
      rg.type = 'range'; rg.min = '-1'; rg.max = '2'; rg.step = '0.05'; rg.value = strength;
      rg.addEventListener('input', () => {
        const v = parseFloat(rg.value); pins.setStrength(n, v); val.textContent = v.toFixed(2);
      });
      const mk = (txt, title, fn) => {
        const b = document.createElement('button');
        b.className = 'ee-btn fx-btn'; b.textContent = txt; b.title = title;
        b.addEventListener('click', fn); return b;
      };
      const top = document.createElement('div'); top.className = 'fx-row top';
      top.append(nm, val,
        parked ? mk('▶', 'restore', () => { pins.restore(n); renderLoras(); })
               : mk('⏸', 'suspend (keeps strength)', () => { pins.suspend(n); renderLoras(); }),
        mk('✕', 'remove', () => { pins.remove(n); renderLoras(); }));
      c.appendChild(top);
      if (!parked) c.appendChild(rg);
      return c;
    }

    function renderLoras() {
      el.lcount.textContent = pins.count() ? `(${pins.count()} on)` : '';
      // pinned chips: JUST above the list; the filter never touches these
      el.pins.innerHTML = '';
      for (const [n, st] of pins.active) el.pins.appendChild(chip(n, st, false));
      // collapsed "suspended (N)" tray
      el.susp.innerHTML = '';
      if (pins.suspended.size) {
        const hd = document.createElement('button');
        hd.className = 'ee-btn fx-btn'; hd.setAttribute('data-id', 'susp-toggle');
        hd.textContent = `${suspOpen ? '▾' : '▸'} suspended (${pins.suspended.size})`;
        hd.addEventListener('click', () => { suspOpen = !suspOpen; renderLoras(); });
        el.susp.appendChild(hd);
        if (suspOpen) for (const [n, st] of pins.suspended) el.susp.appendChild(chip(n, st, true));
      }
      // pick list: filtered; tap to pin at 1.0
      el.loras.innerHTML = '';
      const shown = pins.pickList(allLoras, el.lfilter.value);
      if (!shown.length) el.loras.innerHTML = '<span class="fx-status">no LoRAs found</span>';
      for (const n of shown) {
        const card = document.createElement('div');
        card.className = 'fx-lora';
        const top = document.createElement('div');
        top.className = 'fx-row';
        const nm = document.createElement('span');
        nm.className = 'nm'; nm.textContent = n;
        const tg = document.createElement('button');
        tg.className = 'ee-btn fx-btn'; tg.textContent = '＋ Pin';
        tg.addEventListener('click', () => { pins.pin(n, 1.0); renderLoras(); });
        top.append(nm, tg);
        card.appendChild(top);
        el.loras.appendChild(card);
      }
    }
    el.lfilter.addEventListener('input', renderLoras);

    // ── aspect / seed ──
    el.aspects.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      aspect = b.dataset.a;
      el.aspects.querySelectorAll('[data-a]').forEach(x => x.classList.toggle('on', x === b));
    });
    el.dice.addEventListener('click', () => { el.seed.value = Math.floor(Math.random() * 2 ** 31); });

    // ── denoise (ALWAYS visible, ALWAYS sent — never hidden or grayed) ──
    function setDenoise(v) {
      const d = Math.min(1, Math.max(0.1, Number.isFinite(Number(v)) ? Number(v) : 1));
      el.denoise.value = String(d); el.dval.textContent = d.toFixed(2);
    }
    el.denoise.addEventListener('input', () => setDenoise(el.denoise.value));

    // ── input image (img2img): tap a chip to select, tap again to deselect.
    // Last-selected wins (v1). Natural size is read so the scheduler gets the
    // image's own resolution; aspect buttons are grayed while one is set. ──
    let inputImage = null, inputDims = null, inputItems = [];
    const viewUrl = n => {
      const i = n.replace(/\\/g, '/').lastIndexOf('/');
      const sub = i >= 0 ? n.slice(0, i) : '', fn = i >= 0 ? n.slice(i + 1) : n;
      return `${API}/view?type=input&filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(sub)}`;
    };
    function paintInput() {
      el.aspects.classList.toggle('dim', !!inputImage);
      el.aspects.querySelectorAll('[data-a]').forEach(b => { b.disabled = !!inputImage; });
      el.icount.textContent = inputImage ? '(selected)' : '';
      el.ichips.innerHTML = '';
      const names = inputItems.includes(inputImage) || !inputImage ? inputItems : [inputImage, ...inputItems];
      for (const n of names) {
        const b = document.createElement('button');
        b.className = 'fx-chipimg' + (n === inputImage ? ' on' : '');
        b.title = n; b.setAttribute('aria-pressed', n === inputImage ? 'true' : 'false');
        const im = document.createElement('img');
        im.loading = 'lazy'; im.alt = n; im.src = viewUrl(n);
        b.appendChild(im);
        b.addEventListener('click', () => { setInput(n === inputImage ? null : n); scheduleSave(); });
        el.ichips.appendChild(b);
      }
    }
    function setInput(name) {
      el.ireceipt.textContent = '';            // any manual change retires the receipt
      inputImage = name || null; inputDims = null;
      if (inputImage) {
        const probe = new Image();
        probe.onload = () => { if (inputImage === name) inputDims = [probe.naturalWidth, probe.naturalHeight]; };
        probe.src = viewUrl(inputImage);
      }
      paintInput();
    }
    async function loadInputs() {
      try { inputItems = (await api('/inputs')).items || []; } catch (e) { inputItems = []; }
      paintInput();
    }
    el.iclear.addEventListener('click', () => { setInput(null); scheduleSave(); });
    el.iup.addEventListener('click', () => el.ifile.click());
    el.ifile.addEventListener('change', async () => {
      const file = el.ifile.files[0]; if (!file) return;
      const fd = new FormData(); fd.append('image', file);
      try {
        say('uploading…');
        const j = await api('/upload', { method: 'POST', body: fd });
        const name = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
        if (!inputItems.includes(name)) inputItems.unshift(name);
        setInput(name); scheduleSave(); say(`Uploaded ${name}.`, 'ok');
      } catch (e) { say(e.message, 'err'); }
      el.ifile.value = '';
    });

    // ── presets + auto-remember (Task 5 add.2) ──
    // collectState/applyState are the single place the form maps to a state
    // object. (steps/denoise/input_image are normalized and persisted when the
    // form emits them — img2img will add them here.)
    function collectState() {
      return normalizeState({
        workflow: el.wf.value, prompt: el.prompt.value, aspect,
        seed: el.seed.value === '' ? null : parseInt(el.seed.value),
        loras: pins.payload(), suspended_loras: pins.suspendedPayload(),
        denoise: parseFloat(el.denoise.value), input_image: inputImage,
      });
    }
    function applyState(raw) {
      const st = normalizeState(raw);
      if (st.workflow && [...el.wf.options].some(o => o.value === st.workflow && !o.disabled)) el.wf.value = st.workflow;
      el.prompt.value = st.prompt;
      aspect = st.aspect;
      el.aspects.querySelectorAll('[data-a]').forEach(x => x.classList.toggle('on', x.dataset.a === aspect));
      el.seed.value = st.seed === null ? '' : st.seed;
      pins.restoreFrom(st.loras, st.suspended_loras);
      renderLoras();
      setDenoise(st.denoise);
      setInput(st.input_image || null);
    }
    let savedPresets = [];
    function renderPresetPick(selectName = '') {
      el['preset-pick'].innerHTML = '<option value="">Presets…</option>' +
        savedPresets.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
      el['preset-pick'].value = savedPresets.some(p => p.name === selectName) ? selectName : '';
    }
    async function loadPresets() {
      try {
        const d = await api('/presets');
        savedPresets = d.presets || [];
        renderPresetPick();
        return d.last;
      } catch (e) { return null; }
    }
    el['preset-pick'].addEventListener('change', () => {
      const p = savedPresets.find(x => x.name === el['preset-pick'].value);
      if (p) { applyState(p.state); scheduleSave(); say(`Applied preset “${p.name}”.`, 'ok'); }
    });
    el['preset-save'].addEventListener('click', async () => {
      const name = cleanName(prompt('Preset name:', el['preset-pick'].value || ''));
      if (!name) return;
      if (savedPresets.some(p => p.name === name) && !confirm(`Overwrite preset “${name}”?`)) return;
      try {
        await api('/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, state: presetState(collectState(), el['preset-lock'].checked) }) });
        await loadPresets(); renderPresetPick(name);
        say(`Saved preset “${name}”${el['preset-lock'].checked ? ' (seed locked)' : ''}.`, 'ok');
      } catch (e) { say(e.message, 'err'); }
    });
    el['preset-del'].addEventListener('click', async () => {
      const name = el['preset-pick'].value;
      if (!name) { say('Pick a preset to delete.', 'err'); return; }
      if (!confirm(`Delete preset “${name}”? This cannot be undone.`)) return;
      try {
        await api('/presets/' + encodeURIComponent(name), { method: 'DELETE' });
        await loadPresets(); say(`Deleted preset “${name}”.`, 'ok');
      } catch (e) { say(e.message, 'err'); }
    });
    // Auto-remember: debounced PUT /last on any form edit; flushed when the
    // tab hides (tablet sleep). Held back until the saved state has been
    // applied so a blank first paint can never overwrite it.
    let restored = false;
    const saveLast = () => {
      if (!restored) return;
      fetch(API + '/last', { method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: collectState() }) }).catch(() => {});
    };
    const scheduleSave = debounce(saveLast, 800);
    for (const ev of ['input', 'change', 'click']) {
      panel.addEventListener(ev, e => { if (!e.target.closest('.fx-presets, [data-id="lfilter"]')) scheduleSave(); });
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden && scheduleSave.pending()) scheduleSave.flush(); });

    // ── generate + poll ──
    async function generate() {
      if (busy) return;
      const prompt = el.prompt.value.trim();
      if (!prompt) { say('Type a prompt first.', 'err'); return; }
      busy = true; el.go.disabled = true;
      let [width, height] = PRESETS[aspect];
      if (inputImage && inputDims) [width, height] = inputDims;     // image is the size source
      const body = {
        workflow: el.wf.value, prompt, width, height,
        loras: pins.payload(),
        suspended_loras: pins.suspendedPayload(),
        denoise: parseFloat(el.denoise.value),                       // always sent
      };
      if (inputImage) body.input_image = inputImage;
      // Seed-lock (2026-10-26): unchecked (default) rolls a fresh random
      // seed on every generate; checked keeps the typed seed. The field
      // updates here, before submit, so the seed being used is visible.
      const seed = nextSeed({ locked: el['preset-lock'].checked, current: el.seed.value });
      el.seed.value = seed;
      body.seed = seed;
      try {
        say('submitting…');
        const j = await api('/generate', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        el.seed.value = j.seed;           // always show the seed actually used
        scheduleSave();
        await poll(j.prompt_id);
      } catch (e) { say(e.message, 'err'); }
      busy = false; el.go.disabled = false;
    }
    async function poll(pid) {
      const t0 = Date.now();
      while (Date.now() - t0 < 10 * 60 * 1000) {
        const s = await api('/status/' + pid);
        if (s.state === 'done') {
          say(`done in ${Math.round((Date.now() - t0) / 1000)}s`, 'ok');
          el.out.innerHTML = '';
          for (const u of s.outputs) el.out.appendChild(thumb(u, false));
          loadRecent();
          return;
        }
        if (s.state === 'error') {
          throw new Error((s.error || 'generation failed') +
            ((s.log_tail || []).length ? '\n\n' + s.log_tail.slice(-8).join('\n') : ''));
        }
        say(`${s.state}… ${Math.round((Date.now() - t0) / 1000)}s`);
        await new Promise(r => setTimeout(r, 1500));
      }
      throw new Error('timed out waiting for ComfyUI');
    }
    el.go.addEventListener('click', generate);

    // ── viewer / recent ──
    function thumb(url, small, entry) {
      const im = document.createElement('img');
      im.src = url; im.alt = 'render';
      im.addEventListener('click', () => openBig(url, entry));
      return im;
    }
    let bigUrl = '';
    function openBig(url, entry) {
      bigUrl = url;
      bigEntry = entry || null;
      el.bigimg.src = url;
      el.bigmeta.textContent = entry ? `${entry.workflow} · seed ${entry.seed} · ${entry.prompt}` : '';
      el.reuse.style.display = entry ? '' : 'none';
      el.big.style.display = 'flex';
    }
    el.bigclose.addEventListener('click', () => { el.big.style.display = 'none'; el.bigimg.src = ''; bigUrl = ''; });
    // v1.4 "Send to ▸": a finished render can go to Puppet Theater (as a
    // layer or the background) or to FaceCycle. Server urls only.
    const sendMenu = createSendMenu({
      className: 'ee-btn fx-btn',
      entries: [
        { label: '🎭 Puppet Theater — new layer', target: 'puppet', as: 'layer' },
        { label: '🎭 Puppet Theater — as background', target: 'puppet', as: 'background' },
        { label: '🎭 FaceCycle — as subject', target: 'facecycle' },
        { label: '✎ Update', target: 'update' },
      ],
      getPayload: () => {
        if (!bigUrl) return { error: 'No render open.' };
        const out = { urls: [bigUrl], names: [nameFromUrl(bigUrl)], source: 'FoxDen' };
        try {
          const qpath = new URL(bigUrl, location.origin).searchParams.get('path');
          if (qpath) out.provenance = { kind: 'foxden', paths: [qpath] };
        } catch { /* non-URL bigUrl: Update opens it pathless, as before */ }
        el.bigclose.click();                 // the viewer shouldn't be waiting when the user returns
        return out;
      },
    });
    el.reuse.before(sendMenu.el);
    el.reuse.addEventListener('click', () => {
      const e = bigEntry; if (!e) return;
      el.prompt.value = e.prompt; el.seed.value = e.seed;
      el['preset-lock'].checked = true;   // reused seed is pinned, not re-rolled
      if ([...el.wf.options].some(o => o.value === e.workflow && !o.disabled)) el.wf.value = e.workflow;
      pins.restoreFrom(e.loras, e.suspended_loras);
      renderLoras();
      setDenoise(e.denoise ?? 1); setInput(e.input_image || null);   // older entries: txt2img @1.0
      el.bigclose.click();
    });
    // ── recent strip: load, reconcile, collapse ──
    let recentTotal = 0;
    function countLabel(extra = '') {
      el.rcount.textContent = recentLabel(recentTotal, extra);
    }
    async function loadRecent() {
      try {
        const { items, total } = await api('/recent?limit=16');
        recentTotal = total ?? items.length;
        el.recent.innerHTML = '';
        for (const it of items) for (const u of it.urls) el.recent.appendChild(thumb(u, true, it));
        if (!items.length) el.recent.innerHTML = '<span class="lbl">none yet</span>';
        countLabel();
      } catch (e) { jobbar.textContent = ''; }
    }
    // Adopt renders ComfyUI finished while nobody was polling (tab left, device
    // slept). Server throttles non-forced calls; the refresh button forces.
    async function reconcile(force) {
      try {
        const r = await api('/recent/reconcile' + (force ? '?force=true' : ''), { method: 'POST' });
        if (r.added && !force) await loadRecent();
        return r;
      } catch (e) { el.rcount.title = e.message; return null; }
    }
    async function refreshRecent() {
      el.refresh.disabled = true; el.refresh.classList.add('spin');
      try {
        const r = await reconcile(true);
        await loadRecent();                 // always reload, even if reconcile failed
        if (r === null) countLabel(' · refresh failed (tap ⟳ to retry)');
        else if (r.added) countLabel(` · adopted ${r.added}`);
      } finally { el.refresh.disabled = false; el.refresh.classList.remove('spin'); }
    }
    el.refresh.addEventListener('click', refreshRecent);

    function setCollapsed(on, persist = true) {
      el.recentwrap.classList.toggle('collapsed', on);
      el.rtoggle.textContent = on ? '▸' : '▾';
      el.rtoggle.setAttribute('aria-expanded', String(!on));
      el.rtoggle.setAttribute('aria-label', on ? 'Expand recent renders' : 'Collapse recent renders');
      if (persist) writeCollapsed(window.localStorage, on);
    }
    setCollapsed(readCollapsed(window.localStorage), false);
    const toggleRecent = () => setCollapsed(!el.recentwrap.classList.contains('collapsed'));
    el.rtoggle.addEventListener('click', toggleRecent);
    el.rcount.addEventListener('click', toggleRecent);

    // ── v1.4 receive: Gallery / Puppet composite → input image ──
    // Loads the way a local upload would: fetch the server url, POST it to
    // the existing /upload, select it. No new endpoint; no base64 in events.
    registerReceiver('foxden', {
      canAccept: () => restored ? { ok: true }
        : { ok: false, reason: 'FoxDen is still loading — try again in a moment.' },
    });
    window.addEventListener('ellieedit:foxden-receive', async e => {
      const { urls, names, source } = e.detail || {};
      if (!Array.isArray(urls) || !urls.length) return;
      try {
        say('receiving image…');
        const r = await fetch(urls[0]);
        if (!r.ok) throw new Error(`${(names && names[0]) || urls[0]}: HTTP ${r.status}`);
        const blob = await r.blob();
        const fname = (names && names[0]) || nameFromUrl(urls[0]);
        const fd = new FormData(); fd.append('image', new File([blob], fname, { type: blob.type || 'image/png' }));
        const j = await api('/upload', { method: 'POST', body: fd });
        const name = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
        if (!inputItems.includes(name)) inputItems.unshift(name);
        setInput(name); scheduleSave();
        el.ireceipt.textContent = receiptText(1, source) + (urls.length > 1 ? ` (first of ${urls.length}; input takes one)` : '');
        say(`Input image set: ${name}.`, 'ok');
      } catch (err) { say('Receive failed: ' + err.message, 'err'); }
    });

    // First paint: config (workflow options must exist) -> restore the
    // auto-remembered composition -> only THEN allow auto-save.
    (async () => {
      await loadConfig();
      const last = await loadPresets();
      if (last) applyState(last);
      restored = true;
    })();
    loadInputs();
    loadRecent();
    reconcile(false);
    window.addEventListener('ellieedit:tab-activated', e => {
      // Re-activation refreshes lists only — never re-applies `_last` over
      // an in-progress edit.
      if (e.detail?.name === 'foxden') { loadConfig(); loadPresets(); loadInputs(); loadRecent(); reconcile(false); }
    });
  },
});
