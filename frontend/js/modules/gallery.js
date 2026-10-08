// Gallery module — browse generated images, view large, curate.
// Backend: /api/gallery/list|thumb|file, /api/pending (see backend/routers/).
// Curation contract (§9): multi-select thumbs → [Ladder N] launches the
// Champion Ladder over the selection; [Blend pair] hands two near-twins to
// the Ladder module's blend stage. Delete-mode (🚨) MARKS thumbs into the
// server-side pending-delete manifest; nothing deletes here — all
// destruction lives in the Pending (clemency) view's confirmed delete.
// Handoff events: window CustomEvents
//   'ellieedit:ladder-launch' { detail: { items } }  + activate 'ladder'
//   'ellieedit:blend-launch' { detail: { items } }   + activate 'ladder'

import { registerModule } from '../shell.js';

function panelHTML() {
  return `
  <style>
    .gal-header {
      padding: 10px 20px; background: #161628; border-bottom: 1px solid #2a2a44;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .gal-header h1 { font-size: 17px; font-weight: 600; color: #e0e0f0; }
    .gal-header h1 .subtitle { color: #6c6c8e; font-weight: 400; font-size: 12px; margin-left: 8px; }
    .gal-header select {
      background: #22223a; color: #d4d4e0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 4px 8px; font-size: 12px; max-width: 220px;
    }
    .gal-status { font-size: 11px; color: #6c6c8e; flex: 1; }
    .gal-btn.toggled { background: #5b4a8a; border-color: #7a6aaa; color: #fff; }
    .gal-btn.danger { border-color: #7a3a3a; color: #e87a7a; }
    .gal-btn.danger.toggled { background: #6a2020; color: #ffd0d0; box-shadow: 0 0 8px rgba(220,60,60,0.6); }
    #tabbar .tab .marking-badge {
      background: #a02020; color: #fff; font-size: 9px; padding: 1px 6px;
      border-radius: 8px; font-weight: 700; letter-spacing: 0.5px;
    }
    .gal-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      grid-auto-rows: 130px; gap: 8px; padding: 12px 16px; overflow-y: auto; flex: 1; align-content: start;
      transition: box-shadow 0.2s;
    }
    .gal-grid.marking { box-shadow: inset 0 0 0 3px #a02020, inset 0 0 40px rgba(160,20,20,0.25); }
    .gal-grid.marking::after { content: ''; }
    .gal-cell { position: relative; border-radius: 6px; overflow: hidden; cursor: pointer;
      background: #1a1a2e; border: 2px solid transparent; }
    .gal-cell img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .gal-cell .check {
      position: absolute; top: 4px; right: 4px; width: 22px; height: 22px;
      border-radius: 50%; background: rgba(0,0,0,0.55); color: #fff;
      font-size: 13px; line-height: 22px; text-align: center; display: none;
    }
    .gal-cell.sel { border-color: #7a7aff; }
    .gal-cell.sel .check { display: block; background: #5a5aff; }
    .gal-cell.marked { border-color: #d04040; }
    .gal-cell.marked img { filter: brightness(0.7) sepia(0.3) hue-rotate(-30deg); }
    .gal-cell.marked .check { display: block; background: #a02020; }
    .gal-cell .name {
      position: absolute; bottom: 0; left: 0; right: 0; padding: 2px 6px;
      background: rgba(0,0,0,0.6); color: #b0b0d0; font-size: 9px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* Sticky bars: curation action bar + delete-mode marking bar */
    .gal-bar {
      display: none; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 8px 16px; background: #1d1d33; border-top: 1px solid #4a4a6c;
    }
    .gal-bar.on { display: flex; }
    .gal-bar .msg { font-size: 12px; color: #b0b0d0; flex: 1; }
    .gal-bar.marking { background: #2a1216; border-top-color: #a02020; }
    /* Viewer */
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
    /* Pending (clemency) view */
    .gal-pending {
      display: none; position: absolute; inset: 0; background: #120a0e;
      z-index: 55; flex-direction: column;
    }
    .gal-pending .bar {
      display: flex; align-items: center; gap: 10px; padding: 10px 16px;
      background: #1d1016; border-bottom: 1px solid #5a2020;
    }
    .gal-pending .bar .fname { color: #e0b0b0; font-size: 13px; font-weight: 600; flex: 1; }
    .gal-pending .pd-grid {
      flex: 1; overflow-y: auto; display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      grid-auto-rows: 140px; gap: 8px; padding: 12px 16px; align-content: start;
    }
    .gal-pending .pd-cell { position: relative; border-radius: 6px; overflow: hidden;
      background: #1a1a2e; border: 2px solid #7a2020; }
    .gal-pending .pd-cell img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .gal-pending .pd-cell .name { position: absolute; top: 0; left: 0; right: 0; padding: 2px 6px;
      background: rgba(0,0,0,0.6); color: #d0b0b0; font-size: 9px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gal-pending .pd-cell button {
      position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%);
    }
    .gal-pending .bar.confirming .ee-btn.primary { background: #a02020; border-color: #d04040; }
  </style>
  <div class="gal-header">
    <h1>Gallery <span class="subtitle">— generated images</span></h1>
    <select data-id="dir-select"></select>
    <span class="gal-status" data-id="status"></span>
    <button class="ee-btn gal-btn" data-act="select-mode">☰ Select</button>
    <button class="ee-btn gal-btn danger" data-act="delete-mode" title="Mark images for pending delete">🚨</button>
    <button class="ee-btn gal-btn" data-act="show-pending" style="display:none">🗑 Pending (<span data-id="pending-count">0</span>)</button>
  </div>
  <div class="gal-grid" data-id="grid"></div>
  <div class="gal-bar" data-id="action-bar">
    <span class="msg" data-id="sel-msg"></span>
    <button class="ee-btn" data-act="clear-sel">Clear</button>
    <button class="ee-btn" data-act="blend-pair" style="display:none">Blend pair</button>
    <button class="ee-btn primary" data-act="ladder">Ladder <span data-id="sel-count">0</span></button>
  </div>
  <div class="gal-bar marking" data-id="marking-bar">
    <span class="msg" data-id="mark-msg">Marking for delete — nothing is deleted until you confirm in Pending.</span>
    <button class="ee-btn" data-act="exit-marking">Exit marking</button>
    <button class="ee-btn primary" data-act="done-marking">✓ Done marking (<span data-id="mark-count">0</span>)</button>
  </div>
  <div class="gal-viewer" data-id="viewer">
    <div class="bar">
      <span class="fname" data-id="viewer-name"></span>
      <button class="ee-btn primary" data-act="to-facecycle">→ FaceCycle</button>
      <button class="ee-btn" data-act="close">✕</button>
    </div>
    <div class="stage"><img data-id="viewer-img" alt=""></div>
    <div class="navzone left" data-act="prev">‹</div>
    <div class="navzone right" data-act="next">›</div>
  </div>
  <div class="gal-pending" data-id="pending">
    <div class="bar" data-id="pending-bar">
      <span class="fname">Pending Delete — <span data-id="pd-summary"></span></span>
      <button class="ee-btn" data-act="pd-close">✕ Back to Gallery</button>
      <button class="ee-btn primary" data-act="pd-delete-all">Delete all</button>
    </div>
    <div class="pd-grid" data-id="pd-grid"></div>
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
      selectBtn: panel.querySelector('[data-act="select-mode"]'),
      deleteBtn: panel.querySelector('[data-act="delete-mode"]'),
      pendingBtn: panel.querySelector('[data-act="show-pending"]'),
      pendingCount: panel.querySelector('[data-id="pending-count"]'),
      actionBar: panel.querySelector('[data-id="action-bar"]'),
      selMsg: panel.querySelector('[data-id="sel-msg"]'),
      selCount: panel.querySelector('[data-id="sel-count"]'),
      blendPairBtn: panel.querySelector('[data-act="blend-pair"]'),
      markingBar: panel.querySelector('[data-id="marking-bar"]'),
      markMsg: panel.querySelector('[data-id="mark-msg"]'),
      markCount: panel.querySelector('[data-id="mark-count"]'),
      viewer: panel.querySelector('[data-id="viewer"]'),
      viewerName: panel.querySelector('[data-id="viewer-name"]'),
      viewerImg: panel.querySelector('[data-id="viewer-img"]'),
      pending: panel.querySelector('[data-id="pending"]'),
      pendingBar: panel.querySelector('[data-id="pending-bar"]'),
      pdSummary: panel.querySelector('[data-id="pd-summary"]'),
      pdGrid: panel.querySelector('[data-id="pd-grid"]'),
      pdDeleteAll: panel.querySelector('[data-act="pd-delete-all"]'),
    };
    this.items = [];
    this.cursor = null;
    this.dir = '';
    this.viewIdx = -1;
    this.loading = false;
    this.selectMode = false;
    this.deleteMode = false;
    this.selected = new Map();  // path -> item (ladder/blend selection)
    this.pdItems = [];          // pending manifest snapshot for the clemency view
    this.pdBytes = 0;
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
    this.bindChrome();
    this.bindViewer();
    this.refreshDirs();
    this.refreshPendingCount();
  }

  fileUrl(path) { return `/api/gallery/file?path=${encodeURIComponent(path)}`; }

  // ---- toolbar / sticky bars --------------------------------------------
  bindChrome() {
    const act = n => this.panel.querySelector(`[data-act="${n}"]`);
    this.el.selectBtn.addEventListener('click', () => this.setSelectMode(!this.selectMode));
    this.el.deleteBtn.addEventListener('click', () => this.setDeleteMode(!this.deleteMode));
    act('clear-sel').addEventListener('click', () => this.clearSelection());
    act('ladder').addEventListener('click', () => this.launchLadder());
    this.el.blendPairBtn.addEventListener('click', () => this.launchBlendPair());
    act('done-marking').addEventListener('click', () => this.setDeleteMode(false));
    act('exit-marking').addEventListener('click', () => this.setDeleteMode(false));
    this.el.pendingBtn.addEventListener('click', () => this.openPending());
    act('pd-close').addEventListener('click', () => { this.el.pending.style.display = 'none'; this.refreshPendingCount(); });
    this.el.pdDeleteAll.addEventListener('click', () => this.pdConfirmStep());
  }

  setSelectMode(on) {
    this.selectMode = on && !this.deleteMode;
    this.el.selectBtn.classList.toggle('toggled', this.selectMode);
    if (!this.selectMode) this.clearSelection();
    else this.updateActionBars();
  }

  setDeleteMode(on) {
    this.deleteMode = on;
    this.el.deleteBtn.classList.toggle('toggled', on);
    this.el.grid.classList.toggle('marking', on);
    this.el.markingBar.classList.toggle('on', on);
    if (on) this.setSelectMode(false);
    // MARKING badge on the Gallery tab
    const tab = document.querySelector('#tabbar .tab[data-name="gallery"]');
    let badge = tab && tab.querySelector('.marking-badge');
    if (on && tab && !badge) {
      badge = document.createElement('span');
      badge.className = 'marking-badge';
      badge.textContent = 'MARKING';
      tab.appendChild(badge);
    }
    if (!on && badge) badge.remove();
    this.updateActionBars();
  }

  updateMarkCount() {
    const n = this.panel.querySelectorAll('.gal-cell.marked').length;
    this.el.markCount.textContent = n;
  }

  clearSelection() {
    this.selected.clear();
    for (const c of this.el.grid.children) c.classList.remove('sel');
    this.updateActionBars();
  }

  updateActionBars() {
    const n = this.selected.size;
    const showBar = this.selectMode && n >= 2;
    this.el.actionBar.classList.toggle('on', showBar);
    this.el.selCount.textContent = n;
    this.el.selMsg.textContent = n ? `${n} selected` : 'Tap images to select';
    this.el.blendPairBtn.style.display = n === 2 ? '' : 'none';
  }

  launchLadder() {
    const items = [...this.selected.values()];
    if (items.length < 2) return;
    window.dispatchEvent(new CustomEvent('ellieedit:ladder-launch', { detail: { items } }));
    window.dispatchEvent(new CustomEvent('ellieedit:activate', { detail: { name: 'ladder' } }));
    this.setSelectMode(false);
    this.clearSelection();
  }

  launchBlendPair() {
    const items = [...this.selected.values()];
    if (items.length !== 2) return;
    window.dispatchEvent(new CustomEvent('ellieedit:blend-launch', { detail: { items } }));
    window.dispatchEvent(new CustomEvent('ellieedit:activate', { detail: { name: 'ladder' } }));
    this.setSelectMode(false);
    this.clearSelection();
  }

  // ---- pending delete manifest -------------------------------------------
  async refreshPendingCount() {
    try {
      const j = await fetch('/api/pending').then(r => r.json());
      this.el.pendingCount.textContent = j.count;
      this.el.pendingBtn.style.display = j.count > 0 ? '' : 'none';
    } catch { /* backend unavailable: leave as-is */ }
  }

  async openPending() {
    this.el.pending.style.display = 'flex';
    this.el.pendingBar.classList.remove('confirming');
    this.el.pdDeleteAll.disabled = false;
    this.el.pdDeleteAll.textContent = 'Delete all';
    this.el.pdGrid.innerHTML = '';
    try {
      const j = await fetch('/api/pending').then(r => r.json());
      this.pdItems = j.items;
      this.pdBytes = j.bytes;
      this.el.pdSummary.textContent = j.count
        ? `${j.count} image${j.count === 1 ? '' : 's'} · ${fmtBytes(j.bytes)}`
        : 'nothing marked';
      this.el.pdDeleteAll.style.display = j.count ? '' : 'none';
      for (const it of j.items) {
        const cell = document.createElement('div');
        cell.className = 'pd-cell';
        const img = document.createElement('img');
        img.src = `/api/gallery/thumb?path=${encodeURIComponent(it.path)}`;
        img.alt = it.name;
        const name = document.createElement('div');
        name.className = 'name'; name.textContent = it.name;
        const ret = document.createElement('button');
        ret.className = 'ee-btn'; ret.textContent = 'Return';
        ret.addEventListener('click', async () => {
          await fetch('/api/pending', {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: [it.path] }),
          });
          this.openPending(); // re-render with the pardoned item gone
        });
        cell.append(img, name, ret);
        this.el.pdGrid.appendChild(cell);
      }
    } catch (err) {
      this.el.pdSummary.textContent = 'Load failed: ' + err.message;
    }
  }

  pdConfirmStep() {
    // Two-step confirm: first tap arms the button with the real cost.
    if (!this.el.pendingBar.classList.contains('confirming')) {
      this.el.pendingBar.classList.add('confirming');
      this.el.pdDeleteAll.textContent =
        `Really delete ${this.pdItems.length} images (${fmtBytes(this.pdBytes)})? This cannot be undone.`;
      return;
    }
    this.pdConfirmExecute();
  }

  async pdConfirmExecute() {
    try {
      const j = await fetch('/api/pending/confirm', { method: 'POST' }).then(r => r.json());
      this.toast(`Deleted ${j.deleted} images (${fmtBytes(j.bytes)})`);
      this.el.pending.style.display = 'none';
      this.refreshPendingCount();
      this.reload(this.dir);
    } catch (err) {
      this.toast('Delete failed: ' + err.message, true);
    }
  }

  async markPending(item, on) {
    try {
      await fetch('/api/pending', {
        method: on ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [item.path] }),
      });
      this.refreshPendingCount();
    } catch (err) {
      this.toast('Manifest update failed: ' + err.message, true);
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

  // ---- browse --------------------------------------------------------------
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
    this.selected.clear();
    await this.loadMore();
    this.updateActionBars();
    this.updateMarkCount();
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
    const check = document.createElement('div');
    check.className = 'check';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = item.name;
    cell.append(img, check, name);
    cell.addEventListener('click', () => {
      if (this.deleteMode) {
        const on = !cell.classList.contains('marked');
        cell.classList.toggle('marked', on);
        check.textContent = on ? '✕' : '';
        this.updateMarkCount();
        this.markPending(item, on);
        return;
      }
      if (this.selectMode) {
        if (this.selected.has(item.path)) {
          this.selected.delete(item.path);
          cell.classList.remove('sel');
          check.textContent = '';
        } else {
          this.selected.set(item.path, item);
          cell.classList.add('sel');
          check.textContent = '✓';
        }
        this.updateActionBars();
        return;
      }
      this.openViewer(idx);
    });
    this.el.grid.appendChild(cell);
    this.io.observe(cell);
  }

  // ---- viewer ------------------------------------------------------------
  openViewer(idx) {
    this.viewIdx = idx;
    const it = this.items[idx];
    this.el.viewerImg.src = this.fileUrl(it.path);
    this.el.viewerName.textContent = `${it.name} · ${it.width}×${it.height} · ${new Date(it.mtime * 1000).toLocaleString()}`;
    this.el.viewer.style.display = 'flex';
  }

  closeViewer() { this.el.viewer.style.display = 'none'; this.el.viewerImg.src = ''; }

  nav(dir) {
    if (!this.items.length) return;
    this.openViewer((this.viewIdx + dir + this.items.length) % this.items.length);
  }

  bindViewer() {
    const act = n => this.panel.querySelector(`[data-act="${n}"]`);
    act('close').addEventListener('click', () => this.closeViewer());
    act('prev').addEventListener('click', () => this.nav(-1));
    act('next').addEventListener('click', () => this.nav(1));
    act('to-facecycle').addEventListener('click', () => {
      const item = this.items[this.viewIdx];
      if (!item) return;
      const url = this.fileUrl(item.path);
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
}

function fmtBytes(b) {
  if (b >= 1024 * 1024) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

registerModule({
  name: 'gallery',
  label: 'Gallery',
  icon: '🖼️',
  order: -1,  // first tab — the entry point
  mount: (panel) => new Gallery(panel),
});
