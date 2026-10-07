// Gallery module — browse generated images, view large, hand off to FaceCycle.
// Backend: /api/gallery/list|thumb|file (see backend/routers/gallery.py).
// Open-in-FaceCycle contract: dispatches window CustomEvent
//   'ellieedit:open-in-facecycle' { detail: { url, name } }
// FaceCycle listens for it and loads the image through its normal file path.

import { registerModule } from '../shell.js';

function panelHTML() {
  return `
  <style>
    .gal-header {
      padding: 10px 20px; background: #161628; border-bottom: 1px solid #2a2a44;
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    }
    .gal-header h1 { font-size: 17px; font-weight: 600; color: #e0e0f0; }
    .gal-header h1 .subtitle { color: #6c6c8e; font-weight: 400; font-size: 12px; margin-left: 8px; }
    .gal-header select {
      background: #22223a; color: #d4d4e0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 4px 8px; font-size: 12px; max-width: 260px;
    }
    .gal-status { font-size: 11px; color: #6c6c8e; }
    .gal-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 8px; padding: 12px 16px; overflow-y: auto; flex: 1; align-content: start;
    }
    .gal-cell { position: relative; border-radius: 6px; overflow: hidden; cursor: pointer;
      background: #1a1a2e; aspect-ratio: 1; }
    .gal-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .gal-cell .name {
      position: absolute; bottom: 0; left: 0; right: 0; padding: 2px 6px;
      background: rgba(0,0,0,0.6); color: #b0b0d0; font-size: 9px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .gal-viewer {
      display: none; position: absolute; inset: 0; background: rgba(8,8,16,0.96);
      z-index: 50; flex-direction: column;
    }
    .gal-viewer .bar {
      display: flex; align-items: center; gap: 10px; padding: 10px 16px;
      background: #161628; border-bottom: 1px solid #2a2a44;
    }
    .gal-viewer .bar .fname { color: #b0b0d0; font-size: 12px; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gal-viewer .stage { flex: 1; display: flex; align-items: center; justify-content: center;
      overflow: hidden; min-height: 0; }
    .gal-viewer .stage img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .gal-viewer .navzone { position: absolute; top: 60px; bottom: 0; width: 30%;
      display: flex; align-items: center; justify-content: center; font-size: 34px;
      color: rgba(255,255,255,0.25); cursor: pointer; user-select: none; -webkit-user-select: none; }
    .gal-viewer .navzone:hover { color: rgba(255,255,255,0.6); }
    .gal-viewer .navzone.left { left: 0; }
    .gal-viewer .navzone.right { right: 0; }
  </style>
  <div class="gal-header">
    <h1>Gallery <span class="subtitle">— generated images</span></h1>
    <select data-id="dir-select"></select>
    <span class="gal-status" data-id="status"></span>
  </div>
  <div class="gal-grid" data-id="grid"></div>
  <div class="gal-viewer" data-id="viewer">
    <div class="bar">
      <span class="fname" data-id="viewer-name"></span>
      <button class="ee-btn primary" data-act="to-facecycle">→ FaceCycle</button>
      <button class="ee-btn" data-act="close">✕</button>
    </div>
    <div class="stage"><img data-id="viewer-img" alt=""></div>
    <div class="navzone left" data-act="prev">‹</div>
    <div class="navzone right" data-act="next">›</div>
  </div>`;
}

