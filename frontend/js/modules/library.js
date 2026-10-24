// Library module — browse promoted images (moved, never copied) with
// project tag chips + tag filter + Load more paging.
// Backend: /api/library/list|thumb|file|retag|pending-delete. Thumbnails
// reuse the same fingerprinted-thumb pipeline as gallery/dupe.
// Lightbox (2026-10-09e): thumbnails open the shared viewer experience —
// full image, nav within the filtered listing, Esc/backdrop close, swipe.
// Viewer bar: 🏷 retag (moved here from the cell) · ✎ send-to-update ·
// 🗑 delete (explicit confirm → /api/library/pending-delete: the file is
// MOVED to the deletion queue's pending area, never unlinked). No
// P-promote here — library items are already promoted.
import { registerModule } from '../shell.js';
import { createSendMenu } from '../components/send-menu.js';
import { buildListParams, countLine } from './library-core.js';

const PAGE_SIZE = 40; // must match backend PAGE_SIZE for cursor math

function panelHTML() {
  return `
  <style>
    .lib-header {
      padding: 10px 20px; background: #161628; border-bottom: 1px solid #2a2a44;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .lib-header h1 { font-size: 17px; font-weight: 600; color: #e0e0f0; }
    .lib-status { font-size: 11px; color: #6c6c8e; flex: 1; }
    .lib-tags { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 16px;
      background: #12121f; border-bottom: 1px solid #2a2a44; }
    .lib-tag {
      background: #22223a; color: #c8c8e8; border: 1px solid #4a4a6c;
      border-radius: 12px; padding: 6px 14px; font-size: 12px; cursor: pointer;
      min-height: 32px;
    }
    .lib-tag.active { background: #3a3ab0; border-color: #7a7aff; color: #fff; }
    .lib-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      grid-auto-rows: 150px; gap: 8px; padding: 12px 16px; overflow-y: auto;
      flex: 1; align-content: start;
    }
    .lib-cell { position: relative; border-radius: 6px; overflow: hidden;
      background: #1a1a2e; cursor: pointer; }
    .lib-cell img { width: 100%; height: 120px; object-fit: contain; display: block; }
    .lib-cell .lib-chips { display: flex; gap: 4px; flex-wrap: wrap; padding: 3px 5px; }
    .lib-cell .chip {
      background: #22223a; color: #a8b8ff; border-radius: 8px;
      font-size: 9px; padding: 1px 6px; border: 1px solid #4a4a6c;
    }
    .lib-cell .name {
      position: absolute; bottom: 0; left: 0; right: 0; padding: 2px 6px;
      background: rgba(0,0,0,0.55); color: #b0b0d0; font-size: 9px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
    }
    /* Version-family badge (Phase 0): finals that have an original. */
    .lib-cell .lib-fambadge {
      position: absolute; top: 4px; right: 4px; z-index: 2;
      background: rgba(20,20,40,0.8); color: #e8b84d; font-size: 13px;
      padding: 1px 6px; border-radius: 8px; border: 1px solid #4a4a6c;
    }
    .lib-foot { padding: 10px 16px; display: flex; justify-content: center;
      border-top: 1px solid #2a2a44; }
    .lib-foot .ee-btn { min-height: 44px; min-width: 160px; }
    /* Lightbox viewer (2026-10-09e): same experience as the Gallery viewer */
    .lib-viewer {
      display: none; position: absolute; inset: 0; background: rgba(8,8,16,0.96);
      z-index: 50; flex-direction: column;
    }
    .lib-viewer .bar {
      display: flex; align-items: center; gap: 10px; padding: 10px 16px;
      background: #161628; border-bottom: 1px solid #2a2a44; flex-wrap: wrap;
    }
    .lib-viewer .bar .fname { color: #b0b0d0; font-size: 12px; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lib-viewer .bar .ee-btn { min-height: 44px; }
    .lib-viewer .bar .ee-btn.danger { border-color: #7a3a3a; color: #e87a7a; }
    .lib-viewer .bar .ee-btn.danger.confirming {
      background: #6a2020; color: #ffd0d0; box-shadow: 0 0 8px rgba(220,60,60,0.6); }
    .lib-viewer .stage { flex: 1; display: flex; align-items: center; justify-content: center;
      overflow: hidden; min-height: 0; }
    .lib-viewer .stage img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .lib-viewer .gone-note {
      display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
      background: rgba(20,20,40,0.85); color: #b0b0d0; font-size: 14px;
      padding: 12px 20px; border-radius: 8px; border: 1px solid #4a4a6c;
      pointer-events: none;
    }
    .lib-viewer .navzone { position: absolute; top: 60px; bottom: 0; width: 30%;
      display: flex; align-items: center; justify-content: center; font-size: 34px;
      color: rgba(255,255,255,0.25); cursor: pointer; user-select: none; -webkit-user-select: none; }
    .lib-viewer .navzone:hover { color: rgba(255,255,255,0.6); }
    .lib-viewer .navzone.left { left: 0; }
    .lib-viewer .navzone.right { right: 0; }
  </style>
  <div style="display:flex;flex-direction:column;height:100%;position:relative">
    <div class="lib-header">
      <h1>Library <span style="color:#6c6c8e;font-weight:400;font-size:12px">promoted · moved, never copied</span></h1>
      <div class="lib-status" id="lib-status"></div>
    </div>
    <div class="lib-tags" id="lib-tags"></div>
    <div class="lib-grid" id="lib-grid"></div>
    <div class="lib-foot"><button class="ee-btn" id="lib-more">Load more</button></div>
    <div class="lib-viewer" id="lib-viewer">
      <div class="bar">
        <span class="fname" id="libv-name"></span>
        <button class="ee-btn" id="libv-retag" title="Retag">🏷 Retag</button>
        <button class="ee-btn" id="libv-family" style="display:none" title="Show this final's original (Update version family)">⧉ Original</button>
        <span id="libv-sendwrap"></span>
        <button class="ee-btn danger" id="libv-delete" title="Move to deletion queue pending area — nothing is deleted until you confirm">🗑 Delete</button>
        <button class="ee-btn" id="libv-close">✕</button>
      </div>
      <div class="stage"><img id="libv-img" alt=""></div>
      <div class="gone-note" id="libv-note">already queued — › for next</div>
      <div class="navzone left" id="libv-prev">‹</div>
      <div class="navzone right" id="libv-next">›</div>
    </div>
  </div>`;
}

