// Update module — workflow runner + version stack (2026-10-09d).
// Dropdown-driven preset runner: workflows are JSON templates served by the
// backend (workflows/ dir); the page injects source image, prompt, seed.
// Renders stay in-session (stack); only an explicit Save writes to the
// Library via the save-family machinery. No delete here by design.
import { registerModule } from '../shell.js';
import {
  createStack, current, source, isOriginal, canRevert, compareEntry,
  pushRender, swap, revert, revertToOriginal, saveable,
} from './update-stack.js';

function panelHTML() {
  return `
  <style>
    .upd-bar { padding: 8px 16px; background: #161628; border-bottom: 1px solid #2a2a44;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .upd-bar label { font-size: 12px; color: #8a8aaa; }
    .upd-bar select, .upd-bar input[type=number] {
      background: #1d1d33; color: #e0e0f0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 7px 8px; font-size: 12px; min-height: 34px; }
    #upd-preset { max-width: 280px; }
    #upd-seed { width: 150px; }
    .upd-seedbox { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #8a8aaa; }
    .upd-status { font-size: 11px; color: #6c6c8e; flex: 1; min-width: 120px; }
    .upd-prompt-wrap { padding: 8px 16px; background: #12121f; border-bottom: 1px solid #2a2a44;
      display: flex; gap: 8px; align-items: flex-start; }
    #upd-prompt { flex: 1; min-height: 64px; max-height: 140px; resize: vertical;
      background: #1d1d33; color: #e0e0f0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 8px; font-size: 12px; font-family: inherit; }
    .upd-prompt-side { display: flex; flex-direction: column; gap: 6px; }
    .upd-prompt-side select { background: #1d1d33; color: #e0e0f0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 6px; font-size: 11px; max-width: 180px; min-height: 34px; }
    .upd-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
      padding: 12px; position: relative; overflow: hidden; }
    .cmp { position: relative; max-width: 100%; max-height: 100%;
      display: none; touch-action: none; user-select: none; -webkit-user-select: none; }
    /* Single-box geometry (2026-10-09f): ONE container sized by JS to the
     * source image's aspect ratio; BOTH layers absolute inset:0 with
     * object-fit:contain — natural sizes never lay the images out
     * side-by-side, so identical sources produce pixel-identical layer
     * boxes and the divider drag only ever moves the clip. */
    .cmp img { display: block; position: absolute; inset: 0; width: 100%;
      height: 100%; max-width: none; max-height: none; object-fit: contain; }
    .cmp .cmp-b { position: absolute; inset: 0; overflow: hidden; }
    .cmp .cmp-b img { max-height: none; height: 100%; width: 100%; }
    .cmp .cmp-div { position: absolute; top: 0; bottom: 0; width: 3px; background: #7a6aaa;
      cursor: ew-resize; outline: none; }
    .cmp .cmp-div:focus-visible { background: #b39ae0; }
    .cmp .cmp-div::after { content: '⇔'; position: absolute; top: 50%; left: 50%;
      transform: translate(-50%,-50%); background: #7a6aaa; color: #fff; border-radius: 50%;
      width: 34px; height: 34px; line-height: 34px; text-align: center; font-size: 15px; }
    .cmp .cmp-tag { position: absolute; top: 6px; font-size: 10px; background: rgba(0,0,0,0.6);
      padding: 2px 8px; border-radius: 8px; color: #b0b0d0; }
    .cmp .cmp-tag.a { left: 6px; } .cmp .cmp-tag.b { right: 6px; }
    .upd-empty { color: #6c6c8e; font-size: 13px; text-align: center; max-width: 480px; }
    .upd-actions { padding: 10px 16px; background: #12121f; border-top: 1px solid #2a2a44;
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .upd-actions .ee-btn { min-height: 44px; }
    .upd-actions .stackpos { font-size: 11px; color: #8a8aaa; flex: 1; text-align: center; }
    .upd-mask { padding: 8px 16px; background: #12121f; border-bottom: 1px solid #2a2a44; }
    .upd-mask-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      margin-bottom: 6px; font-size: 11px; color: #8a8aaa; }
    .upd-mask-tools input[type=range] { vertical-align: middle; }
    .upd-mask-tools .ee-btn.active { background: #3a2a5a; border-color: #b39ae0; color: #fff; }
    .upd-mask canvas { display: block; max-width: 100%; max-height: 240px;
      border: 1px solid #4a4a6c; cursor: crosshair; touch-action: none; }
  </style>
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="upd-bar">
      <label>Preset</label>
      <select id="upd-preset"><option value="">loading…</option></select>
      <label>Seed</label>
      <input type="number" id="upd-seed" value="0">
      <span class="upd-seedbox"><input type="checkbox" id="upd-random" checked> random</span>
      <label id="upd-denoise-lbl" style="display:none">Denoise
        <input type="range" id="upd-denoise" min="0.2" max="0.8" step="0.05" value="0.45">
        <span id="upd-denoise-val">0.45</span></label>
      <button class="ee-btn primary" data-act="upd-run" id="upd-run" disabled>▶ Run</button>
      <button class="ee-btn" data-act="upd-cancel" id="upd-cancel" disabled>✕ Cancel</button>
      <span class="upd-status" id="upd-status">send an image from the Gallery lightbox (✎ Update)</span>
    </div>
    <div class="upd-prompt-wrap">
      <textarea id="upd-prompt" placeholder="prompt for the transform…"></textarea>
      <div class="upd-prompt-side">
        <select id="upd-saved"><option value="">saved prompts…</option></select>
        <button class="ee-btn" data-act="upd-save-prompt" title="Save current prompt">💾 Save</button>
        <button class="ee-btn" data-act="upd-del-prompt" title="Delete selected saved prompt">🗑</button>
      </div>
    </div>
    <div class="upd-mask" id="upd-mask" style="display:none">
      <div class="upd-mask-tools">
        <button class="ee-btn" data-act="upd-mask-paint">🖌 Paint</button>
        <button class="ee-btn" data-act="upd-mask-erase">🧽 Erase</button>
        <label>Brush <input type="range" id="upd-brush" min="4" max="120" value="40"></label>
        <button class="ee-btn" data-act="upd-mask-clear">Clear</button>
        <button class="ee-btn" data-act="upd-mask-undo" id="upd-mask-undo" disabled>↩ Undo</button>
        <label>Overlay <input type="range" id="upd-mask-opacity" min="0" max="100" value="55"></label>
        <label><input type="checkbox" id="upd-mask-show" checked> Show mask</label>
        <span id="upd-mask-source"></span>
        <span>White = regenerate. Paint the region to change; everything else stays pixel-exact.</span>
      </div>
      <canvas id="upd-mask-canvas"></canvas>
    </div>
    <div class="upd-stage" id="upd-stage">
      <div class="upd-empty" id="upd-empty">
        No image loaded.<br>Open the Gallery, tap an image, then <b>✎ Update</b>
        to start a version stack here.</div>
      <div class="cmp" id="upd-cmp">
        <img id="upd-img-a" alt="previous">
        <div class="cmp-b" id="upd-wrap-b"><img id="upd-img-b" alt="current"></div>
        <div class="cmp-div" id="upd-div" tabindex="0" role="slider"
          aria-label="before/after divider" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow="50"></div>
        <span class="cmp-tag a" id="upd-tag-a">before</span>
        <span class="cmp-tag b" id="upd-tag-b">after</span>
      </div>
    </div>
    <div class="upd-actions">
      <button class="ee-btn" data-act="upd-compare" id="upd-compare" disabled title="Show the before/after divider, starting closed on the new render">⇔ Compare</button>
      <button class="ee-btn" data-act="upd-swap" title="Accept current render as the next edit's source">Swap</button>
      <button class="ee-btn" data-act="upd-revert">Revert</button>
      <button class="ee-btn" data-act="upd-revert-orig">Revert to original</button>
      <span class="stackpos" id="upd-pos">no stack</span>
      <button class="ee-btn primary" data-act="upd-save" id="upd-save" disabled>⬆ Save to Library</button>
    </div>
  </div>`;
}

