// Dupe module — system-found near-dupe families (plan §9.1).
// Verdicts, never writes: nothing here deletes. "Send rejected → Pending
// Delete" feeds the existing Pending queue; /api/pending/confirm stays the
// only destructive endpoint. Bottom-bar rule: destructive low, navigation top.
import { registerModule } from '../shell.js';

const api = (p, opts) => fetch(`/api/dupe${p}`, opts).then(r => {
  if (!r.ok) return r.json().then(e => Promise.reject(new Error(e.detail || r.status)));
  return r.json();
});

registerModule({
  name: 'dupe',
  label: 'Dupe',
  icon: '👯',
  mount(panel, jobbar) {
    panel.innerHTML = `
    <style>
      .dupe-wrap { display:flex; flex-direction:column; height:100%; overflow:hidden; }
      .dupe-top { display:flex; gap:8px; align-items:center; padding:8px 12px;
                  border-bottom:1px solid #2a2a44; flex-wrap:wrap; flex-shrink:0; }
      .dupe-top .status { font-size:11px; color:#8a8aaa; }
      .pill { background:#1d1d33; border:1px solid #2a2a44; color:#8a8aaa;
              padding:4px 12px; border-radius:14px; cursor:pointer; font-size:12px; }
      .pill.active { background:#5b4a8a; border-color:#7a6aaa; color:#fff; }
      .dupe-scroll { flex:1; overflow-y:auto; padding:12px; }
      .fam-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; }
      .fam-card { background:#161628; border:1px solid #2a2a44; border-radius:8px;
                  padding:10px; cursor:pointer; }
      .fam-card:hover { border-color:#4a4a6c; }
      .fam-card.resolved { opacity:0.65; border-color:#3a3a55; }
      .fam-strip { display:flex; gap:4px; margin:6px 0; }
      .fam-strip img { width:25%; height:90px; object-fit:cover; border-radius:4px;
                       background:#0f0f1a; flex:1; min-width:0; }
      .fam-meta { font-size:11px; color:#8a8aaa; display:flex; gap:6px; flex-wrap:wrap; }
      .tier-badge { background:#2a2a44; border-radius:8px; padding:1px 7px; color:#b0b0d0; font-size:10px; }
      .tier-badge.exact, .tier-badge.near-identical { color:#e8c37a; }
      .verdict-tag { border-radius:8px; padding:1px 7px; font-size:10px; }
      .verdict-tag.kept { background:#1d3a25; color:#7de08a; }
      .verdict-tag.rejected { background:#3a1d1d; color:#e87a7a; }
      .verdict-tag.melded { background:#1d2a3a; color:#7ab8e8; }
      /* Detail */
      .dupe-detail { display:none; flex-direction:column; height:100%; }
      .dupe-detail.open { display:flex; }
      .fam-list.open { display:none; }
      .mem-row { display:flex; gap:12px; padding:10px; background:#161628;
                 border:1px solid #2a2a44; border-radius:8px; margin-bottom:10px;
                 align-items:center; }
      .mem-row img { width:180px; height:180px; object-fit:contain; background:#0f0f1a;
                     border-radius:6px; cursor:zoom-in; }
      .mem-info { flex:1; min-width:0; font-size:12px; color:#8a8aaa; }
      .mem-info .nm { color:#d4d4e0; word-break:break-all; }
      .mem-actions { display:flex; flex-direction:column; gap:6px; }
      .vbtn { min-width:84px; }
      .vbtn.kept.on { background:#1d3a25; border-color:#2f6a42; color:#7de08a; }
      .vbtn.rejected.on { background:#3a1d1d; border-color:#6a2f2f; color:#e87a7a; }
      .vbtn.melded.on { background:#1d2a3a; border-color:#2f4a6a; color:#7ab8e8; }
      .dupe-bottom { display:flex; gap:8px; padding:8px 12px; border-top:1px solid #2a2a44;
                     background:#12121f; flex-shrink:0; flex-wrap:wrap; align-items:center; }
      .dupe-bottom .danger { background:#3a1d1d; border-color:#6a2f2f; color:#e87a7a; }
      .dupe-bottom .danger:hover:not(:disabled) { background:#5a2a2a; }
      .rel-links a { color:#7ab8e8; cursor:pointer; text-decoration:underline; font-size:11px; }
      .dupe-note { flex:1; min-width:160px; background:#0f0f1a; color:#d4d4e0;
                   border:1px solid #2a2a44; border-radius:4px; padding:5px 8px; font-size:12px; }
      .back { margin-right:auto; }
      .dupe-more { display:flex; justify-content:center; padding:12px; }
      .fam-card.skel { opacity:0.5; pointer-events:none; }
      .skel .fam-strip img { background:#22223a; }
    </style>
    <div class="dupe-wrap">
      <div class="dupe-top">
        <span class="pill" data-f="unresolved">Unresolved</span>
        <span class="pill" data-f="resolved">Resolved</span>
        <span class="pill" data-f="all">All</span>
        <span class="status" id="dupe-status"></span>
      </div>
      <div class="dupe-scroll" id="dupe-scroll">
        <div class="fam-list" id="fam-list"></div>
        <div class="dupe-more" id="dupe-more" style="display:none">
          <button class="ee-btn" id="dupe-loadmore">Load more</button>
        </div>
        <div class="dupe-detail" id="dupe-detail"></div>
      </div>
      <div class="dupe-bottom" id="dupe-bottom" style="display:none">
        <button class="ee-btn back" id="dupe-back">← Back to families</button>
        <input class="dupe-note" id="dupe-note" placeholder="note (optional)">
        <button class="ee-btn primary" id="dupe-send">Send rejected → Pending Delete</button>
        <button class="ee-btn" id="dupe-defer">Defer family</button>
      </div>
    </div>`;

    const el = {
      pills: [...panel.querySelectorAll('.dupe-top .pill')],
      status: panel.querySelector('#dupe-status'),
      list: panel.querySelector('#fam-list'),
      more: panel.querySelector('#dupe-more'),
      loadmore: panel.querySelector('#dupe-loadmore'),
      detail: panel.querySelector('#dupe-detail'),
      scroll: panel.querySelector('#dupe-scroll'),
      bottom: panel.querySelector('#dupe-bottom'),
      back: panel.querySelector('#dupe-back'),
      note: panel.querySelector('#dupe-note'),
      send: panel.querySelector('#dupe-send'),
      defer: panel.querySelector('#dupe-defer'),
    };
    let filter = 'unresolved';
    let cursor = '';        // next families page cursor
    let exhausted = false;  // no more pages
    let current = null;      // detail family
    let picks = {};          // path -> verdict (draft in detail view)

    function job(text, cls = '') {
      jobbar.querySelectorAll('.badge.dupe').forEach(b => b.remove());
      if (text) {
        const b = document.createElement('span');
        b.className = `badge dupe ${cls}`;
        b.textContent = text;
        jobbar.appendChild(b);
      }
    }

    el.pills.forEach(p => p.addEventListener('click', () => {
      filter = p.dataset.f;
      renderList();
    }));

    el.loadmore.addEventListener('click', () => renderList(cursor));

    function skeletons(n = 6) {
      const grid = document.createElement('div');
      grid.className = 'fam-grid';
      for (let i = 0; i < n; i++) {
        const card = document.createElement('div');
        card.className = 'fam-card skel';
        const strip = document.createElement('div');
        strip.className = 'fam-strip';
        for (let j = 0; j < 4; j++) strip.appendChild(document.createElement('img'));
        const meta = document.createElement('div');
        meta.className = 'fam-meta';
        meta.innerHTML = '<span>…</span><span>loading</span>';
        card.append(strip, meta);
        grid.appendChild(card);
      }
      return grid;
    }

    async function renderStatus() {
      try {
        const s = await api('/status');
        if (!s.indexed) {
          el.status.textContent = `no index at ${s.root} — ${s.detail}`;
          return;
        }
        el.status.textContent =
          `${s.families} families · ${s.members} members · ` +
          `${s.unresolved} unresolved · index ${s.index_generated} · ${s.freshness}`;
      } catch (e) { el.status.textContent = `status failed: ${e.message}`; }
    }

    function cardFor(f) {
      const card = document.createElement('div');
      card.className = `fam-card ${f.state === 'resolved' ? 'resolved' : ''}`;
      const strip = document.createElement('div');
      strip.className = 'fam-strip';
      for (const m of (f.members || [])) {
        if (m.thumb) {
          const img = document.createElement('img');
          img.loading = 'lazy';   // per-card async — never blocks the grid
          img.src = m.thumb;
          strip.appendChild(img);
        }
      }
      const meta = document.createElement('div');
      meta.className = 'fam-meta';
      meta.innerHTML =
        `<span>${f.id}</span><span>${f.size} members</span>` +
        (f.tiers || []).map(t => `<span class="tier-badge ${t}">${t}</span>`).join('') +
        (f.state === 'resolved' ? '<span class="verdict-tag kept">resolved</span>' : '');
      card.append(strip, meta);
      card.addEventListener('click', () => renderDetail(f.id));
      return card;
    }

    async function renderList(nextCursor = '') {
      el.pills.forEach(p => p.classList.toggle('active', p.dataset.f === filter));
      el.detail.classList.remove('open');
      el.list.classList.add('open');
      el.bottom.style.display = 'none';
      current = null;
      const firstPage = !nextCursor;
      if (firstPage) {
        cursor = '';
        exhausted = false;
        el.list.innerHTML = '';
        el.list.appendChild(skeletons());   // cards-shaped progress immediately
      }
      el.more.style.display = 'none';
      job(firstPage ? 'loading families…' : 'loading more…');
      try {
        const data = await api(`/families?state=${filter}&cursor=${encodeURIComponent(nextCursor)}`);
        el.pills[0].textContent = `Unresolved (${data.counts.unresolved})`;
        el.pills[1].textContent = `Resolved (${data.counts.resolved})`;
        el.pills[2].textContent = `All (${data.total})`;
        let grid = el.list.querySelector('.fam-grid');
        if (firstPage || !grid) {
          el.list.innerHTML = '';
          grid = document.createElement('div');
          grid.className = 'fam-grid';
          el.list.appendChild(grid);
        }
        for (const f of data.items) grid.appendChild(cardFor(f));
        cursor = data.next_cursor || '';
        exhausted = !data.next_cursor;
        el.more.style.display = exhausted ? 'none' : 'flex';
        job('');
      } catch (e) { job(`dupe: ${e.message}`, 'err'); }
    }

    async function renderDetail(fid) {
      job('loading family…');
      try {
        const f = await api(`/families/${fid}`);
        current = f;
        picks = {};
        for (const [p, v] of Object.entries(f.verdicts || {})) if (v) picks[p] = v;
        el.note.value = f.note || '';
        const list = el.detail;
        list.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'fam-meta';
        head.style.margin = '4px 0 10px';
        head.innerHTML = `<span>${f.id}</span>` +
          `<span>${f.members.length} members</span>` +
          (f.state === 'resolved' ? '<span class="verdict-tag kept">resolved</span>'
                                  : '<span class="tier-badge">unresolved</span>');
        list.appendChild(head);

        for (const m of f.members) {
          const row = document.createElement('div');
          row.className = 'mem-row';
          const info = document.createElement('div');
          info.className = 'mem-info';
          info.innerHTML =
            `<div class="nm">${m.name}</div>` +
            `<div>${m.path}</div>` +
            `<div>${m.size ? (m.size / 1024).toFixed(0) + ' KB' : '?'}` +
            `${m.jailed ? ' · <b style="color:#e87a7a">jailed</b>' : ''}` +
            `${m.exists ? '' : ' · <b style="color:#e87a7a">missing</b>'}` +
            ` · dhash ${m.dhash || '?'}</div>`;
          const actions = document.createElement('div');
          actions.className = 'mem-actions';
          for (const v of ['kept', 'rejected', 'melded']) {
            const b = document.createElement('button');
            b.className = `ee-btn vbtn ${v}`;
            b.textContent = v[0].toUpperCase() + v.slice(1);
            b.addEventListener('click', () => {
              picks[m.path] = (picks[m.path] === v) ? undefined : v;
              if (!picks[m.path]) delete picks[m.path];
              syncButtons();
            });
            actions.appendChild(b);
          }
          if (m.thumb) {
            const img = document.createElement('img');
            img.src = m.thumb;
            img.addEventListener('click', () => window.open(m.thumb, '_blank'));
            row.append(img);
          } else {
            const ph = document.createElement('div');
            ph.style.cssText = 'width:180px;height:180px;background:#0f0f1a;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#5a5a7a;font-size:11px';
            ph.textContent = m.jailed ? 'jailed' : 'no image';
            row.append(ph);
          }
          row.append(info, actions);
          list.appendChild(row);
        }

        if ((f.related || []).length) {
          const rel = document.createElement('div');
          rel.className = 'rel-links';
          rel.style.marginBottom = '10px';
          rel.innerHTML = 'Related families: ';
          for (const r of f.related) {
            const a = document.createElement('a');
            a.textContent = `${r.family} (${r.tier})`;
            a.addEventListener('click', () => renderDetail(r.family));
            rel.appendChild(a);
            rel.appendChild(document.createTextNode(' '));
          }
          list.appendChild(rel);
        }

        function syncButtons() {
          [...list.querySelectorAll('.mem-row')].forEach((row, i) => {
            const m = f.members[i];
            row.querySelectorAll('.vbtn').forEach(b => {
              b.classList.toggle('on', picks[m.path] === b.className.match(/vbtn (kept|rejected|melded)/)[1]);
            });
          });
          const n = Object.values(picks).filter(v => v === 'rejected').length;
          el.send.textContent = n ? `Send ${n} rejected → Pending Delete` : 'Send rejected → Pending Delete';
        }
        syncButtons();
        syncButtons._f = syncButtons;

        el.list.classList.remove('open');
        el.detail.classList.add('open');
        el.bottom.style.display = 'flex';
        el.scroll.scrollTop = 0;
        job('');
      } catch (e) { job(`dupe: ${e.message}`, 'err'); }
    }

    el.back.addEventListener('click', renderList);

    async function saveVerdict(members, note) {
      if (!current) return;
      const r = await api(`/families/${current.id}/verdict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members, note }),
      });
      job(`verdict saved (${r.state})`, 'ok');
      return r;
    }

    el.send.addEventListener('click', async () => {
      if (!current) return;
      try {
        const picksNow = { ...picks };
        if (Object.keys(picksNow).length) {
          // the send only makes sense against a saved verdict — persist picks
          await saveVerdict(picksNow, el.note.value.trim());
        }
        const r = await api(`/families/${current.id}/send-pending`, { method: 'POST' });
        job(`pending: +${r.added} (${r.already_pending} already queued, ${r.missing} missing)`, 'ok');
        window.dispatchEvent(new CustomEvent('ellieedit:pending-changed'));
        renderList();
      } catch (e) {
        if (String(e.message).includes('no verdict')) {
          job('mark at least one member Rejected first', 'err');
        } else {
          job(`dupe: ${e.message}`, 'err');
        }
      }
    });

    el.defer.addEventListener('click', async () => {
      if (!current) return;
      try {
        const members = Object.keys(picks).length ? picks
          : Object.fromEntries(current.members.map(m => [m.path, 'deferred']));
        await saveVerdict(members, el.note.value.trim());
        renderList();
      } catch (e) { job(`dupe: ${e.message}`, 'err'); }
    });

    panel.addEventListener('ellieedit:dupe-sync', renderList);
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail?.name === 'dupe') renderList();
    });
    renderStatus();
    renderList();
  },
});