class LibraryView {
  constructor(panel) {
    panel.innerHTML = panelHTML();
    this.panel = panel;
    this.el = {
      status: panel.querySelector('#lib-status'),
      tags: panel.querySelector('#lib-tags'),
      grid: panel.querySelector('#lib-grid'),
      more: panel.querySelector('#lib-more'),
      viewer: panel.querySelector('#lib-viewer'),
      vName: panel.querySelector('#libv-name'),
      vImg: panel.querySelector('#libv-img'),
      vNote: panel.querySelector('#libv-note'),
      vRetag: panel.querySelector('#libv-retag'),
      vFamily: panel.querySelector('#libv-family'),
      vSendWrap: panel.querySelector('#libv-sendwrap'),
      vDelete: panel.querySelector('#libv-delete'),
    };
    this.tag = '';
    this.cursor = 0;
    this.total = 0;
    this.shown = 0;
    this.items = [];   // flat filtered listing — the lightbox navigates this
    this.viewIdx = -1;
    this.viewingOriginal = false;   // family toggle state in the viewer
    this.el.more.addEventListener('click', () => this.load());
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail?.name === 'library') this.reload();
    });
    window.addEventListener('ellieedit:library-changed', () => this.reload());
    this.bindViewer();
  }

  fileUrl(path) { return `/api/library/file?path=${encodeURIComponent(path)}`; }

  async reload() {
    this.cursor = 0;
    this.items = [];
    this.el.grid.innerHTML = '';
    await this.load();
  }

  async load() {
    try {
      const qs = buildListParams({ tag: this.tag, cursor: this.cursor });
      const r = await fetch('/api/library/list?' + qs);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (this.cursor === 0) this.renderTags(d.tags, d.total_all ?? d.total);
      for (const item of d.items) {
        this.items.push(item);
        this.addCell(item, this.items.length - 1);
      }
      this.cursor = d.next_cursor ?? d.items.length + this.cursor;
      this.total = d.total;
      this.shown = this.el.grid.children.length;
      this.el.more.style.display = d.next_cursor == null ? 'none' : '';
      this.el.status.textContent = countLine(this.shown, d.total, this.tag);
    } catch (err) {
      this.el.status.textContent = 'Library load failed: ' + err.message;
    }
  }

  renderTags(tags, total) {
    const host = this.el.tags;
    host.innerHTML = '';
    const all = document.createElement('button');
    all.className = 'lib-tag' + (this.tag ? '' : ' active');
    all.textContent = `all (${total})`;
    all.addEventListener('click', () => { this.tag = ''; this.reload(); });
    host.appendChild(all);
    for (const t of tags) {
      const b = document.createElement('button');
      b.className = 'lib-tag' + (t === this.tag ? ' active' : '');
      b.textContent = t;
      b.addEventListener('click', () => { this.tag = t; this.reload(); });
      host.appendChild(b);
    }
  }

  addCell(item, idx) {
    const cell = document.createElement('div');
    cell.className = 'lib-cell';
    cell.dataset.path = item.path;
    const img = document.createElement('img');
    img.src = `/api/library/thumb?path=${encodeURIComponent(item.path)}`;
    img.alt = item.name; img.loading = 'lazy'; img.decoding = 'async';
    const chips = document.createElement('div');
    chips.className = 'lib-chips';
    for (const t of (item.tags || [])) {
      const c = document.createElement('span');
      c.className = 'chip'; c.textContent = t;
      chips.appendChild(c);
    }
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = item.name;
    cell.append(img, chips, name);
    // ⧉ badge on finals that carry a version family (Phase 0).
    if (item.kind === 'version-family' && item.original) {
      const b = document.createElement('span');
      b.className = 'lib-fambadge'; b.textContent = '⧉';
      b.title = 'Version family — open to see the original';
      cell.appendChild(b);
    }
    // Lightbox instead of raw-file navigation (2026-10-09e).
    cell.addEventListener('click', () => this.openViewer(idx));
    this.el.grid.appendChild(cell);
  }

  // ---- lightbox viewer -----------------------------------------------------
  openViewer(idx) {
    this.viewIdx = idx;
    const it = this.items[idx];
    if (!it) return;
    this.disarmDelete();
    this.viewingOriginal = false;
    this.el.vNote.style.display = 'none';
    this.el.vImg.onerror = () => {
      if (this.el.viewer.style.display === 'flex') this.el.vNote.style.display = 'block';
    };
    this.el.vImg.src = this.fileUrl(it.path);
    const tags = (it.tags || []).join(', ');
    this.el.vName.textContent = `${it.name}${tags ? ' · ' + tags : ''}`;
    // Family toggle (Phase 0): finals with an original offer it directly.
    const hasFam = !!(it.family_id && it.original);
    this.el.vFamily.style.display = hasFam ? '' : 'none';
    this.el.vFamily.textContent = '⧉ Original';
    this.el.viewer.style.display = 'flex';
  }

  // Toggle the viewer between a final and its version original (Phase 0).
  toggleFamily() {
    const it = this.items[this.viewIdx];
    if (!it || !it.original) return;
    this.viewingOriginal = !this.viewingOriginal;
    this.el.vImg.src = this.fileUrl(this.viewingOriginal ? it.original : it.path);
    this.el.vFamily.textContent = this.viewingOriginal ? '⧉ Final' : '⧉ Original';
    const tags = (it.tags || []).join(', ');
    this.el.vName.textContent = `${it.name}${tags ? ' · ' + tags : ''}` +
      (this.viewingOriginal ? ' · original' : '');
  }

  closeViewer() {
    if (this.sendMenu) this.sendMenu.close();
    this.disarmDelete();
    this.el.viewer.style.display = 'none';
    this.el.vImg.src = '';
  }

  nav(dir) {
    if (!this.items.length) return;
    this.openViewer((this.viewIdx + dir + this.items.length) % this.items.length);
  }

  disarmDelete() {
    this.el.vDelete.classList.remove('confirming');
    this.el.vDelete.textContent = '🗑 Delete';
    delete this.el.vDelete.dataset.armed;
  }

  armDelete() {
    if (!this.el.vDelete.dataset.armed) {
      this.el.vDelete.dataset.armed = '1';
      this.el.vDelete.classList.add('confirming');
      this.el.vDelete.textContent = 'Really delete? ✓ Confirm';
      return;
    }
    this.disarmDelete();
    this.deleteFromViewer();
  }

  async deleteFromViewer() {
    const idx = this.viewIdx;
    const item = this.items[idx];
    if (!item) return;
    try {
      const r = await fetch('/api/library/pending-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      this.toast(`Queued ${item.name} for deletion — confirm to purge`);
    } catch (err) {
      this.toast(`Delete failed: ${err.message}`, true);
      return;
    }
    // Remove from listing + advance like promote (close-at-end). The file
    // itself now sits in the pending area; the index carries deleted_soon.
    const cell = [...this.el.grid.children].find(c => c.dataset.path === item.path);
    cell?.remove();
    this.items = this.items.filter(i => i.path !== item.path);
    this.shown = this.el.grid.children.length;
    this.el.status.textContent = countLine(this.shown, Math.max(this.total - 1, 0), this.tag);
    if (this.el.viewer.style.display !== 'flex') return;
    if (!this.items.length || idx >= this.items.length) { this.closeViewer(); return; }
    this.openViewer(Math.min(idx, this.items.length - 1));
  }

  async retagFromViewer() {
    const item = this.items[this.viewIdx];
    if (!item) return;
    const input = prompt('Tags (comma-separated):', (item.tags || []).join(','));
    if (input === null) return;
    const tags = input.split(',').map(s => s.trim()).filter(Boolean);
    if (!tags.length) return;
    try {
      const r = await fetch('/api/library/retag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path, tags }),
      });
      if (!r.ok) throw new Error(r.status);
      item.tags = tags;
      // Refresh the grid cell's chips + the viewer title, no full reload.
      const cell = [...this.el.grid.children].find(c => c.dataset.path === item.path);
      if (cell) {
        const chips = cell.querySelector('.lib-chips');
        chips.innerHTML = '';
        for (const t of tags) {
          const c = document.createElement('span');
          c.className = 'chip'; c.textContent = t;
          chips.appendChild(c);
        }
      }
      this.el.vName.textContent = `${item.name} · ${tags.join(', ')}`;
      this.toast(`Retagged ${item.name}`);
    } catch (err) {
      this.toast(`Retag failed: ${err.message}`, true);
    }
  }

  bindViewer() {
    this.panel.querySelector('#libv-close').addEventListener('click', () => this.closeViewer());
    this.panel.querySelector('#libv-prev').addEventListener('click', () => this.nav(-1));
    this.panel.querySelector('#libv-next').addEventListener('click', () => this.nav(1));
    this.el.vRetag.addEventListener('click', () => this.retagFromViewer());
    this.el.vFamily.addEventListener('click', () => this.toggleFamily());
    // Send to ▸ (Phase 0): replaces the hard-coded ✎ Update dispatch with
    // the v1.4 shell router — Update stays reachable, Puppet / FoxDen /
    // FaceCycle join it. The viewer closes on send, as before.
    const sendMenu = createSendMenu({
      className: 'ee-btn',
      entries: [
        { label: '🎭 Puppet Theater — new layer', target: 'puppet', as: 'layer' },
        { label: '🎭 Puppet Theater — as background', target: 'puppet', as: 'background' },
        { label: '🦊 FoxDen — input image', target: 'foxden' },
        { label: '→ FaceCycle', target: 'facecycle' },
        { label: '✎ Update', target: 'update' },
      ],
      getPayload: () => {
        const item = this.items[this.viewIdx];
        if (!item) return { error: 'No image open.' };
        return { urls: [this.fileUrl(item.path)], names: [item.name],
          source: 'Library',
          provenance: { kind: 'library', paths: [item.path] } };
      },
    });
    this.el.vSendWrap.appendChild(sendMenu.el);
    this.sendMenu = sendMenu;
    this.el.vDelete.addEventListener('click', () => this.armDelete());
    this.el.vImg.addEventListener('click', e => { if (e.target === this.el.vImg) this.closeViewer(); });
    this.onKey = e => {
      if (this.el.viewer.style.display !== 'flex') return;
      if (e.key === 'Escape') this.closeViewer();
      else if (e.key === 'ArrowLeft') this.nav(-1);
      else if (e.key === 'ArrowRight') this.nav(1);
    };
    document.addEventListener('keydown', this.onKey);
    let sx = null;
    this.el.viewer.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    this.el.viewer.addEventListener('touchend', e => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 50) this.nav(dx < 0 ? 1 : -1);
      sx = null;
    }, { passive: true });
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
}

registerModule({
  name: 'library',
  label: 'Library',
  icon: '📚',
  order: 40,
  mount(panel) { new LibraryView(panel); },
});
