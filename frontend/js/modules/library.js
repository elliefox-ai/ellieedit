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
    /* Gallery-style thumb reveal (2026-10-29): skeleton shimmer until
      decoded, then a short fade — thumbnails never pop in raw. */
    .lib-cell.thumb-loading { background: linear-gradient(110deg, #1a1a2e 30%, #24243c 45%, #1a1a2e 60%); background-size: 200% 100%; animation: lib-shimmer 1.4s linear infinite; }
    .lib-cell.thumb-loading img { opacity: 0; }
    .lib-cell.thumb-loaded img { opacity: 1; transition: opacity 0.25s ease-in; }
    @keyframes lib-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
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
    /* Sets + subject/shot filters (2026-10-29): the set bar and filter
      row sit under the tag chips; the dashboard is the training-set
      balance view for the set currently open. */
    .lib-filters, .lib-setbar { display: flex; gap: 8px; flex-wrap: wrap;
      padding: 8px 16px; background: #12121f; border-bottom: 1px solid #2a2a44;
      align-items: center; }
    .lib-filters select, .lib-setbar select, .lib-filters input {
      background: #1d1d33; color: #e0e0f0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 7px 8px; font-size: 12px; min-height: 34px; }
    .lib-filters input { flex: 1; min-width: 160px; }
    .lib-dash { padding: 10px 16px; background: #1a1a2e; border-bottom: 1px solid #2a2a44;
      font-size: 12px; color: #b0b0d0; line-height: 1.6; }
    .lib-dash b { color: #e0e0f0; }
    .lib-cell.selected { outline: 2px solid #7a7aff; outline-offset: -2px; }
    .lib-cell .sel { position: absolute; top: 4px; left: 4px; z-index: 2;
      width: 22px; height: 22px; border-radius: 4px; border: 1px solid #4a4a6c;
      background: rgba(20,20,40,0.85); color: #fff; font-size: 14px;
      line-height: 20px; text-align: center; cursor: pointer; }
    .lib-cell .rm { position: absolute; top: 4px; right: 4px; z-index: 2;
      width: 22px; height: 22px; border-radius: 4px; border: 1px solid #4a4a6c;
      background: rgba(20,20,40,0.85); color: #e87a7a; font-size: 13px;
      line-height: 20px; text-align: center; cursor: pointer; }
    .lib-meta { display: none; position: absolute; inset: 0; z-index: 60;
      background: rgba(8,8,16,0.8); align-items: center; justify-content: center; }
    .lib-meta .box { background: #161628; border: 1px solid #4a4a6c; border-radius: 8px;
      padding: 16px; display: flex; flex-direction: column; gap: 10px; width: min(340px, 90vw); }
    .lib-meta .box label { font-size: 12px; color: #8a8aaa; display: flex;
      flex-direction: column; gap: 4px; }
    .lib-meta .box select, .lib-meta .box input { background: #1d1d33; color: #e0e0f0;
      border: 1px solid #4a4a6c; border-radius: 4px; padding: 7px 8px; font-size: 12px; min-height: 34px; }
    /* Always-there meta side panel (2026-10-29): filters and meta
      editing live here as clickable chips — tap to add, tap again
      to remove — instead of dropdowns and a dialog. */
    .lib-layout { display: flex; height: 100%; min-height: 0; }
    .lib-side { width: 280px; flex: 0 0 280px; overflow-y: auto; background: #12121f;
      border-right: 1px solid #2a2a44; padding: 12px; display: flex;
      flex-direction: column; gap: 18px; }
    .lib-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; position: relative; }
    .lib-sec { display: flex; flex-direction: column; gap: 8px; }
    .lib-sec h4 { margin: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
      color: #8a8aaa; font-weight: 600; }
    .lib-chiprow { display: flex; gap: 6px; flex-wrap: wrap; }
    .lib-sidechip { background: #22223a; color: #c8c8e8; border: 1px solid #4a4a6c;
      border-radius: 12px; padding: 6px 12px; font-size: 12px; cursor: pointer; min-height: 32px; }
    .lib-sidechip.active { background: #3a3ab0; border-color: #7a7aff; color: #fff; }
    .lib-sidechip.mixed { border-style: dashed; color: #e8b84d; }
    .lib-side input { background: #1d1d33; color: #e0e0f0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 7px 8px; font-size: 12px; min-height: 34px; width: 100%; box-sizing: border-box; }
    .lib-side .note { font-size: 11px; color: #6c6c8e; line-height: 1.4; }
    @media (max-width: 900px) {
      .lib-layout { flex-direction: column; }
      .lib-side { width: auto; flex: 0 0 auto; max-height: 42%; border-right: none;
        border-bottom: 1px solid #2a2a44; }
    }
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
  <div style="height:100%;position:relative">
  <div class="lib-layout">
    <aside class="lib-side">
      <section class="lib-sec">
        <h4>Filter — tap to add, tap again to remove</h4>
        <span class="note">Subject</span>
        <div class="lib-chiprow" id="lib-subject"></div>
        <span class="note">Shot</span>
        <div class="lib-chiprow" id="lib-shot"></div>
        <button class="ee-btn" id="lib-clear-filters">Clear filters</button>
      </section>
      <section class="lib-sec">
        <h4>Meta — selected images</h4>
        <span class="note" id="lib-side-meta-status">Select images in the grid, then tap a chip below to set it on all of them. Tap an active chip again to remove it. No dropdowns, no dialog.</span>
        <span class="note">Subject</span>
        <div class="lib-chiprow" id="lib-side-meta-subject"></div>
        <span class="note">Shot</span>
        <div class="lib-chiprow" id="lib-side-meta-shot"></div>
        <span class="note">Figures</span>
        <div class="lib-chiprow" id="lib-side-meta-figures"></div>
        <span class="note">Detail</span>
        <input id="lib-side-detail" placeholder="e.g. woman, horse, car">
        <button class="ee-btn" id="lib-side-detail-save">Set detail on selected</button>
      </section>
      <section class="lib-sec">
        <h4>Sets</h4>
        <span class="note">Sets and the balance dashboard live in the bar above the grid. Add the selection to a set there, then watch its balance.</span>
      </section>
    </aside>
    <div class="lib-main">
    <div class="lib-header">
      <h1>Library <span style="color:#6c6c8e;font-weight:400;font-size:12px">promoted · moved, never copied</span></h1>
      <div class="lib-status" id="lib-status"></div>
    </div>
    <div class="lib-tags" id="lib-tags"></div>
    <div class="lib-filters" id="lib-filters">
      <input id="lib-search" placeholder="search name, detail, tag…">
      <button class="ee-btn" id="lib-select">☐ Select</button>
    </div>
    <div class="lib-setbar" id="lib-setbar">
      <select id="lib-set"><option value="">no set</option></select>
      <button class="ee-btn" id="lib-set-new">＋ New set</button>
      <button class="ee-btn" id="lib-set-view">View set</button>
      <button class="ee-btn" id="lib-set-add" disabled>Add selected to set</button>
      <a class="ee-btn" id="lib-set-export" style="display:none">⬇ Export set</a>
      <span class="lib-status" id="lib-sel-count"></span>
    </div>
    <div class="lib-dash" id="lib-dash" style="display:none"></div>
    <div class="lib-meta" id="lib-meta">
      <div class="box">
        <b>Subject / shot metadata</b>
        <span style="font-size:11px;color:#6c6c8e">Human-entered, never auto-generated.
          For a selection, "keep" leaves that field untouched.</span>
        <label>Subject <select id="libm-subject"></select></label>
        <label>Shot <select id="libm-shot"></select></label>
        <label>Figures <select id="libm-figures"></select></label>
        <label>Detail (e.g. woman, horse, car) <input id="libm-detail"></label>
        <div style="display:flex;gap:8px">
          <button class="ee-btn" id="libm-save" style="flex:1">Save</button>
          <button class="ee-btn" id="libm-cancel" style="flex:1">Cancel</button>
        </div>
      </div>
    </div>
    <div class="lib-grid" id="lib-grid"></div>
    <div class="lib-foot"><button class="ee-btn" id="lib-more">Load more</button></div>
    </div>
  </div>
    <div class="lib-viewer" id="lib-viewer">
      <div class="bar">
        <span class="fname" id="libv-name"></span>
        <button class="ee-btn" id="libv-retag" title="Retag">🏷 Retag</button>
        <button class="ee-btn" id="libv-meta" title="Subject / shot metadata">🎬 Meta</button>
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
      vMeta: panel.querySelector('#libv-meta'),
      vFamily: panel.querySelector('#libv-family'),
      vSendWrap: panel.querySelector('#libv-sendwrap'),
      vDelete: panel.querySelector('#libv-delete'),
      subject: panel.querySelector('#lib-subject'),
      shot: panel.querySelector('#lib-shot'),
      search: panel.querySelector('#lib-search'),
      selectBtn: panel.querySelector('#lib-select'),
      setSel: panel.querySelector('#lib-set'),
      setNew: panel.querySelector('#lib-set-new'),
      setView: panel.querySelector('#lib-set-view'),
      setAdd: panel.querySelector('#lib-set-add'),
      setExport: panel.querySelector('#lib-set-export'),
      sideMetaStatus: panel.querySelector('#lib-side-meta-status'),
      sideMetaSubject: panel.querySelector('#lib-side-meta-subject'),
      sideMetaShot: panel.querySelector('#lib-side-meta-shot'),
      sideMetaFigures: panel.querySelector('#lib-side-meta-figures'),
      sideDetail: panel.querySelector('#lib-side-detail'),
      sideDetailSave: panel.querySelector('#lib-side-detail-save'),
      clearFilters: panel.querySelector('#lib-clear-filters'),
      selCount: panel.querySelector('#lib-sel-count'),
      dash: panel.querySelector('#lib-dash'),
      metaDlg: panel.querySelector('#lib-meta'),
      mSubject: panel.querySelector('#libm-subject'),
      mShot: panel.querySelector('#libm-shot'),
      mFigures: panel.querySelector('#libm-figures'),
      mDetail: panel.querySelector('#libm-detail'),
    };
    this.tag = '';
    this.subject = '';
    this.shot = '';
    this.q = '';
    this.cursor = 0;
    this.total = 0;
    this.shown = 0;
    this.items = [];   // flat filtered listing — the lightbox navigates this
    this.viewIdx = -1;
    this.viewingOriginal = false;   // family toggle state in the viewer
    this.selectMode = false;
    this.selected = new Set();  // library paths, in selection order
    this.setId = '';
    this.setViewMode = false;
    this.currentSet = null;
    this.metaPaths = [];
    this.loading = false;
    this.gen = 0;
    // Gallery-style streaming (2026-10-29): thumbnails are only
    // requested when near the viewport, and the next page loads
    // automatically near the bottom — no "Load more" click, no
    // 40-at-once thumbnail burst.
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target.querySelector('img');
        if (img && img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        this.io.unobserve(e.target);
      }
    }, { rootMargin: '900px' });
    this.el.grid.addEventListener('scroll', () => {
      const g = this.el.grid;
      if (g.scrollTop + g.clientHeight >= g.scrollHeight - 1500) this.load();
    });
    this.el.more.addEventListener('click', () => this.load());
    this.el.clearFilters.addEventListener('click', () => {
      this.subject = ''; this.shot = ''; this.tag = '';
      this.renderFilterChips();
      this.reload();
    });
    this.el.sideDetailSave.addEventListener('click', () => this.applySideDetail());
    this.el.search.addEventListener('input', () => {
      clearTimeout(this._searchT);
      this._searchT = setTimeout(() => { this.q = this.el.search.value.trim(); this.reload(); }, 400);
    });
    this.el.selectBtn.addEventListener('click', () => this.toggleSelectMode());
    this.el.setNew.addEventListener('click', () => this.createSet());
    this.el.setView.addEventListener('click', () => this.toggleSetView());
    this.el.setAdd.addEventListener('click', () => this.addSelectedToSet());
    this.el.setSel.addEventListener('change', () => { this.setId = this.el.setSel.value; this.updateSetBar(); });
    this.panel.querySelector('#libm-cancel').addEventListener('click', () => this.closeMeta());
    this.panel.querySelector('#libm-save').addEventListener('click', () => this.saveMeta());
    this.loadSets();
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail?.name === 'library') this.reload();
    });
    window.addEventListener('ellieedit:library-changed', () => this.reload());
    this.bindViewer();
  }

  fileUrl(path) { return `/api/library/file?path=${encodeURIComponent(path)}`; }

  async reload() {
    this.gen++;  // drop any in-flight page from the old view
    this.loading = false;
    this.cursor = 0;
    this.items = [];
    this.el.grid.innerHTML = '';
    if (this.setViewMode) { await this.loadSet(); return; }
    await this.load();
  }

  async load() {
    if (this.loading) return;
    if (this.cursor !== 0 && this.cursor == null) return;
    this.loading = true;
    const gen = this.gen;
    try {
      const qs = buildListParams({ tag: this.tag, cursor: this.cursor,
        subject: this.subject, shot: this.shot, q: this.q });
      const r = await fetch('/api/library/list?' + qs);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (gen !== this.gen) { this.loading = false; return; }  // view changed while paging
      if (this.cursor === 0) {
        this.renderTags(d.tags, d.total_all ?? d.total);
        this.renderMetaFilters(d.meta_vocab);
      }
      for (const item of d.items) {
        this.items.push(item);
        this.addCell(item, this.items.length - 1);
      }
      this.cursor = d.next_cursor;
      this.total = d.total;
      this.shown = this.el.grid.children.length;
      // Infinite scroll replaces the Load more button (Gallery-style);
      // the button stays in the DOM as a fallback but is not shown.
      this.el.more.style.display = 'none';
      this.el.status.textContent = countLine(this.shown, d.total, this.tag);
    } catch (err) {
      if (gen !== this.gen) { this.loading = false; return; }
      this.el.status.textContent = 'Library load failed: ' + err.message;
    }
    this.loading = false;
    if (gen === this.gen) this.maybeTopUp();
  }

  // If the grid is not yet scrollable (short listing, tall viewport),
  // no scroll event will ever fire — top it up until it is, or the
  // listing is exhausted. Same pattern as the Gallery.
  maybeTopUp() {
    const g = this.el.grid;
    if (this.cursor != null && !this.loading &&
        g.scrollHeight - g.scrollTop - g.clientHeight < 1500) this.load();
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

  renderMetaFilters(vocab) {
    if (vocab) this._vocab = vocab;
    this.renderFilterChips();
    this.renderSideMetaChips();
  }

  // Filter chips (side panel): tap to set, tap the active one again
  // to clear. No dropdown, no separate Apply — a filter change is a
  // genuine view change, so it reloads (with streaming, cleanly).
  renderFilterChips() {
    if (!this._vocab) return;
    for (const [host, values, current, field] of [
      [this.el.subject, this._vocab.subjects, this.subject, 'subject'],
      [this.el.shot, this._vocab.shots, this.shot, 'shot']]) {
      host.innerHTML = '';
      for (const v of values) {
        const b = document.createElement('button');
        b.className = 'lib-sidechip' + (current === v ? ' active' : '');
        b.textContent = v;
        b.addEventListener('click', () => {
          this[field] = this[field] === v ? '' : v;
          this.renderFilterChips();
          this.reload();
        });
        host.appendChild(b);
      }
    }
  }

  // Side-panel meta chips: the same tap-to-add / tap-again-to-remove
  // pattern, applied to the current selection. A chip is active when
  // every selected image already carries that value, dashed ("mixed")
  // when only some do. Applying updates items and cells in place —
  // never a grid reload, or the flicker fix would be undone.
  renderSideMetaChips() {
    if (!this._vocab) return;
    const selItems = this.items.filter(i => this.selected.has(i.path));
    this.el.sideMetaStatus.textContent = selItems.length
      ? `${selItems.length} selected — tap a chip to set it on all of them, tap an active chip again to remove it.`
      : 'Select images in the grid, then tap a chip below to set it on all of them. Tap an active chip again to remove it. No dropdowns, no dialog.';
    const groups = [
      [this.el.sideMetaSubject, this._vocab.subjects, 'subject'],
      [this.el.sideMetaShot, this._vocab.shots, 'shot'],
      [this.el.sideMetaFigures, this._vocab.figures || ['none', '1', '2', '3+'], 'figures'],
    ];
    for (const [host, values, field] of groups) {
      host.innerHTML = '';
      const vals = new Set(selItems.map(i => (i.meta || {})[field] || ''));
      const common = vals.size === 1 ? [...vals][0] : '';
      for (const v of values) {
        const b = document.createElement('button');
        b.className = 'lib-sidechip' +
          (common === v ? ' active' : (vals.has(v) ? ' mixed' : ''));
        b.textContent = v;
        b.addEventListener('click', () => this.applySideMeta(field, common === v ? '' : v));
        host.appendChild(b);
      }
    }
  }

  async applySideMeta(field, value) {
    if (!this.selected.size) { this.toast('Select images first', true); return; }
    const body = { paths: [...this.selected], subject: null, shot: null, figures: null, detail: null };
    body[field] = value;
    const r = await fetch('/api/library/meta/bulk', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { this.toast('Meta save failed: ' + r.status, true); return; }
    this.updateItemsMetaInPlace([...this.selected], { [field]: value });
    this.renderSideMetaChips();
  }

  async applySideDetail() {
    const detail = this.el.sideDetail.value.trim();
    if (!this.selected.size) { this.toast('Select images first', true); return; }
    if (!detail) { this.toast('Type a detail first', true); return; }
    const r = await fetch('/api/library/meta/bulk', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [...this.selected], subject: null, shot: null, figures: null, detail }) });
    if (!r.ok) { this.toast('Meta save failed: ' + r.status, true); return; }
    this.updateItemsMetaInPlace([...this.selected], { detail });
    this.renderSideMetaChips();
  }

  updateItemsMetaInPlace(paths, patch) {
    const set = new Set(paths);
    for (const item of this.items) {
      if (!set.has(item.path)) continue;
      item.meta = { ...(item.meta || {}), ...patch };
      const cell = [...this.el.grid.children].find(c => c.dataset.path === item.path);
      if (!cell) continue;
      const meta = item.meta;
      const text = [meta.subject, meta.shot, meta.detail].filter(Boolean).join(' · ');
      let chip = cell.querySelector('.meta-chip');
      if (!text) { chip?.remove(); continue; }
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'chip meta-chip';
        cell.querySelector('.lib-chips')?.appendChild(chip);
      }
      chip.textContent = text;
    }
  }

  // Selection must never reload the grid (2026-10-29 flicker fix):
  // reload() clears grid.innerHTML and rebuilds every cell, so every
  // thumbnail re-renders — once when Select is clicked, and again
  // on every single selection. Selection is purely local state, so
  // it updates the existing cells in place: checkbox text + outline
  // + selection bar only. No fetch, no re-render, no flicker.
  toggleSelectMode() {
    this.selectMode = !this.selectMode;
    if (!this.selectMode) this.selected.clear();
    this.el.selectBtn.textContent = this.selectMode ? '☑ Select' : '☐ Select';
    this.updateSelectionBar();
    this.syncSelectionUI();
  }

  toggleCellSelection(cell, path) {
    if (this.selected.has(path)) this.selected.delete(path);
    else this.selected.add(path);
    cell.classList.toggle('selected', this.selected.has(path));
    const sel = cell.querySelector('.sel');
    if (sel) sel.textContent = this.selected.has(path) ? '✓' : '';
    this.updateSelectionBar();
  }

  syncSelectionUI() {
    for (const cell of this.el.grid.children) {
      const path = cell.dataset.path;
      let sel = cell.querySelector('.sel');
      if (!this.selectMode) {
        sel?.remove();
        cell.classList.remove('selected');
        continue;
      }
      if (!sel) {
        sel = document.createElement('span');
        sel.className = 'sel';
        sel.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleCellSelection(cell, path);
        });
        cell.appendChild(sel);
      }
      sel.textContent = this.selected.has(path) ? '✓' : '';
      cell.classList.toggle('selected', this.selected.has(path));
    }
  }

  updateSelectionBar() {
    this.el.selCount.textContent = this.selected.size
      ? `${this.selected.size} selected` : '';
    this.el.setAdd.disabled = !this.selected.size;
    this.renderSideMetaChips();
  }

  async loadSets() {
    try {
      const d = await (await fetch('/api/library/sets')).json();
      const cur = this.el.setSel.value;
      this.el.setSel.innerHTML = '<option value="">no set</option>';
      for (const s of d.sets || []) {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = `${s.name} (${s.member_count})${s.status === 'locked' ? ' 🔒' : ''}`;
        this.el.setSel.appendChild(o);
      }
      if ([...this.el.setSel.options].some(o => o.value === cur)) this.el.setSel.value = cur;
      this.setId = this.el.setSel.value;
    } catch { /* quiet — sets are optional */ }
    this.updateSetBar();
  }

  updateSetBar() {
    this.el.setView.textContent = this.setViewMode ? 'All library' : 'View set';
    this.el.setExport.style.display = (this.setViewMode && this.setId) ? '' : 'none';
    if (this.setId) this.el.setExport.href = `/api/library/sets/${this.setId}/export`;
    this.el.dash.style.display = (this.setViewMode && this.currentSet) ? '' : 'none';
  }

  async createSet() {
    const name = prompt('New set name (e.g. color-hold-v2):');
    if (!name || !name.trim()) return;
    const r = await fetch('/api/library/sets', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), purpose: 'LoRA training' }) });
    if (!r.ok) { this.toast('Set creation failed', true); return; }
    await this.loadSets();
    const created = await r.json();
    this.el.setSel.value = created.id;
    this.setId = created.id;
    this.toast(`Set "${created.name}" created`);
  }

  async toggleSetView() {
    if (this.setViewMode) {
      this.setViewMode = false;
      this.currentSet = null;
      this.updateSetBar();
      await this.reload();
      return;
    }
    if (!this.setId) { this.toast('Pick a set first', true); return; }
    this.setViewMode = true;
    await this.reload();
  }

  async loadSet() {
    try {
      const d = await (await fetch(`/api/library/sets/${this.setId}`)).json();
      this.currentSet = d;
      this.items = d.members.filter(m => !m.missing)
        .map(m => ({ path: m.path, name: m.name, tags: m.tags, meta: m.meta }));
      this.el.grid.innerHTML = '';
      this.items.forEach((item, i) => this.addCell(item, i));
      this.total = d.member_count;
      this.shown = this.items.length;
      this.el.more.style.display = 'none';
      this.el.status.textContent = `set "${d.name}" — ${d.member_count} members` +
        (d.missing_count ? ` (${d.missing_count} missing from disk)` : '') +
        (d.status === 'locked' ? ' · 🔒 locked' : '');
      this.renderDash(d);
      this.renderSideMetaChips();
    } catch (err) {
      this.el.status.textContent = 'Set load failed: ' + err.message;
    }
    this.updateSetBar();
  }

  renderDash(d) {
    const dist = d.distribution || {};
    const top = (obj) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`).join(', ') || '—';
    const topCombo = Object.entries(dist.by_combo || {}).sort((a, b) => b[1] - a[1])[0];
    let note = '';
    if (topCombo && d.member_count >= 10 && topCombo[1] / d.member_count >= 0.5) {
      note = `<br>⚠ Top combo is ${topCombo[0]} at ${Math.round(topCombo[1] / d.member_count * 100)}% — ` +
        'if you want balance, look for other subjects or shots next.';
    }
    this.el.dash.innerHTML = `<b>Balance</b> — by subject: ${top(dist.by_subject)}` +
      `<br>by shot: ${top(dist.by_shot)}` +
      `<br>by subject/shot: ${top(dist.by_combo)}` + note;
  }

  async addSelectedToSet() {
    if (!this.setId) {
      await this.createSet();
      if (!this.setId) return;
    }
    const r = await fetch(`/api/library/sets/${this.setId}/members`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [...this.selected] }) });
    if (!r.ok) { this.toast('Add to set failed: ' + r.status, true); return; }
    this.toast(`Added ${this.selected.size} to set`);
    this.selected.clear();
    this.updateSelectionBar();
    await this.loadSets();
  }

  async removeFromSet(path) {
    const r = await fetch(`/api/library/sets/${this.setId}/members/remove`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path] }) });
    if (!r.ok) { this.toast('Remove failed', true); return; }
    await this.loadSet();
  }

  openMeta(paths, initial, bulk) {
    this.metaPaths = paths;
    const fill = (sel, values, current) => {
      sel.innerHTML = '';
      if (bulk) {
        const k = document.createElement('option');
        k.value = '__keep__'; k.textContent = 'keep';
        sel.appendChild(k);
      } else {
        const e = document.createElement('option');
        e.value = ''; e.textContent = '—';
        sel.appendChild(e);
      }
      for (const v of values) {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        if (!bulk && current === v) o.selected = true;
        sel.appendChild(o);
      }
    };
    fill(this.el.mSubject, ['person', 'animal', 'vehicle', 'building', 'landscape', 'object', 'other'], initial?.subject);
    fill(this.el.mShot, ['close-up', 'medium', 'wide', 'full', 'other'], initial?.shot);
    fill(this.el.mFigures, ['none', '1', '2', '3+'], initial?.figures);
    this.el.mDetail.value = bulk ? '' : (initial?.detail || '');
    this.el.mDetail.placeholder = bulk ? 'leave blank to keep' : 'e.g. woman, horse, car';
    this.el.metaDlg.style.display = 'flex';
  }

  closeMeta() { this.el.metaDlg.style.display = 'none'; }

  async saveMeta() {
    const pick = (v) => (v === '__keep__' ? null : v);
    const paths = this.metaPaths;
    const url = paths.length > 1 ? '/api/library/meta/bulk' : '/api/library/meta';
    const body = paths.length > 1
      ? { paths, subject: pick(this.el.mSubject.value), shot: pick(this.el.mShot.value),
          figures: pick(this.el.mFigures.value),
          detail: this.el.mDetail.value.trim() ? this.el.mDetail.value.trim() : null }
      : { path: paths[0], subject: this.el.mSubject.value, shot: this.el.mShot.value,
          figures: this.el.mFigures.value, detail: this.el.mDetail.value.trim() };
    const r = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { this.toast('Meta save failed: ' + r.status, true); return; }
    this.closeMeta();
    this.toast(paths.length > 1 ? `Meta saved for ${paths.length} images` : 'Meta saved');
    await this.reload();
  }

  addCell(item, idx) {
    const cell = document.createElement('div');
    cell.className = 'lib-cell';
    cell.dataset.path = item.path;
    const img = document.createElement('img');
    // Gallery-style: src is assigned by the IntersectionObserver when
    // the cell nears the viewport, not for all 40 thumbnails at once.
    img.dataset.src = `/api/library/thumb?path=${encodeURIComponent(item.path)}`;
    img.alt = item.name; img.loading = 'lazy'; img.decoding = 'async';
    cell.classList.add('thumb-loading');
    const reveal = () => {
      cell.classList.remove('thumb-loading');
      cell.classList.add('thumb-loaded');
      this.io.unobserve(cell);
    };
    img.addEventListener('load', () => { if (img.decode) img.decode().then(reveal).catch(reveal); else reveal(); });
    img.addEventListener('error', reveal);
    const chips = document.createElement('div');
    chips.className = 'lib-chips';
    for (const t of (item.tags || [])) {
      const c = document.createElement('span');
      c.className = 'chip'; c.textContent = t;
      chips.appendChild(c);
    }
    // Subject/shot chip, so a set's balance is scannable in the grid.
    const meta = item.meta || {};
    if (meta.subject || meta.shot) {
      const c = document.createElement('span');
      c.className = 'chip meta-chip';
      c.textContent = [meta.subject, meta.shot, meta.detail].filter(Boolean).join(' · ');
      chips.appendChild(c);
    }
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = item.name;
    cell.append(img, chips, name);
    if (this.selectMode) {
      const sel = document.createElement('span');
      sel.className = 'sel';
      sel.textContent = this.selected.has(item.path) ? '✓' : '';
      if (this.selected.has(item.path)) cell.classList.add('selected');
      sel.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleCellSelection(cell, item.path);
      });
      cell.appendChild(sel);
    }
    if (this.setViewMode && this.currentSet?.status !== 'locked') {
      const rm = document.createElement('span');
      rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'Remove from set';
      rm.addEventListener('click', (e) => { e.stopPropagation(); this.removeFromSet(item.path); });
      cell.appendChild(rm);
    }
    // ⧉ badge on finals that carry a version family (Phase 0).
    if (item.kind === 'version-family' && item.original) {
      const b = document.createElement('span');
      b.className = 'lib-fambadge'; b.textContent = '⧉';
      b.title = 'Version family — open to see the original';
      cell.appendChild(b);
    }
    // Lightbox instead of raw-file navigation (2026-10-09e); in select
    // mode a cell click toggles selection instead of opening the viewer.
    cell.addEventListener('click', () => {
      if (this.selectMode) {
        this.toggleCellSelection(cell, item.path);
        return;
      }
      this.openViewer(idx);
    });
    this.el.grid.appendChild(cell);
    this.io.observe(cell);
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
    this.el.vMeta.addEventListener('click', () => {
      const item = this.items[this.viewIdx];
      if (item) this.openMeta([item.path], item.meta || {}, false);
    });
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
