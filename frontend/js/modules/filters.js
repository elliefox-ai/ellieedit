// Filters module — basic visual tunes + the Colorhold Lineart transform
// as a first-class, tunable effect (workorder 2026-10-31).
//
// Pipeline, in order (all documented in the module header on the tab):
//   1. Source image (Gallery send-to, or a local upload).
//   2. Colorhold (backend /api/filters/apply, v5 defaults) — skipped
//      when the Colorhold toggle is off. Slider previews run on a
//      downscaled image (preview_max_side 1024); [Apply at full res]
//      re-runs at full size on commit, per the workorder's preview flow.
//   3. Tier-2 tunes (client-side canvas, filters-tunes.js): saturation,
//      brightness/contrast, value curve incl. lift-blacks.
//   4. Universal strength: out = lerp(original, tuned, strength/100),
//      strength 0-100, default 100 — no extrapolation past 100.
// Saving: [Apply at full res] stores the committed canvas once via
// /api/filters/store (one bounded write, ellieedit_tmp/filters), then
// [Save to Library] reuses Update's save-family machinery, so a filtered
// result travels with its original like any other render.
// Panels follow the FaceCycle drawer contract: a toggle button with
// aria-expanded, and a drawer whose visibility is the `hidden`
// attribute — never a display style alone.
// Presets follow FoxDen's server-backed pattern: named presets +
// auto-remembered last slider state (GET/POST/DELETE /api/filters/presets,
// PUT /api/filters/last).

import { registerModule, registerReceiver } from '../shell.js';
import { tuneImageData, tunesAreIdentity } from './filters-tunes.js';

const PREVIEW_MAX_SIDE = 1024;

