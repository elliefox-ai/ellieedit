// Library module — browse promoted images (moved, never copied) with
// project tag chips + tag filter + Load more paging.
// Backend: /api/library/list|thumb|file|retag. Thumbnails reuse the same
// fingerprinted-thumb pipeline as gallery/dupe (server-side get_thumbnail
// keyed by path|mtime), so iPad stays fast.
import { registerModule } from '../shell.js';
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
      position: absolute; bottom: 20px; left: 0; right: 0; padding: 2px 6px;
      background: rgba(0,0,0,0.55); color: #b0b0d0; font-size: 9px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
    }
    .lib-cell .lib-retag {
      position: absolute; top: 4px; left: 4px; z-index: 3;
      min-width: 44px; min-height: 44px; padding: 0 8px;
      background: rgba(20,20,40,0.75); color: #ffd88f; font-size: 12px;
      border-color: #4a4a6c;
    }
    .lib-foot { padding: 10px 16px; display: flex; justify-content: center;
      border-top: 1px solid #2a2a44; }
    .lib-foot .ee-btn { min-height: 44px; min-width: 160px; }
  </style>
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="lib-header">
      <h1>Library <span style="color:#6c6c8e;font-weight:400;font-size:12px">promoted · moved, never copied</span></h1>
      <div class="lib-status" id="lib-status"></div>
    </div>
    <div class="lib-tags" id="lib-tags"></div>
    <div class="lib-grid" id="lib-grid"></div>
    <div class="lib-foot"><button class="ee-btn" id="lib-more">Load more</button></div>
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
    };
    this.tag = '';
    this.cursor = 0;
    this.total = 0;
    this.shown = 0;
    this.el.more.addEventListener('click', () => this.load());
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail?.name === 'library') this.reload();
    });
    window.addEventListener('ellieedit:library-changed', () => this.reload());
  }

  async reload() {
    this.cursor = 0;
    this.el.grid.innerHTML = '';
    await this.load();
  }

  async load() {
    try {
      const qs = buildListParams({ tag: this.tag, cursor: this.cursor });
      const r = await fetch('/api/library/list?' + qs);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (this.cursor === 0) this.renderTags(d.tags, d.total);
      for (const item of d.items) this.addCell(item);
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

  addCell(item) {
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
    const retag = document.createElement('button');
    retag.className = 'ee-btn lib-retag'; retag.textContent = '🏷';
    retag.title = 'Retag'; retag.setAttribute('aria-label', 'Retag');
    retag.addEventListener('click', async e => {
      e.stopPropagation();
      const input = prompt('Tags (comma-separated):', (item.tags || []).join(','));
      if (input === null) return;
      const tags = input.split(',').map(s => s.trim()).filter(Boolean);
      if (!tags.length) return;
      const r = await fetch('/api/library/retag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path, tags }),
      });
      if (r.ok) this.reload();
    });
    cell.append(img, chips, name, retag);
    cell.addEventListener('click', () => {
      window.open(`/api/library/file?path=${encodeURIComponent(item.path)}`, '_blank');
    });
    this.el.grid.appendChild(cell);
  }
}

registerModule({
  name: 'library',
  label: 'Library',
  icon: '📚',
  order: 40,
  mount(panel) { new LibraryView(panel); },
});
