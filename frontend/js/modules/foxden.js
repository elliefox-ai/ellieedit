// FoxDen — simple ComfyUI generation shell (work order 2026-10-13).
// One page: workflow, prompt, LoRA toggles + strengths, seed, aspect presets,
// Generate -> poll status -> inline outputs (tap to enlarge) + recent strip.
// Backend: /api/foxden/*. No frameworks, no build step.
import { registerModule, registerReceiver } from '../shell.js';
import { createSendMenu } from '../components/send-menu.js';
import { nameFromUrl, receiptText } from '../send-to.js';
import { readCollapsed, writeCollapsed, recentLabel, flattenRecent, cycleIndex } from './foxden-recent.js';
import { createPins } from './foxden-loras.js';
import { normalizeState, presetState, debounce, cleanName, nextSeed, sizeFor } from './foxden-state.js';
import { orderInputs, pageInputs, INPUTS_PAGE } from './foxden-inputs.js';
import { recipeSettings, recipeLines, copyText } from './foxden-recipe.js';

const API = '/api/foxden';
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
            <button class="ee-btn fx-btn on" data-a="landscape">▭ Landscape</button>
            <button class="ee-btn fx-btn" data-a="portrait">▯ Portrait</button>
            <button class="ee-btn fx-btn" data-a="square">■ Square</button>
          </div>
          <div class="fx-size"><label>Size <span data-id="fx-sizeval">1024×576</span></label>
            <input type="range" data-id="fx-size" min="0" max="3" step="1" value="1" aria-label="Output size step">
          </div>
          <div class="fx-inputs">
            <label>Input image (img2img) <span data-id="icount"></span> <span data-id="ireceipt" class="fx-receipt" style="color:#8ad08a"></span></label>
            <div class="fx-row fx-ibar">
              <select data-id="isort" aria-label="Sort input images">
                <option value="recent">Recent</option>
                <option value="name">Name</option>
              </select>
              <input type="text" data-id="ifilter" placeholder="filter…" aria-label="Filter input images">
            </div>
            <div class="fx-chips" data-id="ichips"></div>
            <button class="ee-btn fx-btn" data-id="imore" hidden>Show more</button>
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
          <button class="ee-btn fx-btn" data-id="bigprev" aria-label="Previous recent image" title="Previous">‹</button>
          <button class="ee-btn fx-btn" data-id="bignext" aria-label="Next recent image" title="Next">›</button>
          <button class="ee-btn fx-btn" data-id="reuse">↺ Reuse settings</button>
          <button class="ee-btn fx-btn" data-id="bigclose">✕</button></div>
        <div class="fx-bigbody">
          <aside class="fx-recipe" data-id="recipe" hidden aria-label="Settings this image was made with"></aside>
          <div class="stage"><img data-id="bigimg" alt=""></div>
        </div>
      </div>
    </div>`;
    const $ = id => panel.querySelector(`[data-id="${id}"]`);
    const el = Object.fromEntries(['conn', 'wf', 'prompt', 'aspects', 'fx-size', 'fx-sizeval', 'seed', 'dice',
      'lcount', 'lfilter', 'loras', 'pins', 'susp',
      'preset-pick', 'preset-lock', 'preset-save', 'preset-del',
      'icount', 'ireceipt', 'ichips', 'iup', 'iclear', 'ifile', 'isort', 'ifilter', 'imore', 'denoise', 'dval', 'go', 'status', 'out', 'recent', 'recentwrap',
      'refresh', 'rtoggle', 'rcount', 'big', 'bigmeta', 'reuse', 'bigclose', 'bigimg', 'recipe',
      'bigprev', 'bignext'].map(k => [k, $(k)]));

    let aspect = 'landscape';
    let sizeIdx = 1;  // step 1 = pre-existing default size for every aspect
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
        // Chunk A bug fix (2026-11-11): loadConfig also runs on every tab
        // re-activation, and unconditionally resetting to the default
        // workflow there is what made the selection "snap back to klein"
        // and what clobbered ReUse's choice a moment after it landed.
        // Preserve the current selection whenever it is still valid; the
        // default only applies on the very first paint (empty select).
        const prevWf = el.wf.value;
        const stillValid = prevWf && [...el.wf.options].some(o => o.value === prevWf && !o.disabled);
        el.wf.value = stillValid ? prevWf : c.default_workflow;
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

    // ── aspect / size / seed ──
    function paintSize() {
      const [w, h] = sizeFor(aspect, sizeIdx);
      if (el['fx-size']) el['fx-size'].value = String(sizeIdx);
      if (el['fx-sizeval']) el['fx-sizeval'].textContent = `${w}×${h}`;
    }
    el.aspects.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      aspect = b.dataset.a;
      el.aspects.querySelectorAll('[data-a]').forEach(x => x.classList.toggle('on', x === b));
      paintSize();
    });
    if (el['fx-size']) el['fx-size'].addEventListener('input', () => {
      sizeIdx = Math.min(3, Math.max(0, parseInt(el['fx-size'].value, 10) || 0));
      paintSize();
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
    let inputRecency = {};        // name -> last-used ts (from /inputs + local picks)
    let inputsShown = INPUTS_PAGE; // browsing window, grown by Show more
    // Issue #14 A1: the gallery path of a send-to input image, so the
    // next generate's provenance record can link back to it. Set only
    // by the foxden-receive handler, cleared by ANY other input change
    // (setInput) so a manually picked input never inherits a stale parent.
    let inputParent = null;
    const viewUrl = n => {
      const i = n.replace(/\\/g, '/').lastIndexOf('/');
      const sub = i >= 0 ? n.slice(0, i) : '', fn = i >= 0 ? n.slice(i + 1) : n;
      return `${API}/view?type=input&filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(sub)}`;
    };
    // Chunk A UX (2026-11-11): the chip strip was the whole (unsorted,
    // possibly hundreds-long) ComfyUI input list. Now it's a browser:
    // recency-first order (server recency map from provenance + this
    // client's own picks/uploads), sort by recency or name, a filter box,
    // and a sane page size with Show more. Pure logic in foxden-inputs.js.
    function paintInput() {
      el.aspects.classList.toggle('dim', !!inputImage);
      el.aspects.querySelectorAll('[data-a]').forEach(b => { b.disabled = !!inputImage; });
      // Size is also a txt2img-only control: an input image supplies its own
      // resolution, so the size slider is disabled alongside the aspects.
      if (el['fx-size']) el['fx-size'].disabled = !!inputImage;
      el.icount.textContent = inputImage ? '(selected)' : '';
      const ordered = orderInputs(inputItems, inputRecency,
        { sort: el.isort.value, q: el.ifilter.value });
      // A selected image off-window stays visible: prepend it if filtered out.
      const names = ordered.includes(inputImage) || !inputImage
        ? ordered : [inputImage, ...ordered];
      const { items, more } = pageInputs(names, inputsShown);
      el.ichips.innerHTML = '';
      for (const n of items) {
        const b = document.createElement('button');
        b.className = 'fx-chipimg' + (n === inputImage ? ' on' : '');
        b.title = n + (inputRecency[n] ? ` · last used ${inputRecency[n]}` : '');
        b.setAttribute('aria-pressed', n === inputImage ? 'true' : 'false');
        const im = document.createElement('img');
        im.loading = 'lazy'; im.alt = n; im.src = viewUrl(n);
        b.appendChild(im);
        b.addEventListener('click', () => { setInput(n === inputImage ? null : n); scheduleSave(); });
        el.ichips.appendChild(b);
      }
      el.imore.hidden = more === 0;
      el.imore.textContent = `Show more (${more} more)`;
    }
    el.isort.addEventListener('change', () => { inputsShown = INPUTS_PAGE; paintInput(); });
    el.ifilter.addEventListener('input', () => { inputsShown = INPUTS_PAGE; paintInput(); });
    el.imore.addEventListener('click', () => { inputsShown += INPUTS_PAGE; paintInput(); });
    function setInput(name) {
      el.ireceipt.textContent = '';            // any manual change retires the receipt
      inputParent = null;                      // and any received parent link
      inputImage = name || null; inputDims = null;
      if (inputImage) {
        inputRecency[inputImage] = new Date().toISOString();   // this client's own pick counts as recency
        const probe = new Image();
        probe.onload = () => { if (inputImage === name) inputDims = [probe.naturalWidth, probe.naturalHeight]; };
        probe.src = viewUrl(inputImage);
      }
      paintInput();
    }
    async function loadInputs() {
      try {
        const d = await api('/inputs');
        inputItems = d.items || [];
        inputRecency = (d.recency && typeof d.recency === 'object') ? d.recency : inputRecency;
      } catch (e) { inputItems = []; }
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
        workflow: el.wf.value, prompt: el.prompt.value, aspect, size_idx: sizeIdx,
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
      sizeIdx = st.size_idx ?? 1;  // old states have no size_idx: keep 1024 step
      paintSize();
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
      let [width, height] = sizeFor(aspect, sizeIdx);
      if (inputImage && inputDims) [width, height] = inputDims;     // image is the size source
      const body = {
        workflow: el.wf.value, prompt, width, height,
        loras: pins.payload(),
        suspended_loras: pins.suspendedPayload(),
        denoise: parseFloat(el.denoise.value),                       // always sent
      };
      if (inputImage) body.input_image = inputImage;
      // Issue #14 A1: a send-to input's gallery path travels as the
      // new render's parent_image (backend validates it like input_image).
      if (inputImage && inputParent) body.parent_image = inputParent;
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
    // The zoom viewer cycles through a list, not just the tapped image:
    // recent-strip thumbs pass the flattened recent list, so ‹ / › (and
    // the arrow keys) walk recents with wrap-around. Inline outputs are
    // not in the recent list, so opening one cycles within itself and the
    // step buttons stay disabled.
    function thumb(url, small, entry, cycleList) {
      const im = document.createElement('img');
      im.src = url; im.alt = 'render';
      im.addEventListener('click', () => openBig(url, entry, cycleList));
      return im;
    }
    let bigUrl = '';
    let bigList = [];
    let bigIdx = -1;
    function bigMetaText(entry, idx, len) {
      const base = entry ? `${entry.workflow} · seed ${entry.seed} · ${entry.prompt}` : '';
      const pos = len > 1 && idx >= 0 ? ` · ${idx + 1}/${len}` : '';
      return base ? base + pos : (pos ? pos.trim().replace(/^· /, '') : '');
    }
    function updateBigNav() {
      const on = bigList.length > 1;
      el.bigprev.disabled = !on; el.bignext.disabled = !on;
    }
    // ── settings column (Chunk A UX, 2026-11-11): what "Reuse settings"
    // would apply to the open image. Data source: the provenance record
    // for the image's path (PR #18), falling back to the in-memory recent
    // entry for pre-provenance images. Left-side column, prompt prominent
    // with a copy button — offset, never overlay. ──
    let recipeToken = 0;
    function outputPathOf(entry) {
      if (!entry || !Array.isArray(entry.outputs) || !entry.outputs[0]) return null;
      const o = entry.outputs[0];
      return o.subfolder ? `${o.subfolder}/${o.filename}` : (o.filename || null);
    }
    function paintRecipe(settings) {
      el.recipe.innerHTML = '';
      if (!settings) { el.recipe.hidden = true; return; }
      el.recipe.hidden = false;
      const head = document.createElement('div');
      head.className = 'fx-recipe-head';
      head.textContent = 'settings used';
      el.recipe.appendChild(head);
      const prow = document.createElement('div');
      prow.className = 'fx-recipe-prompt';
      prow.textContent = settings.prompt || '(no prompt recorded)';
      const copy = document.createElement('button');
      copy.className = 'ee-btn fx-btn fx-recipe-copy';
      copy.textContent = '⧉ Copy prompt';
      copy.addEventListener('click', async () => {
        const ok = await copyText(settings.prompt || '');
        copy.textContent = ok ? '✓ copied' : '✕ copy failed';
        setTimeout(() => { copy.textContent = '⧉ Copy prompt'; }, 1500);
      });
      el.recipe.append(prow, copy);
      for (const line of recipeLines(settings)) {
        const d = document.createElement('div');
        d.className = 'fx-recipe-line';
        d.textContent = line;
        el.recipe.appendChild(d);
      }
    }
    async function loadRecipe(entry) {
      const token = ++recipeToken;
      // Immediate paint from the in-memory entry, then upgrade from the
      // provenance log when a record for this path exists.
      paintRecipe(recipeSettings(entry, null));
      const path = outputPathOf(entry);
      if (!path) return;
      try {
        const r = await fetch(`${API}/provenance?path=${encodeURIComponent(path)}`);
        if (!r.ok) return;                       // pre-provenance image: entry fallback stands
        const rec = await r.json();
        if (token === recipeToken && el.big.style.display === 'flex') paintRecipe(recipeSettings(entry, rec));
      } catch (e) { /* network hiccup: entry fallback stands */ }
    }
    function showBig(idx) {
      if (!bigList.length) return;
      bigIdx = cycleIndex(idx, 0, bigList.length);
      const cur = bigList[bigIdx];
      bigUrl = cur.url;
      bigEntry = cur.entry || null;
      el.bigimg.src = cur.url;
      el.bigmeta.textContent = bigMetaText(bigEntry, bigIdx, bigList.length);
      el.reuse.style.display = bigEntry ? '' : 'none';
      loadRecipe(bigEntry);
      updateBigNav();
    }
    function openBig(url, entry, cycleList) {
      bigList = (Array.isArray(cycleList) && cycleList.length) ? cycleList : [{ url, entry: entry || null }];
      bigIdx = bigList.findIndex(e => e.url === url);
      if (bigIdx < 0) { bigList = [{ url, entry: entry || null }]; bigIdx = 0; }
      showBig(bigIdx);
      el.big.style.display = 'flex';
    }
    el.bigclose.addEventListener('click', () => {
      el.big.style.display = 'none'; el.bigimg.src = ''; bigUrl = ''; bigList = []; bigIdx = -1;
      recipeToken++; el.recipe.hidden = true; el.recipe.innerHTML = '';
    });
    el.bigprev.addEventListener('click', () => showBig(bigIdx - 1));
    el.bignext.addEventListener('click', () => showBig(bigIdx + 1));
    document.addEventListener('keydown', e => {
      if (el.big.style.display !== 'flex') return;
      if (e.target.closest && e.target.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') { showBig(bigIdx - 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { showBig(bigIdx + 1); e.preventDefault(); }
      else if (e.key === 'Escape') el.bigclose.click();
    });
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
        // The render's addressable path: the view URL carries no `path`
        // param, so take it from the recent entry's output record.
        let rpath = null;
        try { rpath = new URL(bigUrl, location.origin).searchParams.get('path'); } catch { /* non-URL bigUrl */ }
        const e = bigEntry;
        if (!rpath && e && Array.isArray(e.outputs) && e.outputs[0]) {
          const o = e.outputs[0];
          rpath = o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename;
        }
        if (rpath) out.provenance = { kind: 'foxden', paths: [rpath] };
        // Issue #14 A1: the open render's own recipe travels with it
        // (its provenance-record path rides in recipe.path, so a
        // receiving FoxDen can link the next generation back to it).
        if (e && e.prompt) {
          out.recipe = { prompt: e.prompt, workflow: e.workflow,
            seed: e.seed, steps: e.steps, width: e.width,
            height: e.height, loras: e.loras, denoise: e.denoise,
            input_image: e.input_image, path: rpath || null };
        }
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
        const flat = flattenRecent(items);
        for (const f of flat) el.recent.appendChild(thumb(f.url, true, f.entry, flat));
        if (!items.length) el.recent.innerHTML = '<span class="lbl">none yet</span>';
        // A refresh while the viewer is open keeps the cycle list current:
        // if the open image is still in recents, re-point at it (position
        // and nav update, image itself untouched); otherwise leave the
        // viewer's existing list alone so the open image stays viewable.
        if (bigUrl) {
          const i = flat.findIndex(f => f.url === bigUrl);
          if (i >= 0) {
            bigList = flat; bigIdx = i;
            el.bigmeta.textContent = bigMetaText(bigEntry, bigIdx, bigList.length);
            updateBigNav();
          }
        }
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
      const { urls, names, source, recipe, provenance } = e.detail || {};
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
        // Issue #14 A1: keep the sent image's gallery path as this
        // input's parent (set AFTER setInput, which clears it). The
        // recipe's path wins; else the provenance path; else none.
        inputParent = (recipe && recipe.path) || (provenance && Array.isArray(provenance.paths) && provenance.paths[0]) || null;
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
