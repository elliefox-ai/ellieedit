// FaceCycle module for EllieEdit — behavior ported 1:1 from
// /home/zengonzo/workspace/facecycle/index.html (commit 18cb4e3 era):
// single-image start, multi-variant diff regions, box/mask repaint via
// pending-preview Keep/Discard/Undo, mask-generate source priority
// (selected box → in-progress painted mask → last painted-mask region),
// denoise slider driving BasicScheduler server-side.

import { registerModule } from '../shell.js';
import { CanvasStack, drawFeatheredSource, drawMaskedSource } from '../components/canvas-stack.js';
import { PendingPreview } from '../components/pending.js';
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
    .fc-status { font-size: 12px; color: #6c6c8e; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .fc-status .badge { background: #2a2a44; padding: 2px 8px; border-radius: 10px; font-size: 11px; color: #b0b0d0; }
    .fc-status .help { color: #6c6c8e; }
    .fc-canvas-wrap { flex: 1; display: flex; justify-content: center; align-items: center; overflow: auto; min-height: 0; }
    .fc-thumbs {
      display: flex; gap: 6px; padding: 8px 10px; background: #161628; border-radius: 8px;
      overflow-x: auto; border: 1px solid #2a2a44; transition: border-color .2s, background .2s;
    }
    .fc-thumbs.drag-over { border-color: #7a6aaa; background: rgba(90,74,138,0.08); }
    .thumb { position: relative; border-radius: 4px; overflow: hidden; border: 2px solid transparent; cursor: pointer; flex-shrink: 0; }
    .thumb img { display: block; height: 56px; width: auto; }
    .thumb .label { position: absolute; bottom: 2px; left: 2px; background: rgba(0,0,0,0.75); color: #d4d4e0; font-size: 10px; padding: 1px 5px; border-radius: 2px; font-family: monospace; }
    .thumb.current { border-color: #7a6aaa; }
    .thumb-del { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; background: rgba(0,0,0,0.75); color: #d4d4e0; border: none; border-radius: 50%; font-size: 13px; line-height: 14px; text-align: center; cursor: pointer; opacity: 0; transition: opacity .15s; padding: 0; }
    .thumb:hover .thumb-del { opacity: 1; }
    .thumb-del:hover { background: rgba(200,60,60,0.85); }
    .seed-echo { font-size: 11px; color: #7de08a; cursor: pointer; }
    .seed-echo:empty { display: none; }
  </style>
  <div class="fc-header">
    <div class="fc-row top">
      <h1>FaceCycle <span class="subtitle">— pick the best variant for each changed region</span></h1>
      <div class="fc-row">
        <button class="ee-btn" data-act="reset">New Images</button>
        <button class="ee-btn primary" data-act="export" disabled>Export</button>
      </div>
    </div>
    <div class="fc-row" data-group="controls">
      <label>Diff sensitivity <input type="range" data-id="threshold" min="3" max="80" value="20"><span class="val" data-id="threshold-val">20</span></label>
      <label>Min region <input type="range" data-id="min-size" min="200" max="20000" value="1000" step="200"><span class="val" data-id="min-size-val">1k</span></label>
      <label>Max region <input type="range" data-id="max-size" min="2000" max="500000" value="500000" step="2000"><span class="val" data-id="max-size-val">&infin;</span></label>
      <button class="ee-btn" data-act="detect">🔍 Detect Faces</button>
      <button class="ee-btn" data-act="click-add">👆 Click Face</button>
      <button class="ee-btn" data-act="draw-box">✏️ Draw Box</button>
      <button class="ee-btn" data-act="draw-mask">🖌️ Draw Mask</button>
      <label data-id="brush-controls" style="display:none">Brush <input type="range" data-id="brush-size" min="5" max="80" value="25"><span class="val" data-id="brush-size-val">25</span></label>
      <button class="ee-btn" data-act="erase" style="display:none">Erase: Off</button>
      <select data-id="face-mode"><option value="add">Add to regions</option><option value="replace">Replace regions</option></select>
      <button class="ee-btn" data-act="remove-all">Remove All</button>
    </div>
    <div class="fc-row" data-group="repaint">
      <label>Prompt <input type="text" data-id="repaint-prompt" placeholder="repaint prompt… (select a box, then Generate)" size="44"></label>
      <label>Denoise <input type="range" data-id="denoise" min="0.3" max="0.8" step="0.05" value="0.5"><span class="val" data-id="denoise-val">0.5</span></label>
      <label>Seed <input type="number" data-id="seed-input" placeholder="random"></label>
      <label><input type="checkbox" data-id="randomize-seed" checked> Randomize each</label>
      <span class="seed-echo" data-id="seed-echo" title="Click to adopt this seed (turns randomize off)"></span>
      <label><input type="checkbox" data-id="detail-crop" checked> Detail crop</label>
      <label>Variants <select data-id="variant-count"><option value="1" selected>1</option><option value="2">2</option><option value="4">4</option></select></label>
      <button class="ee-btn primary" data-act="generate">⚡ Generate</button>
      <button class="ee-btn" data-act="keep">✓ Keep</button>
      <button class="ee-btn" data-act="discard">✕ Discard</button>
      <button class="ee-btn" data-act="undo">↩ Undo</button>
      <button class="ee-btn" data-act="layer-toggle">👁 Edit layer: On</button>
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
    <div class="fc-canvas-wrap" data-id="canvas-container"></div>
    <div class="fc-thumbs" data-id="thumbnail-strip"></div>
  </div>`;
}

class FaceCycle {
  constructor(panel, jobbarEl) {
    panel.innerHTML = panelHTML();
    this.panel = panel;
    const $ = id => panel.querySelector(`[data-id="${id}"]`);
    const act = name => panel.querySelector(`[data-act="${name}"]`);
    this.el = {
      dropZone: $('drop-zone'), mainView: $('main-view'), fileInput: $('file-input'),
      thumbnailStrip: $('thumbnail-strip'), canvasContainer: $('canvas-container'),
      statusBar: $('status-bar'), exportBtn: act('export'), resetBtn: act('reset'),
      removeAllBtn: act('remove-all'), detectBtn: act('detect'), clickAddBtn: act('click-add'),
      drawBoxBtn: act('draw-box'), drawMaskBtn: act('draw-mask'),
      brushControls: $('brush-controls'), brushSizeSlider: $('brush-size'),
      brushSizeVal: $('brush-size-val'), eraseToggleBtn: act('erase'),
      faceModeSelect: $('face-mode'), repaintPromptInput: $('repaint-prompt'),
      denoiseSlider: $('denoise'), denoiseVal: $('denoise-val'), seedInput: $('seed-input'),
      randomizeSeed: $('randomize-seed'), detailCrop: $('detail-crop'), seedEcho: $('seed-echo'),
      variantCountSelect: $('variant-count'), generateBtn: act('generate'),
      keepBtn: act('keep'), discardBtn: act('discard'), undoBtn: act('undo'),
      layerToggleBtn: act('layer-toggle'),
      threshold: $('threshold'), thresholdVal: $('threshold-val'),
      minSize: $('min-size'), minSizeVal: $('min-size-val'),
      maxSize: $('max-size'), maxSizeVal: $('max-size-val'),
    };

    this.jobs = new JobPanel(jobbarEl);

    // ── State (same shape as the original) ──
    this.state = { images: [], width: 0, height: 0, activeRegions: [], selections: {}, baseVariant: 0 };
    this.nextRegionId = 0;
    this.selectedRegionId = null;
    this.clickToAddMode = false;
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
    this.faceModelsLoaded = false;
    this.faceApiLoading = false;
    this.BADGE_H = 20;
    this.RESIZE_TAB_SIZE = 10;

    // Shared canvas stack + pending preview model
    this.stack = new CanvasStack(this.el.canvasContainer, {
      onPointerDown: (e, pt) => this.onPointerDown(e, pt),
      onPointerMove: (e, pts) => this.onPointerMove(e, pts),
      onPointerUp: (e, pt) => this.onPointerUp(e, pt),
      onPointerEnter: () => { this.mouseInCanvas = true; },
      onPointerLeave: () => this.onPointerLeave(),
      onPointerCancel: () => this.onPointerCancel(),
    });
    this.stack.opts.drawContent = (ctx, opts) => this.drawContent(ctx, opts);
    this.pendingStore = new PendingPreview(this.stack, () => this.onPendingChange());
    this.stack.pending = null;

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
    this.el.detectBtn.addEventListener('click', () => this.detectFaces());
    this.el.clickAddBtn.addEventListener('click', () => this.toggleClickToAdd());
    this.el.drawBoxBtn.addEventListener('click', () => this.toggleDrawBox());
    this.el.drawMaskBtn.addEventListener('click', () => this.toggleDrawMask());
    this.el.eraseToggleBtn.addEventListener('click', () => this.toggleErase());
    this.el.brushSizeSlider.addEventListener('input', () => {
      this.brushSize = parseInt(this.el.brushSizeSlider.value);
      this.el.brushSizeVal.textContent = this.brushSize;
      this.render();
    });
    this.el.generateBtn.addEventListener('click', () => this.generateRepaint());
    this.el.keepBtn.addEventListener('click', () => this.commitPending());
    this.el.discardBtn.addEventListener('click', () => this.pendingStore.discard());
    this.el.undoBtn.addEventListener('click', () => this.pendingStore.undo());
    this.el.layerToggleBtn.addEventListener('click', () => this.toggleLayer());
    this.el.exportBtn.addEventListener('click', () => this.exportComposite());
    this.el.repaintPromptInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.generateRepaint(); }
    });
    this.el.seedEcho.addEventListener('click', () => {
      const s = parseInt(this.el.seedEcho.dataset.seed);
      if (!isNaN(s)) { this.el.seedInput.value = s; this.el.randomizeSeed.checked = false; }
    });

    document.addEventListener('keydown', this.onKeyDown = e => {
      if (!this.panel.classList.contains('active')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      this.onKeyDownInner(e);
    });

    window.addEventListener('resize', this.onResize = () => { if (this.state.images.length) this.render(); });
  }

  resetAll() {
    this.state.images = [];
    this.state.activeRegions = [];
    this.state.selections = {};
    this.state.baseVariant = 0;
    this.stack.baseData = null;
    this.stack.editLayer = null;
    this.stack.editLayerVisible = true;
    this.pendingStore.reset();
    this.el.layerToggleBtn.textContent = '👁 Edit layer: On';
    this.el.layerToggleBtn.classList.remove('active-toggle');
    this.nextRegionId = 0;
    this.selectedRegionId = null;
    this.el.thumbnailStrip.innerHTML = '';
    this.el.mainView.style.display = 'none';
    this.el.dropZone.style.display = 'flex';
    this.el.exportBtn.disabled = true;
    if (this.clickToAddMode) this.toggleClickToAdd();
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
      thumb.addEventListener('click', () => {
        this.state.baseVariant = idx;
        this.renderThumbnails();
        this.render();
      });
      this.el.thumbnailStrip.appendChild(thumb);
    });
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
    const pending = this.pendingStore.current;

    this.el.keepBtn.disabled = !pending || pending.vsel < 0;
    this.el.discardBtn.disabled = !pending;
    this.el.undoBtn.disabled = !this.pendingStore.canUndo;

    const pendingBadge = pending
      ? ' <span class="badge" style="color:#7de08a">Preview: ' +
        (pending.vsel >= 0
          ? (pending.vsel + 1) + '/' + pending.variants.length + ' — Keep or Discard'
          : 'generating… ' + pending.generating + ' left') + '</span>'
      : '';

    const selRegion = this.state.activeRegions.find(r => r.id === this.selectedRegionId);
    const maskExists = this.drawMaskMode || this.state.activeRegions.some(r => r.maskCanvas);
    const runBadge = this.lastRunInfo ? ` <span class="badge" style="color:#8ab4e8">${this.lastRunInfo}</span>` : '';
    const maskHint = (selRegion && !selRegion.maskCanvas && maskExists)
      ? ' <span class="badge" style="color:#e87ad0">box selected — Generate overrides painted mask</span>'
      : '';

    if (n === 0) {
      this.el.statusBar.innerHTML = '<span class="badge">' + (this.state.images.length < 2 ? 'Editor ready — draw a box (B) or click a region' : 'No changes detected') + '</span> <span class="help">' + (this.state.images.length < 2 ? 'Type a prompt (or leave empty), select a box, Generate to repaint.' : 'Try lowering sensitivity or min region size.') + '</span>' + pendingBadge + maskHint + runBadge;
      return;
    }

    let parts = [];
    parts.push(`<span class="badge">${n} region${n !== 1 ? 's' : ''}</span>`);
    if (manualCount > 0) parts.push(`<span class="badge" style="color:#e8b84d">${manualCount} manual</span>`);
    let modeIndicator = '';
    if (this.clickToAddMode) modeIndicator = ' <span class="badge" style="color:#e8b84d">👆 Click Face active</span>';
    if (this.drawBoxMode) modeIndicator = ' <span class="badge" style="color:#e8b84d">✏️ Draw Box active</span>';
    if (this.drawMaskMode) modeIndicator = ' <span class="badge" style="color:#e8b84d">🖌️ Draw Mask — click a region to edit its mask · paint adds (box auto-grows) · Enter=apply · Esc=reset · E=erase · ,/. = brush size</span>';
    parts.push('<span class="help">Click a region to cycle • Right-click to go back • Drag tabs to move/resize • H toggles overlays • Del removes selected</span>');
    this.el.statusBar.innerHTML = parts.join(' ') + modeIndicator + pendingBadge + maskHint + runBadge;
  }

  onPendingChange() {
    this.updateStatusBar();
    this.render();
  }

  // ── Rendering ──
  render(opts = {}) {
    this.setBaseLayer();
    this.stack.render(opts);
  }

  // Module content drawn above base/edit/pending: region variants + highlights + mode previews.
  drawContent(ctx, opts = {}) {
    const s = this.state;
    // Region variants
    for (const region of s.activeRegions) {
      if (region.id === opts.skipRegionId) continue;
      const sel = s.selections[region.id] ?? s.baseVariant;
      if (sel === s.baseVariant) continue;
      if (region.maskCanvas) this.drawMaskedRegion(ctx, sel, region);
      else drawFeatheredSource(ctx, this.variantCanvas(sel), region);
    }

    // Highlights
    if (!this.hideOverlays) {
      for (const region of s.activeRegions) {
        const isSelected = region.id === this.selectedRegionId;
        const accentColor = region.manual ? '#e8b84d' : '#64b4ff';
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
    return `${this.getRegionNumber(region)}:${String.fromCharCode(65 + sel)}`;
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
    if (this.clickToAddMode) {
      if (e.button === 0) { e.preventDefault(); this.detectFaceAtPoint(x, y); }
      else if (e.button === 2) { e.preventDefault(); this.toggleClickToAdd(); }
      return;
    }
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
          const region = { x: bx, y: by, w: bw, h: bh, id: this.nextRegionId++, manual: true };
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
        const region = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), id: this.nextRegionId++, manual: true };
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
    const cur = this.state.selections[region.id] ?? this.state.baseVariant;
    const n = this.state.images.length;
    this.state.selections[region.id] = ((cur + dir) % n + n) % n;
    this.render();
  }

  cycleAt(x, y, dir) {
    const pending = this.pendingStore.current;
    if (pending && pending.variants.length > 0) {
      if (x >= pending.x && x <= pending.x + pending.w && y >= pending.y && y <= pending.y + pending.h) {
        this.pendingStore.cycle(dir);
        this.updateStatusBar();
        return;
      }
    }
    for (let i = this.state.activeRegions.length - 1; i >= 0; i--) {
      const r = this.state.activeRegions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        this.cycleRegion(r, dir);
        return;
      }
    }
  }

  onKeyDownInner(e) {
    if (e.key === 'f' || e.key === 'F') { if (this.state.images.length) this.toggleClickToAdd(); return; }
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
      if (this.pendingStore.current && this.pendingStore.current.variants.length > 0) {
        this.pendingStore.cycle(-1);
        this.updateStatusBar();
        return;
      }
      const r = this.state.activeRegions[this.focusedRegion];
      if (r) this.cycleRegion(r, -1);
    } else if (e.key === ']' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (this.pendingStore.current && this.pendingStore.current.variants.length > 0) {
        this.pendingStore.cycle(1);
        this.updateStatusBar();
        return;
      }
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

  // ── Face detection (face-api.js, lazy loaded — as original) ──
  async loadFaceModels() {
    if (this.faceModelsLoaded) return true;
    if (this.faceApiLoading) {
      while (this.faceApiLoading) await new Promise(r => setTimeout(r, 100));
      return this.faceModelsLoaded;
    }
    this.faceApiLoading = true;
    const CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14';
    const MODEL_URL = CDN + '/model';
    try {
      this.el.detectBtn.textContent = '⏳ Loading model…';
      this.el.detectBtn.disabled = true;
      if (!window.faceapi) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = CDN + '/dist/face-api.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('Failed to load face-api.js'));
          document.head.appendChild(s);
        });
      }
      await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      this.faceModelsLoaded = true;
      return true;
    } catch (err) {
      console.error('Face model load failed:', err);
      this.el.statusBar.innerHTML = '<span class="badge">⚠️ Face detection unavailable</span> <span class="help">' + err.message + '</span>';
      return false;
    } finally {
      this.faceApiLoading = false;
      this.el.detectBtn.textContent = '🔍 Detect Faces';
      this.el.detectBtn.disabled = false;
    }
  }

  rectOverlap(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
  }

  async detectFaces() {
    if (this.state.images.length === 0) return;
    const ok = await this.loadFaceModels();
    if (!ok) return;
    this.el.detectBtn.textContent = '⏳ Detecting…';
    this.el.detectBtn.disabled = true;
    try {
      const detCanvas = document.createElement('canvas');
      detCanvas.width = this.state.width;
      detCanvas.height = this.state.height;
      detCanvas.getContext('2d').putImageData(this.state.images[0].processedData, 0, 0);
      const options = new window.faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 });
      const detections = await window.faceapi.detectAllFaces(detCanvas, options);
      if (detections.length === 0) {
        this.el.statusBar.innerHTML = '<span class="badge">No faces detected</span> <span class="help">Try a different image or adjust settings.</span>';
        setTimeout(() => this.updateStatusBar(), 2500);
        return;
      }
      const padPct = 0.15;
      const detectedRegions = detections.map(d => {
        const box = d.box;
        const padW = box.width * padPct;
        const padH = box.height * padPct;
        return {
          x: Math.max(0, Math.round(box.x - padW)),
          y: Math.max(0, Math.round(box.y - padH)),
          w: Math.min(this.state.width, Math.round(box.width + padW * 2)),
          h: Math.min(this.state.height, Math.round(box.height + padH * 2)),
        };
      });
      const mode = this.el.faceModeSelect.value;
      if (mode === 'replace') {
        const manualRegions = this.state.activeRegions.filter(r => r.manual);
        const newAutoRegions = detectedRegions.map(r => ({ ...r, id: this.nextRegionId++, manual: false }));
        this.state.activeRegions = [...newAutoRegions, ...manualRegions];
      } else {
        const existing = [...this.state.activeRegions];
        for (const dr of detectedRegions) {
          let overlaps = false;
          for (const er of existing) {
            const overlapArea = this.rectOverlap(dr, er);
            const drArea = dr.w * dr.h;
            if (drArea > 0 && overlapArea / drArea > 0.5) { overlaps = true; break; }
          }
          if (!overlaps) existing.push({ ...dr, id: this.nextRegionId++, manual: false });
        }
        this.state.activeRegions = existing;
      }
      for (const r of this.state.activeRegions) {
        if (this.state.selections[r.id] === undefined) this.state.selections[r.id] = this.state.baseVariant;
      }
      this.updateStatusBar();
      this.el.exportBtn.disabled = this.state.activeRegions.length === 0;
      this.render();
    } catch (err) {
      console.error('Face detection error:', err);
      this.el.statusBar.innerHTML = '<span class="badge">⚠️ Detection error</span> <span class="help">' + err.message + '</span>';
    } finally {
      this.el.detectBtn.textContent = '🔍 Detect Faces';
      this.el.detectBtn.disabled = false;
    }
  }

  toggleClickToAdd() {
    this.clickToAddMode = !this.clickToAddMode;
    if (this.clickToAddMode) {
      if (this.drawBoxMode) this.toggleDrawBox();
      this.el.clickAddBtn.classList.add('active-toggle');
      this.stack.setCursor('crosshair');
    } else {
      this.el.clickAddBtn.classList.remove('active-toggle');
      this.stack.setCursor('pointer');
    }
    this.updateStatusBar();
  }

  async detectFaceAtPoint(x, y) {
    const ok = await this.loadFaceModels();
    if (!ok) return;
    const cropSize = Math.round(Math.min(this.state.width, this.state.height) * 0.4);
    const halfSize = cropSize / 2;
    const cropX = Math.max(0, Math.round(x - halfSize));
    const cropY = Math.max(0, Math.round(y - halfSize));
    const cropW = Math.min(cropSize, this.state.width - cropX);
    const cropH = Math.min(cropSize, this.state.height - cropY);
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropW;
    cropCanvas.height = cropH;
    cropCanvas.getContext('2d').putImageData(this.state.images[0].processedData, -cropX, -cropY);
    const options = new window.faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.15 });
    try {
      const detections = await window.faceapi.detectAllFaces(cropCanvas, options);
      if (detections.length === 0) {
        this.el.statusBar.innerHTML = '<span class="badge">No face found there</span> <span class="help">Try clicking closer to the center of the face.</span>';
        setTimeout(() => { if (this.clickToAddMode) this.updateStatusBar(); }, 2000);
        return;
      }
      const localX = x - cropX;
      const localY = y - cropY;
      let best = null, bestDist = Infinity;
      for (const d of detections) {
        const cx = d.box.x + d.box.width / 2;
        const cy = d.box.y + d.box.height / 2;
        const dist = Math.hypot(cx - localX, cy - localY);
        if (dist < bestDist) { bestDist = dist; best = d; }
      }
      const box = best.box;
      const padPct = 0.15;
      const padW = box.width * padPct;
      const padH = box.height * padPct;
      const faceRegion = {
        x: Math.max(0, Math.round(box.x + cropX - padW)),
        y: Math.max(0, Math.round(box.y + cropY - padH)),
        w: Math.min(this.state.width, Math.round(box.width + padW * 2)),
        h: Math.min(this.state.height, Math.round(box.height + padH * 2)),
      };
      let overlaps = false;
      for (const er of this.state.activeRegions) {
        const overlap = this.rectOverlap(faceRegion, er);
        if (faceRegion.w * faceRegion.h > 0 && overlap / (faceRegion.w * faceRegion.h) > 0.5) { overlaps = true; break; }
      }
      if (overlaps) {
        this.el.statusBar.innerHTML = '<span class="badge">Already covered</span> <span class="help">That area already has a region.</span>';
        setTimeout(() => { if (this.clickToAddMode) this.updateStatusBar(); }, 2000);
      } else {
        const rid = this.nextRegionId++;
        this.state.activeRegions.push({ ...faceRegion, id: rid, manual: true });
        this.state.selections[rid] = this.state.baseVariant;
        this.selectedRegionId = rid;
        this.updateStatusBar();
        this.el.exportBtn.disabled = this.state.activeRegions.length === 0;
      }
      this.render();
    } catch (err) {
      console.error('Click Face detection error:', err);
      this.el.statusBar.innerHTML = '<span class="badge">⚠️ Detection error</span> <span class="help">' + err.message + '</span>';
    }
  }

  toggleDrawBox() {
    this.drawBoxMode = !this.drawBoxMode;
    if (this.drawBoxMode) {
      if (this.clickToAddMode) this.toggleClickToAdd();
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
      if (this.clickToAddMode) this.toggleClickToAdd();
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

  addPendingVariant(b64) {
    const img = new Image();
    img.onload = () => {
      const p = this.pendingStore.current;
      if (!p) return;
      const c = document.createElement('canvas');
      c.width = this.state.width;
      c.height = this.state.height;
      const cctx = c.getContext('2d');
      if (p.detail) {
        // Detail-crop response arrived at working res — composite back at the
        // exact crop rect (preview + Keep both feather at that rect).
        cctx.drawImage(img, p.detail.cx, p.detail.cy, p.detail.cw, p.detail.ch);
      } else {
        cctx.drawImage(img, 0, 0);
      }
      this.pendingStore.addVariant(c);
    };
    img.src = 'data:image/png;base64,' + b64;
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
    // Source priority: selected box → in-progress painted mask → last painted-mask region.
    let win = null;
    let maskCropped = null;
    const selRegion = this.state.activeRegions.find(r => r.id === this.selectedRegionId);
    if (selRegion) {
      win = { x: Math.round(selRegion.x), y: Math.round(selRegion.y), w: Math.round(selRegion.w), h: Math.round(selRegion.h) };
      if (selRegion.maskCanvas) maskCropped = selRegion.maskCanvas;
    } else {
      const bbox = this.drawMaskMode ? this.scanPaintBBox() : null;
      if (bbox) {
        win = bbox;
        maskCropped = this.cropCanvas(this.maskPaintCanvas, bbox.x, bbox.y, bbox.w, bbox.h);
      } else {
        for (let i = this.state.activeRegions.length - 1; i >= 0; i--) {
          const r = this.state.activeRegions[i];
          if (r.maskCanvas) {
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
    const prompt = this.el.repaintPromptInput.value.trim(); // may be empty — conditioning from context only
    const denoise = parseFloat(this.el.denoiseSlider.value);
    const variantCount = parseInt(this.el.variantCountSelect.value) || 1;
    const randomize = this.el.randomizeSeed.checked;
    let baseSeed = parseInt(this.el.seedInput.value);
    if (!randomize && isNaN(baseSeed)) {
      baseSeed = Math.floor(Math.random() * 2 ** 31);
      this.el.seedInput.value = baseSeed;
    }
    const seeds = [];
    for (let i = 0; i < variantCount; i++) {
      seeds.push(randomize ? Math.floor(Math.random() * 2 ** 31) : baseSeed + i);
    }

    // Generate always replaces any pending preview; drawing/deleting boxes never touches it.
    const useDetail = this.el.detailCrop.checked;
    let pendingWin = win;
    let pendingMaskLocal = null;
    let detail = null;
    let image_b64, mask_b64;
    if (useDetail) {
      // Detail crop: bbox + ~32% context ring → working res (long side 1024,
      // even dims) → inpaint there → composite back at the exact crop rect.
      const pct = 0.32;
      const pad = Math.round(pct * Math.max(win.w, win.h));
      const cx = Math.max(0, win.x - pad);
      const cy = Math.max(0, win.y - pad);
      const cw = Math.min(this.state.width, win.x + win.w + pad) - cx;
      const ch = Math.min(this.state.height, win.y + win.h + pad) - cy;
      const scale = 1024 / Math.max(cw, ch);
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
      smc.drawImage(maskFull, (win.x - cx) * scale, (win.y - cy) * scale, win.w * scale, win.h * scale,
                    (win.x - cx) * scale, (win.y - cy) * scale, win.w * scale, win.h * scale);

      // Preview mask in native crop coords (for mask-shaped pending preview)
      pendingMaskLocal = document.createElement('canvas');
      pendingMaskLocal.width = cw; pendingMaskLocal.height = ch;
      const pmc = pendingMaskLocal.getContext('2d');
      pmc.drawImage(maskFull, -cx, -cy);

      image_b64 = sendImg.toDataURL('image/png').split(',')[1];
      mask_b64 = sendMask.toDataURL('image/png').split(',')[1];
      pendingWin = { x: cx, y: cy, w: cw, h: ch };
      detail = { cx, cy, cw, ch, cw2, ch2 };
      this.lastRunInfo = `detail crop ${cw2}×${ch2} · ring ${Math.round(pct * 100)}%${prompt ? '' : ' · no prompt'}`;
    } else {
      // Legacy full-image behavior.
      image_b64 = this.currentSourceCanvas().toDataURL('image/png').split(',')[1];
      mask_b64 = (maskCropped
        ? this.buildFullSizeMask(maskCropped, win.x, win.y)
        : this.boxMaskCanvas(win)
      ).toDataURL('image/png').split(',')[1];
      pendingMaskLocal = maskCropped
        ? (() => { const c = document.createElement('canvas'); c.width = this.state.width; c.height = this.state.height; c.getContext('2d').drawImage(maskCropped, win.x, win.y); return c; })()
        : null;
      this.lastRunInfo = `full-image${prompt ? '' : ' · no prompt'}`;
    }

    this.pendingStore.begin(pendingWin, { maskCanvas: pendingMaskLocal, variantCount });
    this.stack.pending.detail = detail;

    this.el.generateBtn.disabled = true;
    this.el.generateBtn.textContent = '⏳ 0/' + variantCount;
    this.updateStatusBar();

    const jobId = this.jobs.start('repaint', variantCount);
    const done = () => {
      const p = this.pendingStore.current;
      if (p) p.generating = Math.max(0, (p.generating || 0) - 1);
      this.el.generateBtn.textContent = `⏳ ${variantCount - (p ? p.generating : 0)}/${variantCount}`;
      this.jobs.progress(jobId);
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
          this.addPendingVariant(body.image_b64);
        }).catch(err => {
          console.error('Repaint failed (seed ' + seed + '):', err);
          done();
          this.jobs.fail(jobId, err.message);
          this.el.statusBar.innerHTML = '<span class="badge" style="color:#e87a7a">⚠️ Repaint failed: ' + String(err.message).slice(0, 160) + '</span>';
        })
      );
    }
    await Promise.allSettled(jobs);
    const p = this.pendingStore.current;
    if (p) p.generating = 0;
    this.jobs.finish(jobId);
    this.el.generateBtn.disabled = false;
    this.el.generateBtn.textContent = '⚡ Generate';
    // Seed echo: show what actually ran; click adopts it (reproducible).
    this.el.seedEcho.textContent = 'seed ' + seeds.join(', ');
    this.el.seedEcho.dataset.seed = seeds[0];
    this.updateStatusBar();
    this.render();
  }

  commitPending() {
    const ok = this.pendingStore.keep();
    if (!ok) { alert('No preview to keep — Generate first.'); return; }
    this.el.exportBtn.disabled = false;
  }

  toggleLayer() {
    this.stack.editLayerVisible = !this.stack.editLayerVisible;
    this.el.layerToggleBtn.textContent = this.stack.editLayerVisible ? '👁 Edit layer: On' : '👁 Edit layer: Off';
    this.el.layerToggleBtn.classList.toggle('active-toggle', !this.stack.editLayerVisible);
    this.render();
  }

  exportComposite() {
    const exp = document.createElement('canvas');
    exp.width = this.state.width;
    exp.height = this.state.height;
    const ectx = exp.getContext('2d');
    const baseV = this.state.baseVariant;
    ectx.putImageData(this.state.images[baseV].processedData, 0, 0);
    if (this.stack.editLayer) ectx.drawImage(this.stack.editLayer, 0, 0);
    for (const region of this.state.activeRegions) {
      const sel = this.state.selections[region.id] ?? baseV;
      if (sel === baseV) continue;
      if (region.maskCanvas) this.drawMaskedRegion(ectx, sel, region);
      else drawFeatheredSource(ectx, this.variantCanvas(sel), region);
    }
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
