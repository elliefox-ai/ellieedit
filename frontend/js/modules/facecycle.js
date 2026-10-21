// FaceCycle module for EllieEdit — behavior ported 1:1 from
// /home/zengonzo/workspace/facecycle/index.html (commit 18cb4e3 era):
// single-image start, multi-variant diff regions, box/mask repaint via
// pending-preview Keep/Discard/Undo, mask-generate source priority
// (selected box → in-progress painted mask → last painted-mask region),
// denoise slider driving BasicScheduler server-side.

import { makeGenLayer, stepRing } from './facecycle-layers.js';
import {} from './facecycle-sheets.js'; // controller retired 2026-10-16f (sheets → drawers); module kept for its tests
import { registerModule } from '../shell.js';
import { CanvasStack, drawFeatheredSource } from '../components/canvas-stack.js';
import { JobPanel } from '../components/jobpanel.js';

const REPAINT_URL = '/api/facecycle/repaint';

function panelHTML() {
  return `
  <style>
    .fc-header {
      padding: 10px 20px; background: #161628; border-bottom: 1px solid #2a2a44;
      display: flex; flex-direction: column; gap: 8px;
    }
    .fc-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .fc-row.top { justify-content: space-between; }
    /* Tools drawer (2026-10-20, rev 23:25): one compact line on wide screens;
       when narrow it WRAPS to extra lines rather than scrolling sideways —
       Alexander prefers vertical space over a scrollbar. */
    .fc-row.oneline { flex-wrap: wrap; gap: 8px; }
    .fc-row.oneline > * { flex-shrink: 0; }
    .fc-row.oneline > .fc-gens { flex-shrink: 1; min-width: 0; }
    .fc-header h1 { font-size: 17px; font-weight: 600; color: #e0e0f0; }
    .fc-header h1 .subtitle { color: #6c6c8e; font-weight: 400; font-size: 12px; margin-left: 8px; }
    label { font-size: 11px; color: #8a8aaa; display: flex; align-items: center; gap: 6px; }
    input[type="range"] { width: 100px; accent-color: #7a6aaa; }
    input[type="text"], input[type="number"], select {
      background: #22223a; color: #d4d4e0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 4px 8px; font-size: 12px;
    }
    .val { font-size: 11px; color: #6c6c8e; min-width: 28px; text-align: right; }
    button.active-toggle { background: #5b4a8a; border-color: #7a6aaa; color: #fff; }
    .hidden { display: none !important; }
    .fc-drop {
      flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column;
      gap: 10px; padding: 60px 40px; border: 2px dashed #2a2a44; margin: 24px;
      border-radius: 12px; cursor: pointer; transition: border-color .2s, background .2s;
    }
    .fc-drop.drag-over { border-color: #7a6aaa; background: rgba(90,74,138,0.08); }
    .fc-drop .icon { font-size: 40px; opacity: 0.4; }
    .fc-drop p { color: #8a8aaa; font-size: 15px; }
    .fc-drop p.hint { font-size: 12px; color: #4a4a6c; }
    .fc-main { display: none; flex: 1; flex-direction: column; padding: 12px 20px 16px; gap: 10px; min-height: 0; }
    /* 2026-10-16d — compact band: one short line, long guidance lives in the
       hover tooltip, not inline. */
    .fc-status { font-size: 12px; color: #6c6c8e; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; white-space: nowrap; }
    .fc-status .badge { background: #2a2a44; padding: 1px 7px; border-radius: 10px; font-size: 11px; color: #b0b0d0; }
    .fc-status .help { color: #6c6c8e; }
    .fc-canvas-wrap { flex: 1; display: flex; overflow: auto; min-height: 0; }
    .fc-canvas-wrap > * { margin: auto; }
    .fc-thumbs {
      display: flex; gap: 6px; padding: 8px 10px; background: #161628; border-radius: 8px;
      overflow-x: auto; border: 1px solid #2a2a44; transition: border-color .2s, background .2s;
    }
    .fc-thumbs.drag-over { border-color: #7a6aaa; background: rgba(90,74,138,0.08); }
    /* Task 10: kept gens live IN the layers row (keep/discard/undo/layer-toggle),
       right-aligned — no extra bar, no canvas-height cost. */
    .fc-zoom { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:#9a9ab8; }
    .fc-zoom input[type=range] { width: 90px; }
    .fc-zoom .val { min-width: 34px; font-family: monospace; }
    .fc-gens { display: none; margin-left: auto; max-width: 45%; gap: 4px; padding: 2px 6px; background: #12121f; border: 1px solid #2a2a44; border-radius: 8px; overflow-x: auto; align-items: center; }
    .fc-gens .label { font-size: 10px; color: #6c6c8e; flex-shrink: 0; margin-right: 2px; }
    .gen-thumb { position: relative; flex-shrink: 0; border: 2px solid transparent; border-radius: 4px; overflow: hidden; cursor: pointer; }
    .gen-thumb.current { border-color: #7de08a; }
    .gen-thumb canvas { display: block; height: 48px; width: auto; }
    .gen-del { position: absolute; top: 1px; right: 1px; width: 14px; height: 14px; background: rgba(0,0,0,0.75); color: #d4d4e0; border: none; border-radius: 50%; font-size: 11px; line-height: 12px; text-align: center; cursor: pointer; padding: 0; }
    .thumb { position: relative; border-radius: 4px; overflow: hidden; border: 2px solid transparent; cursor: pointer; flex-shrink: 0; }
    .thumb img { display: block; height: 56px; width: auto; }
    .thumb .label { position: absolute; bottom: 2px; left: 2px; background: rgba(0,0,0,0.75); color: #d4d4e0; font-size: 10px; padding: 1px 5px; border-radius: 2px; font-family: monospace; }
    .thumb.current { border-color: #7a6aaa; }
    .thumb-del { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; background: rgba(0,0,0,0.75); color: #d4d4e0; border: none; border-radius: 50%; font-size: 13px; line-height: 14px; text-align: center; cursor: pointer; opacity: 0; transition: opacity .15s; padding: 0; }
    .thumb:hover .thumb-del { opacity: 1; }
    .thumb-del:hover { background: rgba(200,60,60,0.85); }
    /* Dupe→Meld save-back bar (2026-10-08g): visible only while a meld
       batch from the Dupe view is loaded. */
    .fc-meld-bar { display:none; align-items:center; gap:10px; padding:8px 16px;
      background:#1d2438; border-top:1px solid #2f5a8a; }
    .fc-meld-bar .msg { font-size:12px; color:#7ab8e8; flex:1; }
    /* Replace sources (work order 2026-10-13): result lands next to the BASE
       image, every source goes to the deletion queue. 2026-10-16c: button lives
       in the top row next to New Images (tinted), warning text dropped — the
       tooltip carries the destination info. */
    .ee-btn.warn { background:#5a3a2a; border-color:#8a5a3a; color:#f0c8a8; }
    .ee-btn.warn:disabled { opacity:.45; }
    .thumb .basetag { position:absolute; top:2px; left:2px; background:#7a6aaa; color:#fff;
      font-size:9px; padding:1px 4px; border-radius:2px; font-family:monospace; }
    /* 2026-10-16c — retracting drawers (tools band + media strip): toggling only
       flips the hidden attribute on a wrapper — never canvas/region/undo state. */
    .fc-drawer[hidden] { display:none; }
    /* Repaint drawer (2026-10-20): same panel treatment as the Tools bar
       (.fc-header: #161628 + #2a2a44 border). :not([hidden]) so the hidden
       attribute still wins. */
    .fc-drawer.fc-repaint:not([hidden]) {
      display:flex; flex-direction:column; gap:8px; padding:10px 20px;
      background:#161628; border-top:1px solid #2a2a44; border-bottom:1px solid #2a2a44; }
    .fc-drawer-toggle.active-toggle { border-color:#7a6aaa; color:#c8b8ee; }
  </style>
  <div class="fc-header">
    <div class="fc-row top">
      <h1>FaceCycle <span class="subtitle">— pick the best variant for each changed region</span></h1>
      <div class="fc-row">
        <button class="ee-btn" data-act="toggle-tools" aria-expanded="false" title="Show/hide the draw + generate controls">⚙ Tools</button>
        <button class="ee-btn" data-act="open-repaint" aria-expanded="false" title="Prompt, denoise, seed, variants">🖌 Repaint <span data-id="repaint-dot" style="color:#8ad08a"></span></button>
        <button class="ee-btn warn" data-act="replace-sources" style="display:none" title="Writes the result next to the base image; every source goes to the deletion queue">♻ Replace sources</button>
        <button class="ee-btn" data-act="reset">New Images</button>
        <button class="ee-btn primary" data-act="export" disabled>Export</button>
      </div>
    </div>
    <div class="fc-drawer" data-id="tools-drawer" hidden>
    <div class="fc-row oneline" data-group="controls">
      <button class="ee-btn" data-act="draw-box">✏️ Draw Box</button>
      <button class="ee-btn" data-act="draw-mask">🖌️ Draw Mask</button>
      <label data-id="brush-controls" style="display:none">Brush <input type="range" data-id="brush-size" min="5" max="80" value="25"><span class="val" data-id="brush-size-val">25</span></label>
      <button class="ee-btn" data-act="erase" style="display:none">Erase: Off</button>
      <button class="ee-btn" data-act="remove-all">Remove All</button>
      <label title="Diff sensitivity — lower finds more regions">Δ <input type="range" data-id="threshold" min="3" max="80" value="20" style="max-width:90px"><span class="val" data-id="threshold-val">20</span></label>
      <label title="Minimum changed-region size (px)">min <input type="range" data-id="min-size" min="200" max="20000" value="1000" step="200" style="max-width:90px"><span class="val" data-id="min-size-val">1k</span></label>
      <label title="Maximum changed-region size (px)">max <input type="range" data-id="max-size" min="2000" max="500000" value="500000" step="2000" style="max-width:90px"><span class="val" data-id="max-size-val">∞</span></label>
      <button class="ee-btn primary" data-act="generate">⚡ Generate</button>
      <button class="ee-btn" data-act="keep">✓ Keep</button>
      <button class="ee-btn" data-act="discard">✕ Discard</button>
      <button class="ee-btn" data-act="undo">↩ Undo</button>
      <button class="ee-btn" data-act="layer-toggle">👁 Edit layer: On</button>
      <span class="fc-zoom" title="Zoom the working image (two-finger drag pans on touch)">🔍
        <input type="range" data-id="zoom-slider" min="25" max="300" step="5" value="100" aria-label="Zoom">
        <span class="val" data-id="zoom-val">Fit</span>
        <button class="ee-btn" data-act="zoom-fit">Fit</button></span>
      <div class="fc-gens" data-id="gen-strip"></div>
    </div>
    </div>
  </div>
  <div class="fc-drop" data-id="drop-zone">
    <div class="icon">📁</div>
    <p>Drop 1+ images here</p>
    <p class="hint">One image: edit directly with boxes + repaint. Two or more same-composition variants: the tool finds what changed and lets you cycle each region independently.</p>
    <input type="file" data-id="file-input" multiple accept="image/*" class="hidden">
  </div>
  <div class="fc-main" data-id="main-view">
    <div class="fc-status" data-id="status-bar"></div>
    <div class="fc-drawer fc-repaint" data-id="repaint-drawer" hidden>
      <div class="fc-row">
        <label style="flex:1">Prompt <input type="text" data-id="repaint-prompt" placeholder="repaint prompt… (select a box, then Generate)"></label>
        <button class="ee-btn primary" data-act="generate-sheet">⚡ Generate</button>
      </div>
      <div class="fc-row">
        <label>Denoise <input type="range" data-id="denoise" min="0.2" max="0.8" step="0.05" value="0.5" style="max-width:140px"><span class="val" data-id="denoise-val">0.5</span></label>
        <label>Variants <select data-id="variant-count"><option value="1" selected>1</option><option value="2">2</option><option value="4">4</option></select></label>
        <label>Seed <input type="number" data-id="seed-input" placeholder="random" style="max-width:110px"></label>
        <label><input type="checkbox" data-id="randomize-seed" checked> Randomize each</label>
        <label><input type="checkbox" data-id="detail-crop" checked> Detail crop</label>
      </div>
    </div>
    <div class="fc-meld-bar" data-id="meld-bar" style="display:none">
      <span class="msg" data-id="meld-msg"></span>
      <button class="ee-btn primary" data-act="meld-save" style="min-height:40px">💾 Save back → family</button>
      <button class="ee-btn" data-act="meld-cancel" style="min-height:40px">✕ Cancel</button>
    </div>
    <div class="fc-canvas-wrap" data-id="canvas-container"></div>
    <button class="ee-btn fc-drawer-toggle" data-act="toggle-thumbs" aria-expanded="false" style="align-self:flex-start" title="Show/hide the media strip (drop images here too)">🎞 Media</button>
    <div class="fc-drawer" data-id="thumbs-drawer" hidden>
    <div class="fc-thumbs" data-id="thumbnail-strip"></div>
    </div>
  </div>
  </div>`;
}