function panelHTML() {
  return `
  <style>
    .flt-layout { display: flex; height: 100%; min-height: 0; }
    .flt-side { width: 300px; flex: 0 0 300px; overflow-y: auto; background: #12121f;
      border-right: 1px solid #2a2a44; padding: 12px; display: flex;
      flex-direction: column; gap: 18px; }
    .flt-sec { display: flex; flex-direction: column; gap: 8px; }
    .flt-sec h4 { margin: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
      color: #8a8aaa; font-weight: 600; }
    .flt-side label { font-size: 12px; color: #8a8aaa; }
    .flt-side select, .flt-side input[type=text], .flt-side input[type=number] {
      background: #1d1d33; color: #e0e0f0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 7px 8px; font-size: 12px; min-height: 34px; width: 100%;
      box-sizing: border-box; }
    .flt-side input[type=range] { width: 100%; }
    .flt-row { display: flex; gap: 8px; align-items: center; }
    .flt-row .ee-btn { flex: 1; }
    .flt-row .ee-btn.primary { flex: 2; }
    .flt-status { font-size: 11px; color: #6c6c8e; }
    .flt-drawer[hidden] { display: none; }
    .flt-drawer-toggle.active-toggle { border-color: #7a6aaa; color: #c8b8ee; }
    .flt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
    .flt-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
      padding: 12px; position: relative; overflow: hidden; }
    .flt-stage canvas { max-width: 100%; max-height: 100%; object-fit: contain; background: #1a1a2e; }
    .flt-empty { color: #6c6c8e; font-size: 13px; text-align: center; max-width: 480px; }
    .flt-caption { font-size: 11px; color: #6c6c8e; line-height: 1.4; }
    @media (max-width: 900px) {
      .flt-layout { flex-direction: column; }
      .flt-side { width: auto; flex: 0 0 auto; max-height: 46%; border-right: none;
        border-bottom: 1px solid #2a2a44; }
    }
  </style>
  <div class="flt-layout">
    <aside class="flt-side">
      <section class="flt-sec">
        <h4>Source</h4>
        <span class="flt-status" data-id="src-name">No image yet — send one from the Gallery viewer (Send to ▸ Filters), or upload.</span>
        <input type="file" accept="image/*" data-id="upload">
        <span class="flt-caption">Gallery sends arrive by path; uploads are sent to the backend as image data for the colorhold step only.</span>
      </section>
      <section class="flt-sec">
        <button class="ee-btn flt-drawer-toggle active-toggle" data-act="toggle-colorhold" aria-expanded="true">🎛 Colorhold Lineart</button>
        <div class="flt-drawer" data-id="colorhold-drawer">
          <label><input type="checkbox" data-id="ch-enabled" checked> Enable colorhold</label>
          <label>Dark threshold <input type="range" data-id="ch-dark" min="0.1" max="0.9" step="0.01" value="0.45"> <span data-id="ch-dark-val">0.45</span></label>
          <label>Line saturation <input type="range" data-id="ch-sat" min="0.5" max="2" step="0.05" value="1.45"> <span data-id="ch-sat-val">1.45</span></label>
          <label>Line darkness <input type="range" data-id="ch-val" min="0.3" max="1" step="0.01" value="0.72"> <span data-id="ch-val-val">0.72</span></label>
          <label>Fill smoothing <input type="range" data-id="ch-smooth" min="0" max="5" step="1" value="3"> <span data-id="ch-smooth-val">7</span> <span class="flt-caption">(0 = off, then 3–11)</span></label>
          <label>Line smoothing <input type="range" data-id="ch-sigma" min="0" max="2" step="0.1" value="0"> <span data-id="ch-sigma-val">0</span> <span class="flt-caption">(secondary — softens source-lineart jaggies)</span></label>
          <label><input type="checkbox" data-id="ch-gate"> Protect black masses (thin-stroke gate, opt-in)</label>
          <label>Max stroke width <input type="range" data-id="gate-maxw" min="1" max="12" step="1" value="6"> <span data-id="gate-maxw-val">6</span> <span class="flt-caption">(px at a 1280×848 reference — scaled to the working image, so preview and full-res gate the same relative width)</span></label>
          <label>Gate sensitivity <input type="range" data-id="gate-bh" min="0.02" max="0.2" step="0.01" value="0.06"> <span data-id="gate-bh-val">0.06</span></label>
          <label>Gate strength <input type="range" data-id="gate-strength" min="0" max="100" step="1" value="100"> <span data-id="gate-strength-val">100%</span></label>
          <span class="flt-caption">Gate = black-hat on value: strokes narrower than the width get tinted, solid masses keep their black. Textured masses (grilles, panel lines) still tint their internal thin detail — only the solid core is fully protected. Off by default: plain v5 is unchanged.</span>
          <span class="flt-caption">Defaults are the eye-validated v5 finals. Rejected by eye-testing, not offered: line-sat beyond ~1.75, charcoal/parabolic black attenuation.</span>
        </div>
      </section>
      <section class="flt-sec">
        <button class="ee-btn flt-drawer-toggle active-toggle" data-act="toggle-tunes" aria-expanded="true">✨ Tunes (canvas)</button>
        <div class="flt-drawer" data-id="tunes-drawer">
          <label>Saturation <input type="range" data-id="tn-sat" min="0" max="2" step="0.05" value="1"> <span data-id="tn-sat-val">1</span></label>
          <label>Brightness <input type="range" data-id="tn-bri" min="-0.5" max="0.5" step="0.01" value="0"> <span data-id="tn-bri-val">0</span></label>
          <label>Contrast <input type="range" data-id="tn-con" min="0" max="2" step="0.05" value="1"> <span data-id="tn-con-val">1</span></label>
          <label>Lift blacks <input type="range" data-id="tn-lift" min="0" max="0.3" step="0.01" value="0"> <span data-id="tn-lift-val">0</span></label>
          <label>Lift edge <input type="range" data-id="tn-edge" min="0" max="0.5" step="0.01" value="0"> <span data-id="tn-edge-val">0</span></label>
          <span class="flt-caption">Lift curve: identity above the edge, quadratic ease-in below it, rising from the lift value at black.</span>
        </div>
      </section>
      <section class="flt-sec">
        <h4>Strength &amp; commit</h4>
        <label>Effect strength <input type="range" data-id="strength" min="0" max="100" step="1" value="100"> <span data-id="strength-val">100%</span></label>
        <span class="flt-caption">Universal: out = lerp(original, filtered, strength). 100% is the full effect; 0% is the untouched source.</span>
        <div class="flt-row">
          <button class="ee-btn primary" data-act="commit">▶ Apply at full res</button>
          <button class="ee-btn" data-act="reset">↺ v5 defaults</button>
        </div>
        <label>Tag for Library save <input type="text" data-id="tag" placeholder="optional tag"></label>
        <button class="ee-btn" data-act="save" disabled>💾 Save to Library</button>
        <span class="flt-status" data-id="status">Idle.</span>
      </section>
      <section class="flt-sec">
        <h4>Presets</h4>
        <select data-id="preset-sel"><option value="">presets…</option></select>
        <div class="flt-row">
          <input type="text" data-id="preset-name" placeholder="preset name">
          <button class="ee-btn" data-act="preset-save">💾 Save</button>
          <button class="ee-btn" data-act="preset-del">🗑</button>
        </div>
        <span class="flt-caption">Slider state auto-saves as “last” on every change (reload-safe).</span>
      </section>
    </aside>
    <div class="flt-main">
      <div class="flt-stage">
        <div class="flt-empty" data-id="empty">Send an image from Gallery, or upload one, to start filtering.</div>
        <canvas data-id="canvas" style="display:none"></canvas>
      </div>
      <div class="flt-row" style="padding:8px 12px;border-top:1px solid #2a2a44">
        <button class="ee-btn" data-act="view-filtered">Filtered</button>
        <button class="ee-btn" data-act="view-original">Original</button>
        <span class="flt-status" data-id="view-label"></span>
      </div>
    </div>
  </div>`;
}

