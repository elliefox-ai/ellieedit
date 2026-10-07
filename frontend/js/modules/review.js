// Review module — compare near-twin renders and merge the best of each.
// Backend: reuses /api/gallery/list|thumb|file for browsing; POST /api/review/save
// writes a blended PNG into the gallery root under "reviewed/".
// Blend is 100% client-side canvas (no server deps): either a draggable split
// wipe (all of B right of the slider) or a rectangle mask (only that rect of B).

import { registerModule } from '../shell.js';

function panelHTML() {
  return `
  <style>
    .rv-header {
      padding: 10px 20px; background: #161628; border-bottom: 1px solid #2a2a44;
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    }
    .rv-header h1 { font-size: 17px; font-weight: 600; color: #e0e0f0; }
    .rv-header .subtitle { color: #6c6c8e; font-weight: 400; font-size: 12px; margin-left: 8px; }
    .rv-header select {
      background: #22223a; color: #d4d4e0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 4px 8px; font-size: 12px; max-width: 220px;
    }
    .rv-status { font-size: 11px; color: #6c6c8e; flex: 1; }
    .rv-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 8px; padding: 12px 16px; overflow-y: auto; flex: 1; align-content: start;
    }
    .rv-cell { position: relative; border-radius: 6px; overflow: hidden; cursor: pointer;
      background: #1a1a2e; aspect-ratio: 1; border: 2px solid transparent; }
    .rv-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .rv-cell.sel { border-color: #7a7aff; }
    .rv-cell .check {
      position: absolute; top: 4px; right: 4px; width: 22px; height: 22px;
      border-radius: 50%; background: rgba(0,0,0,0.55); color: #fff;
      font-size: 13px; line-height: 22px; text-align: center; display: none;
    }
    .rv-cell.sel .check { display: block; background: #5a5aff; }
    .rv-cell .name {
      position: absolute; bottom: 0; left: 0; right: 0; padding: 2px 6px;
      background: rgba(0,0,0,0.6); color: #b0b0d0; font-size: 9px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .rv-full {
      display: none; position: absolute; inset: 0; background: #0a0a14;
      z-index: 60; flex-direction: column;
    }
    .rv-full .bar {
      display: flex; align-items: center; gap: 10px; padding: 10px 16px;
      background: #161628; border-bottom: 1px solid #2a2a44; flex-wrap: wrap;
    }
    .rv-full .bar .fname { color: #b0b0d0; font-size: 12px; flex: 1; min-width: 120px; }
    .rv-stage { flex: 1; position: relative; min-height: 0; display: flex;
      align-items: center; justify-content: center; overflow: hidden; touch-action: none; }
    .rv-stage canvas { max-width: 100%; max-height: 100%; object-fit: contain; }
    .rv-split { position: absolute; top: 0; bottom: 0; width: 3px; background: #e8b84d;
      cursor: ew-resize; display: none; }
    .rv-split::after { content: '⟷'; position: absolute; top: 50%; left: 50%;
      transform: translate(-50%,-50%); background: #e8b84d; color: #111;
      border-radius: 50%; width: 30px; height: 30px; line-height: 30px; text-align: center; }
    .rv-mask-box { position: absolute; border: 2px dashed #e8b84d; background: rgba(232,184,77,0.12);
      display: none; pointer-events: none; }
    .rv-compare { flex: 1; display: none; flex-direction: row; gap: 2px; min-height: 0; }
    .rv-compare .half { flex: 1; position: relative; display: flex; align-items: center;
      justify-content: center; overflow: hidden; }
    .rv-compare .half img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .rv-compare .half .tag { position: absolute; top: 6px; left: 8px; font-size: 11px;
      color: #b0b0d0; background: rgba(0,0,0,0.5); padding: 2px 8px; border-radius: 4px; }
    .rv-compare .half .pick { position: absolute; bottom: 10px; }
    input.rv-name-in {
      background: #22223a; color: #d4d4e0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 4px 8px; font-size: 12px; width: 180px;
    }
    .rv-hint { font-size: 11px; color: #6c6c8e; }
  </style>
  <div class="rv-header">
    <h1>Review <span class="subtitle">— pick &amp; merge the best twin</span></h1>
    <select data-id="dir-select"></select>
    <span class="rv-status" data-id="status"></span>
    <button class="ee-btn primary" data-act="start-review" disabled>Review <span data-id="count">0</span></button>
    <button class="ee-btn" data-act="blend" disabled>Blend</button>
    <button class="ee-btn" data-act="clear-sel">Clear</button>
  </div>
  <div class="rv-grid" data-id="grid"></div>

  <div class="rv-full" data-id="full">
    <div class="bar">
      <span class="fname" data-id="phase-label"></span>
      <button class="ee-btn" data-act="mode-compare">Compare</button>
      <button class="ee-btn" data-act="mode-blend">Blend</button>
      <button class="ee-btn" data-act="exit">✕ Done</button>
    </div>
    <div class="rv-compare" data-id="compare">
      <div class="half">
        <span class="tag">A</span>
        <img data-id="img-a" alt="">
        <button class="ee-btn primary pick" data-act="pick-a">Keep A</button>
      </div>
      <div class="half">
        <span class="tag">B</span>
        <img data-id="img-b" alt="">
        <button class="ee-btn primary pick" data-act="pick-b">Keep B</button>
      </div>
    </div>
    <div class="rv-stage" data-id="stage">
      <canvas data-id="canvas"></canvas>
      <div class="rv-split" data-id="split"></div>
      <div class="rv-mask-box" data-id="maskbox"></div>
    </div>
    <div class="bar">
      <span class="rv-hint" data-id="blend-hint">Drag the divider, or switch to rect mask and drag a box on the image.</span>
      <label class="rv-hint"><input type="checkbox" data-id="use-mask"> rect mask (only masked area from B)</label>
      <input class="rv-name-in" data-id="save-name" placeholder="merged.png">
      <button class="ee-btn primary" data-act="save">Save</button>
    </div>
  </div>`;
}

