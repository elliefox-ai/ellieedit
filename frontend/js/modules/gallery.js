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
//   'ellieedit:facecycle-handoff' { urls, names }    + activate 'facecycle'
import { registerModule } from '../shell.js';
import { planFaceCycleHandoff } from '../handoff.js';
import { planMarkBatch } from './marking-batch.js';
import { crumbsFor, joinDir, isBrowsableDir } from './gallery-path.js';
import { diffManifest, planManifestChange, pickSurvivor, scrollDeltaFor } from './gallery-scroll.js';

function panelHTML() {
  return `
  <style>
    .gal-header {
      padding: 10px 20px; background: #161628; border-bottom: 1px solid #2a2a44;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .gal-header h1 { font-size: 17px; font-weight: 600; color: #e0e0f0; }
    .gal-header h1 .subtitle { color: #6c6c8e; font-weight: 400; font-size: 12px; margin-left: 8px; }
    /* Breadcrumb folder navigation (2026-10-09e) */
    .gal-crumbs { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
    .gal-crumbs .crumb {
      background: transparent; border: none; color: #8a8ab0; font-size: 12px;
      padding: 6px 6px; min-height: 32px; cursor: pointer; border-radius: 4px;
    }
    .gal-crumbs .crumb:hover { color: #e0e0f0; background: #22223a; }
    .gal-crumbs .crumb:last-child { color: #e0e0f0; font-weight: 600; }
    .gal-crumbs .csep { color: #4a4a6c; font-size: 12px; }
    .gal-header select {
      background: #22223a; color: #d4d4e0; border: 1px solid #4a4a6c;
      border-radius: 4px; padding: 4px 8px; font-size: 12px; max-width: 220px;
    }
    .gal-status { font-size: 11px; color: #6c6c8e; flex: 1; }
    .gal-btn.toggled { background: #5b4a8a; border-color: #7a6aaa; color: #fff; }
    /* View filter: [All | Active | Pending] — server-side filtered listing */
    .gal-viewseg { display: flex; gap: 0; }
    .gal-viewseg .ee-btn { border-radius: 0; margin-right: -1px; font-size: 11px; padding: 4px 10px; }
    .gal-viewseg .ee-btn:first-child { border-radius: 4px 0 0 4px; }
    .gal-viewseg .ee-btn:last-child { border-radius: 0 4px 4px 0; margin-right: 0; }
    .gal-viewseg .ee-btn .cnt { color: #e87a7a; font-weight: 700; }
    /* Select mode: filled/inverted active pill, same treatment as view pills */
    .gal-btn.selecting { background: #3a3ab0; border-color: #7a7aff; color: #fff;
      box-shadow: 0 0 8px rgba(90,90,255,0.5); }
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
    /* Async thumb reveal (2026-10-08i): skeleton shimmer until decoded,
       then a single opacity fade. Cells keep fixed grid geometry, so no
       reflow when images land. */
    .gal-cell.thumb-loading { background: linear-gradient(110deg, #1a1a2e 30%, #24243c 45%, #1a1a2e 60%); background-size: 200% 100%; animation: gal-shimmer 1.4s linear infinite; }
    .gal-cell.thumb-loading img { opacity: 0; }
    .gal-cell.thumb-loaded img { opacity: 1; transition: opacity 0.25s ease-in; }
    @keyframes gal-shimmer { to { background-position: -200% 0; } }
    /* Folder cards (2026-10-09e): descend into subfolders */
    .gal-cell.folder { display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 4px; background: #20203a; border-color: #3a3a5c; }
    .gal-cell.folder .ficon { font-size: 30px; }
    .gal-cell.folder .fname2 { color: #c8c8e8; font-size: 11px; max-width: 95%;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* Promote lives in the lightbox viewer bar (2026-10-09c): cards are
       clean thumbnails; 44px touch target on the viewer action. */
    /* Pending-delete badge (All view + pending filter): red edge + tint */
    .gal-cell.ispending { border-color: #d04040; }
    .gal-cell.ispending img { filter: sepia(0.35) hue-rotate(-30deg) brightness(0.8); }
    .gal-cell.ispending::before {
      content: 'DELETION'; position: absolute; top: 4px; left: 4px; z-index: 2;
      background: #a02020; color: #fff; font-size: 8px; font-weight: 700;
      padding: 1px 5px; border-radius: 6px; letter-spacing: 0.5px;
    }
    .gal-cell .pd-return { position: absolute; bottom: 20px; left: 50%;
      transform: translateX(-50%); display: none; font-size: 10px; padding: 2px 8px; }
    .gal-view-pending .gal-cell .pd-return { display: block; }
    /* Champion highlight (post-ladder): gold ring + one-time flash */
    .gal-cell.champion { border-color: #e8b84d; box-shadow: 0 0 10px rgba(232,184,77,0.55); }
    .gal-cell.champion::after {
      content: '👑'; position: absolute; top: 4px; right: 4px; font-size: 14px;
      text-shadow: 0 0 4px rgba(0,0,0,0.8);
    }
    @keyframes champ-flash { 0%,100% { box-shadow: 0 0 4px rgba(232,184,77,0.3); }
      50% { box-shadow: 0 0 26px rgba(232,184,77,0.95); } }
    .gal-cell.champion.flash { animation: champ-flash 1.2s ease-in-out 2; }
    .gal-cell .name {
      position: absolute; bottom: 0; left: 0; right: 0; padding: 2px 6px;
      background: rgba(0,0,0,0.6); color: #b0b0d0; font-size: 9px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* Sticky bars: curation action bar + delete-mode marking bar + pending bar */
    .gal-bar {
      display: none; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 8px 16px; background: #1d1d33; border-top: 1px solid #4a4a6c;
    }
    .gal-bar.on { display: flex; }
    .gal-bar .msg { font-size: 12px; color: #b0b0d0; flex: 1; }
    /* 40px touch convention (matches dupe.js touch buttons) for every
       multi-select bar action, → FaceCycle included. */
    .gal-bar .ee-btn { min-height: 40px; }
    .gal-bar.marking { background: #2a1216; border-top-color: #a02020; }
    /* Pending filter sticky bottom bar — destructive action lives LOW and LEFT
       (iPad thumb-zone rule): never top-right under the operator's thumb. */
    .gal-bar.pendingbar { background: #2a1216; border-top-color: #a02020; }
    .gal-bar.pendingbar .msg { white-space: pre-wrap; }
    .gal-bar.pendingbar .ee-btn.primary { background: #6a2020; border-color: #d04040; }
    .gal-bar.pendingbar.confirming .ee-btn.primary { background: #a02020; }
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
    .gal-viewer .bar .ee-btn { min-height: 44px; }
    .gal-viewer .moved-note {
      display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
      background: rgba(20,20,40,0.85); color: #b0b0d0; font-size: 14px;
      padding: 12px 20px; border-radius: 8px; border: 1px solid #4a4a6c;
      pointer-events: none;
    }
    .gal-viewer .navzone { position: absolute; top: 60px; bottom: 0; width: 30%;
      display: flex; align-items: center; justify-content: center; font-size: 34px;
      color: rgba(255,255,255,0.25); cursor: pointer; user-select: none; -webkit-user-select: none; }
    .gal-viewer .navzone:hover { color: rgba(255,255,255,0.6); }
    .gal-viewer .navzone.left { left: 0; }
    .gal-viewer .navzone.right { right: 0; }
  </style>
  <div class="gal-header">
    <h1>Gallery <span class="subtitle">— generated images</span></h1>
    <div class="gal-crumbs" data-id="crumbs"></div>
    <span class="gal-status" data-id="status"></span>
    <div class="gal-viewseg">
      <button class="ee-btn gal-btn" data-act="view-all">All</button>
      <button class="ee-btn gal-btn toggled" data-act="view-active">Active</button>
      <button class="ee-btn gal-btn" data-act="view-pending">🗑 Deletion (<span data-id="pending-count">0</span>)</button>
    </div>
    <button class="ee-btn gal-btn" data-act="select-mode">☰ Select</button>
    <button class="ee-btn gal-btn danger" data-act="delete-mode" title="Mark images for pending delete">🚨</button>
  </div>
  <div class="gal-grid" data-id="grid"></div>
  <div class="gal-bar" data-id="action-bar">
    <span class="msg" data-id="sel-msg"></span>
    <button class="ee-btn" data-act="clear-sel">Clear</button>
    <button class="ee-btn" data-act="blend-pair" style="display:none">Blend pair</button>
    <button class="ee-btn" data-act="to-facecycle-multi" style="display:none">→ FaceCycle</button>
    <button class="ee-btn primary" data-act="ladder">Ladder <span data-id="sel-count">0</span></button>
  </div>
  <div class="gal-bar marking" data-id="marking-bar">
    <span class="msg" data-id="mark-msg">Marking for delete — nothing is deleted until you confirm in the Deletion view.</span>
    <button class="ee-btn" data-act="exit-marking">Exit marking</button>
    <button class="ee-btn primary" data-act="done-marking">✓ Done marking (<span data-id="mark-count">0</span>)</button>
  </div>
  <div class="gal-bar pendingbar" data-id="pending-bar">
    <button class="ee-btn primary" data-act="pd-delete-all">Delete all</button>
    <button class="ee-btn" data-act="pd-audit" title="Last pending-manifest mutations">◷ audit</button>
    <span class="msg" data-id="pd-msg"></span>
  </div>
  <div class="gal-viewer" data-id="viewer">
    <div class="bar">
      <span class="fname" data-id="viewer-name"></span>
      <button class="ee-btn primary" data-act="viewer-promote" title="Promote to Library (P)">⬆ Promote</button>
      <button class="ee-btn" data-act="to-update" title="Open in Update tab (version stack)">✎ Update</button>
      <button class="ee-btn danger" data-act="viewer-delete" title="Mark for deletion (Delete key) — nothing is deleted until you confirm in the Deletion view">🗑 Delete</button>
      <button class="ee-btn" data-act="close">✕</button>
    </div>
    <div class="stage"><img data-id="viewer-img" alt=""></div>
    <div class="moved-note" data-id="viewer-note">already moved — › for next</div>
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
      crumbs: panel.querySelector('[data-id="crumbs"]'),
      status: panel.querySelector('[data-id="status"]'),
      selectBtn: panel.querySelector('[data-act="select-mode"]'),
      deleteBtn: panel.querySelector('[data-act="delete-mode"]'),
      viewBtns: {
        all: panel.querySelector('[data-act="view-all"]'),
        active: panel.querySelector('[data-act="view-active"]'),
        pending: panel.querySelector('[data-act="view-pending"]'),
      },
      pendingCount: panel.querySelector('[data-id="pending-count"]'),
      actionBar: panel.querySelector('[data-id="action-bar"]'),
      selMsg: panel.querySelector('[data-id="sel-msg"]'),
      selCount: panel.querySelector('[data-id="sel-count"]'),
      blendPairBtn: panel.querySelector('[data-act="blend-pair"]'),
      fcBtn: panel.querySelector('[data-act="to-facecycle-multi"]'),
      markingBar: panel.querySelector('[data-id="marking-bar"]'),
      markMsg: panel.querySelector('[data-id="mark-msg"]'),
      markCount: panel.querySelector('[data-id="mark-count"]'),
      viewer: panel.querySelector('[data-id="viewer"]'),
      viewerName: panel.querySelector('[data-id="viewer-name"]'),
      viewerImg: panel.querySelector('[data-id="viewer-img"]'),
      viewerNote: panel.querySelector('[data-id="viewer-note"]'),
      pendingBar: panel.querySelector('[data-id="pending-bar"]'),
      pdMsg: panel.querySelector('[data-id="pd-msg"]'),
      pdDeleteAll: panel.querySelector('[data-act="pd-delete-all"]'),
    };
    this.items = [];
    this.cursor = null;
    this.dir = '';
    this.viewIdx = -1;
    this.viewFilter = 'active';    // all | active | pending (server-side filter)
    this.pendingSet = new Set();   // manifest paths, mirrors /api/pending
    this.pdBytes = 0;
    this.championPath = null;      // last ladder champion, for Gallery highlight
    this.loading = false;
    this.gen = 0;                 // bumps on reload: in-flight loadMore results from an older view are dropped
    this.anchor = null;           // {path, off, top}: where the user is, tracked while the tab is visible
    this.anchorRaf = 0;
    this.championPending = false; // flash/scroll to the champion once per Ladder round
    this.selectMode = false;
    this.deleteMode = false;
    this.selected = new Map();  // path -> item (ladder/blend selection)
    this.pdBytes = 0;
    this.markTouched = new Map(); // path -> desired on-state; committed on exit
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target.querySelector('img');
        if (img && img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        this.io.unobserve(e.target);
      }
    }, { rootMargin: '900px' });   // thumbs are warmed server-side: ask a few rows early
    this.el.grid.addEventListener('scroll', () => {
      // Prefetch ~1.5 screens ahead so the next page is usually in before you get there.
      if (this.el.grid.scrollTop + this.el.grid.clientHeight >= this.el.grid.scrollHeight - 1500) this.loadMore();
      this.noteScroll();
    });
    this.bindChrome();
    this.bindViewer();
    this.bindCrossModule();
    this.renderCrumbs();
    this.syncManifest();
    this.reload();  // initial listing — never rely on syncManifest's changed-path
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
    this.el.fcBtn.addEventListener('click', () => this.launchFaceCycle());
    act('done-marking').addEventListener('click', () => this.setDeleteMode(false));
    act('exit-marking').addEventListener('click', () => this.setDeleteMode(false));
    for (const v of ['all', 'active', 'pending']) {
      this.el.viewBtns[v].addEventListener('click', () => this.setViewFilter(v));
    }
    this.el.pdDeleteAll.addEventListener('click', () => this.pdConfirmStep());
    act('pd-audit').addEventListener('click', () => this.pdAudit());
  }

  async pdAudit() {
    // Last manifest mutations, inline (reads GET /api/pending/audit).
    try {
      const r = await fetch('/api/pending/audit?limit=10');
      const { lines } = await r.json();
      this.el.pdMsg.textContent = (lines || []).map(l =>
        `${l.ts} ${l.ip ?? '-'} ${l.action} n=${l.count}${(l.paths || []).length ? ' ' + l.paths.join(', ') : ''}`
      ).join('\n') || 'no audit entries';
    } catch { this.el.pdMsg.textContent = 'audit fetch failed'; }
  }

  setViewFilter(v) {
    if (this.viewFilter === v) return;
    this.viewFilter = v;
    for (const k of ['all', 'active', 'pending']) {
      this.el.viewBtns[k].classList.toggle('toggled', k === v);
    }
    this.el.grid.classList.toggle('gal-view-pending', v === 'pending');
    this.pdDisarm();
    this.reload();
  }

  // ---- cross-module sync -------------------------------------------------
  // Every path that changes the manifest funnels through syncManifest(); the
  // visible Gallery view always re-reads the live manifest, so marked/badge
  // state can never go stale (Ladder → Gallery returns included).
  bindCrossModule() {
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail?.name !== 'gallery') return;
      // Inactive tabs are display:none, which resets the grid's scroll to 0.
      // Put the user back on the image they were looking at BEFORE anything async.
      this.restoreAnchor(this.anchor);
      this.syncManifest().then(() => { this.flashChampion(); this.maybeFill(); });
    });
    window.addEventListener('ellieedit:pending-changed', () => this.syncManifest());
    window.addEventListener('ellieedit:ladder-complete', e => {
      this.championPath = e.detail?.champion?.path || null;
      this.championPending = !!this.championPath;
      this.applyChampion();
    });
  }

  async syncManifest() {
    try {
      // Cheap badge source (2026-10-08n): manifest keys only — no per-entry
      // stats on every Gallery activation. Bytes load lazily when the
      // Deletion view actually opens (ensurePdBytes).
      const j = await fetch('/api/pending/count').then(r => r.json());
      const fresh = new Set(j.paths || []);
      const diff = diffManifest(this.pendingSet, fresh);
      this.pendingSet = fresh;
      this.pdBytes = null;      // unknown until the Deletion view opens
      this.el.pendingCount.textContent = j.count;
      // 2026-10-15: no more wipe-and-refetch on every manifest change. Images
      // that just went pending leave the grid in place (scroll anchored);
      // only an image that came BACK needs a refetch, and that one keeps the
      // user's place too.
      const plan = planManifestChange(this.viewFilter, diff);
      if (plan.removeLocal.size) this.removeCells(plan.removeLocal);
      if (plan.reload) await this.reload({ keepPosition: true });
      else this.applyBadges();
      this.updatePendingBar();
    } catch { /* backend unavailable: leave as-is */ }
  }

  // ---- place-keeping ------------------------------------------------------
  isVisible() {
    return this.panel.classList.contains('active') && this.el.grid.clientHeight > 0;
  }

  // Remember the image at the top of the viewport (by path, so it survives
  // removals and column-count changes) plus the raw offset as a fallback.
  captureAnchor() {
    const g = this.el.grid, gr = g.getBoundingClientRect();
    for (const dy of [12, 48, 96]) {
      for (const fx of [0.5, 0.2, 0.8]) {
        const hit = document.elementFromPoint(gr.left + gr.width * fx, gr.top + dy);
        const cell = hit && hit.closest ? hit.closest('.gal-cell') : null;
        if (cell && cell.dataset.path && g.contains(cell)) {
          return { path: cell.dataset.path, off: cell.getBoundingClientRect().top - gr.top, top: g.scrollTop };
        }
      }
    }
    return { path: null, off: 0, top: g.scrollTop };
  }

  noteScroll() {
    if (this.anchorRaf || !this.isVisible()) return;
    this.anchorRaf = requestAnimationFrame(() => {
      this.anchorRaf = 0;
      if (this.isVisible()) this.anchor = this.captureAnchor();
    });
  }

  currentAnchor() { return this.isVisible() ? this.captureAnchor() : this.anchor; }

  restoreAnchor(a) {
    if (!a || !this.isVisible()) return;   // hidden: keep the stored anchor for activation
    const g = this.el.grid;
    const cell = a.path ? [...g.children].find(c => c.dataset.path === a.path) : null;
    if (cell) {
      g.scrollTop += scrollDeltaFor(cell.getBoundingClientRect().top, g.getBoundingClientRect().top, a.off);
    } else {
      g.scrollTop = a.top;
    }
  }

  // Remove cells for `set` (paths) without touching anything else, and keep
  // the user's place. Server cursors tolerate the removed items, so paging
  // simply continues from the last loaded image.
  removeCells(set) {
    if (!set.size) return;
    const g = this.el.grid;
    const visible = this.isVisible();
    let anchor = this.currentAnchor();
    if (anchor && anchor.path && set.has(anchor.path)) {
      const alt = pickSurvivor([...g.children].map(c => c.dataset.path || null), anchor.path, set);
      anchor = { path: alt, off: alt ? anchor.off : 0, top: anchor.top };
    }
    const viewing = this.el.viewer.style.display === 'flex' ? this.items[this.viewIdx] : null;
    for (const cell of [...g.children]) {
      if (cell.dataset.path && set.has(cell.dataset.path)) cell.remove();
    }
    this.items = this.items.filter(i => !set.has(i.path));
    for (const p of set) this.selected.delete(p);
    if (viewing) {
      if (!set.has(viewing.path)) this.viewIdx = this.items.indexOf(viewing);
      else if (!this.items.length) this.closeViewer();
      else this.openViewer(Math.min(this.viewIdx, this.items.length - 1));
    }
    if (anchor) { if (visible) this.restoreAnchor(anchor); else this.anchor = anchor; }
    this.updateStatus();
    this.applyBadges();
    this.updateActionBars();
    this.updateMarkCount();
    this.maybeFill();
  }

  // After removals the grid may no longer reach the prefetch threshold (and
  // then no scroll event would ever fire): top it up.
  async maybeFill() {
    const g = this.el.grid;
    while (this.cursor && !this.loading && this.isVisible() &&
           g.scrollHeight - g.scrollTop - g.clientHeight < 1500) {
      const before = this.items.length;
      await this.loadMore();
      if (this.items.length === before) break;
    }
  }

  updateStatus() {
    this.el.status.textContent =
      `${this.items.length} images${this.cursor ? ' +' : ''}` +
      (this.viewFilter === 'all' && this.pendingSet.size
        ? ` · ${this.pendingSet.size} pending` : '');
  }

  applyBadges() {
    for (const cell of this.el.grid.children) {
      cell.classList.toggle('ispending', this.pendingSet.has(cell.dataset.path));
    }
    this.updatePendingBar();
  }

  async ensurePdBytes() {
    // Bytes/sizes cost a stat per manifest entry on /mnt — pay only when
    // the Deletion view (or its confirm step) actually needs them.
    if (this.pdBytes != null || this.pdFetching) return;
    this.pdFetching = true;
    try {
      const j = await fetch('/api/pending').then(r => r.json());
      this.pdBytes = j.bytes;
      if (this.viewFilter === 'pending') this.updatePendingBar();
    } catch { /* leave unknown */ }
    finally { this.pdFetching = false; }
  }

  updatePendingBar() {
    const on = this.viewFilter === 'pending';
    this.el.pendingBar.classList.toggle('on', on);
    if (!on) return;
    const n = this.pendingSet.size;
    const bytes = this.pdBytes == null ? '' : ` · ${fmtBytes(this.pdBytes)}`;
    this.el.pdMsg.textContent = n
      ? `Deletion queue — ${n} image${n === 1 ? '' : 's'}${bytes}. Nothing is deleted until you confirm.`
      : 'Deletion queue — nothing marked.';
    this.el.pdDeleteAll.style.display = n ? '' : 'none';
    if (n) this.ensurePdBytes();
  }

  pdDisarm() {
    this.el.pendingBar.classList.remove('confirming');
    this.el.pdDeleteAll.disabled = false;
    this.el.pdDeleteAll.textContent = 'Delete all';
  }

  setSelectMode(on) {
    this.selectMode = on && !this.deleteMode;
    this.updateSelectBtn();
    if (!this.selectMode) this.clearSelection();
    else this.updateActionBars();
  }

  updateSelectBtn() {
    this.el.selectBtn.classList.toggle('selecting', this.selectMode);
    const n = this.selected.size;
    this.el.selectBtn.innerHTML = this.selectMode && n
      ? `☰ Selecting (${n})` : '☰ Select';
  }

  setDeleteMode(on) {
    this.deleteMode = on;
    this.el.deleteBtn.classList.toggle('toggled', on);
    this.el.grid.classList.toggle('marking', on);
    this.el.markingBar.classList.toggle('on', on);
    if (on) this.setSelectMode(false);
    else this.flushMarkBatch();
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

  // ---- deferred marking commit -------------------------------------------
  // Marking taps are local-only; both exit paths (Done marking / Exit
  // marking) funnel here: ONE batched manifest write + ONE syncManifest,
  // i.e. a single grid refresh instead of one per tap. Marks that were
  // never committed (page reload before Done) simply never existed server-
  // side — same clemency contract as before, just batched.
  async flushMarkBatch() {
    const { toAdd, toRemove } = planMarkBatch(this.pendingSet, this.markTouched);
    this.markTouched = new Map();
    if (!toAdd.length && !toRemove.length) return;
    try {
      if (toAdd.length) {
        await fetch('/api/pending', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: toAdd }),
        });
      }
      if (toRemove.length) {
        await fetch('/api/pending', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: toRemove }),
        });
      }
      await this.syncManifest();
    } catch (err) {
      this.toast('Manifest update failed: ' + err.message, true);
    }
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
    this.el.fcBtn.style.display = n >= 1 ? '' : 'none';
    this.updateSelectBtn();
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

  // Handoff: selection stays selected so the rings are still visible when
  // the user comes back to Gallery (👑-ring precedent: outcome visible on
  // return). FaceCycle loads a fresh stack from the jailed file URLs.
  launchFaceCycle() {
    const items = [...this.selected.values()];
    const plan = planFaceCycleHandoff(items);
    if (plan.error) { this.toast(plan.error, true); return; }
    window.dispatchEvent(new CustomEvent('ellieedit:activate', { detail: { name: 'facecycle' } }));
    window.dispatchEvent(new CustomEvent('ellieedit:facecycle-handoff',
      { detail: { urls: plan.urls, names: plan.names, provenance: plan.provenance } }));
  }

  // ---- pending delete manifest -------------------------------------------
  // Manifest state lives in this.pendingSet (kept fresh by syncManifest).

  async pdConfirmStep() {
    // Two-step confirm: first tap arms the button with the real cost.
    if (!this.el.pendingBar.classList.contains('confirming')) {
      await this.ensurePdBytes();
      this.el.pendingBar.classList.add('confirming');
      const bytes = this.pdBytes == null ? 'sizes loading' : fmtBytes(this.pdBytes);
      this.el.pdDeleteAll.textContent =
        `Really delete ${this.pendingSet.size} images (${bytes})? This cannot be undone.`;
      return;
    }
    this.pdConfirmExecute();
  }

  async pdConfirmExecute() {
    try {
      // Optimistic-concurrency: send the count the view showed the operator.
      // A 409 means the queue changed under us — re-sync and ask for a retry.
      const r = await fetch('/api/pending/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_count: this.pendingSet.size }),
      });
      if (r.status === 409) {
        await this.syncManifest();
        this.toast('Queue changed — review and retry', true);
        this.pdDisarm();
        return;
      }
      const j = await r.json();
      this.toast(`Deleted ${j.deleted} images (${fmtBytes(j.bytes)})`);
      this.pdDisarm();
      if (this.viewFilter !== 'pending') this.setViewFilter('active');
      await this.syncManifest();
      this.reload();
    } catch (err) {
      this.toast('Delete failed: ' + err.message, true);
    }
  }

  // ---- promote to library ----------------------------------------------
  // Returns an outcome so callers can react: 'moved' | 'already' (source
  // file was already gone — treated as resolved) | 'cancel' | 'error'.
  async promoteCell(item, cell) {
    let tag = '';
    try {
      const d = await fetch(`/api/library/derive?path=${encodeURIComponent(item.path)}`).then(r => r.json());
      tag = d.tag || '';
    } catch { /* derive is best-effort — empty prompt is fine */ }
    const input = prompt(`Promote to Library — tag/project:`, tag);
    if (input === null) return 'cancel';
    tag = input.trim().toLowerCase() || tag;
    try {
      const r = await fetch('/api/library/promote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path, tag }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (r.status === 404) {  // double-promote: source already moved
          this.toast(`${item.name} already promoted`);
          cell?.remove();         // reflect reality — no ghost card
          this.items = this.items.filter(i => i.path !== item.path);
          this.updateActionBars();
          return 'already';
        }
        throw new Error(err.detail || r.status);
      }
      // Move succeeded: the file is gone from GALLERY_ROOT — remove the
      // card, don't show a ghost.
      cell?.remove();
      this.items = this.items.filter(i => i.path !== item.path);
      this.selected.delete(item.path);
      this.updateActionBars();
      this.updateMarkCount();
      this.toast(`Promoted ${item.name} → ${tag}`);
      window.dispatchEvent(new CustomEvent('ellieedit:library-changed'));
      return 'moved';
    } catch (err) {
      this.toast(`Promote failed: ${err.message}`, true);
      return 'error';
    }
  }

  // Lightbox promote (P / ⬆ button): promote, then advance to the image
  // that now sits at the same index (next-in-listing). CLOSE-AT-END: when
  // the promoted image was the last one, the lightbox closes — no wrap,
  // so a promote session ends instead of re-looping promoted work.
  async promoteFromViewer() {
    const idx = this.viewIdx;
    const item = this.items[idx];
    if (!item) return;
    const cell = [...this.el.grid.children].find(c => c.dataset.path === item.path);
    const res = await this.promoteCell(item, cell);
    if (res !== 'moved' && res !== 'already') return;  // cancel/error: stay
    if (this.el.viewer.style.display !== 'flex') return;
    if (!this.items.length || idx >= this.items.length) { this.closeViewer(); return; }
    this.openViewer(Math.min(idx, this.items.length - 1));
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

  // Lightbox delete (🗑 / Delete key, 2026-10-09e): two-step confirm, then
  // enqueue into the EXISTING pending-delete manifest — never an unlink.
  // Then advance exactly like promote (close-at-end).
  armViewerDelete() {
    const btn = this.panel.querySelector('[data-act="viewer-delete"]');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Really delete? ✓ Confirm';
      return;
    }
    this.disarmViewerDelete();
    this.deleteFromViewer();
  }

  disarmViewerDelete() {
    const btn = this.panel.querySelector('[data-act="viewer-delete"]');
    delete btn.dataset.armed;
    btn.textContent = '🗑 Delete';
  }

  async deleteFromViewer() {
    const idx = this.viewIdx;
    const item = this.items[idx];
    if (!item) return;
    try {
      const r = await fetch('/api/pending', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [item.path] }),
      });
      if (!r.ok) throw new Error(r.status);
      this.toast(`Marked ${item.name} for deletion — confirm in the Deletion view`);
    } catch (err) {
      this.toast(`Delete failed: ${err.message}`, true);
      return;
    }
    await this.syncManifest();
    // Advance like promote: remove from the listing, next image takes the
    // same index; close-at-end when it was the last one.
    const cell = [...this.el.grid.children].find(c => c.dataset.path === item.path);
    cell?.remove();
    this.items = this.items.filter(i => i.path !== item.path);
    this.selected.delete(item.path);
    this.updateActionBars();
    this.updateMarkCount();
    if (this.el.viewer.style.display !== 'flex') return;
    if (!this.items.length || idx >= this.items.length) { this.closeViewer(); return; }
    this.openViewer(Math.min(idx, this.items.length - 1));
  }

  // ---- champion highlight (post-ladder visibility) ------------------------
  applyChampion() {
    for (const cell of this.el.grid.children) {
      cell.classList.toggle('champion',
        !!this.championPath && cell.dataset.path === this.championPath);
    }
  }

  flashChampion() {
    // Once per Ladder round — otherwise every tab switch would yank the grid
    // back to the champion and fight place-keeping.
    if (!this.championPath || !this.championPending) return;
    this.championPending = false;
    const cell = [...this.el.grid.children].find(c => c.dataset.path === this.championPath);
    if (!cell) return;
    const gr = this.el.grid.getBoundingClientRect(), cr = cell.getBoundingClientRect();
    if (cr.bottom < gr.top || cr.top > gr.bottom) {      // only travel if it's off-screen
      cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    cell.classList.remove('flash');
    requestAnimationFrame(() => cell.classList.add('flash'));
  }

  // ---- browse --------------------------------------------------------------
  renderCrumbs() {
    const host = this.el.crumbs;
    host.innerHTML = '';
    const crumbs = crumbsFor(this.dir);
    crumbs.forEach((c, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'csep'; sep.textContent = '›';
        host.appendChild(sep);
      }
      const b = document.createElement('button');
      b.className = 'crumb'; b.textContent = c.name;
      b.addEventListener('click', () => { this.setDir(c.dir); });
      host.appendChild(b);
    });
  }

  setDir(dir) {
    if (this.dir === dir) return;
    this.dir = dir;
    this.renderCrumbs();
    this.reload();
  }

  // keepPosition: refetch as many pages as were loaded and put the user back
  // on the image they were looking at (used for manifest changes). A plain
  // reload() is a deliberate "new view" (folder / filter change): top of list.
  async reload(opts = {}) {
    const keep = opts.keepPosition
      ? { n: this.items.length, a: this.currentAnchor() } : null;
    this.gen++;                  // drop any in-flight page from the old view
    this.loading = false;
    if (!keep) this.anchor = null;
    this.el.grid.innerHTML = '';
    this.items = []; this.cursor = null;
    this.selected.clear();
    await this.loadMore();
    if (keep) {
      while (this.cursor && this.items.length < keep.n) {
        const before = this.items.length;
        await this.loadMore();
        if (this.items.length === before) break;
      }
      this.restoreAnchor(keep.a);
    }
    this.updateActionBars();
    this.updateMarkCount();
  }

  async loadMore() {
    if (this.loading || (this.cursor === null && this.items.length)) return;
    this.loading = true;
    const gen = this.gen;
    try {
      // Pending is a GLOBAL inbox: always list the whole manifest regardless of
      // the folder dropdown, so status count and grid count agree by
      // construction (both come from this same fetch → this.items).
      const dir = this.viewFilter === 'pending' ? '' : this.dir;
      const p = new URLSearchParams({ dir, pending: this.viewFilter });
      if (this.cursor) p.set('cursor', this.cursor);
      const r = await fetch('/api/gallery/list?' + p);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      if (gen !== this.gen) return;   // view was reloaded while this page was in flight
      const start = this.items.length;
      this.items.push(...data.items);
      this.cursor = data.next_cursor;
      for (let i = 0; i < data.items.length; i++) this.addCell(data.items[i], start + i);
      // Folder cards render above the newest images on the first page of a
      // browse level (2026-10-09e). Subfolders of the CURRENT depth come
      // straight from the listing; ellieedit_tmp is filtered out.
      if (start === 0) {
        for (const d of (data.subdirs || [])) {
          if (!isBrowsableDir(d)) continue;
          this.addFolderCell(d);
        }
      }
      this.updateStatus();
      this.applyBadges();
      this.applyChampion();
    } catch (err) {
      if (gen !== this.gen) return;
      this.el.status.textContent = 'Load failed: ' + err.message;
    }
    this.loading = false;
  }

  addFolderCell(name) {
    const cell = document.createElement('div');
    cell.className = 'gal-cell folder';
    cell.dataset.folder = name;
    const icon = document.createElement('div');
    icon.className = 'ficon'; icon.textContent = '📁';
    const label = document.createElement('div');
    label.className = 'fname2'; label.textContent = name;
    cell.append(icon, label);
    cell.addEventListener('click', () => this.setDir(joinDir(this.dir, name)));
    this.el.grid.insertBefore(cell, this.el.grid.firstChild);
  }

  addCell(item, idx) {
    const cell = document.createElement('div');
    cell.className = 'gal-cell';
    cell.dataset.path = item.path;
    if (item.pending || this.pendingSet.has(item.path)) cell.classList.add('ispending');
    if (item.path === this.championPath) cell.classList.add('champion');
    const img = document.createElement('img');
    img.dataset.src = `/api/gallery/thumb?path=${encodeURIComponent(item.path)}`;
    img.alt = item.name; img.loading = 'lazy'; img.decoding = 'async';
    // Skeleton now; IO assigns src; decode/decode-failure reveals once.
    cell.classList.add('thumb-loading');
    const reveal = () => {
      cell.classList.remove('thumb-loading');
      cell.classList.add('thumb-loaded');
      this.io.unobserve(cell);
    };
    img.addEventListener('load', () => { if (img.decode) img.decode().then(reveal).catch(reveal); else reveal(); });
    img.addEventListener('error', reveal);
    const check = document.createElement('div');
    check.className = 'check';
    const name = document.createElement('div');
    name.className = 'name';
    // Pending spans folders: show the folder-qualified path as the label.
    name.textContent = item.path.includes('/') ? item.path : item.name;
    // Clemency: per-cell Return in the Pending filter view.
    const ret = document.createElement('button');
    ret.className = 'ee-btn pd-return'; ret.textContent = 'Return';
    ret.addEventListener('click', async e => {
      e.stopPropagation();
      await fetch('/api/pending', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [item.path] }),
      });
      this.toast(`Returned ${item.name} to Active`);
      await this.syncManifest();
    });
    cell.append(img, check, name, ret);
    cell.addEventListener('click', () => {
      if (this.deleteMode) {
        // Deferred: visual flip only — no fetch, no re-render, no grid swap.
        const on = !cell.classList.contains('marked');
        cell.classList.toggle('marked', on);
        check.textContent = on ? '✕' : '';
        this.markTouched.set(item.path, on);
        this.updateMarkCount();
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
      // Index at click time: removals shift positions, a captured idx would go stale.
      const at = this.items.indexOf(item);
      if (at >= 0) this.openViewer(at);
    });
    this.el.grid.appendChild(cell);
    this.io.observe(cell);
  }

  // ---- viewer ------------------------------------------------------------
  openViewer(idx) {
    this.viewIdx = idx;
    const it = this.items[idx];
    this.disarmViewerDelete();
    this.el.viewerNote.style.display = 'none';
    this.el.viewerImg.onload = () => { this.el.viewerNote.style.display = 'none'; };
    this.el.viewerImg.onerror = () => {
      // Quiet "already moved" state: file gone (promoted/deleted elsewhere);
      // navigation still works — no error dialog.
      if (this.el.viewer.style.display === 'flex') this.el.viewerNote.style.display = 'block';
    };
    this.el.viewerImg.src = this.fileUrl(it.path);
    this.el.viewerName.textContent = `${it.name} · ${it.width}×${it.height} · ${new Date(it.mtime * 1000).toLocaleString()}`;
    this.el.viewer.style.display = 'flex';
  }

  closeViewer() { this.disarmViewerDelete(); this.el.viewer.style.display = 'none'; this.el.viewerImg.src = ''; }

  nav(dir) {
    if (!this.items.length) return;
    this.openViewer((this.viewIdx + dir + this.items.length) % this.items.length);
  }

  bindViewer() {
    const act = n => this.panel.querySelector(`[data-act="${n}"]`);
    act('close').addEventListener('click', () => this.closeViewer());
    act('prev').addEventListener('click', () => this.nav(-1));
    act('next').addEventListener('click', () => this.nav(1));
    act('viewer-promote').addEventListener('click', () => this.promoteFromViewer());
    act('viewer-delete').addEventListener('click', () => this.armViewerDelete());
    act('to-update').addEventListener('click', () => {
      const item = this.items[this.viewIdx];
      if (!item) return;
      window.dispatchEvent(new CustomEvent('ellieedit:open-in-update',
        { detail: { url: this.fileUrl(item.path), name: item.name, path: item.path } }));
      window.dispatchEvent(new CustomEvent('ellieedit:activate', { detail: { name: 'update' } }));
      this.closeViewer();
    });
    this.el.viewerImg.addEventListener('click', e => { if (e.target === this.el.viewerImg) this.closeViewer(); });
    this.onKey = e => {
      if (this.el.viewer.style.display !== 'flex') return;
      if (e.key === 'Escape') this.closeViewer();
      else if (e.key === 'p' || e.key === 'P') this.promoteFromViewer();
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.armViewerDelete(); }
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