// kind: 'backend' sliders re-run the colorhold preview (debounced,
// fill + thin-mask cached server-side); 'canvas' sliders only re-draw
// the canvas from the last colorhold result — instant, no backend call.
const SLIDERS = [
  ['ch-dark', 'dark_t', parseFloat, 'backend'], ['ch-sat', 'sat_mul', parseFloat, 'backend'],
  ['ch-val', 'val_mul', parseFloat, 'backend'], ['ch-smooth', 'smooth', v => { const n = parseInt(v, 10); return n === 0 ? 0 : n * 2 + 1; }, 'backend'],
  ['ch-sigma', 'line_sigma', parseFloat, 'backend'],
  ['gate-maxw', 'gate_maxw', v => parseInt(v, 10), 'backend'],
  ['gate-bh', 'gate_bh_full', parseFloat, 'backend'],
  ['gate-strength', 'gate_strength', parseFloat, 'backend'],
  ['tn-sat', 'satMul', parseFloat, 'canvas'], ['tn-bri', 'brightness', parseFloat, 'canvas'],
  ['tn-con', 'contrast', parseFloat, 'canvas'], ['tn-lift', 'lift', parseFloat, 'canvas'],
  ['tn-edge', 'edge', parseFloat, 'canvas'], ['strength', 'strength', parseFloat, 'canvas'],
];