export class Review {
  constructor(panel) {
    panel.innerHTML = panelHTML();
    this.panel = panel;
    this.el = {
      grid: panel.querySelector('[data-id="grid"]'),
      dirSelect: panel.querySelector('[data-id="dir-select"]'),
      status: panel.querySelector('[data-id="status"]'),
      count: panel.querySelector('[data-id="count"]'),
      startBtn: panel.querySelector('[data-act="start-review"]'),
      blendBtn: panel.querySelector('[data-act="blend"]'),
      full: panel.querySelector('[data-id="full"]'),
      phaseLabel: panel.querySelector('[data-id="phase-label"]'),
      compare: panel.querySelector('[data-id="compare"]'),
      imgA: panel.querySelector('[data-id="img-a"]'),
      imgB: panel.querySelector('[data-id="img-b"]'),
      stage: panel.querySelector('[data-id="stage"]'),
      canvas: panel.querySelector('[data-id="canvas"]'),
      split: panel.querySelector('[data-id="split"]'),
      maskBox: panel.querySelector('[data-id="mask-box"]'),
      useMask: panel.querySelector('[data-id="use-mask"]'),
      saveName: panel.querySelector('[data-id="save-name"]'),
      blendHint: panel.querySelector('[data-id="blend-hint"]'),
    };
    this.items = [];
    this.selected = new Map(); // path -> item
    this.pairs = [];          // compare queue
    this.pairIdx = 0;
    this.winners = [];        // paths kept in the compare loop
    this.blendPair = null;    // {a, b, imgA, imgB}
    this.splitFrac = 0.5;
    this.maskRect = null;     // {x,y,w,h} in image coords
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target.querySelector('img');
        if (img && img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        this.io.unobserve(e.target);
      }
    }, { rootMargin: '300px' });
    this.bindBrowse();
    this.bindFull();
    this.refreshDirs();
  }

  fileUrl(path) { return `/api/gallery/file?path=${encodeURIComponent(path)}`; }

  // ---- browse / multi-select -------------------------------------------
  bindBrowse() {
    this.el.startBtn.addEventListener('click', () => this.startReview());
    this.el.blendBtn.addEventListener('click', () => this.startBlend());
    this.panel.querySelector('[data-act="clear-sel"]').addEventListener('click', () => {
      this.selected.clear();
      for (const c of this.el.grid.children) c.classList.remove('sel');
      this.updateButtons();
    });
  }

  async refreshDirs() {
    try {
      const r = await fetch('/api/gallery/list');
      const data = await r.json();
      const sel = this.el.dirSelect;
      sel.innerHTML = '<option value="">/ (root)</option>';
      for (const d of data.subdirs) {
        const o = document.createElement('option');
        o.value = d; o.textContent = d + '/';
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => this.reload(sel.value));
      this.reload('');
    } catch (err) {
      this.el.status.textContent = 'Backend error: ' + err.message;
    }
  }

  async reload(dir) {
    this.el.grid.innerHTML = '';
    this.items = [];
    this.selected.clear();
    try {
      const r = await fetch('/api/gallery/list?dir=' + encodeURIComponent(dir));
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      let cursor = data.next_cursor;
      this.items.push(...data.items);
      while (cursor) {
        const r2 = await fetch(`/api/gallery/list?dir=${encodeURIComponent(dir)}&cursor=${encodeURIComponent(cursor)}`);
        if (!r2.ok) break;
        const d2 = await r2.json();
        this.items.push(...d2.items);
        cursor = d2.next_cursor;
      }
      for (let i = 0; i < this.items.length; i++) this.addCell(this.items[i], i);
      this.el.status.textContent = `${this.items.length} images`;
    } catch (err) {
      this.el.status.textContent = 'Load failed: ' + err.message;
    }
    this.updateButtons();
  }

  addCell(item, idx) {
    const cell = document.createElement('div');
    cell.className = 'rv-cell';
    const img = document.createElement('img');
    img.dataset.src = `/api/gallery/thumb?path=${encodeURIComponent(item.path)}`;
    img.alt = item.name; img.loading = 'lazy';
    const check = document.createElement('div');
    check.className = 'check'; check.textContent = '✓';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = item.name;
    cell.append(img, check, name);
    cell.addEventListener('click', () => {
      if (this.selected.has(item.path)) {
        this.selected.delete(item.path);
        cell.classList.remove('sel');
      } else {
        this.selected.set(item.path, item);
        cell.classList.add('sel');
      }
      this.updateButtons();
    });
    this.el.grid.appendChild(cell);
    this.io.observe(cell);
  }

  updateButtons() {
    const n = this.selected.size;
    this.el.count.textContent = n;
    this.el.startBtn.disabled = n < 2;
    this.el.blendBtn.disabled = n !== 2;
  }

  // ---- compare loop -----------------------------------------------------
  async startReview() {
    const sel = [...this.selected.values()];
    // Queue: every unordered pair (small N is typical for twin sets).
    this.pairs = [];
    for (let i = 0; i < sel.length; i++)
      for (let j = i + 1; j < sel.length; j++)
        this.pairs.push([sel[i], sel[j]]);
    this.pairIdx = 0;
    this.winners = [];
    this.showFull('Compare');
    this.showPair();
  }

  async showPair() {
    if (this.pairIdx >= this.pairs.length) {
      this.finishReview();
      return;
    }
    const [a, b] = this.pairs[this.pairIdx];
    this.el.phaseLabel.textContent =
      `Compare ${this.pairIdx + 1}/${this.pairs.length} — ${a.name} vs ${b.name}`;
    this.el.imgA.src = this.fileUrl(a.path);
    this.el.imgB.src = this.fileUrl(b.path);
    this.el.compare.style.display = 'flex';
    this.el.stage.style.display = 'none';
  }

  pick(which) {
    if (this.pairIdx >= this.pairs.length) return;
    const [a, b] = this.pairs[this.pairIdx];
    const w = which === 'a' ? a : b;
    if (!this.winners.includes(w.path)) this.winners.push(w.path);
    this.pairIdx++;
    this.showPair();
  }

  finishReview() {
    this.el.phaseLabel.textContent =
      `Done — ${this.winners.length} winner${this.winners.length === 1 ? '' : 's'}: ` +
      this.winners.map(p => p.split('/').pop()).join(', ');
    this.el.compare.style.display = 'none';
    this.el.stage.style.display = 'none';
  }

  // ---- blend -------------------------------------------------------------
  async startBlend() {
    const [a, b] = [...this.selected.values()];
    if (!a || !b) return;
    this.blendPair = { a, b };
    this.showFull('Blend');
    this.el.compare.style.display = 'none';
    this.el.stage.style.display = 'flex';
    this.el.blendHint.textContent =
      `A = ${a.name} · B = ${b.name}. Drag the divider, or rect-mask an area to take from B.`;
    const [imgA, imgB] = await Promise.all([a, b].map(it => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = () => rej(new Error('load ' + it.name));
      im.src = this.fileUrl(it.path);
    })));
    this.blendPair.imgA = imgA;
    this.blendPair.imgB = imgB;
    this.splitFrac = 0.5;
    this.maskRect = null;
    this.el.useMask.checked = false;
    const def = this.el.saveName.value ||
      'merged-' + a.name.replace(/\.[^.]+$/, '') + '+' + b.name.replace(/\.[^.]+$/, '') + '.png';
    this.el.saveName.value = def;
    this.renderBlend();
    this.bindStageGestures();
  }

  renderBlend() {
    const { imgA, imgB } = this.blendPair;
    const cv = this.el.canvas;
    cv.width = imgA.naturalWidth;
    cv.height = imgA.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(imgA, 0, 0);
    const useMask = this.el.useMask.checked;
    this.el.split.style.display = useMask ? 'none' : 'block';
    this.el.maskBox.style.display = useMask ? 'block' : 'none';
    if (useMask) {
      if (this.maskRect && this.maskRect.w > 1 && this.maskRect.h > 1) {
        const { x, y, w, h } = this.maskRect;
        // Feathered rect: blurred white rect as alpha mask over B.
        const feather = Math.max(6, Math.round(Math.min(w, h) * 0.08));
        const out = document.createElement('canvas');
        out.width = cv.width; out.height = cv.height;
        const octx = out.getContext('2d');
        octx.drawImage(imgB, 0, 0);
        const m = document.createElement('canvas');
        m.width = cv.width; m.height = cv.height;
        const mctx = m.getContext('2d');
        mctx.filter = `blur(${feather}px)`;
        mctx.fillStyle = '#fff';
        mctx.fillRect(x + feather, y + feather,
          Math.max(1, w - 2 * feather), Math.max(1, h - 2 * feather));
        octx.globalCompositeOperation = 'destination-in';
        octx.drawImage(m, 0, 0);
        ctx.drawImage(out, 0, 0);
      }
      this.drawMaskOverlay();
      return;
    }
    // Split wipe: B right of the divider, with a soft 24px seam.
    const sx = Math.round(this.splitFrac * cv.width);
    const feather = Math.min(24, Math.max(1, Math.round(cv.width * 0.02)));
    const tmp = document.createElement('canvas');
    tmp.width = cv.width; tmp.height = cv.height;
    const tctx = tmp.getContext('2d');
    const g = tctx.createLinearGradient(sx - feather, 0, sx + feather, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    tctx.fillStyle = '#000';
    tctx.fillRect(sx + feather, 0, cv.width - sx - feather, cv.height);
    tctx.fillStyle = g;
    tctx.fillRect(sx - feather, 0, feather * 2, cv.height);
    tctx.globalCompositeOperation = 'source-in';
    tctx.drawImage(imgB, 0, 0);
    ctx.drawImage(tmp, 0, 0);
    this.positionSplit();
  }

  drawMaskOverlay() {
    const box = this.el.maskBox;
    if (!this.maskRect) { box.style.display = 'none'; return; }
    const { width: cw, height: ch } = this.el.canvas.getBoundingClientRect();
    const s = cw / this.el.canvas.width;
    box.style.display = 'block';
    box.style.left = (this.maskRect.x * s) + 'px';
    box.style.top = (this.maskRect.y * (ch / this.el.canvas.height)) + 'px';
    box.style.width = (this.maskRect.w * s) + 'px';
    box.style.height = (this.maskRect.h * (ch / this.el.canvas.height)) + 'px';
  }

  positionSplit() {
    const r = this.el.canvas.getBoundingClientRect();
    const sr = this.el.stage.getBoundingClientRect();
    this.el.split.style.left = (r.left - sr.left + this.splitFrac * r.width) + 'px';
  }

  canvasPoint(e) {
    const r = this.el.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * this.el.canvas.width,
      y: (e.clientY - r.top) / r.height * this.el.canvas.height,
    };
  }

  bindStageGestures() {
    if (this._gesturesBound) { this.renderBlend(); return; }
    this._gesturesBound = true;
    let mode = null; // 'split' | 'rect'
    let start = null;
    this.el.split.addEventListener('pointerdown', e => {
      if (this.el.useMask.checked) return;
      mode = 'split'; this.el.split.setPointerCapture(e.pointerId);
    });
    this.el.stage.addEventListener('pointerdown', e => {
      if (!this.el.useMask.checked || e.target === this.el.split) return;
      mode = 'rect'; start = this.canvasPoint(e);
      this.maskRect = { x: start.x, y: start.y, w: 0, h: 0 };
      this.el.stage.setPointerCapture(e.pointerId);
      this.renderBlend();
    });
    this.el.stage.addEventListener('pointermove', e => {
      if (mode === 'split') {
        const r = this.el.canvas.getBoundingClientRect();
        this.splitFrac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        this.renderBlend();
      } else if (mode === 'rect') {
        const p = this.canvasPoint(e);
        this.maskRect = {
          x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
          w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y),
        };
        this.renderBlend();
      }
    });
    const end = () => { mode = null; start = null; };
    this.el.stage.addEventListener('pointerup', end);
    this.el.stage.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => {
      if (this.el.full.style.display === 'flex') this.renderBlend();
    });
  }

  // ---- save ---------------------------------------------------------------
  async saveBlend() {
    if (!this.blendPair) return;
    let name = this.el.saveName.value.trim();
    if (!name) { alert('Enter a filename'); return; }
    if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) name += '.png';
    const dataUrl = this.el.canvas.toDataURL('image/png');
    try {
      const r = await fetch('/api/review/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: name, data: dataUrl }),
      });
      if (r.status === 409) {
        if (!confirm('File exists — overwrite?')) return;
        const r2 = await fetch('/api/review/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: name, data: dataUrl, overwrite: true }),
        });
        if (!r2.ok) throw new Error((await r2.json()).detail || r2.status);
        this.toast(`Saved ${r2.json().saved} (overwritten) — refresh Gallery to see it`);
      } else if (!r.ok) {
        throw new Error((await r.json()).detail || r.status);
      } else {
        const j = await r.json();
        this.toast(`Saved ${j.saved} — refresh Gallery to see it`);
      }
      this.exitFull();
    } catch (err) {
      this.toast('Save failed: ' + err.message, true);
    }
  }

  toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);' +
      'background:' + (isErr ? '#7a2a2a' : '#2a5a3a') + ';color:#fff;padding:10px 18px;' +
      'border-radius:8px;font-size:13px;z-index:200;max-width:80vw';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ---- full-screen plumbing ----------------------------------------------
  showFull(mode) {
    this.el.full.style.display = 'flex';
    this.el.compare.style.display = mode === 'Compare' ? 'flex' : 'none';
    this.el.stage.style.display = mode === 'Blend' ? 'flex' : 'none';
  }

  exitFull() {
    this.el.full.style.display = 'none';
    this.el.imgA.src = ''; this.el.imgB.src = '';
  }

  bindFull() {
    const act = n => this.panel.querySelector(`[data-act="${n}"]`);
    act('exit').addEventListener('click', () => this.exitFull());
    act('pick-a').addEventListener('click', () => this.pick('a'));
    act('pick-b').addEventListener('click', () => this.pick('b'));
    act('mode-compare').addEventListener('click', () => {
      this.el.compare.style.display = 'flex';
      this.el.stage.style.display = 'none';
    });
    act('mode-blend').addEventListener('click', () => {
      if (!this.blendPair) {
        // From compare mode: blend the current pair.
        const [a, b] = this.pairs[this.pairIdx] || [];
        if (a && b) {
          this.selected.set(a.path, a);
          this.selected.set(b.path, b);
          this.startBlend();
          return;
        }
        this.toast('Select exactly 2 images to blend', true);
        return;
      }
      this.el.compare.style.display = 'none';
      this.el.stage.style.display = 'flex';
      this.renderBlend();
    });
    this.el.useMask.addEventListener('change', () => this.renderBlend());
    act('save').addEventListener('click', () => this.saveBlend());
  }
}

registerModule({
  name: 'review',
  label: 'Review',
  icon: '⚖️',
  order: 1,
  mount: (panel) => new Review(panel),
});