export class Gallery {
  constructor(panel) {
    panel.innerHTML = panelHTML();
    this.panel = panel;
    this.el = {
      grid: panel.querySelector('[data-id="grid"]'),
      dirSelect: panel.querySelector('[data-id="dir-select"]'),
      status: panel.querySelector('[data-id="status"]'),
      viewer: panel.querySelector('[data-id="viewer"]'),
      viewerName: panel.querySelector('[data-id="viewer-name"]'),
      viewerImg: panel.querySelector('[data-id="viewer-img"]'),
    };
    this.items = [];
    this.cursor = null;
    this.dir = '';
    this.viewIdx = -1;
    this.loading = false;
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target.querySelector('img');
        if (img && img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        this.io.unobserve(e.target);
      }
    }, { rootMargin: '300px' });
    this.el.grid.addEventListener('scroll', () => {
      if (this.el.grid.scrollTop + this.el.grid.clientHeight >= this.el.grid.scrollHeight - 200) this.loadMore();
    });
    this.bindViewer();
    this.refreshDirs();
  }

  bindViewer() {
    const act = n => this.panel.querySelector(`[data-act="${n}"]`);
    act('close').addEventListener('click', () => this.closeViewer());
    act('prev').addEventListener('click', () => this.nav(-1));
    act('next').addEventListener('click', () => this.nav(1));
    act('to-facecycle').addEventListener('click', () => {
      const item = this.items[this.viewIdx];
      if (!item) return;
      const url = `/api/gallery/file?path=${encodeURIComponent(item.path)}`;
      window.dispatchEvent(new CustomEvent('ellieedit:open-in-facecycle',
        { detail: { url, name: item.name } }));
      this.closeViewer();
    });
    this.el.viewerImg.addEventListener('click', e => { if (e.target === this.el.viewerImg) this.closeViewer(); });
    this.onKey = e => {
      if (this.el.viewer.style.display !== 'flex') return;
      if (e.key === 'Escape') this.closeViewer();
      else if (e.key === 'ArrowLeft') this.nav(-1);
      else if (e.key === 'ArrowRight') this.nav(1);
    };
    document.addEventListener('keydown', this.onKey);
    // Swipe on the stage.
    let sx = null;
    this.el.viewer.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    this.el.viewer.addEventListener('touchend', e => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 50) this.nav(dx < 0 ? 1 : -1);
      sx = null;
    }, { passive: true });
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
      sel.addEventListener('change', () => { this.dir = sel.value; this.reload(); });
      this.reload();
    } catch (err) {
      this.el.status.textContent = 'Backend error: ' + err.message;
    }
  }

  async reload() {
    this.el.grid.innerHTML = '';
    this.items = []; this.cursor = null;
    await this.loadMore();
  }

  async loadMore() {
    if (this.loading || (this.cursor === null && this.items.length)) return;
    this.loading = true;
    try {
      const p = new URLSearchParams({ dir: this.dir });
      if (this.cursor) p.set('cursor', this.cursor);
      const r = await fetch('/api/gallery/list?' + p);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      const start = this.items.length;
      this.items.push(...data.items);
      this.cursor = data.next_cursor;
      for (let i = 0; i < data.items.length; i++) this.addCell(data.items[i], start + i);
      this.el.status.textContent = `${this.items.length} images${data.next_cursor ? ' +' : ''}`;
    } catch (err) {
      this.el.status.textContent = 'Load failed: ' + err.message;
    }
    this.loading = false;
  }

  addCell(item, idx) {
    const cell = document.createElement('div');
    cell.className = 'gal-cell';
    const img = document.createElement('img');
    img.dataset.src = `/api/gallery/thumb?path=${encodeURIComponent(item.path)}`;
    img.alt = item.name; img.loading = 'lazy';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = item.name;
    cell.append(img, name);
    cell.addEventListener('click', () => this.openViewer(idx));
    this.el.grid.appendChild(cell);
    this.io.observe(cell);
  }

  openViewer(idx) {
    this.viewIdx = idx;
    const it = this.items[idx];
    this.el.viewerImg.src = `/api/gallery/file?path=${encodeURIComponent(it.path)}`;
    this.el.viewerName.textContent = `${it.name} · ${it.width}×${it.height} · ${new Date(it.mtime * 1000).toLocaleString()}`;
    this.el.viewer.style.display = 'flex';
  }

  closeViewer() { this.el.viewer.style.display = 'none'; this.el.viewerImg.src = ''; }

  nav(dir) {
    if (!this.items.length) return;
    this.openViewer((this.viewIdx + dir + this.items.length) % this.items.length);
  }
}

registerModule({
  name: 'gallery',
  label: 'Gallery',
  icon: '🖼️',
  order: -1,  // first tab — the entry point
  mount: (panel) => new Gallery(panel),
});