export class FaceCycle {
  constructor(panel, jobbarEl) {
    panel.innerHTML = panelHTML();
    this.panel = panel;
    const $ = id => panel.querySelector(`[data-id="${id}"]`);
    const act = name => panel.querySelector(`[data-act="${name}"]`);
    this.el = {
      dropZone: $('drop-zone'), mainView: $('main-view'), fileInput: $('file-input'),
      thumbnailStrip: $('thumbnail-strip'), canvasContainer: $('canvas-container'),
      statusBar: $('status-bar'), exportBtn: act('export'), resetBtn: act('reset'),
      meldBar: $('meld-bar'), meldMsg: $('meld-msg'),
      meldSaveBtn: act('meld-save'), meldCancelBtn: act('meld-cancel'),
      replaceBtn: act('replace-sources'), toolsDrawer: $('tools-drawer'),
      thumbsDrawer: $('thumbs-drawer'),
      removeAllBtn: act('remove-all'),
      drawBoxBtn: act('draw-box'), drawMaskBtn: act('draw-mask'),
      brushControls: $('brush-controls'), brushSizeSlider: $('brush-size'),
      brushSizeVal: $('brush-size-val'), eraseToggleBtn: act('erase'),
      repaintPromptInput: $('repaint-prompt'),
      repaintDrawer: $('repaint-drawer'), repaintGenerateBtn: act('generate-sheet'),
      denoiseSlider: $('denoise'), denoiseVal: $('denoise-val'), seedInput: $('seed-input'),
      randomizeSeed: $('randomize-seed'), detailCrop: $('detail-crop'),
      variantCountSelect: $('variant-count'), genStrip: $('gen-strip'),
      generateBtn: act('generate'),
      keepBtn: act('keep'), discardBtn: act('discard'), undoBtn: act('undo'),
      layerToggleBtn: act('layer-toggle'),
      zoomSlider: $('zoom-slider'), zoomVal: $('zoom-val'), zoomFitBtn: act('zoom-fit'),
      threshold: $('threshold'), thresholdVal: $('threshold-val'),
      minSize: $('min-size'), minSizeVal: $('min-size-val'),
      maxSize: $('max-size'), maxSizeVal: $('max-size-val'),
    };

    this.jobs = new JobPanel(jobbarEl);

    // ── State (same shape as the original) ──
    this.state = { images: [], width: 0, height: 0, activeRegions: [], selections: {}, baseVariant: 0 };
    this.nextRegionId = 0;
    this.selectedRegionId = null;
    this.drawBoxMode = false;
    this.drawMaskMode = false;
    this.moveDrag = null;
    this.resizeDrag = null;
    this.drawBoxDrag = null;
    this.maskPaintCanvas = null;
    this.maskPaintCtx = null;
    this.isPainting = false;
    this.brushSize = 25;
    this.eraseMode = false;
    this.lastPaintX = null;
    this.lastPaintY = null;
    this.mouseInCanvas = false;
    this.mouseCanvasX = 0;
    this.mouseCanvasY = 0;
    this.focusedRegion = 0;
    this.hideOverlays = false;
    this.maskEditId = null;   // region id whose mask is being edited
    this.strokeBBox = null;   // bbox of current paint strokes (auto-grow)
    this.paintArm = null;     // armed paint: { x0, y0, mode } — tap vs stroke disambiguation
    this.lastRunInfo = null;  // 'detail crop …' / 'full-image' status for the last generate
    this.BADGE_H = 20;
    this.RESIZE_TAB_SIZE = 10;

    // Shared canvas stack. Generation lifecycle lives ON each region object
    // (region.status: idle|generating|preview|kept) — there is no global
    // pending preview anywhere in this module.
    this.stack = new CanvasStack(this.el.canvasContainer, {
      onPointerDown: (e, pt) => this.onPointerDown(e, pt),
      onPointerMove: (e, pts) => this.onPointerMove(e, pts),
      onPointerUp: (e, pt) => this.onPointerUp(e, pt),
      onPointerEnter: () => { this.mouseInCanvas = true; },
      onPointerLeave: () => this.onPointerLeave(),
      onPointerCancel: () => this.onPointerCancel(),
    });
    this.stack.opts.drawUnder = (ctx, opts) => this.drawRegionState(ctx, opts);
    this.initZoom();
    this.stack.opts.drawContent = (ctx, opts) => this.drawOverlays(ctx, opts);
    this.undoLog = []; // transitions { region, before, after } for Undo

    this.bind();
  }

  q(name) { return this.el[name]; }