class Filters {
  constructor(panel) {
    this.panel = panel;
    panel.innerHTML = panelHTML();
    const q = s => panel.querySelector(`[data-id="${s}"]`);
    const act = n => panel.querySelector(`[data-act="${n}"]`);
    this.el = { q, act };
    this.source = null; // { name, path?, dataUrl?, img }
    this.colorholdUrl = null;
    this.colorholdKey = null;
    this.baseImg = null;
    this.committedPath = null;
    this.viewing = 'filtered';
    this.debounce = null;
    this.lastSave = 0;

    act('toggle-colorhold').addEventListener('click', () => this.toggleDrawer('colorhold', act('toggle-colorhold')));
    act('toggle-tunes').addEventListener('click', () => this.toggleDrawer('tunes', act('toggle-tunes')));
    q('upload').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) this.loadUpload(f);
    });
    for (const [id, , , kind] of SLIDERS) {
      const el = q(id);
      el.addEventListener('input', () => {
        const valEl = q(id + '-val');
        if (valEl) valEl.textContent = (id === 'strength' || id === 'gate-strength') ? `${el.value}%`
          : (id === 'ch-smooth') ? (el.value === '0' ? '0' : el.value * 2 + 1) : el.value;
        // Canvas sliders (tunes + universal strength) re-draw instantly
        // from the last colorhold result — no backend round-trip, so
        // they feel live. Backend sliders go through the debounced
        // preview fetch, where the fill + thin masks are cached.
        if (kind === 'canvas' && this.baseImg) { this.renderCanvas(); this.rememberLast(); }
        else this.scheduleRender();
      });
    }
    q('ch-enabled').addEventListener('change', () => this.scheduleRender());
    q('ch-gate').addEventListener('change', () => this.scheduleRender());
    act('commit').addEventListener('click', () => this.commitFullRes());
    act('reset').addEventListener('click', () => this.resetDefaults());
    act('save').addEventListener('click', () => this.saveToLibrary());
    act('view-filtered').addEventListener('click', () => { this.viewing = 'filtered'; this.renderCanvas(); });
    act('view-original').addEventListener('click', () => { this.viewing = 'original'; this.renderCanvas(); });
    act('preset-save').addEventListener('click', () => this.savePreset());
    act('preset-del').addEventListener('click', () => this.deletePreset());
    q('preset-sel').addEventListener('change', () => this.loadPreset());
    window.addEventListener('ellieedit:filters-receive', e => this.receive(e.detail));
    registerReceiver('filters', { canAccept: () => ({ ok: true }) });
    this.refreshPresets();
  }

  toggleDrawer(name, btn) {
    const drawer = this.el.q(name === 'colorhold' ? 'colorhold-drawer' : 'tunes-drawer');
    const open = drawer.hidden;
    drawer.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('active-toggle', open);
  }

  state() {
    const q = this.el.q;
    const s = { chEnabled: q('ch-enabled').checked, gate: q('ch-gate').checked };
    for (const [id, key, parse] of SLIDERS) s[key] = parse(q(id).value);
    return s;
  }

  // Only the parameters the backend colorhold step consumes. Tunes and
  // universal strength are canvas-side and must NOT bust this key —
  // otherwise dragging them would re-fetch the backend for no reason.
  colorholdParams() {
    const s = this.state();
    return { chEnabled: s.chEnabled, dark_t: s.dark_t, sat_mul: s.sat_mul,
      val_mul: s.val_mul, smooth: s.smooth, line_sigma: s.line_sigma,
      gate: s.gate, gate_maxw: s.gate_maxw, gate_bh_full: s.gate_bh_full,
      gate_strength: s.gate_strength };
  }

  applyState(s) {
    const q = this.el.q;
    if (s.chEnabled !== undefined) q('ch-enabled').checked = !!s.chEnabled;
    if (s.gate !== undefined) q('ch-gate').checked = !!s.gate;
    for (const [id, key, parse] of SLIDERS) {
      if (s[key] === undefined) continue;
      q(id).value = s[key];
      const valEl = q(id + '-val');
      if (valEl) valEl.textContent = (id === 'strength' || id === 'gate-strength') ? `${s[key]}%` : String(s[key]);
      void parse;
    }
  }

  resetDefaults() {
    this.applyState({ chEnabled: true, dark_t: 0.45, sat_mul: 1.45, val_mul: 0.72,
      smooth: 7, line_sigma: 0, gate: false, gate_maxw: 6, gate_bh_full: 0.06,
      gate_strength: 100, satMul: 1, brightness: 0, contrast: 1,
      lift: 0, edge: 0, strength: 100 });
    this.scheduleRender();
  }

  setStatus(msg, err) {
    this.el.q('status').textContent = msg;
    this.el.q('status').style.color = err ? '#e87a7a' : '';
  }

  async receive(detail) {
    const url = (detail.urls && detail.urls[0]) || detail.url;
    const name = (detail.names && detail.names[0]) || detail.name || 'image';
    const path = (detail.provenance && detail.provenance.paths && detail.provenance.paths[0]) || detail.path || null;
    if (!url && !path) return;
    this.setStatus('Loading source…');
    try {
      let dataUrl = null;
      let img;
      if (path) {
        // Server-rooted source: load the image directly from its own URL.
        // The backend applies from `path`, so no data URL is ever needed —
        // and the fetch→Blob→FileReader detour that broke gallery sends
        // (readAsDataURL: not a Blob, 2026-10-31) disappears entirely.
        img = await this.loadImage(url);
      } else {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
        const blob = await r.blob();
        dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
        img = await this.loadImage(dataUrl);
      }
      this.source = { name, path, dataUrl, img };
      this.colorholdUrl = null;
      this.baseImg = null;
      this.colorholdKey = null;
      this.committedPath = null;
      this.el.act('save').disabled = true;
      this.el.q('src-name').textContent = name + (path ? ` (${path})` : '');
      this.scheduleRender(true);
    } catch (e) {
      this.setStatus(`Could not load source: ${e.message}`, true);
    }
  }

  async loadUpload(file) {
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    const img = await this.loadImage(dataUrl);
    this.source = { name: file.name, path: null, dataUrl, img };
    this.colorholdUrl = null;
    this.colorholdKey = null;
    this.baseImg = null;
    this.committedPath = null;
    this.el.act('save').disabled = true;
    this.el.q('src-name').textContent = file.name + ' (upload)';
    this.scheduleRender(true);
  }

  loadImage(dataUrl) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('image failed to load'));
      img.src = dataUrl;
    });
  }

  scheduleRender(now) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.render(), now ? 0 : 300);
    this.rememberLast();
  }

  rememberLast() {
    const now = Date.now();
    if (now - this.lastSave < 1000) return;
    this.lastSave = now;
    fetch('/api/filters/last', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: this.state() }) }).catch(() => {});
  }

  async fetchColorhold(preview) {
    const s = this.colorholdParams();
    const key = JSON.stringify({ ...s, src: this.source.path || 'upload', preview });
    if (key === this.colorholdKey && this.colorholdUrl) return this.colorholdUrl;
    const body = { dark_t: s.dark_t, sat_mul: s.sat_mul, val_mul: s.val_mul,
      smooth: s.smooth, line_sigma: s.line_sigma, strength: 100,
      gate: s.gate, gate_maxw: s.gate_maxw, gate_bh_full: s.gate_bh_full,
      gate_strength: s.gate_strength };
    if (preview) body.preview_max_side = PREVIEW_MAX_SIDE;
    if (this.source.path) body.path = this.source.path;
    else body.image_b64 = this.source.dataUrl;
    const r = await fetch('/api/filters/apply', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`colorhold failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    this.colorholdUrl = data.image;
    this.colorholdKey = key;
    if (data.gate_effective_maxw) {
      this.setStatus(`Gate on: effective max width ${data.gate_effective_maxw}px at this preview size (engine ${data.engine}).`);
    }
    return data.image;
  }

  async render(preview = true) {
    if (!this.source) return;
    try {
      const s = this.state();
      // Live-preview split, answering the operator's question directly:
      // the expensive stages run ONCE per colorhold parameter set and
      // are cached (fill field by image+threshold, thin mask by
      // image+width+sensitivity). After that, tunes and strength are
      // pure canvas work — no backend call, no re-computation of the
      // edge/fill stages — so those sliders are instant. A colorhold
      // or gate slider change re-runs only the backend step for the
      // new parameter set, on the downscaled preview; full res is
      // re-run once, on commit.
      if (s.chEnabled) {
        const key = JSON.stringify({ ...this.colorholdParams(), src: this.source.path || 'upload', preview });
        if (key !== this.colorholdKey || !this.baseImg) {
          const url = await this.fetchColorhold(preview);
          this.baseImg = await this.loadImage(url);
        }
      } else {
        this.baseImg = this.source.img;
      }
      this.renderCanvas();
      if (!this.el.q('status').textContent.startsWith('Gate on:')) {
        this.setStatus(preview ? 'Preview (downscaled for sliders — Apply at full res to commit).'
          : 'Full-res render ready. Save to Library to keep it.');
      }
    } catch (e) {
      this.setStatus(e.message, true);
    }
  }

  renderCanvas() {
    if (!this.source || !this.baseImg) return;
    const canvas = this.el.q('canvas');
    const empty = this.el.q('empty');
    const s = this.state();
    const showOriginal = this.viewing === 'original';
    const img = showOriginal ? this.source.img : this.baseImg;
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.drawImage(img, 0, 0);
    if (!showOriginal) {
      const tune = { satMul: s.satMul, brightness: s.brightness, contrast: s.contrast, lift: s.lift, edge: s.edge };
      if (!tunesAreIdentity(tune)) {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        tuneImageData(data, tune);
        ctx.putImageData(data, 0, 0);
      }
      if (s.strength < 100) {
        // Universal strength, canvas form of lerp(original, tuned, t):
        // draw the original over the tuned result at alpha 1 - t.
        ctx.globalAlpha = 1 - s.strength / 100;
        ctx.drawImage(this.source.img, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
      }
    }
    canvas.style.display = 'block';
    empty.style.display = 'none';
    this.el.q('view-label').textContent = showOriginal ? 'Showing original' : `Showing filtered (${canvas.width}×${canvas.height})`;
  }

  async commitFullRes() {
    if (!this.source) { this.setStatus('No source image.', true); return; }
    this.setStatus('Running full-res colorhold…');
    try {
      // Full-res pass through render() (no preview downscale), then store
      // the composited canvas — tunes + strength included — once.
      await this.render(false);
      const canvas = this.el.q('canvas');
      // Render the filtered view at full res even if the operator was
      // looking at the original when they hit commit.
      this.viewing = 'filtered';
      this.renderCanvas();
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      let originalPath = this.source.path;
      if (!originalPath) {
        const r0 = await fetch('/api/filters/store', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_b64: this.source.dataUrl }) });
        if (!r0.ok) throw new Error('could not store original for save-family');
        originalPath = (await r0.json()).render_path;
      }
      this.originalPathForSave = originalPath;
      const r = await fetch('/api/filters/store', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: dataUrl }) });
      if (!r.ok) throw new Error(`store failed: ${r.status}`);
      this.committedPath = (await r.json()).render_path;
      this.el.act('save').disabled = false;
      this.setStatus(`Full-res committed: ${this.committedPath}. Save to Library to keep it.`);
    } catch (e) {
      this.setStatus(e.message, true);
    }
  }

  async saveToLibrary() {
    if (!this.committedPath) return;
    this.setStatus('Saving to Library…');
    try {
      const r = await fetch('/api/update/save-family', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ render_path: this.committedPath,
          original_path: this.originalPathForSave || this.source.path,
          tag: this.el.q('tag').value || null, recipe: 'filters-colorhold' }) });
      if (!r.ok) throw new Error(`save failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      this.setStatus(`Saved to Library: ${data.final}`);
    } catch (e) {
      this.setStatus(e.message, true);
    }
  }

  async refreshPresets() {
    try {
      const r = await fetch('/api/filters/presets');
      if (!r.ok) return;
      const data = await r.json();
      const sel = this.el.q('preset-sel');
      sel.innerHTML = '<option value="">presets…</option>';
      for (const p of data.presets || []) {
        const o = document.createElement('option');
        o.value = p.name;
        o.textContent = p.name;
        sel.appendChild(o);
      }
      this.presetStates = new Map((data.presets || []).map(p => [p.name, p.state]));
      if (data.last && !this.source) this.applyState(data.last);
    } catch (e) { /* presets are a convenience, never a blocker */ }
  }

  async savePreset() {
    const name = this.el.q('preset-name').value.trim();
    if (!name) { this.setStatus('Name the preset first.', true); return; }
    const r = await fetch('/api/filters/presets', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, state: this.state() }) });
    if (!r.ok) { this.setStatus(`preset save failed: ${r.status}`, true); return; }
    this.setStatus(`Preset saved: ${name}`);
    this.refreshPresets();
  }

  async deletePreset() {
    const name = this.el.q('preset-sel').value;
    if (!name) return;
    const r = await fetch(`/api/filters/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) { this.setStatus(`preset delete failed: ${r.status}`, true); return; }
    this.setStatus(`Preset deleted: ${name}`);
    this.refreshPresets();
  }

  loadPreset() {
    const name = this.el.q('preset-sel').value;
    const state = this.presetStates && this.presetStates.get(name);
    if (state) { this.applyState(state); this.scheduleRender(); }
  }
}

registerModule({
  name: 'filters',
  label: 'Filters',
  icon: '🎛',
  order: 3,
  mount: (panel) => new Filters(panel),
});
