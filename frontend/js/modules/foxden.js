// FoxDen — simple ComfyUI generation shell (work order 2026-10-13).
// One page: workflow, prompt, LoRA toggles + strengths, seed, aspect presets,
// Generate -> poll status -> inline outputs (tap to enlarge) + recent strip.
// Backend: /api/foxden/*. No frameworks, no build step.
import { registerModule } from '../shell.js';
import { readCollapsed, writeCollapsed, recentLabel } from './foxden-recent.js';

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
          <div><label>Workflow</label><select data-id="wf"></select></div>
          <div><label>Prompt</label><textarea data-id="prompt" placeholder="describe the image…"></textarea></div>
          <div class="fx-row" data-id="aspects">
            <button class="ee-btn fx-btn on" data-a="landscape">▭ 1024×576</button>
            <button class="ee-btn fx-btn" data-a="portrait">▯ 576×1024</button>
          </div>
          <div class="fx-row">
            <div style="flex:1;min-width:140px"><label>Seed</label><input type="number" data-id="seed" placeholder="random"></div>
            <button class="ee-btn fx-btn" data-id="dice">🎲 Random</button>
          </div>
          <div><label>LoRAs <span data-id="lcount"></span></label>
            <input type="text" data-id="lfilter" placeholder="filter…" style="margin-bottom:6px">
            <div class="fx-loras" data-id="loras"></div></div>
          <button class="ee-btn primary fx-go" data-id="go">⚡ Generate</button>
          <div class="fx-status" data-id="status"></div>
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
      'lcount', 'lfilter', 'loras', 'go', 'status', 'out', 'recent', 'recentwrap',
      'refresh', 'rtoggle', 'rcount', 'big', 'bigmeta', 'reuse', 'bigclose', 'bigimg'].map(k => [k, $(k)]));

    let aspect = 'landscape';
    let allLoras = [];
    const sel = new Map();          // lora name -> strength (selected only)
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

    function renderLoras() {
      const q = el.lfilter.value.trim().toLowerCase();
      el.lcount.textContent = sel.size ? `(${sel.size} on)` : '';
      el.loras.innerHTML = '';
      const shown = allLoras.filter(n => sel.has(n) || !q || n.toLowerCase().includes(q));
      if (!shown.length) el.loras.innerHTML = '<span class="fx-status">no LoRAs found</span>';
      for (const n of shown) {
        const on = sel.has(n);
        const card = document.createElement('div');
        card.className = 'fx-lora' + (on ? ' on' : '');
        const top = document.createElement('div');
        top.className = 'fx-row';
        const nm = document.createElement('span');
        nm.className = 'nm'; nm.textContent = n;
        const tg = document.createElement('button');
        tg.className = 'ee-btn fx-btn' + (on ? ' on' : '');
        tg.textContent = on ? 'On' : 'Off';
        tg.addEventListener('click', () => { on ? sel.delete(n) : sel.set(n, 1.0); renderLoras(); });
        top.append(nm, tg);
        card.appendChild(top);
        if (on) {
          const row = document.createElement('div');
          row.className = 'fx-row';
          const rg = document.createElement('input');
          rg.type = 'range'; rg.min = '-1'; rg.max = '2'; rg.step = '0.05'; rg.value = sel.get(n);
          const val = document.createElement('span');
          val.className = 'fx-status'; val.textContent = Number(sel.get(n)).toFixed(2);
          rg.addEventListener('input', () => { sel.set(n, parseFloat(rg.value)); val.textContent = parseFloat(rg.value).toFixed(2); });
          row.append(rg, val);
          card.appendChild(row);
        }
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

    // ── generate + poll ──
    async function generate() {
      if (busy) return;
      const prompt = el.prompt.value.trim();
      if (!prompt) { say('Type a prompt first.', 'err'); return; }
      busy = true; el.go.disabled = true;
      const [width, height] = PRESETS[aspect];
      const body = {
        workflow: el.wf.value, prompt, width, height,
        loras: [...sel].map(([name, strength_model]) => ({ name, strength_model })),
      };
      if (el.seed.value !== '') body.seed = parseInt(el.seed.value);
      try {
        say('submitting…');
        const j = await api('/generate', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        el.seed.value = j.seed;           // always show the seed actually used
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
    function openBig(url, entry) {
      bigEntry = entry || null;
      el.bigimg.src = url;
      el.bigmeta.textContent = entry ? `${entry.workflow} · seed ${entry.seed} · ${entry.prompt}` : '';
      el.reuse.style.display = entry ? '' : 'none';
      el.big.style.display = 'flex';
    }
    el.bigclose.addEventListener('click', () => { el.big.style.display = 'none'; el.bigimg.src = ''; });
    el.reuse.addEventListener('click', () => {
      const e = bigEntry; if (!e) return;
      el.prompt.value = e.prompt; el.seed.value = e.seed;
      if ([...el.wf.options].some(o => o.value === e.workflow && !o.disabled)) el.wf.value = e.workflow;
      sel.clear(); (e.loras || []).forEach(l => sel.set(l.name, l.strength_model));
      renderLoras();
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

    loadConfig();
    loadRecent();
    reconcile(false);
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail?.name === 'foxden') { loadConfig(); loadRecent(); reconcile(false); }
    });
  },
});