  bind() {
    const el = this.el;
    // Slider labels
    el.threshold.addEventListener('input', () => { el.thresholdVal.textContent = el.threshold.value; });
    el.minSize.addEventListener('input', () => {
      const v = parseInt(el.minSize.value);
      el.minSizeVal.textContent = v >= 1000 ? (v / 1000).toFixed(1).replace('.0', '') + 'k' : v;
    });
    el.maxSize.addEventListener('input', () => {
      const v = parseInt(el.maxSize.value);
      el.maxSizeVal.textContent = v >= 500000 ? '\u221E' : (v >= 1000 ? (v / 1000).toFixed(1).replace('.0', '') + 'k' : v);
    });
    el.denoiseSlider.addEventListener('input', () => {
      el.denoiseVal.textContent = parseFloat(el.denoiseSlider.value).toFixed(2);
    });

    let reprocessTimer = null;
    const scheduleReprocess = () => {
      clearTimeout(reprocessTimer);
      reprocessTimer = setTimeout(() => { if (this.state.images.length >= 2) this.processImages(); }, 250);
    };
    for (const s of [el.threshold, el.minSize, el.maxSize]) s.addEventListener('input', scheduleReprocess);

    // Drop zone
    el.dropZone.addEventListener('click', () => el.fileInput.click());
    el.dropZone.addEventListener('dragover', e => { e.preventDefault(); el.dropZone.classList.add('drag-over'); });
    el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
    el.dropZone.addEventListener('drop', e => { e.preventDefault(); el.dropZone.classList.remove('drag-over'); this.handleFiles(e.dataTransfer.files); });
    el.fileInput.addEventListener('change', e => this.handleFiles(e.target.files));

    // Thumbnail strip as drop target
    el.thumbnailStrip.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); el.thumbnailStrip.classList.add('drag-over'); });
    el.thumbnailStrip.addEventListener('dragleave', () => el.thumbnailStrip.classList.remove('drag-over'));
    el.thumbnailStrip.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      el.thumbnailStrip.classList.remove('drag-over');
      if (this.state.images.length === 0) return;
      const files = e.dataTransfer.files;
      if (files && files.length > 0) this.handleFiles(files);
    });

    this.el.resetBtn.addEventListener('click', () => this.resetAll());
    this.el.removeAllBtn.addEventListener('click', () => this.removeAll());
    this.el.drawBoxBtn.addEventListener('click', () => this.toggleDrawBox());
    this.el.drawMaskBtn.addEventListener('click', () => this.toggleDrawMask());
    this.el.eraseToggleBtn.addEventListener('click', () => this.toggleErase());
    this.el.brushSizeSlider.addEventListener('input', () => {
      this.brushSize = parseInt(this.el.brushSizeSlider.value);
      this.el.brushSizeVal.textContent = this.brushSize;
      this.render();
    });
    this.el.generateBtn.addEventListener('click', () => this.generateRepaint());
    // ── Drawers (2026-10-16e): Repaint is now an in-flow drawer like Tools —
    // it offsets the canvas instead of overlaying it. Toggling flips `hidden`
    // on wrappers only; the controls keep their data-ids/handlers, so nothing
    // about the canvas, regions, undo log or an in-flight generation changes. ──
    const pq = sel => this.panel.querySelector(sel);
    pq('[data-act="open-repaint"]').addEventListener('click', e => this.toggleDrawer(this.el.repaintDrawer, e.currentTarget));
    this.el.repaintGenerateBtn.addEventListener('click', () => this.generateRepaint());
    const paintDot = () => { const d = pq('[data-id="repaint-dot"]'); if (d) d.textContent = this.el.repaintPromptInput.value.trim() ? '●' : ''; };
    this.el.repaintPromptInput.addEventListener('input', paintDot);
    // Drawers: toggling flips `hidden` on wrappers only — never canvas state.
    pq('[data-act="toggle-tools"]').addEventListener('click', e => this.toggleDrawer(this.el.toolsDrawer, e.currentTarget));
    pq('[data-act="toggle-thumbs"]').addEventListener('click', e => this.toggleDrawer(this.el.thumbsDrawer, e.currentTarget));
    this.el.keepBtn.addEventListener('click', () => this.commitPending());
    this.el.discardBtn.addEventListener('click', () => this.discardAction());
    this.el.undoBtn.addEventListener('click', () => this.undo());
    this.el.layerToggleBtn.addEventListener('click', () => this.toggleLayer());
    this.el.exportBtn.addEventListener('click', () => this.exportComposite());
    // ── Dupe→Meld explicit exits (2026-10-08g) ──────────────────────
    this.el.meldSaveBtn.addEventListener('click', () => this.meldSaveBack());
    this.el.meldCancelBtn.addEventListener('click', () => this.meldCancel());
    this.el.replaceBtn.addEventListener('click', () => this.replaceSources());
    this.el.repaintPromptInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.generateRepaint(); }
    });

    // Import API: Gallery (or anything) dispatches a window CustomEvent
    //   'ellieedit:open-in-facecycle' { detail: { url, name } }
    // and the image is fetched and loaded through the normal file path.
    window.addEventListener('ellieedit:open-in-facecycle', this.onImportEvent = async e => {
      const { url, name } = e.detail || {};
      if (!url || !this.panel.classList.contains('active')) return;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(r.status);
        const blob = await r.blob();
        await this.handleFiles([new File([blob], name || 'image.png', { type: blob.type })]);
      } catch (err) {
        alert('Failed to open image in FaceCycle: ' + err.message);
      }
    });

    // Multi-image handoff: Gallery's ☰-select bar dispatches
    //   'ellieedit:facecycle-handoff' { detail: { urls, names } }
    // (urls are jailed file links, 1..8 of them). Dupe-view meld batches add
    //   detail.meld = { family, members } — then the explicit exits here are
    //   Save back (write blend + collapse, server-side meld-save) or Cancel
    //   (return marking NOTHING — no manifest, no ledger writes).
    window.addEventListener('ellieedit:facecycle-handoff', this.onHandoffEvent = async e => {
      const { urls, names, meld, provenance } = e.detail || {};
      if (!Array.isArray(urls) || !urls.length) return;
      if (!this.panel.classList.contains('active')) return;
      try {
        this.resetAll();          // clears any prior meld context
        this.meldCtx = meld || null;
        this.paintMeldBar();
        const files = await Promise.all(urls.map(async (url, i) => {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`${names[i] || url}: HTTP ${r.status}`);
          const blob = await r.blob();
          return new File([blob], names[i] || `image-${i}.png`, { type: blob.type });
        }));
        await this.handleFiles(files);
        // Remember where each image came from (same order as the stack) so
        // Replace sources knows the base folder and what to retire.
        if (provenance && Array.isArray(provenance.paths) && provenance.paths.length === files.length) {
          this.prov = { kind: provenance.kind, family: provenance.family || null };
          this.state.images.forEach((im, i) => { im.srcPath = provenance.paths[i]; });
        }
        this.paintReplaceBar();
        // Visible receipt: the status bar names exactly what was handed off.
        // Long names are middle-ellipsized so the band stays one line and the
        // canvas keeps its vertical space (operator feedback 2026-10-15).
        const mid = (s, max = 34) => s.length <= max ? s : s.slice(0, Math.ceil(max / 2) - 1) + '…' + s.slice(-Math.floor(max / 2));
        const list = files.map(f => mid(f.name)).join(', ');
        const full = files.map(f => f.name).join(', ');
        const src = meld ? 'Dupe family' : 'Gallery';
        // Kept so the receipt SURVIVES the analyze pass overwriting the status
        // band (updateStatusBar re-renders it with the middle-ellipsized names).
        this.handoffReceipt = { src, list, full: full.replace(/"/g, '&quot;') };
        this.el.statusBar.innerHTML = `<span class="badge" style="color:#8ad08a" title="${full.replace(/"/g, '&quot;')}">→ ${files.length} image${files.length !== 1 ? 's' : ''} from ${src}</span>`;
      } catch (err) {
        alert('FaceCycle handoff failed: ' + err.message);
      }
    });

    document.addEventListener('keydown', this.onKeyDown = e => {
      if (!this.panel.classList.contains('active')) return;
      if (e.key === 'Escape') { e.preventDefault();
        this.el.repaintDrawer.hidden = true;
        pq('[data-act="open-repaint"]').setAttribute('aria-expanded', 'false');
        return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      this.onKeyDownInner(e);
    });

    window.addEventListener('resize', this.onResize = () => {
      if (this.state.images.length) { this.stack.setZoom(this.stack.zoom); this.render(); }
    });
  }

  resetAll() {
    this.state.images = [];
    this.meldCtx = null;          // leaving a meld batch = no Save back exits
    this.paintMeldBar();
    this.state.activeRegions = [];
    this.state.selections = {};
    this.state.baseVariant = 0;
    this.stack.baseData = null;
    this.stack.editLayer = null;
    this.stack.editLayerVisible = true;
    this.undoLog = [];
    this.el.layerToggleBtn.textContent = '👁 Edit layer: On';
    this.el.layerToggleBtn.classList.remove('active-toggle');
    this.nextRegionId = 0;
    this.selectedRegionId = null;
    this.prov = null;
    this.paintReplaceBar();
    this.el.thumbnailStrip.innerHTML = '';
    this.el.mainView.style.display = 'none';
    this.el.dropZone.style.display = 'flex';
    this.el.exportBtn.disabled = true;
    if (this.drawBoxMode) this.toggleDrawBox();
    if (this.drawMaskMode) this.toggleDrawMask();
  }

  removeAll() {
    if (this.state.activeRegions.length === 0) return;
    if (!confirm(`Remove all ${this.state.activeRegions.length} region${this.state.activeRegions.length !== 1 ? 's' : ''}?`)) return;
    this.state.activeRegions = [];
    this.state.selections = {};
    this.selectedRegionId = null;
    this.nextRegionId = 0;
    this.updateStatusBar();
    this.el.exportBtn.disabled = true;
    this.render();
  }

  // ── File loading ──
  async handleFiles(files) {
    this.handoffReceipt = null;   // a fresh stack gets a fresh receipt
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length < 1 && this.state.images.length === 0) {
      alert('Please drop at least 1 image.');
      return;
    }
    if (imageFiles.length === 0) return;

    const loaded = await Promise.all(imageFiles.map(f => this.loadImage(f)));

    let minW = Infinity, minH = Infinity;
    for (const img of loaded) {
      if (img.naturalWidth < minW) { minW = img.naturalWidth; minH = img.naturalHeight; }
    }
    if (this.state.images.length > 0) {
      this.normalizeAndAppendImages(loaded, imageFiles);
      this.renderThumbnails();
      this.render();
      return;
    }

    this.state.width = Math.floor(minW / 2) * 2;
    this.state.height = Math.floor(minH / 2) * 2;
    this.stack.setSize(this.state.width, this.state.height);
    this.normalizeAndAppendImages(loaded, imageFiles);

    this.el.dropZone.style.display = 'none';
    this.el.mainView.style.display = 'flex';

    this.renderThumbnails();
    this.processImages();
  }

  normalizeAndAppendImages(loaded, imageFiles) {
    const tmp = document.createElement('canvas');
    tmp.width = this.state.width;
    tmp.height = this.state.height;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingQuality = 'high';

    const newImages = loaded.map((img, idx) => {
      tctx.clearRect(0, 0, this.state.width, this.state.height);
      if (img.naturalWidth === this.state.width && img.naturalHeight === this.state.height) {
        tctx.drawImage(img, 0, 0);
      } else {
        const scale = Math.max(this.state.width / img.naturalWidth, this.state.height / img.naturalHeight);
        const sw = this.state.width / scale;
        const sh = this.state.height / scale;
        const sx = (img.naturalWidth - sw) / 2;
        const sy = (img.naturalHeight - sh) / 2;
        tctx.drawImage(img, sx, sy, sw, sh, 0, 0, this.state.width, this.state.height);
      }
      const imgData = tctx.getImageData(0, 0, this.state.width, this.state.height);
      return { img, processedData: imgData, data: new ImageData(new Uint8ClampedArray(imgData.data), imgData.width, imgData.height), name: imageFiles[idx].name };
    });
    this.state.images.push(...newImages);
  }

  loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load ' + file.name));
      img.src = URL.createObjectURL(file);
    });
  }

  renderThumbnails() {
    this.el.thumbnailStrip.innerHTML = '';
    this.state.images.forEach((item, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'thumb' + (idx === this.state.baseVariant ? ' current' : '');
      const im = document.createElement('img');
      im.src = item.img.src;
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = String.fromCharCode(65 + idx);
      const del = document.createElement('div');
      del.className = 'thumb-del';
      del.textContent = '×';
      del.title = 'Remove this image';
      del.addEventListener('click', e => { e.stopPropagation(); this.removeImage(idx); });
      thumb.appendChild(im); thumb.appendChild(label); thumb.appendChild(del);
      if (item.srcPath && this.state.images.length > 1 && idx === this.state.baseVariant) {
        const tag = document.createElement('div');
        tag.className = 'basetag'; tag.textContent = 'BASE';
        tag.title = 'Replace sources writes the result into this image\'s folder';
        thumb.appendChild(tag);
      }
      thumb.addEventListener('click', () => {
        this.state.baseVariant = idx;
        this.renderThumbnails();
        this.render();
      });
      this.el.thumbnailStrip.appendChild(thumb);
    });
    this.paintReplaceBar();
  }

  removeImage(index) {
    if (this.state.images.length <= 1) return;
    this.state.images.splice(index, 1);
    if (this.state.baseVariant === index) this.state.baseVariant = 0;
    else if (this.state.baseVariant > index) this.state.baseVariant--;
    for (const r of this.state.activeRegions) {
      let sel = this.state.selections[r.id] ?? this.state.baseVariant;
      if (sel === index) sel = (index < this.state.images.length) ? index : this.state.baseVariant;
      else if (sel > index) sel--;
      this.state.selections[r.id] = sel;
    }
    this.renderThumbnails();
    this.updateStatusBar();
    this.render();
  }

  // ── Diff computation (pixel-level, same algorithm as original) ──
  computeDiff() {
    const threshold = parseInt(this.el.threshold.value);
    const minSize = parseInt(this.el.minSize.value);
    const maxSize = parseInt(this.el.maxSize.value);
    const w = this.state.width, h = this.state.height, n = this.state.images.length;
    if (n < 2) return [];

    const base = this.state.images[0].data.data;
    const mask = new Uint8Array(w * h);
    for (let p = 1; p < n; p++) {
      const pd = this.state.images[p].data.data;
      for (let i = 0; i < base.length; i += 4) {
        if (mask[i >> 2]) continue;
        const dr = Math.abs(base[i] - pd[i]);
        const dg = Math.abs(base[i + 1] - pd[i + 1]);
        const db = Math.abs(base[i + 2] - pd[i + 2]);
        if (Math.max(dr, dg, db) > threshold) mask[i >> 2] = 1;
      }
    }

    const bs = Math.max(4, Math.round(Math.min(w, h) / 160));
    const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
    const grid = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let cnt = 0, total = 0;
        const x0 = gx * bs, y0 = gy * bs;
        const x1 = Math.min(x0 + bs, w), y1 = Math.min(y0 + bs, h);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++, total++)
            if (mask[y * w + x]) cnt++;
        grid[gy * gw + gx] = (cnt / total > 0.12) ? 1 : 0;
      }
    }

    const visited = new Uint8Array(gw * gh);
    const regions = [];
    const stack = [];
    for (let sy = 0; sy < gh; sy++) {
      for (let sx = 0; sx < gw; sx++) {
        if (!grid[sy * gw + sx] || visited[sy * gw + sx]) continue;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        stack.length = 0;
        stack.push(sx, sy);
        while (stack.length > 0) {
          const cy = stack.pop();
          const cx = stack.pop();
          if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) continue;
          const ci = cy * gw + cx;
          if (visited[ci] || !grid[ci]) continue;
          visited[ci] = 1;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          stack.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1);
        }
        const rw = (maxX - minX + 1) * bs;
        const rh = (maxY - minY + 1) * bs;
        if (rw * rh >= minSize && rw * rh <= maxSize) {
          const pad = bs * 2;
          regions.push({
            x: Math.max(0, minX * bs - pad),
            y: Math.max(0, minY * bs - pad),
            w: Math.min(w, rw + pad * 2),
            h: Math.min(h, rh + pad * 2),
            id: this.nextRegionId++,
            manual: false,
            status: 'idle',
          });
        }
      }
    }
    return regions;
  }

  processImages() {
    this.el.statusBar.innerHTML = '<span class="badge">⏳ Analyzing…</span>';
    const manualRegions = this.state.activeRegions.filter(r => r.manual);
    const autoRegions = this.computeDiff();
    this.state.activeRegions = [...autoRegions, ...manualRegions];
    this.stack.ensureEditLayer();
    this.state.baseVariant = 0;
    for (const r of this.state.activeRegions) {
      if (this.state.selections[r.id] === undefined) this.state.selections[r.id] = this.state.baseVariant;
    }
    const validIds = new Set(this.state.activeRegions.map(r => r.id));
    for (const key of Object.keys(this.state.selections)) {
      if (!validIds.has(parseInt(key))) delete this.state.selections[key];
    }
    this.setBaseLayer();
    this.updateStatusBar();
    this.el.exportBtn.disabled = this.state.activeRegions.length === 0;
    this.render();
  }

  setBaseLayer() {
    if (!this.state.images.length) return;
    this.stack.baseData = this.state.images[this.state.baseVariant].processedData;
  }

  updateStatusBar() {
    const n = this.state.activeRegions.length;
    const manualCount = this.state.activeRegions.filter(r => r.manual).length;
    // Handoff receipt (2026-10-16d): badge only — full names live in the hover
    // tooltip; Alexander never reads them inline.
    const receipt = this.handoffReceipt
      ? ` <span class="badge" style="color:#8ad08a" title="${this.handoffReceipt.full}">→ from ${this.handoffReceipt.src}</span>`
      : '';

    // Buttons derive from the SELECTED REGION's status only.
    const selRegion = this.state.activeRegions.find(r => r.id === this.selectedRegionId);
    const status = selRegion?.status ?? 'idle';
    const selGens = selRegion?.gens?.length ?? 0;
    const selPsel = selRegion?.preview?.psel ?? -1;
    const selVariants = selRegion?.preview?.variants?.length ?? 0;
    this.el.keepBtn.disabled = !(status === 'preview' && selPsel >= 0);
    this.el.discardBtn.disabled = !(selRegion && (status === 'preview' || selGens));
    this.el.undoBtn.disabled = this.undoLog.length === 0;

    const statusBadge = status === 'generating'
      ? ' <span class="badge" style="color:#8ab4e8">generating… ' + (selVariants ? selVariants + ' variant' + (selVariants > 1 ? 's' : '') + ' in' : '') + '</span>'
      : status === 'preview'
        ? ' <span class="badge" style="color:#7de08a">Preview: ' + (selPsel + 1) + '/' + selVariants + ' — Keep or Discard</span>'
        : '';
    const gensBadge = (selGens && status !== 'preview' && status !== 'generating')
      ? ` <span class="badge" style="color:#7de08a">${(() => { return (selRegion?.gsel ?? -1) >= 0 ? `gen ${(selRegion?.gsel ?? 0) + 1}/${selGens}` : 'photo shown'; })()} — [/] cycles</span>`
      : '';

    const maskExists = this.drawMaskMode || this.state.activeRegions.some(r => r.maskCanvas);
    const runBadge = this.lastRunInfo ? ` <span class="badge" style="color:#8ab4e8">${this.lastRunInfo}</span>` : '';
    const maskHint = (selRegion && !selRegion.maskCanvas && maskExists && status === 'idle')
      ? ' <span class="badge" style="color:#e87ad0">box selected — Generate overrides painted mask</span>'
      : '';

    if (n === 0) {
      this.el.statusBar.innerHTML = '<span class="badge">' + (this.state.images.length < 2 ? 'Editor ready — draw a box (B) or click a region' : 'No changes detected') + '</span> <span class="help">' + (this.state.images.length < 2 ? 'Type a prompt (or leave empty), select a box, Generate to repaint.' : 'Try lowering sensitivity or min region size.') + '</span>' + statusBadge + maskHint + runBadge + gensBadge + receipt;
      return;
    }

    // Compact band (2026-10-16d): short badges only; the long guidance sentence
    // rides on the band's title tooltip. Alexander rarely reads it inline.
    const bandTitle = 'Click a region to cycle · Right-click to go back · Drag tabs to move/resize · H toggles overlays · Del removes selected';
    this.el.statusBar.title = bandTitle;
    let parts = [];
    parts.push(`<span class="badge">${n} reg${n !== 1 ? 's' : ''}</span>`);
    if (manualCount > 0) parts.push(`<span class="badge" style="color:#e8b84d" title="manual regions">${manualCount} man</span>`);
    let modeIndicator = '';
    if (this.drawBoxMode) modeIndicator = ' <span class="badge" style="color:#e8b84d">✏️ box</span>';
    if (this.drawMaskMode) modeIndicator = ' <span class="badge" style="color:#e8b84d" title="Draw Mask — click a region to edit its mask · paint adds (box auto-grows) · Enter=apply · Esc=reset · E=erase · ,/. = brush size">🖌 mask</span>';
    this.el.statusBar.innerHTML = parts.join(' ') + modeIndicator + statusBadge + maskHint + runBadge + gensBadge + receipt;
  }

  // ── Drawers (2026-10-16c): toggling flips `hidden` on a wrapper div only —
  // the controls inside keep every data-id/handler, so nothing about canvas,
  // regions, undo or in-flight generations can be disturbed. ──
  toggleDrawer(drawer, btn) {
    const open = drawer.hidden;      // about to open
    drawer.hidden = !open;
    if (btn) { btn.setAttribute('aria-expanded', String(open)); btn.classList.toggle('active-toggle', open); }
    return open;
  }

  // ── Rendering ──
  render(opts = {}) {
    this.setBaseLayer();
    this.stack.render(opts);
    this.renderGenStrip();
  }

  // Pure function of region states — the renderer. Per region, per status:
  //   kept      → its current gen drawn at the EXACT rect the preview displayed
  //   preview   → the selected preview variant drawn at its rect
  //   generating→ nothing painted yet (progress affordance is an overlay)
  //   idle      → photo variant (if cycled) only
  // What this paints (minus overlays) is exactly what Export produces.
  drawRegionState(ctx, opts = {}) {
    const s = this.state;
    for (const region of s.activeRegions) {
      if (region.id === opts.skipRegionId) continue;
      const sel = s.selections[region.id] ?? s.baseVariant;
      if (sel !== s.baseVariant) {
        if (region.maskCanvas) this.drawMaskedRegion(ctx, sel, region);
        else drawFeatheredSource(ctx, this.variantCanvas(sel), region);
      }
      if (region.status === 'kept' && region.gens?.length && (region.gsel ?? -1) >= 0) {
        const gen = region.gens[region.gsel];
        ctx.drawImage(gen.canvas, gen.rect.x, gen.rect.y);
      } else if (!opts.exporting && region.status === 'preview' && region.preview && region.preview.psel >= 0) {
        const pv = region.preview.variants[region.preview.psel];
        ctx.drawImage(pv, region.preview.rect.x, region.preview.rect.y);
      }
    }
  }

  // Overlays ABOVE the pending preview: highlights + mode previews.
  drawOverlays(ctx, opts = {}) {
    const s = this.state;

    // Highlights
    if (!this.hideOverlays) {
      for (const region of s.activeRegions) {
        const isSelected = region.id === this.selectedRegionId;
        const accentColor = region.manual ? '#e8b84d' : '#64b4ff';
        // Status affordances: dashed outline around the live preview rect;
        // pulsing-style badge for generating regions.
        if (region.status === 'preview' && region.preview) {
          const r = region.preview.rect;
          ctx.save();
          ctx.strokeStyle = 'rgba(125, 224, 138, 0.9)';
          ctx.lineWidth = 2;
          ctx.setLineDash([8, 5]);
          ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
          ctx.restore();
        }
        ctx.save();
        if (isSelected) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = accentColor;
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
        }
        ctx.strokeRect(region.x + 1, region.y + 1, region.w - 2, region.h - 2);
        ctx.restore();

        const badgeText = this.getBadgeText(region);
        ctx.font = 'bold 13px monospace';
        const bw = ctx.measureText(badgeText).width + 12;
        const bh = 20;
        ctx.fillStyle = isSelected ? 'rgba(255, 255, 255, 0.95)' : accentColor;
        ctx.fillRect(region.x, region.y, bw, bh);
        ctx.fillStyle = '#0f0f1a';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, region.x + 6, region.y + bh / 2 + 1);

        const tabSize = 10;
        const rx = region.x + region.w - tabSize / 2;
        const ry = region.y + region.h - tabSize / 2;
        ctx.fillStyle = isSelected ? 'rgba(255, 255, 255, 0.95)' : accentColor;
        ctx.fillRect(rx - tabSize / 2, ry - tabSize / 2, tabSize, tabSize);
      }
    }

    // Draw Box rubber preview (while dragging)
    if (this.drawBoxMode && this.drawBoxDrag && this.drawBoxDrag.active) {
      const d = this.drawBoxDrag;
      const x = Math.min(d.startX, d.curX);
      const y = Math.min(d.startY, d.curY);
      const w = Math.abs(d.curX - d.startX);
      const h = Math.abs(d.curY - d.startY);
      ctx.save();
      ctx.strokeStyle = '#e8b84d';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(232, 184, 77, 0.1)';
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }

    // Painted-mask overlay + brush cursor (skipped during live stroke — overlay carries it)
    if (this.drawMaskMode && this.maskPaintCanvas && !opts.skipMask) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.maskPaintCanvas, 0, 0);
      ctx.restore();
      if (this.mouseInCanvas && !this.isPainting) {
        ctx.save();
        ctx.strokeStyle = this.eraseMode ? 'rgba(255, 80, 80, 0.9)' : 'rgba(255, 100, 255, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(this.mouseCanvasX, this.mouseCanvasY, this.brushSize / 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  variantCanvas(idx) {
    const src = document.createElement('canvas');
    src.width = this.state.width;
    src.height = this.state.height;
    src.getContext('2d').putImageData(this.state.images[idx].processedData, 0, 0);
    return src;
  }

  drawMaskedRegion(targetCtx, variantIdx, region) {
    const fw = Math.round(region.w);
    const fh = Math.round(region.h);
    const tmp = document.createElement('canvas');
    tmp.width = fw; tmp.height = fh;
    const tctx = tmp.getContext('2d');
    tctx.putImageData(this.state.images[variantIdx].processedData, -Math.round(region.x), -Math.round(region.y));
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(region.maskCanvas, 0, 0, fw, fh);
    tctx.globalCompositeOperation = 'source-over';
    targetCtx.drawImage(tmp, region.x, region.y);
  }

  getBadgeText(region) {
    const sel = this.state.selections[region.id] ?? this.state.baseVariant;
    const st = region.status === 'generating' ? ' ⏳' : region.status === 'preview' ? ' ✓?' : '';
    return `${this.getRegionNumber(region)}:${String.fromCharCode(65 + sel)}${st}`;
  }

  getRegionNumber(region) {
    return this.state.activeRegions.indexOf(region) + 1;
  }

  // ── Overlay-only interactions (cheap per-frame) ──
  drawBoxRubberOverlay() {
    const octx = this.stack.overlayCtx;
    this.stack.clearOverlay();
    if (!this.drawBoxDrag) return;
    this.stack.ensureOverlay();
    const sx = this.stack.overlayCanvas.width / this.state.width;
    const sy = this.stack.overlayCanvas.height / this.state.height;
    const d = this.drawBoxDrag;
    const x = Math.min(d.startX, d.curX) * sx, y = Math.min(d.startY, d.curY) * sy;
    const w = Math.abs(d.curX - d.startX) * sx, h = Math.abs(d.curY - d.startY) * sy;
    octx.save();
    octx.strokeStyle = '#e8b84d';
    octx.lineWidth = 2;
    octx.setLineDash([4, 4]);
    octx.strokeRect(x, y, w, h);
    octx.fillStyle = 'rgba(232, 184, 77, 0.1)';
    octx.fillRect(x, y, w, h);
    octx.restore();
  }

  drawMaskOverlay(dirtyRect = null) {
    const octx = this.stack.overlayCtx;
    this.stack.clearOverlay(dirtyRect);
    if (!this.maskPaintCanvas) return;
    octx.save();
    octx.globalAlpha = 0.5;
    octx.drawImage(this.maskPaintCanvas, 0, 0, this.stack.overlayCanvas.width, this.stack.overlayCanvas.height);
    octx.restore();
    if (this.mouseInCanvas && !this.isPainting) {
      const sx = this.stack.overlayCanvas.width / this.state.width;
      const sy = this.stack.overlayCanvas.height / this.state.height;
      octx.save();
      octx.strokeStyle = this.eraseMode ? 'rgba(255, 80, 80, 0.9)' : 'rgba(255, 100, 255, 0.9)';
      octx.lineWidth = 1.5;
      octx.beginPath();
      octx.arc(this.mouseCanvasX * sx, this.mouseCanvasY * sy, this.brushSize / 2 * sx, 0, Math.PI * 2);
      octx.stroke();
      octx.restore();
    }
  }

  drawDragOverlay() {
    const octx = this.stack.overlayCtx;
    this.stack.clearOverlay();
    this.stack.ensureOverlay();
    const id = (this.moveDrag && this.moveDrag.regionId) ?? (this.resizeDrag && this.resizeDrag.regionId);
    const r = this.state.activeRegions.find(r => r.id === id);
    if (!r) return;
    const scaleX = this.stack.overlayCanvas.width / this.state.width;
    const scaleY = this.stack.overlayCanvas.height / this.state.height;
    octx.save();
    octx.scale(scaleX, scaleY);
    const sel = this.state.selections[r.id] ?? this.state.baseVariant;
    if (sel !== this.state.baseVariant) {
      if (r.maskCanvas) this.drawMaskedRegion(octx, sel, r);
      else drawFeatheredSource(octx, this.variantCanvas(sel), r);
    }
    this.stack.ctx.font = 'bold 13px monospace';
    const badgeText = this.getBadgeText(r);
    const bw = this.stack.ctx.measureText(badgeText).width + 12;
    octx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    octx.lineWidth = 2;
    octx.setLineDash([]);
    octx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    octx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    octx.fillRect(r.x, r.y, bw, 20);
    octx.fillStyle = '#0f0f1a';
    octx.textBaseline = 'middle';
    octx.fillText(badgeText, r.x + 6, r.y + 11);
    octx.restore();
  }

  // ── Interaction ──
  hitBadgeTab(x, y, region) {
    const badgeText = this.getBadgeText(region);
    this.stack.ctx.font = 'bold 13px monospace';
    const bw = this.stack.ctx.measureText(badgeText).width + 12;
    return x >= region.x && x <= region.x + bw && y >= region.y && y <= region.y + this.BADGE_H;
  }

  hitResizeTab(x, y, region) {
    const cx = region.x + region.w;
    const cy = region.y + region.h;
    const half = this.RESIZE_TAB_SIZE / 2 + 2;
    return x >= cx - half && x <= cx + half && y >= cy - half && y <= cy + half;
  }

  onPointerDown(e, pt) {
    const { x, y } = pt;
    if (this.drawBoxMode) {
      if (e.button === 0) { e.preventDefault(); this.drawBoxDrag = { active: true, startX: x, startY: y, curX: x, curY: y }; }
      else if (e.button === 2) { e.preventDefault(); this.toggleDrawBox(); }
      return;
    }
    if (this.drawMaskMode) {
      if (e.button === 0) {
        e.preventDefault();
        const hit = this.topmostRegionAt(x, y);
        if (this.maskEditId != null && (!hit || hit.id === this.maskEditId)) {
          // Arm paint on the region already in mask-edit. A tap (no drag) on
          // empty space exits mask-edit; a drag paints and the box auto-grows.
          this.paintArm = { x0: x, y0: y, mode: hit ? 'attach' : 'deselect-on-tap' };
        } else if (hit) {
          this.finalizeMaskEdit();
          this.selectedRegionId = hit.id;
          this.maskEditId = hit.id;
          this.initMaskCanvas();
          if (hit.maskCanvas) this.maskPaintCtx.drawImage(hit.maskCanvas, hit.x, hit.y);
          this.strokeBBox = null;
          this.updateStatusBar();
          this.render();
        } else {
          // Empty space with no active edit: start a fresh mask region.
          this.finalizeMaskEdit();
          this.selectedRegionId = null;
          this.maskEditId = null;
          this.initMaskCanvas();
          this.strokeBBox = null;
          this.paintArm = { x0: x, y0: y, mode: 'new' };
        }
      } else if (e.button === 2) {
        e.preventDefault();
        this.finalizeMaskEdit();
        this.render();
        this.updateStatusBar();
      }
      return;
    }

    if (e.button === 0) {
      for (let i = this.state.activeRegions.length - 1; i >= 0; i--) {
        const r = this.state.activeRegions[i];
        if (this.hitResizeTab(x, y, r)) {
          this.selectedRegionId = r.id;
          this.resizeDrag = { regionId: r.id, startMouseX: x, startMouseY: y, startW: r.w, startH: r.h, moved: false };
          this.stack.ensureOverlay();
          this.render({ skipRegionId: r.id });
          return;
        }
        if (this.hitBadgeTab(x, y, r)) {
          this.selectedRegionId = r.id;
          this.moveDrag = { regionId: r.id, startMouseX: x, startMouseY: y, startRegionX: r.x, startRegionY: r.y, moved: false };
          this.stack.ensureOverlay();
          this.render({ skipRegionId: r.id });
          return;
        }
      }
      for (let i = this.state.activeRegions.length - 1; i >= 0; i--) {
        const r = this.state.activeRegions[i];
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
          this.selectedRegionId = r.id;
          this.cycleAt(x, y, 1);
          this.render();
          return;
        }
      }
      this.selectedRegionId = null;
      this.render();
    } else if (e.button === 2) {
      for (let i = this.state.activeRegions.length - 1; i >= 0; i--) {
        const r = this.state.activeRegions[i];
        if (this.hitResizeTab(x, y, r) || this.hitBadgeTab(x, y, r) ||
            (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) {
          this.selectedRegionId = r.id;
          e.preventDefault();
          this.cycleAt(x, y, -1);
          this.render();
          return;
        }
      }
    }
  }

  onPointerMove(e, pts) {
    const { x, y } = pts[pts.length - 1];

    if (this.drawBoxMode && this.drawBoxDrag && this.drawBoxDrag.active) {
      this.drawBoxDrag.curX = x;
      this.drawBoxDrag.curY = y;
      this.drawBoxRubberOverlay();
      return;
    }

    if (this.drawMaskMode) {
      // Armed paint becomes a real stroke once the pointer moves a threshold —
      // taps without movement never paint (tap = select/deselect only).
      if (this.paintArm && !this.isPainting) {
        if (Math.hypot(x - this.paintArm.x0, y - this.paintArm.y0) > 6) {
          this.beginPaint(this.paintArm.x0, this.paintArm.y0);
        }
      }
      if (this.isPainting) {
        // Coalesced samples (pts) — stroke to mask canvas, blit overlay once
        for (const c of pts) {
          this.mouseCanvasX = c.x;
          this.mouseCanvasY = c.y;
          this.mouseInCanvas = true;
          if (this.isPainting) {
            this.paintBrush(c.x, c.y, this.lastPaintX, this.lastPaintY);
            this.lastPaintX = c.x;
            this.lastPaintY = c.y;
          }
        }
        this.autoGrowBox();
        this.drawMaskOverlay();
      } else {
        this.render({ skipMask: true });
      }
      return;
    }

    if (this.moveDrag) {
      const dx = x - this.moveDrag.startMouseX;
      const dy = y - this.moveDrag.startMouseY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.moveDrag.moved = true;
      const r = this.state.activeRegions.find(r => r.id === this.moveDrag.regionId);
      if (r) {
        r.x = Math.max(0, Math.min(this.state.width - r.w, this.moveDrag.startRegionX + dx));
        r.y = Math.max(0, Math.min(this.state.height - r.h, this.moveDrag.startRegionY + dy));
        this.drawDragOverlay();
      }
      return;
    }

    if (this.resizeDrag) {
      const dx = x - this.resizeDrag.startMouseX;
      const dy = y - this.resizeDrag.startMouseY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.resizeDrag.moved = true;
      const r = this.state.activeRegions.find(r => r.id === this.resizeDrag.regionId);
      if (r) {
        const minDim = 20;
        r.w = Math.max(minDim, Math.min(this.state.width - r.x, this.resizeDrag.startW + dx));
        r.h = Math.max(minDim, Math.min(this.state.height - r.y, this.resizeDrag.startH + dy));
        this.drawDragOverlay();
      }
    }
  }

  onPointerUp(e, pt) {
    if (this.drawMaskMode) {
      if (this.isPainting) {
        // Finish stroke: commit the working mask into the region (box = current
        // grown bbox; mask cropped from the full-size working canvas).
        this.isPainting = false;
        this.lastPaintX = null;
        this.lastPaintY = null;
        const r = this.state.activeRegions.find(r => r.id === this.maskEditId);
        if (r) {
          r.maskCanvas = this.cropCanvas(this.maskPaintCanvas, r.x, r.y, r.w, r.h);
        } else if (this.strokeBBox) {
          // Fresh mask finished: create its box control from the stroke bbox.
          const pad = 2;
          const bx = Math.max(0, Math.round(this.strokeBBox.x - pad));
          const by = Math.max(0, Math.round(this.strokeBBox.y - pad));
          const bw = Math.min(this.state.width - bx, Math.round(this.strokeBBox.w + pad * 2));
          const bh = Math.min(this.state.height - by, Math.round(this.strokeBBox.h + pad * 2));
          const region = { x: bx, y: by, w: bw, h: bh, id: this.nextRegionId++, manual: true, status: 'idle' };
          region.maskCanvas = this.cropCanvas(this.maskPaintCanvas, bx, by, bw, bh);
          this.state.activeRegions.push(region);
          this.state.selections[region.id] = this.state.baseVariant;
          this.selectedRegionId = region.id;
          this.maskEditId = region.id;
        }
        this.strokeBBox = null;
        this.stack.clearOverlay();
        this.updateStatusBar();
        this.render();
        return;
      }
      if (this.paintArm && !this.isPainting) {
        // Tap without drag:
        const mode = this.paintArm.mode;
        this.paintArm = null;
        if (mode === 'deselect-on-tap') {
          this.finalizeMaskEdit();
          this.selectedRegionId = null;
          this.updateStatusBar();
          this.render();
        }
        // mode 'new': tap did nothing (intentional — no accidental dot regions)
        return;
      }
    }
    if (this.drawBoxMode && this.drawBoxDrag && this.drawBoxDrag.active) {
      const d = this.drawBoxDrag;
      this.drawBoxDrag = null;
      const x = Math.min(d.startX, d.curX);
      const y = Math.min(d.startY, d.curY);
      const w = Math.abs(d.curX - d.startX);
      const h = Math.abs(d.curY - d.startY);
      if (w >= 20 && h >= 20) {
        const region = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), id: this.nextRegionId++, manual: true, status: 'idle' };
        this.state.activeRegions.push(region);
        this.state.selections[region.id] = this.state.baseVariant;
        this.selectedRegionId = region.id;
        this.updateStatusBar();
        this.el.exportBtn.disabled = this.state.activeRegions.length === 0;
      }
      this.stack.clearOverlay();
      this.render();
      return;
    }
    if (this.moveDrag) {
      this.moveDrag = null;
      this.stack.clearOverlay();
      this.render();
      return;
    }
    if (this.resizeDrag) {
      this.resizeDrag = null;
      this.stack.clearOverlay();
      this.render();
    }
  }

  onPointerLeave() {
    this.mouseInCanvas = false;
    if (this.moveDrag || this.resizeDrag || this.isPainting || (this.drawBoxMode && this.drawBoxDrag)) return;
    if (!this.drawMaskMode) this.stack.clearOverlay();
  }

  onPointerCancel() {
    this.drawBoxDrag = null;
    this.isPainting = false;
    this.paintArm = null;
    this.lastPaintX = null;
    this.lastPaintY = null;
    this.moveDrag = null;
    this.resizeDrag = null;
    this.render();
  }

  cycleRegion(region, dir) {
    // Preview status: cycle that region's own preview variants.
    if (region.status === 'preview' && region.preview) {
      const pv = region.preview;
      const n = pv.variants.length;
      if (!n) return;
      pv.psel = ((pv.psel + dir) % n + n) % n;
      this.render();
      this.updateStatusBar();
      return;
    }
    // Kept/idle: click cycles a combined ring of kept generations then photo
    // variants. A region with a single gen still responds to taps (gsel -1 =
    // variant shown; >= 0 = that gen drawn at its exact rect).
    const sel = this.state.selections[region.id] ?? this.state.baseVariant;
    const step = stepRing(region, this.state.images.length, sel, dir);
    if (!step) return;
    region.gsel = step.gsel;
    if (step.gsel === -1) this.state.selections[region.id] = step.photoSel;
    this.renderGenStrip();
    this.render();
    this.updateStatusBar();
  }

  cycleAt(x, y, dir) {
    // Cycling reads ONLY the region under the pointer — no cross-region effects.
    for (let i = this.state.activeRegions.length - 1; i >= 0; i--) {
      const r = this.state.activeRegions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        this.cycleRegion(r, dir);
        return;
      }
    }
  }

  onKeyDownInner(e) {
    if (e.key === 'b' || e.key === 'B') { if (this.state.images.length) this.toggleDrawBox(); return; }
    if (e.key === 'm' || e.key === 'M') { if (this.state.images.length) this.toggleDrawMask(); return; }

    if (this.drawMaskMode) {
      if (e.key === 'Enter') { e.preventDefault(); this.finalizeMaskEdit(); this.render(); this.updateStatusBar(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.clearMaskCanvas(); return; }
      if (e.key === 'e' || e.key === 'E') { this.toggleErase(); return; }
      if (e.key === ',') {
        this.brushSize = Math.max(5, this.brushSize - 5);
        this.el.brushSizeSlider.value = this.brushSize;
        this.el.brushSizeVal.textContent = this.brushSize;
        this.render();
        return;
      }
      if (e.key === '.') {
        this.brushSize = Math.min(80, this.brushSize + 5);
        this.el.brushSizeSlider.value = this.brushSize;
        this.el.brushSizeVal.textContent = this.brushSize;
        this.render();
        return;
      }
    }

    if (this.state.activeRegions.length === 0 && e.key !== 'h' && e.key !== 'H') return;

    if (e.key === 'h' || e.key === 'H') {
      if (!e.repeat) {
        this.hideOverlays = !this.hideOverlays;
        this.render();
      }
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedRegionId !== null) {
        e.preventDefault();
        if (this.maskEditId === this.selectedRegionId) this.maskEditId = null;
        this.state.activeRegions = this.state.activeRegions.filter(r => r.id !== this.selectedRegionId);
        delete this.state.selections[this.selectedRegionId];
        this.selectedRegionId = null;
        this.updateStatusBar();
        this.el.exportBtn.disabled = this.state.activeRegions.length === 0;
        this.render();
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      this.focusedRegion = (this.focusedRegion + (e.shiftKey ? -1 : 1) + this.state.activeRegions.length) % this.state.activeRegions.length;
      this.selectedRegionId = this.state.activeRegions[this.focusedRegion]?.id ?? null;
      this.flashRegion(this.state.activeRegions[this.focusedRegion]);
    } else if (e.key === '[' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const r = this.state.activeRegions[this.focusedRegion];
      if (r) this.cycleRegion(r, -1);
    } else if (e.key === ']' || e.key === 'ArrowRight') {
      e.preventDefault();
      const r = this.state.activeRegions[this.focusedRegion];
      if (r) this.cycleRegion(r, 1);
    }
  }

  flashRegion(region) {
    this.render();
    if (!region) return;
    const ctx = this.stack.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 4;
    ctx.strokeRect(region.x, region.y, region.w, region.h);
    ctx.restore();
    setTimeout(() => this.render(), 200);
  }

  toggleDrawBox() {
    this.drawBoxMode = !this.drawBoxMode;
    if (this.drawBoxMode) {
      this.el.drawBoxBtn.classList.add('active-toggle');
      this.stack.setCursor('crosshair');
    } else {
      this.el.drawBoxBtn.classList.remove('active-toggle');
      this.stack.setCursor('pointer');
      this.drawBoxDrag = null;
    }
    this.updateStatusBar();
  }

  toggleDrawMask() {
    this.drawMaskMode = !this.drawMaskMode;
    if (this.drawMaskMode) {
      if (this.drawBoxMode) this.toggleDrawBox();
      this.el.drawMaskBtn.classList.add('active-toggle');
      this.el.brushControls.style.display = '';
      this.el.eraseToggleBtn.style.display = '';
      this.stack.setCursor('crosshair');
      this.initMaskCanvas();
    } else {
      this.finalizeMaskEdit();
      this.el.drawMaskBtn.classList.remove('active-toggle');
      this.el.brushControls.style.display = 'none';
      this.el.eraseToggleBtn.style.display = 'none';
      this.stack.setCursor('pointer');
      this.maskPaintCanvas = null;
      this.maskPaintCtx = null;
    }
    this.updateStatusBar();
    this.render();
  }

  toggleErase() {
    this.eraseMode = !this.eraseMode;
    this.el.eraseToggleBtn.textContent = `Erase: ${this.eraseMode ? 'On' : 'Off'}`;
    this.el.eraseToggleBtn.classList.toggle('active-toggle', this.eraseMode);
    this.render();
  }

  initMaskCanvas() {
    if (!this.maskPaintCanvas) this.maskPaintCanvas = document.createElement('canvas');
    this.maskPaintCanvas.width = this.state.width;
    this.maskPaintCanvas.height = this.state.height;
    this.maskPaintCtx = this.maskPaintCanvas.getContext('2d');
    this.maskPaintCtx.clearRect(0, 0, this.state.width, this.state.height);
    this.stack.clearOverlay();
  }

  paintBrush(x, y, prevX, prevY) {
    if (!this.maskPaintCtx) return;
    if (!this.eraseMode) {
      // Track stroke bbox (paint only — erasing never grows the box)
      const r = this.brushSize / 2;
      const b = this.strokeBBox;
      if (!b) this.strokeBBox = { x: x - r, y: y - r, w: this.brushSize, h: this.brushSize };
      else {
        const nx = Math.min(b.x, x - r), ny = Math.min(b.y, y - r);
        const mx = Math.max(b.x + b.w, x + r), my = Math.max(b.y + b.h, y + r);
        this.strokeBBox = { x: nx, y: ny, w: mx - nx, h: my - ny };
      }
    }
    const mctx = this.maskPaintCtx;
    mctx.lineWidth = this.brushSize;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    if (this.eraseMode) {
      mctx.globalCompositeOperation = 'destination-out';
      mctx.strokeStyle = 'rgba(0,0,0,1)';
      mctx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      mctx.globalCompositeOperation = 'source-over';
      mctx.strokeStyle = 'rgba(255, 100, 255, 1)';
      mctx.fillStyle = 'rgba(255, 100, 255, 1)';
    }
    if (prevX !== null && prevY !== null) {
      mctx.beginPath();
      mctx.moveTo(prevX, prevY);
      mctx.lineTo(x, y);
      mctx.stroke();
    }
    mctx.beginPath();
    mctx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
    mctx.fill();
    mctx.globalCompositeOperation = 'source-over';
  }

  // ── Region/mask unification helpers ──

  topmostRegionAt(x, y) {
    for (let i = this.state.activeRegions.length - 1; i >= 0; i--) {
      const r = this.state.activeRegions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  beginPaint(x, y) {
    this.paintArm = null;
    this.isPainting = true;
    this.lastPaintX = x;
    this.lastPaintY = y;
    this.paintBrush(x, y, null, null);
    this.stack.ensureOverlay();
    this.render({ skipMask: true });
    this.drawMaskOverlay();
  }

  autoGrowBox() {
    // Box auto-grows to contain strokes that extend outside it.
    const r = this.state.activeRegions.find(r => r.id === this.maskEditId);
    const b = this.strokeBBox;
    if (!r || !b) return;
    const pad = 2;
    const nx = Math.max(0, Math.min(r.x, Math.floor(b.x) - pad));
    const ny = Math.max(0, Math.min(r.y, Math.floor(b.y) - pad));
    const mx = Math.min(this.state.width, Math.max(r.x + r.w, Math.ceil(b.x + b.w) + pad));
    const my = Math.min(this.state.height, Math.max(r.y + r.h, Math.ceil(b.y + b.h) + pad));
    if (nx !== r.x || ny !== r.y || mx !== r.x + r.w || my !== r.y + r.h) {
      r.x = nx; r.y = ny; r.w = mx - nx; r.h = my - ny;
    }
  }

  finalizeMaskEdit() {
    // Bake the working mask into the region currently being edited (if any).
    const r = this.state.activeRegions.find(r => r.id === this.maskEditId);
    if (r && this.maskPaintCanvas && this.maskPaintCtx) {
      r.maskCanvas = this.cropCanvas(this.maskPaintCanvas, r.x, r.y, r.w, r.h);
    }
    this.maskEditId = null;
    this.strokeBBox = null;
    this.paintArm = null;
  }

  clearMaskCanvas() {
    // Esc: reset the working mask to the region's last committed mask (or blank).
    if (!this.maskPaintCtx) return;
    this.maskPaintCtx.clearRect(0, 0, this.state.width, this.state.height);
    const r = this.state.activeRegions.find(r => r.id === this.maskEditId);
    if (r && r.maskCanvas) this.maskPaintCtx.drawImage(r.maskCanvas, r.x, r.y);
    this.strokeBBox = null;
    this.stack.clearOverlay();
    this.render();
  }

  // ── Repaint (ComfyUI Krea2 inpaint via EllieEdit relay) ──
  boxMaskCanvas(region) {
    const m = document.createElement('canvas');
    m.width = this.state.width;
    m.height = this.state.height;
    const mc = m.getContext('2d');
    const feather = Math.max(8, Math.min(20, region.w / 3, region.h / 3));
    mc.filter = `blur(${(feather / 2).toFixed(1)}px)`;
    mc.fillStyle = '#ffffff';
    const inset = feather / 2;
    mc.fillRect(region.x + inset, region.y + inset, region.w - feather, region.h - feather);
    mc.filter = 'none';
    return m;
  }

  currentSourceCanvas() {
    const src = document.createElement('canvas');
    src.width = this.state.width;
    src.height = this.state.height;
    const sctx = src.getContext('2d');
    sctx.putImageData(this.state.images[this.state.baseVariant].processedData, 0, 0);
    if (this.stack.editLayer) sctx.drawImage(this.stack.editLayer, 0, 0);
    return src;
  }

  // Composite a raw response image into the region's preview variant at the
  // EXACT crop rect — masked to the painted mask, or feathered at the rect
  // edges. This canvas (plus rect) is what previews, what Keep stores, what
  // renders, and what Export paints. No re-projection ever happens.
  // Layer pixels, split in two (F1, 2026-10-21): the RAW model output at rect
  // size, and the DERIVED masked canvas. Keeping raw is what makes a generated
  // layer re-maskable — the masked canvas is only ever a cache of raw ∩ mask.
  makeRawLayer(img, rect) {
    const c = document.createElement('canvas');
    c.width = rect.w; c.height = rect.h;
    c.getContext('2d').drawImage(img, 0, 0, rect.w, rect.h);
    return c;
  }

  composeLayer(raw, rect, maskLocal) {
    const c = document.createElement('canvas');
    c.width = rect.w; c.height = rect.h;
    const g = c.getContext('2d');
    g.drawImage(raw, 0, 0, rect.w, rect.h);
    if (maskLocal) {
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(maskLocal, 0, 0);
      g.globalCompositeOperation = 'source-over';
    } else {
      this.featherEdges(g, rect.w, rect.h);
    }
    return c;
  }

  // Re-derive a kept gen's masked canvas from its raw output + current mask.
  // Returns false for legacy gens that never stored raw.
  recomposeGen(gen) {
    if (!gen || !gen.raw) return false;
    gen.canvas = this.composeLayer(gen.raw, gen.rect, gen.mask);
    return true;
  }

  // Feathered alpha at canvas edges (same profile as drawFeatheredSource),
  // applied in-place via destination-in.
  featherEdges(g, fw, fh) {
    const feather = Math.min(18, Math.min(fw, fh) / 3.5);
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createLinearGradient(0, 0, fw, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(Math.min(0.3, feather / fw), 'rgba(0,0,0,1)');
    grad.addColorStop(Math.max(0.7, 1 - feather / fw), 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, fw, fh);
    const gradV = g.createLinearGradient(0, 0, 0, fh);
    gradV.addColorStop(0, 'rgba(0,0,0,0)');
    gradV.addColorStop(Math.min(0.3, feather / fh), 'rgba(0,0,0,1)');
    gradV.addColorStop(Math.max(0.7, 1 - feather / fh), 'rgba(0,0,0,1)');
    gradV.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gradV;
    g.fillRect(0, 0, fw, fh);
    g.globalCompositeOperation = 'source-over';
  }

  scanPaintBBox() {
    if (!this.maskPaintCtx) return null;
    const d = this.maskPaintCtx.getImageData(0, 0, this.state.width, this.state.height).data;
    let minX = this.state.width, minY = this.state.height, maxX = -1, maxY = -1;
    for (let y = 0; y < this.state.height; y++) {
      for (let x = 0; x < this.state.width; x++) {
        if (d[(y * this.state.width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  cropCanvas(src, x, y, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
    return c;
  }

  buildFullSizeMask(croppedMask, x, y) {
    const m = document.createElement('canvas');
    m.width = this.state.width; m.height = this.state.height;
    const mc = m.getContext('2d');
    mc.fillStyle = '#000000';
    mc.fillRect(0, 0, m.width, m.height);
    mc.drawImage(croppedMask, x, y);
    return m;
  }

  async generateRepaint() {
    if (!this.state.images.length) { alert('Load images first.'); return; }
    this.finalizeMaskEdit(); // bake any in-progress mask edit before priority scan
    // Source priority: selected box → in-progress painted mask → last
    // painted-mask region. Every generation lands on a region — if none exists
    // yet, its region is created NOW (single source of truth).
    let region = this.state.activeRegions.find(r => r.id === this.selectedRegionId);
    let win = null;
    let maskCropped = null;
    if (region) {
      win = { x: Math.round(region.x), y: Math.round(region.y), w: Math.round(region.w), h: Math.round(region.h) };
      if (region.maskCanvas) maskCropped = region.maskCanvas;
    } else {
      const bbox = this.drawMaskMode ? this.scanPaintBBox() : null;
      if (bbox) {
        win = bbox;
        maskCropped = this.cropCanvas(this.maskPaintCanvas, bbox.x, bbox.y, bbox.w, bbox.h);
      } else {
        for (let i = this.state.activeRegions.length - 1; i >= 0; i--) {
          const r = this.state.activeRegions[i];
          if (r.maskCanvas) {
            region = r;
            win = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
            maskCropped = r.maskCanvas;
            break;
          }
        }
      }
    }
    if (!win) {
      this.jobs.note('Draw a box (B) or paint a mask (M) to generate');
      return;
    }
    if (!region) {
      region = { x: win.x, y: win.y, w: win.w, h: win.h, id: this.nextRegionId++, manual: true, status: 'idle' };
      this.state.activeRegions.push(region);
      this.state.selections[region.id] = this.state.baseVariant;
      this.selectedRegionId = region.id;
      this.el.exportBtn.disabled = false;
    }
    if (region.status === 'generating') return; // one live generation per region
    if (region.status === 'preview') { region.preview = null; region.status = region.gens?.length ? 'kept' : 'idle'; }
    region.maskCanvas ??= maskCropped ?? null;

    const prompt = this.el.repaintPromptInput.value.trim(); // may be empty — conditioning from context only
    const denoise = parseFloat(this.el.denoiseSlider.value);
    const variantCount = parseInt(this.el.variantCountSelect.value) || 1;
    const randomize = this.el.randomizeSeed.checked;
    let baseSeed = parseInt(this.el.seedInput.value);
    if (randomize) {
      // Pick a fresh seed now and write it into the box BEFORE generating:
      // the box always shows the seed actually used, so unchecking random
      // afterward reproduces this exact run.
      baseSeed = Math.floor(Math.random() * 2 ** 31);
      this.el.seedInput.value = baseSeed;
    } else if (isNaN(baseSeed)) {
      baseSeed = Math.floor(Math.random() * 2 ** 31);
      this.el.seedInput.value = baseSeed;
    }
    const seeds = [];
    for (let i = 0; i < variantCount; i++) {
      seeds.push(randomize ? Math.floor(Math.random() * 2 ** 31) : baseSeed + i);
    }

    // Region-status transition: region enters 'generating' with its own preview
    // shell. Unified pipeline (2026-10-07d): crop to bbox + ~32% context ring,
    // inpaint at working res, result composited back at the exact crop rect.
    // Detail crop ON adds a fixed 1.5× enlargement (longest side clamped to
    // 2048); OFF works at native crop size. No multiplier control.
    const useDetail = this.el.detailCrop.checked;
    const pct = 0.32;
    const pad = Math.round(pct * Math.max(win.w, win.h));
    const cx = Math.max(0, win.x - pad);
    const cy = Math.max(0, win.y - pad);
    const cw = Math.min(this.state.width, win.x + win.w + pad) - cx;
    const ch = Math.min(this.state.height, win.y + win.h + pad) - cy;
    const target = useDetail ? Math.min(2048, Math.round(Math.max(cw, ch) * 1.5)) : Math.max(cw, ch);
    const scale = target / Math.max(cw, ch);
    const even = n => Math.max(2, Math.floor(n / 2) * 2);
    const cw2 = even(cw * scale), ch2 = even(ch * scale);

    const sendImg = document.createElement('canvas');
    sendImg.width = cw2; sendImg.height = ch2;
    sendImg.getContext('2d').drawImage(this.currentSourceCanvas(), cx, cy, cw, ch, 0, 0, cw2, ch2);

    const maskFull = maskCropped ? this.buildFullSizeMask(maskCropped, win.x, win.y) : this.boxMaskCanvas(win);
    const sendMask = document.createElement('canvas');
    sendMask.width = cw2; sendMask.height = ch2;
    const smc = sendMask.getContext('2d');
    smc.fillStyle = '#000000';
    smc.fillRect(0, 0, cw2, ch2);
    // maskFull is in full-image coords: copy the win rect out of it, place at
    // the scaled crop offset.
    smc.drawImage(maskFull, win.x, win.y, win.w, win.h,
                  (win.x - cx) * scale, (win.y - cy) * scale, win.w * scale, win.h * scale);

    // Preview/kept mask in LOCAL crop coords (rect-sized, like the composited result).
    const maskLocal = document.createElement('canvas');
    maskLocal.width = cw; maskLocal.height = ch;
    maskLocal.getContext('2d').drawImage(maskFull, -cx, -cy);

    const image_b64 = sendImg.toDataURL('image/png').split(',')[1];
    const mask_b64 = sendMask.toDataURL('image/png').split(',')[1];
    this.lastRunInfo = `${useDetail ? 'detail crop · enlarged 1.5×' : 'full native'} · ring ${Math.round(pct * 100)}%${prompt ? '' : ' · no prompt'}`;

    const rect = { x: cx, y: cy, w: cw, h: ch };
    region.preview = { variants: [], raws: [], psel: -1, rect, maskCanvas: maskLocal, outstanding: variantCount };
    region.status = 'generating';

    this.el.generateBtn.disabled = true;
    this.el.generateBtn.textContent = '⏳ 0/' + variantCount;
    this.updateStatusBar();
    this.render();

    const jobId = this.jobs.start('repaint', variantCount);
    const done = () => {
      const pv = region.preview;
      if (pv) pv.outstanding = Math.max(0, (pv.outstanding || 0) - 1);
      this.el.generateBtn.textContent = `⏳ ${variantCount - (pv ? pv.outstanding : variantCount)}/${variantCount}`;
      this.jobs.progress(jobId);
    };

    // Response attaches to THIS region only — structurally incapable of
    // touching any other region's state.
    const attachPreview = (b64) => {
      const img = new Image();
      // Decode accounting: fetch resolution ≠ decode completion. The tail
      // below runs after allSettled while Image decodes may still be pending;
      // it must not reset a region whose results are still decoding.
      const pv0 = region.preview;
      if (pv0) pv0.decoding = (pv0.decoding || 0) + 1;
      img.onload = () => {
        const pv = region.preview;
        if (pv) pv.decoding = Math.max(0, (pv.decoding || 0) - 1);
        if (!pv) return; // discarded/replaced mid-flight; drop it
        const raw = this.makeRawLayer(img, pv.rect);
        const c = this.composeLayer(raw, pv.rect, pv.maskCanvas);
        (pv.raws ??= []).push(raw);   // parallel to pv.variants: index i ↔ variant i
        pv.variants.push(c);
        pv.psel = pv.variants.length - 1;
        region.status = 'preview';
        this.updateStatusBar();
        this.render();
      };
      img.onerror = () => {
        const pv = region.preview;
        if (pv) pv.decoding = Math.max(0, (pv.decoding || 0) - 1);
      };
      img.src = 'data:image/png;base64,' + b64;
    };

    const jobs = [];
    for (let i = 0; i < variantCount; i++) {
      const seed = seeds[i];
      jobs.push(
        fetch(REPAINT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_b64, mask_b64, prompt, denoise, seed }),
        }).then(async r => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.detail || body.error || ('HTTP ' + r.status));
          done();
          attachPreview(body.image_b64);
        }).catch(err => {
          console.error('Repaint failed (seed ' + seed + '):', err);
          done();
          this.jobs.fail(jobId, err.message);
          this.el.statusBar.innerHTML = '<span class="badge" style="color:#e87a7a">⚠️ Repaint failed: ' + String(err.message).slice(0, 160) + '</span>';
        })
      );
    }
    await Promise.allSettled(jobs);
    const pv = region.preview;
    if (pv) pv.outstanding = 0;
    if (pv && !pv.variants.length && !(pv.decoding > 0)) {
      // All responses failed AND nothing is still decoding: fall back to
      // previous status. (If decodes are pending, onload/onerror settles them.)
      region.status = region.gens?.length ? 'kept' : 'idle';
      region.preview = null;
    }
    this.jobs.finish(jobId);
    this.el.generateBtn.disabled = false;
    this.el.generateBtn.textContent = '⚡ Generate';
    this.updateStatusBar();
    this.render();
  }

  // Keep: region transition preview → kept. The EXACT previewed canvas and its
  // rect are stored 1:1 — no re-projection through bbox math. What the preview
  // showed is what renders and what Export paints.
  commitPending() {
    const region = this.state.activeRegions.find(r => r.id === this.selectedRegionId);
    if (!region || region.status !== 'preview' || !region.preview || region.preview.psel < 0) {
      alert('No preview to keep — Generate first.');
      return;
    }
    const pv = region.preview;
    region.gens ??= [];
    const entry = {
      type: 'keep', region,
      before: { status: region.status, gens: region.gens.slice(), gsel: region.gsel ?? -1 },
      after: null, // filled below
    };
    // The gen layer owns its raw output + mask snapshot (re-maskable); its
    // canvas is the exact previewed (derived) canvas, stored 1:1.
    region.gens.push(makeGenLayer({
      raw: pv.raws?.[pv.psel] ?? null, mask: pv.maskCanvas ?? null,
      rect: pv.rect, canvas: pv.variants[pv.psel],
    }));
    region.gsel = region.gens.length - 1;
    region.status = 'kept';
    region.preview = null; // preview consumed: the kept gen now carries it
    // Stash the kept variant so Undo can restore the exact preview transition.
    entry.after = { status: region.status, gens: region.gens.slice(), gsel: region.gsel };
    entry.keptVariant = pv.variants[pv.psel];
    entry.keptRaw = pv.raws?.[pv.psel] ?? null;
    entry.keptRect = { ...pv.rect };
    entry.keptMask = pv.maskCanvas;
    this.undoLog.push(entry);
    this.el.exportBtn.disabled = false;
    this.render();
    this.updateStatusBar();
  }

  discardAction() {
    const region = this.state.activeRegions.find(r => r.id === this.selectedRegionId);
    if (!region) return;
    if (region.status === 'preview') {
      // Discard the preview: back to previous status (kept w/ prior gen, or idle).
      region.preview = null;
      region.status = region.gens?.length ? 'kept' : 'idle';
      this.render();
      this.updateStatusBar();
      return;
    }
    // No preview: discard the selected region's current kept generation (undoable).
    if (region.gens?.length) {
      const idx = (region.gsel ?? -1) >= 0 ? region.gsel : region.gens.length - 1;
      const [gen] = region.gens.splice(idx, 1);
      this.undoLog.push({
        type: 'discard', region,
        before: { status: 'kept', gens: [...region.gens.slice(0, idx), gen, ...region.gens.slice(idx)], gsel: region.gsel ?? -1 },
        after: { status: region.gens.length ? 'kept' : 'idle', gens: region.gens.slice(), gsel: Math.min(idx, region.gens.length - 1) },
        removedIndex: idx,
        removedGen: gen,
      });
      region.gsel = Math.min(idx, region.gens.length - 1);
      if (!region.gens.length) delete region.gsel;
      if (!region.gens.length) region.status = 'idle';
      this.render();
      this.updateStatusBar();
    }
  }

  undo() {
    // Global stack of { region, before, after } status transitions.
    const entry = this.undoLog.pop();
    if (!entry) return;
    const region = entry.region;
    if (!this.state.activeRegions.includes(region)) return; // region deleted
    const b = entry.before;
    region.gens = b.gens.slice();
    if (b.gsel >= 0) region.gsel = b.gsel; else delete region.gsel;
    if (entry.type === 'keep') {
      // Reverse the transition: back to preview with the exact kept variant.
      if (entry.keptVariant) {
        region.preview = { variants: [entry.keptVariant], raws: [entry.keptRaw ?? null], psel: 0, rect: entry.keptRect, maskCanvas: entry.keptMask ?? null, outstanding: 0 };
        region.status = 'preview';
      } else {
        region.preview = null;
        region.status = region.gens.length ? 'kept' : 'idle';
      }
    } else if (entry.type === 'discard') {
      region.preview = null;
      region.status = region.gens.length ? 'kept' : 'idle';
    }
    this.render();
    this.updateStatusBar();
  }

  renderGenStrip() {
    const strip = this.el.genStrip;
    if (!strip) return;
    strip.innerHTML = '';
    const region = this.state.activeRegions.find(r => r.id === this.selectedRegionId);
    if (!region?.gens?.length) { strip.style.display = 'none'; return; }
    strip.style.display = 'flex';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = `gens ${region.gens.length}`;
    strip.appendChild(label);
    region.gens.forEach((gen, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'gen-thumb' + (i === (region.gsel ?? 0) ? ' current' : '');
      const th = document.createElement('canvas');
      th.width = 64; th.height = 48;
      th.getContext('2d').drawImage(gen.canvas, 0, 0, 64, 48);
      wrap.appendChild(th);
      const del = document.createElement('button');
      del.className = 'gen-del';
      del.textContent = '×';
      del.addEventListener('click', ev => {
        ev.stopPropagation();
        const before = { status: region.status, gens: region.gens.slice(), gsel: region.gsel ?? -1 };
        region.gens.splice(i, 1);
        region.gsel = Math.min(i, region.gens.length - 1);
        if (!region.gens.length) { delete region.gsel; region.status = 'idle'; }
        this.undoLog.push({ type: 'discard', region,
          before,
          after: { status: region.status, gens: region.gens.slice(), gsel: region.gsel ?? -1 } });
        this.render();
        this.updateStatusBar();
      });
      wrap.appendChild(del);
      wrap.addEventListener('click', () => { region.gsel = i; this.render(); this.updateStatusBar(); });
      strip.appendChild(wrap);
    });
  }

  toggleLayer() {
    this.stack.editLayerVisible = !this.stack.editLayerVisible;
    this.el.layerToggleBtn.textContent = this.stack.editLayerVisible ? '👁 Edit layer: On' : '👁 Edit layer: Off';
    this.el.layerToggleBtn.classList.toggle('active-toggle', !this.stack.editLayerVisible);
    this.render();
  }

  // ── Dupe→Meld (2026-10-08g) ─────────────────────────────────────────
  // Explicit exits for a meld batch. Save back posts the blend to the
  // server (new auto-named gallery-root file + ledger ACCEPTED + every
  // component onto the deletion queue), then returns to the Dupe family.
  // Cancel returns marking NOTHING — no fetch, no writes.
  paintMeldBar() {
    if (!this.el.meldBar) return;
    const on = !!this.meldCtx;
    this.el.meldBar.style.display = on ? 'flex' : 'none';
    if (on) {
      this.el.meldMsg.textContent =
        `⑂ Meld batch from family ${this.meldCtx.family} (${this.meldCtx.members.length} members). ` +
        `Save back collapses the group; Cancel writes nothing.`;
    }
  }

  async meldSaveBack() {
    const ctx = this.meldCtx;
    if (!ctx) return;
    try {
      const blob = await this.exportBlob();
      if (!blob) throw new Error('nothing blended to save');
      const b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result.split(',')[1]);
        fr.onerror = () => rej(new Error('blob read failed'));
        fr.readAsDataURL(blob);
      });
      const r = await fetch(`/api/dupe/families/${encodeURIComponent(ctx.family)}/meld-save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: b64, members: ctx.members }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      const j = await r.json();
      this.meldCtx = null;
      this.resetAll();
      window.dispatchEvent(new CustomEvent('ellieedit:activate', { detail: { name: 'dupe' } }));
      window.dispatchEvent(new CustomEvent('ellieedit:dupe-meld-saved',
        { detail: { family: ctx.family, saved_as: j.saved_as } }));
    } catch (err) {
      alert('Meld save-back failed: ' + err.message);
    }
  }

  // ── Zoom + pan (Task 6) ───────────────────────────────────────────────
  // 25% … Fit (100%, the default + rest position) … 300%. The useful travel is
  // DOWNWARD (shrink for overview/margin); above fit the .fc-canvas-wrap scrolls. Level
  // persists in localStorage. Touch pan = two-finger drag on the wrap (the
  // paint path ignores non-primary pointers, so a second finger is free);
  // mouse users pan with scrollbars/wheel.
  initZoom() {
    const KEY = 'ellieedit.facecycle.zoom';
    let pct = 100;
    try { pct = Number(localStorage.getItem(KEY)) || 100; } catch (e) {}
    this.setZoomPct = (v, persist = true) => {
      pct = Math.min(300, Math.max(25, Math.round(Number(v) || 100)));
      this.stack.setZoom(pct / 100);
      this.el.zoomSlider.value = String(pct);
      this.el.zoomVal.textContent = pct === 100 ? 'Fit' : pct + '%';
      if (persist) { try { localStorage.setItem(KEY, String(pct)); } catch (e) {} }
      if (this.state.images.length) this.render();
    };
    this.el.zoomSlider.addEventListener('input', () => this.setZoomPct(this.el.zoomSlider.value));
    this.el.zoomFitBtn.addEventListener('click', () => this.setZoomPct(100));
    this.stack.zoom = pct / 100;                       // applied on first setSize
    this.el.zoomSlider.value = String(pct);
    this.el.zoomVal.textContent = pct === 100 ? 'Fit' : pct + '%';
    const c = this.el.canvasContainer, touches = new Map();
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }, true);
    c.addEventListener('pointermove', e => {
      const t = touches.get(e.pointerId);
      if (!t) return;
      const dx = e.clientX - t.x, dy = e.clientY - t.y;
      t.x = e.clientX; t.y = e.clientY;
      if (touches.size >= 2) { c.scrollLeft -= dx / touches.size; c.scrollTop -= dy / touches.size; }
    }, true);
    const up = e => touches.delete(e.pointerId);
    c.addEventListener('pointerup', up, true);
    c.addEventListener('pointercancel', up, true);
  }

  // ── Replace sources (work order 2026-10-13, Task 8/9 revision) ───────
  // Final image -> the BASE image's folder; every source image with a known
  // path -> the existing deletion queue. No confirm step: the queue is the
  // safety net. Hidden-with-hint when the stack has no provenance.
  replaceInfo() {
    const imgs = this.state.images;
    const base = imgs[this.state.baseVariant];
    const srcs = imgs.filter(im => im.srcPath).map(im => im.srcPath);
    if (!this.prov || !srcs.length) return { ok: false, hint: 'Replace sources is available for images handed off from Gallery or a Dupe family.' };
    if (!base || !base.srcPath) return { ok: false, hint: 'Click a thumbnail that came from Gallery/Dupe to make it the base.' };
    const folder = base.srcPath.includes('/') ? base.srcPath.slice(0, base.srcPath.lastIndexOf('/')) : '(root)';
    return { ok: true, base, srcs, folder };
  }

  paintReplaceBar() {
    if (!this.el.replaceBtn) return;
    const hasImages = this.state.images.length > 0;
    this.el.replaceBtn.style.display = hasImages ? '' : 'none';
    if (!hasImages) return;
    const info = this.replaceInfo();
    this.el.replaceBtn.disabled = !info.ok;
    this.el.replaceBtn.title = info.ok
      ? `♻ Result → ${info.folder}/ (next to base ${info.base.name}). ${info.srcs.length} source${info.srcs.length !== 1 ? 's' : ''} → deletion queue.`
      : info.hint;
  }

  async replaceSources() {
    const info = this.replaceInfo();
    if (!info.ok) return;
    this.el.replaceBtn.disabled = true;
    try {
      const blob = await this.exportBlob();
      if (!blob) throw new Error('nothing to save');
      const b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result.split(',')[1]);
        fr.onerror = () => rej(new Error('blob read failed'));
        fr.readAsDataURL(blob);
      });
      const kind = this.prov.kind, family = this.prov.family;
      const r = await fetch('/api/facecycle/replace-sources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: b64, kind, family, base: info.base.srcPath, sources: info.srcs }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      const j = await r.json();
      this.meldCtx = null;
      this.resetAll();
      if (kind === 'dupe' && family) {
        window.dispatchEvent(new CustomEvent('ellieedit:activate', { detail: { name: 'dupe' } }));
        window.dispatchEvent(new CustomEvent('ellieedit:dupe-meld-saved',
          { detail: { family, saved_as: j.saved_as } }));
      } else {
        this.el.statusBar.textContent = `♻ Saved ${j.saved_as} · ${j.pending_added} source${j.pending_added !== 1 ? 's' : ''} queued for deletion`;
        // Manual gallery update (2026-10-16g): no alert, no gallery reload —
        // the Gallery slides the new file into its grid in place.
        window.dispatchEvent(new CustomEvent('ellieedit:gallery-file-added', { detail: { path: j.saved_as } }));
      }
    } catch (err) {
      alert('Replace sources failed: ' + err.message);
      this.paintReplaceBar();
    }
  }

  meldCancel() {
    this.meldCtx = null;
    this.paintMeldBar();
    window.dispatchEvent(new CustomEvent('ellieedit:activate', { detail: { name: 'dupe' } }));
  }

  exportBlob() {
    if (!this.state.images.length) return Promise.resolve(null);
    const exp = document.createElement('canvas');
    exp.width = this.state.width;
    exp.height = this.state.height;
    const ectx = exp.getContext('2d');
    const baseV = this.state.baseVariant;
    ectx.putImageData(this.state.images[baseV].processedData, 0, 0);
    if (this.stack.editLayer) ectx.drawImage(this.stack.editLayer, 0, 0);
    this.drawRegionState(ectx, { exporting: true });
    return new Promise(res => exp.toBlob(res, 'image/png'));
  }

  exportComposite() {
    const exp = document.createElement('canvas');
    exp.width = this.state.width;
    exp.height = this.state.height;
    const ectx = exp.getContext('2d');
    const baseV = this.state.baseVariant;
    ectx.putImageData(this.state.images[baseV].processedData, 0, 0);
    if (this.stack.editLayer) ectx.drawImage(this.stack.editLayer, 0, 0);
    this.drawRegionState(ectx, { exporting: true });
    exp.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'facecycle_composite.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }
}

registerModule({
  name: 'facecycle',
  label: 'FaceCycle',
  icon: '🎨',
  order: 10,
  mount(panel, jobbar) {
    new FaceCycle(panel, jobbar);
  },
});