class UpdateView {
  constructor(panel) {
    panel.innerHTML = panelHTML();
    this.panel = panel;
    this.el = {};
    for (const id of ['preset', 'seed', 'random', 'run', 'cancel', 'status', 'prompt',
      'saved', 'stage', 'empty', 'cmp', 'img-a', 'wrap-b', 'img-b', 'div',
      'tag-a', 'tag-b', 'pos', 'save', 'compare', 'denoise', 'denoise-lbl',
      'denoise-val', 'mask', 'mask-canvas', 'mask-undo', 'mask-opacity',
      'mask-show', 'mask-source', 'brush']) {
      this.el[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] =
        panel.querySelector(`#upd-${id}`);
    }
    this.stack = null;          // version-stack state (update-stack.js)
    this.presets = [];
    this.running = false;
    this.maskedMode = false;    // masked-inpaint recipe selected
    this.maskCanvas = null;     // offscreen mask (black bg, white = regen)
    this.maskImg = null;        // source image element for the mask view
    this.maskPainted = false;   // any white stroke laid down yet
    this.maskMode = 'paint';
    this.maskBrush = 40;
    this.maskOpacity = 0.55;
    this.maskShow = true;
    this.maskUndoStack = [];    // mask-canvas data URLs, one per stroke start
    this.jobCancelled = false;
    this.compareOn = false;    // comparer is opt-in, never shown by default
    this.cmpPct = 100;          // when opened, start "closed" on the new render
    window.addEventListener('resize', () => this.fitComparer());

    this.loadPresets();
    this.loadSavedPrompts();
    this.bind();
    window.addEventListener('ellieedit:open-in-update',
      this.onOpenIn = e => this.openIn(e.detail || {}));
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail?.name === 'update') this.loadSavedPrompts();
    });
    window.__upd = this;  // debug/probe hook
  }

  // ---- data ----------------------------------------------------------------
  async loadPresets() {
    try {
      const r = await fetch('/api/update/presets');
      const data = await r.json();
      this.presets = data.presets || [];
      const sel = this.el.preset;
      sel.innerHTML = '';
      for (const p of this.presets) {
        const o = document.createElement('option');
        o.value = p.file; o.textContent = p.name; o.title = p.description;
        sel.appendChild(o);
      }
      // Masked-inpaint recipe (2026-10-24): NOT a workflow file — it runs
      // Puppet's Klein inpaint graph + composite_back via /inpaint-async.
      const mi = document.createElement('option');
      mi.value = '__masked_inpaint'; mi.textContent = '🎭 Masked inpaint (Klein)';
      mi.title = 'Regenerate only the painted region, with a prompt. Unpainted pixels stay pixel-exact.';
      sel.appendChild(mi);
      this.updateButtons();
    } catch (err) {
      this.el.status.textContent = 'preset load failed: ' + err.message;
    }
  }

  async loadSavedPrompts() {
    try {
      const r = await fetch('/api/update/prompts');
      const data = await r.json();
      const sel = this.el.saved;
      const cur = sel.value;
      sel.innerHTML = '<option value="">saved prompts…</option>';
      for (const p of data.prompts || []) {
        const o = document.createElement('option');
        o.value = p.name; o.textContent = p.name; o.title = p.text.slice(0, 120);
        // Full text lives in dataset.text: title is only a tooltip, and
        // copying title into the prompt box truncated prompts at 120 chars.
        o.dataset.text = p.text;
        sel.appendChild(o);
      }
      if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    } catch { /* quiet — side feature */ }
  }

  // ---- mask editor (masked-inpaint recipe) --------------------------------
  setMaskedMode(on) {
    this.maskedMode = on;
    this.el.mask.style.display = on ? '' : 'none';
    this.el.denoiseLbl.style.display = on ? '' : 'none';
    if (on && this.stack) this.initMaskForSource();
    this.updateButtons();
  }

  // (Re)build the mask for the CURRENT source entry: black canvas at the
  // source's natural size, view = source dimmed + red overlay of painted
  // regions. Called when the recipe is picked, a source arrives, or Swap
  // moves the source — a mask always belongs to exactly one source.
  initMaskForSource() {
    const srcEntry = this.stack && source(this.stack);
    if (!srcEntry) return;
    this.maskPainted = false;
    this.maskUndoStack = [];
    const img = new Image();
    img.onload = () => {
      this.maskImg = img;
      const mc = document.createElement('canvas');
      mc.width = img.naturalWidth; mc.height = img.naturalHeight;
      mc.getContext('2d').fillStyle = '#000';
      mc.getContext('2d').fillRect(0, 0, mc.width, mc.height);
      this.maskCanvas = mc;
      this.setMaskTool(this.maskMode);
      this.updateMaskSourceLabel();
      this.drawMaskView();
    };
    img.src = srcEntry.url;
  }

  // The mask belongs to the source entry, not the viewed entry: say so in
  // the panel, so painting after a Revert is not mistaken for painting
  // on the viewed image. Swap to make the viewed image the source.
  updateMaskSourceLabel() {
    if (!this.el.maskSource) return;
    const s = this.stack;
    this.el.maskSource.textContent = s
      ? `Mask applies to source entry ${s.sourceIdx + 1} of ${s.entries.length}.`
      : '';
  }

  // True only if some mask pixel is actually white. A stroke counter is
  // not enough: erasing everything must count as an empty mask, or the
  // backend rejects it after a wasted queue.
  maskHasWhite() {
    const mc = this.maskCanvas;
    if (!mc) return false;
    const data = mc.getContext('2d').getImageData(0, 0, mc.width, mc.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  }

  setMaskTool(mode) {
    this.maskMode = mode;
    for (const act of ['upd-mask-paint', 'upd-mask-erase']) {
      const btn = this.panel.querySelector(`[data-act="${act}"]`);
      if (btn) btn.classList.toggle('active', mode === (act.endsWith('paint') ? 'paint' : 'erase'));
    }
  }

  pushMaskUndo() {
    if (!this.maskCanvas) return;
    this.maskUndoStack.push(this.maskCanvas.toDataURL('image/png'));
    if (this.maskUndoStack.length > 20) this.maskUndoStack.shift();
    if (this.el.maskUndo) this.el.maskUndo.disabled = false;
  }

  restoreMaskUndo() {
    const url = this.maskUndoStack.pop();
    if (!url || !this.maskCanvas) return;
    const img = new Image();
    img.onload = () => {
      const ctx = this.maskCanvas.getContext('2d');
      ctx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
      ctx.drawImage(img, 0, 0);
      this.maskPainted = this.maskHasWhite();
      if (this.el.maskUndo) this.el.maskUndo.disabled = this.maskUndoStack.length === 0;
      this.drawMaskView();
    };
    img.src = url;
  }

  drawMaskView() {
    const vc = this.el.maskCanvas, img = this.maskImg, mc = this.maskCanvas;
    if (!vc || !img || !mc) return;
    const vw = Math.min(img.naturalWidth, 900);
    const vh = Math.round(img.naturalHeight * (vw / img.naturalWidth));
    vc.width = vw; vc.height = vh;
    const ctx = vc.getContext('2d');
    ctx.drawImage(img, 0, 0, vw, vh);
    if (!this.maskShow) return;
    // Red overlay of the painted (white) regions, built from luminance:
    // an alpha-keyed composite, which the old code used, keeps
    // black pixels too (they are fully opaque), so the whole image
    // tinted red. Here alpha = mask brightness, so unpainted black
    // areas stay transparent and only painted regions go red.
    const ov = document.createElement('canvas');
    ov.width = vw; ov.height = vh;
    const octx = ov.getContext('2d');
    octx.drawImage(mc, 0, 0, vw, vh);
    const imageData = octx.getImageData(0, 0, vw, vh);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const luminance = d[i];  // mask is grayscale: black keep, white regen
      d[i] = 255; d[i + 1] = 59; d[i + 2] = 48; d[i + 3] = luminance;
    }
    octx.putImageData(imageData, 0, 0);
    ctx.globalAlpha = this.maskOpacity;
    ctx.drawImage(ov, 0, 0);
    ctx.globalAlpha = 1;
  }

  maskStroke(e) {
    const vc = this.el.maskCanvas, mc = this.maskCanvas;
    if (!vc || !mc) return;
    const rect = vc.getBoundingClientRect();
    const sx = mc.width / rect.width, sy = mc.height / rect.height;
    const x = (e.clientX - rect.left) * sx, y = (e.clientY - rect.top) * sy;
    const ctx = mc.getContext('2d');
    ctx.strokeStyle = this.maskMode === 'paint' ? '#fff' : '#000';
    ctx.lineWidth = this.maskBrush * sx;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (this._lastMaskPt) { ctx.moveTo(this._lastMaskPt.x, this._lastMaskPt.y); }
    else { ctx.moveTo(x, y); }
    ctx.lineTo(x, y); ctx.stroke();
    this._lastMaskPt = { x, y };
    // Erasing everything must clear the painted flag, not leave it true.
    this.maskPainted = this.maskMode === 'paint' ? true : this.maskHasWhite();
    this.drawMaskView();
  }

  // ---- handoff -------------------------------------------------------------
  // Gallery lightbox ✎ Update dispatches 'ellieedit:open-in-update'
  // { url, name, path }; url is a jailed gallery file link.
  async openIn({ url, name, path }) {
    if (!url) return;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      const blob = await r.blob();
      const objUrl = URL.createObjectURL(blob);
      this.stack = createStack({ url: objUrl, name: name || 'image.png', path: path || '' });
      this.compareOn = false; this.cmpPct = 100;
      this.showCurrent();
      if (this.maskedMode) this.initMaskForSource();
      this.el.status.textContent = `source: ${this.stack.entries[0].name}`;
    } catch (err) {
      this.el.status.textContent = 'failed to load image: ' + err.message;
    }
  }

  // ---- render --------------------------------------------------------------
  // Async submit/poll (2026-10-24): the old sync /run blocked the request
  // up to 900 s. Both recipes now submit and poll /jobs/{id}; the sync
  // endpoint stays server-side for old callers.
  async run() {
    if (this.running || !this.stack) return;
    const preset = this.el.preset.value;
    if (!preset) { this.el.status.textContent = 'pick a preset first'; return; }
    const srcEntry = source(this.stack);
    if (!srcEntry.path) { this.el.status.textContent = 'current source has no server path'; return; }
    const useRandom = this.el.random.checked;
    const seed = useRandom ? null : (parseInt(this.el.seed.value, 10) || 0);
    if (!useRandom) this.el.seed.value = String(seed);
    const prompt = this.el.prompt.value;
    this.running = true;
    this.jobCancelled = false;
    this.el.run.disabled = true;
    this.updateButtons();
    try {
      let url, body;
      if (this.maskedMode) {
        if (!this.maskCanvas || !this.maskHasWhite()) {
          throw new Error('paint a region to regenerate first');
        }
        url = '/api/update/inpaint-async';
        body = { path: srcEntry.path, prompt,
          mask_b64: this.maskCanvas.toDataURL('image/png'),
          denoise: parseFloat(this.el.denoise.value) || 0.45,
          seed, random: useRandom };
        this.el.status.textContent = 'inpaint queued to ComfyUI…';
      } else {
        url = '/api/update/run-async';
        body = { preset, path: srcEntry.path, prompt, seed, random: useRandom };
        this.el.status.textContent = 'queued to ComfyUI…';
      }
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).detail || r.status);
      const { job_id } = await r.json();
      const data = await this.pollJob(job_id);
      this.lastSeed = data.seed;
      this.el.seed.value = String(data.seed);
      this.stack = pushRender(this.stack, {
        url: data.image, name: `render seed=${data.seed}`,
        path: data.render_path || '',
        recipe: data.recipe || preset, masked: !!data.masked,
      });
      // A new render starts as a single image, not a split view. The
      // user opens Compare deliberately, and it starts closed (100%).
      this.compareOn = false; this.cmpPct = 100;
      this.showCurrent();
      this.el.status.textContent = data.render_path
        ? `render done (seed ${data.seed})`
        : `render done (seed ${data.seed}) — warning: render could not be stored, Save is unavailable`;
    } catch (err) {
      this.el.status.textContent = 'run failed: ' + err.message;
    }
    this.running = false;
    this.el.run.disabled = false;
    this.updateButtons();
  }

  async pollJob(jobId) {
    // Cancel stops polling (the server job, if any, may still finish in
    // the background — there is no server-side cancel). Timeout is 15
    // minutes, matching the old synchronous run ceiling, instead of
    // polling forever on a hung Comfy job.
    const started = Date.now();
    for (;;) {
      if (this.jobCancelled) throw new Error('job cancelled');
      if (Date.now() - started > 15 * 60 * 1000) {
        throw new Error('job timed out after 15 minutes');
      }
      await new Promise(res => setTimeout(res, 2000));
      if (this.jobCancelled) throw new Error('job cancelled');
      const r = await fetch(`/api/update/jobs/${jobId}`);
      if (!r.ok) throw new Error((await r.json()).detail || r.status);
      const job = await r.json();
      if (job.status === 'done') return job.result;
      if (job.status === 'error') throw new Error(job.error || 'job failed');
      this.el.status.textContent = `ComfyUI ${job.status}…`;
    }
  }

  // ---- save ----------------------------------------------------------------
  async save() {
    if (!this.stack || !saveable(this.stack)) return;
    const entry = current(this.stack);
    const tag = prompt('Save to Library — tag/project:', 'zengosoft');
    if (tag === null) return;
    try {
      const r = await fetch('/api/update/save-family', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          render_path: entry.path,
          original_path: this.stack.entries[0].path,
          tag,
          intermediates: this.stack.entries.slice(1, this.stack.idx)
            .map(e => e.path).filter(Boolean),
          recipe: entry.recipe || null,
          masked: !!entry.masked,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || r.status);
      const data = await r.json();
      this.el.status.textContent =
        `saved — final ${data.final} · original ${data.original} (family ${data.family_id})`;
    } catch (err) {
      this.el.status.textContent = 'save failed: ' + err.message;
    }
  }

  // ---- saved prompts -------------------------------------------------------
  async savePrompt() {
    const text = this.el.prompt.value;
    if (!text.trim()) { this.el.status.textContent = 'nothing to save — prompt box is empty'; return; }
    const name = prompt('Name this prompt:');
    if (name === null || !name.trim()) return;
    await fetch('/api/update/prompts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), text }),
    });
    await this.loadSavedPrompts();
    this.el.saved.value = name.trim();
    this.el.status.textContent = `prompt saved: ${name.trim()}`;
  }

  async deletePrompt() {
    const name = this.el.saved.value;
    if (!name) return;
    if (!confirm(`Delete saved prompt "${name}"?`)) return;
    await fetch(`/api/update/prompts?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await this.loadSavedPrompts();
    this.el.status.textContent = `prompt deleted: ${name}`;
  }

  // ---- stack / display -----------------------------------------------------
  showCurrent() {
    const s = this.stack;
    if (!s) return;
    const cur = current(s), prev = compareEntry(s);
    // No distinct previous entry at the original: there is nothing to
    // compare, so the comparer stays off regardless of its last state.
    if (s.idx === 0) this.compareOn = false;
    this.el.empty.style.display = 'none';
    this.el.cmp.style.display = 'block';
    this.el.imgA.src = prev.url;
    this.el.imgB.src = cur.url;
    this.updateMaskSourceLabel();
    // ONE container sized to the source image (2026-10-09f): both layers
    // fill it inset:0 with object-fit:contain, so same-size sources yield
    // pixel-identical layer boxes — the divider only moves the clip.
    this.el.imgA.onload = () => this.fitComparer();
    this.fitComparer();
    this.updateButtons();
  }

  fitComparer() {
    const img = this.el.imgA, st = this.el.stage, cmp = this.el.cmp;
    const natW = img.naturalWidth || 0, natH = img.naturalHeight || 0;
    if (!natW || !natH || cmp.style.display === 'none') return;
    const availW = Math.max(60, st.clientWidth - 24);
    const availH = Math.max(60, Math.min(st.clientHeight - 24,
      window.innerHeight * 0.76));
    const scale = Math.min(availW / natW, availH / natH);
    cmp.style.width = Math.round(natW * scale) + 'px';
    cmp.style.height = Math.round(natH * scale) + 'px';
    this.syncComparer();
  }

  syncComparer() {
    // Clip-only divider (2026-10-09f): the top layer keeps its full box and
    // is clipped by inset() from the right — no width resize, so the layers
    // never reflow or squash as the divider moves.
    // Single-view mode (compare off): the top layer is unclipped, so the
    // stage shows only the current image, and the divider/tags hide.
    const s = this.stack;
    const compare = !!(this.compareOn && s && s.idx > 0);
    this.el.wrapB.style.clipPath = compare
      ? `inset(0 ${100 - this.cmpPct}% 0 0)` : 'inset(0 0 0 0)';
    this.el.div.style.display = compare ? '' : 'none';
    this.el.div.style.left = this.cmpPct + '%';
    this.el.div.setAttribute('aria-valuenow', String(Math.round(this.cmpPct)));
    this.el.tagA.style.display = compare ? '' : 'none';
    this.el.tagB.style.display = compare ? '' : 'none';
    this.el.tagA.textContent = s && s.idx > 0 ? 'previous' : 'original';
    this.el.tagB.textContent = s && current(s) ? current(s).name : 'current';
    if (this.el.compare) {
      this.el.compare.disabled = !s || s.idx === 0;
      this.el.compare.textContent = compare ? '✕ Close compare' : '⇔ Compare';
      this.el.compare.setAttribute('aria-pressed', compare ? 'true' : 'false');
    }
  }

  updateButtons() {
    const s = this.stack;
    this.el.run.disabled = this.running || !s || !this.el.preset.value;
    if (this.el.cancel) this.el.cancel.disabled = !this.running;
    this.el.save.disabled = !s || !saveable(s);
    this.el.pos.textContent = s ? `entry ${s.idx + 1}/${s.entries.length} · source ${s.sourceIdx + 1}` : 'no stack';
    this.syncComparer();
  }

  // ---- events --------------------------------------------------------------
  bind() {
    this.el.preset.addEventListener('change', () => {
      this.setMaskedMode(this.el.preset.value === '__masked_inpaint');
    });
    this.el.denoise.addEventListener('input', () => {
      this.el.denoiseVal.textContent = (+this.el.denoise.value).toFixed(2);
    });
    this.el.brush.addEventListener('input', () => {
      this.maskBrush = parseInt(this.el.brush.value, 10) || 40;
    });
    if (this.el.maskOpacity) {
      this.el.maskOpacity.addEventListener('input', () => {
        this.maskOpacity = (parseInt(this.el.maskOpacity.value, 10) || 0) / 100;
        this.drawMaskView();
      });
    }
    if (this.el.maskShow) {
      this.el.maskShow.addEventListener('change', () => {
        this.maskShow = this.el.maskShow.checked;
        this.drawMaskView();
      });
    }
    this.panel.querySelector('[data-act="upd-mask-paint"]')
      .addEventListener('click', () => { this.setMaskTool('paint'); });
    this.panel.querySelector('[data-act="upd-mask-erase"]')
      .addEventListener('click', () => { this.setMaskTool('erase'); });
    this.panel.querySelector('[data-act="upd-mask-clear"]')
      .addEventListener('click', () => {
        if (!this.maskCanvas) return;
        this.pushMaskUndo();
        const ctx = this.maskCanvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        this.maskPainted = false;
        this.drawMaskView();
      });
    if (this.el.maskUndo) {
      this.el.maskUndo.addEventListener('click', () => this.restoreMaskUndo());
    }
    const mvc = this.el.maskCanvas;
    let masking = false;
    mvc.addEventListener('pointerdown', e => {
      if (!this.maskCanvas) { this.el.status.textContent = 'load an image first'; return; }
      masking = true; this._lastMaskPt = null;
      this.pushMaskUndo();
      mvc.setPointerCapture(e.pointerId);
      this.maskStroke(e);
    });
    mvc.addEventListener('pointermove', e => { if (masking) this.maskStroke(e); });
    const endMask = () => { masking = false; this._lastMaskPt = null; };
    mvc.addEventListener('pointerup', endMask);
    mvc.addEventListener('pointercancel', endMask);
    this.el.run.addEventListener('click', () => this.run());
    if (this.el.cancel) {
      this.el.cancel.addEventListener('click', () => { this.jobCancelled = true; });
    }
    if (this.el.compare) {
      this.el.compare.addEventListener('click', () => {
        if (!this.stack || this.stack.idx === 0) return;
        this.compareOn = !this.compareOn;
        if (this.compareOn) this.cmpPct = 100;  // open closed, on the new render
        this.syncComparer();
      });
    }
    // Seed box is meaningless while "random" is checked: disable it so the
    // displayed seed is not mistaken for a reusable fixed seed.
    const syncSeedBox = () => { this.el.seed.disabled = this.el.random.checked; };
    this.el.random.addEventListener('change', syncSeedBox);
    syncSeedBox();
    this.el.save.addEventListener('click', () => this.save());
    this.el.saved.addEventListener('change', () => {
      const name = this.el.saved.value;
      if (!name) return;
      const opt = this.el.saved.selectedOptions[0];
      if (opt && opt.dataset.text) this.el.prompt.value = opt.dataset.text;
      else if (opt && opt.title) this.el.prompt.value = opt.title;
    });
    this.panel.querySelector('[data-act="upd-save-prompt"]')
      .addEventListener('click', () => this.savePrompt());
    this.panel.querySelector('[data-act="upd-del-prompt"]')
      .addEventListener('click', () => this.deletePrompt());
    this.panel.querySelector('[data-act="upd-swap"]')
      .addEventListener('click', () => {
        if (!this.stack) return;
        this.stack = swap(this.stack);
        this.el.status.textContent = `source set to entry ${this.stack.sourceIdx + 1}`;
        if (this.maskedMode) this.initMaskForSource();  // mask belongs to the source
        this.showCurrent();
      });
    this.panel.querySelector('[data-act="upd-revert"]')
      .addEventListener('click', () => {
        if (!canRevert(this.stack)) return;
        this.stack = revert(this.stack);
        this.showCurrent();
      });
    this.panel.querySelector('[data-act="upd-revert-orig"]')
      .addEventListener('click', () => {
        if (!this.stack) return;
        this.stack = revertToOriginal(this.stack);
        this.showCurrent();
      });

    // Draggable comparer divider — pointer events cover mouse + iPad touch.
    const stage = this.el.cmp;
    const drag = e => {
      const rect = this.el.imgA.getBoundingClientRect();
      if (!rect.width) return;
      const pct = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
      this.cmpPct = pct;
      this.syncComparer();
    };
    let dragging = false;
    stage.addEventListener('pointerdown', e => {
      if (!this.compareOn) return;  // single view is not draggable
      dragging = true;
      stage.setPointerCapture(e.pointerId);
      drag(e);
    });
    stage.addEventListener('pointermove', e => { if (dragging) drag(e); });
    stage.addEventListener('pointerup', () => { dragging = false; });
    stage.addEventListener('pointercancel', () => { dragging = false; });

    // Keyboard divider adjust (2026-10-09f): arrows move the clip; shift =
    // coarse steps. The divider is a pure overlay — keys change nothing but
    // the clip position.
    this.el.div.addEventListener('keydown', e => {
      if (!this.compareOn) return;
      const step = e.shiftKey ? 10 : 2;
      if (e.key === 'ArrowLeft') {
        this.cmpPct = Math.max(0, this.cmpPct - step);
      } else if (e.key === 'ArrowRight') {
        this.cmpPct = Math.min(100, this.cmpPct + step);
      } else return;
      e.preventDefault();
      this.syncComparer();
    });
  }
}

registerModule({
  name: 'update',
  label: 'Update',
  icon: '✎',
  order: 0,
  mount: (panel) => new UpdateView(panel),
});
