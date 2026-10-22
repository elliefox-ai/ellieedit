// Puppet Theater — multi-subject compose stage (work order 2026-10-22).
// Humans place rmbg cutouts as baked pixels (drag / resize / rotate,
// nondestructive alpha-mask erase); the model only gets a final fenced
// low-denoise harmonization pass (0.4–0.5, server-clamped) via
// /api/puppet/render. Poses are pixels, not prompt-wishes.
// Backend: /api/puppet/*. Pure logic: puppet-core.js (node-tested).
import { registerModule } from '../shell.js';
import { clampDenoise, presetSize, normalizeState, defaultState, fitPlacement,
  moveLayerZ, stageToLocal, localToStage, handlePositions, resizeRect,
  rotationFromPointer, pointerAngle, History, CANVAS_PRESETS } from './puppet-core.js';

const API = '/api/puppet';
const FOX = '/api/foxden';
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => 'lyr-' + Math.random().toString(36).slice(2, 9);

registerModule({
  name: 'puppet',
  label: 'Puppet Theater',
  icon: '🎭',
  order: 30,
  mount(panel, jobbar) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('./puppet.css', import.meta.url).href;
    document.head.appendChild(css);

    panel.innerHTML = `
    <div class="pt-wrap">
      <div class="pt-side">
        <div class="pt-status" data-id="conn">connecting…</div>
        <div><label>Project name</label><input type="text" data-id="pname"></div>
        <div class="pt-row">
          <select data-id="popen" style="flex:1;min-width:120px"><option value="">Open project…</option></select>
          <button class="ee-btn pt-btn" data-id="pnew" title="Start a fresh theater">New</button>
          <button class="ee-btn pt-btn" data-id="psave" title="Save now (autosaves too)">💾</button>
        </div>
        <div class="pt-status" data-id="savestat"></div>
        <div class="pt-sec">Stage</div>
        <div class="pt-row">
          <select data-id="preset">
            <option value="1:1">1:1 · 1024×1024</option>
            <option value="3:2">3:2 · 1152×768</option>
            <option value="16:9">16:9 · 1280×720</option>
            <option value="last">last used</option>
            <option value="custom">custom…</option>
          </select>
          <input type="number" data-id="cw" title="canvas width" style="width:76px">
          <span class="pt-x">×</span>
          <input type="number" data-id="ch" title="canvas height" style="width:76px">
          <button class="ee-btn pt-btn" data-id="apply-size">Set</button>
        </div>
        <div><label>Background prompt (FoxDen generation)</label>
          <input type="text" data-id="bgprompt" placeholder="empty stage, wooden floor…"></div>
        <div class="pt-row">
          <button class="ee-btn pt-btn" data-id="bggen">🎨 Generate bg</button>
          <button class="ee-btn pt-btn" data-id="bgup">⬆ Upload bg</button>
          <button class="ee-btn pt-btn" data-id="bgclear">✕ Blank</button>
          <input type="file" accept="image/*" data-id="bgfile" style="display:none">
        </div>
        <div class="pt-sec">Puppets</div>
        <button class="ee-btn primary pt-go" data-id="add">＋ Add puppet images</button>
        <input type="file" accept="image/*" multiple data-id="afile" style="display:none">
        <div class="pt-hint">…or drop images straight onto the stage. Backgrounds are
          removed automatically; the cutout is placed as baked pixels.</div>
        <div class="pt-sec">Tools</div>
        <div class="pt-row" data-id="tools">
          <button class="ee-btn pt-btn on" data-tool="move">✥ Move</button>
          <button class="ee-btn pt-btn" data-tool="erase">🧽 Erase</button>
          <button class="ee-btn pt-btn" data-tool="restore">🖌 Restore</button>
        </div>
        <div><label>Brush size <span data-id="bsize-val">48</span> · edge <span data-id="bhard-val">70%</span></label>
          <div class="pt-row">
            <input type="range" data-id="bsize" min="6" max="240" step="2" value="48" style="flex:1" aria-label="Brush size">
            <input type="range" data-id="bhard" min="0" max="100" step="5" value="70" style="flex:1" aria-label="Brush hardness">
          </div></div>
        <div class="pt-row">
          <button class="ee-btn pt-btn" data-id="maskreset">Reset mask</button>
          <button class="ee-btn pt-btn" data-id="undo">↩ Undo</button>
          <button class="ee-btn pt-btn" data-id="redo">↪ Redo</button>
        </div>
        <div class="pt-sec">Final pass — harmonize</div>
        <div><label>Atmosphere (optional)</label>
          <input type="text" data-id="rprompt" placeholder="golden hour, soft rim light…"></div>
        <div><label>Denoise <span data-id="dval">0.45</span> — fenced 0.40–0.50</label>
          <input type="range" data-id="denoise" min="0.4" max="0.5" step="0.01" value="0.45" aria-label="Final pass denoise"></div>
        <button class="ee-btn primary pt-go" data-id="render">✨ Render final pass</button>
        <div class="pt-sec">Export</div>
        <div class="pt-row">
          <button class="ee-btn pt-btn" data-id="expng">⬇ Composite PNG</button>
          <button class="ee-btn pt-btn" data-id="exjson">⬇ Layer stack JSON</button>
        </div>
        <div class="pt-status" data-id="status"></div>
      </div>
      <div class="pt-main">
        <div class="pt-stagewrap" data-id="stagewrap">
          <div class="pt-stage" data-id="stage">
            <img class="pt-bg" data-id="bgimg" alt="">
            <div class="pt-empty" data-id="empty">Drop puppet images here — poses stay exactly as placed.</div>
          </div>
          <div class="pt-preview" data-id="preview">
            <img data-id="previewimg" alt="final pass preview">
            <div class="pt-pvbar">
              <span>Final pass preview — the layer stack underneath is untouched.</span>
              <button class="ee-btn primary pt-btn" data-id="pvaccept">✓ Accept as new stage picture</button>
              <button class="ee-btn pt-btn" data-id="pvdiscard">✕ Discard</button>
            </div>
          </div>
        </div>
      </div>
      <div class="pt-layers">
        <div class="pt-sec">Layers <span data-id="lcount"></span></div>
        <div class="pt-llist" data-id="llist"></div>
        <div class="pt-hint">Top of the list paints last (on top). Select a layer,
          then drag it on stage; corners resize (Shift = free-stretch), the
          stalk rotates. Erase paints the layer's mask — the pixels are
          never destroyed, Reset mask brings everything back.</div>
      </div>
    </div>`;
    const $ = id => panel.querySelector(`[data-id="${id}"]`);
    const ids = ['conn', 'pname', 'popen', 'pnew', 'psave', 'savestat', 'preset', 'cw', 'ch',
      'apply-size', 'bgprompt', 'bggen', 'bgup', 'bgclear', 'bgfile', 'add', 'afile',
      'tools', 'bsize', 'bsize-val', 'bhard', 'bhard-val', 'maskreset', 'undo', 'redo',
      'rprompt', 'denoise', 'dval', 'render', 'expng', 'exjson', 'status',
      'stagewrap', 'stage', 'bgimg', 'empty', 'preview', 'previewimg', 'pvaccept',
      'pvdiscard', 'lcount', 'llist'];
    const el = Object.fromEntries(ids.map(k => [k, $(k)]));

    // ------------------------------------------------------------ state
    let state = defaultState();
    let projectId = null;
    let selectedId = null;
    let tool = 'move';
    let fitScale = 1;
    let previewAsset = null;               // render_asset filename while previewing
    const rt = new Map();                  // layer id -> runtime (canvases, urls)
    const history = new History(50);
    let bgUrl = '';                        // object/data/asset URL for the stage bg

    const say = (msg, cls = '') => { el.status.textContent = msg; el.status.className = 'pt-status ' + cls; };
    const saveNote = msg => { el.savestat.textContent = msg; };
    async function api(path, opts) {
      const r = await fetch(API + path, opts);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
      return j;
    }
    const jsonPost = (path, body, method = 'POST') => api(path, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // ------------------------------------------------------- runtime/layer
    function runtimeFor(layer) {
      let r = rt.get(layer.id);
      if (r) return r;
      const wrap = document.createElement('div');
      wrap.className = 'pt-layer';
      wrap.dataset.id = layer.id;
      const cv = document.createElement('canvas');
      cv.className = 'pt-lcv';
      wrap.appendChild(cv);
      for (const hn of ['nw', 'ne', 'se', 'sw']) {
        const hd = document.createElement('div');
        hd.className = 'pt-handle'; hd.dataset.handle = hn;
        wrap.appendChild(hd);
      }
      const rot = document.createElement('div');
      rot.className = 'pt-handle rot'; rot.dataset.handle = 'rot';
      rot.title = 'drag to rotate';
      wrap.appendChild(rot);
      const mask = document.createElement('canvas');
      r = { wrap, cv, ctx: cv.getContext('2d', { willReadFrequently: true }),
            mask, mctx: mask.getContext('2d'), img: null,
            cutoutUrl: '', sourceDataUrl: '', cutoutDataUrl: '',
            maskTouched: false, maskDirty: false };
      rt.set(layer.id, r);
      el.stage.appendChild(wrap);
      return r;
    }

    function resetMask(r, w, h) {
      r.mask.width = Math.max(1, w); r.mask.height = Math.max(1, h);
      r.mctx.save();
      r.mctx.globalCompositeOperation = 'source-over';
      r.mctx.clearRect(0, 0, r.mask.width, r.mask.height);
      r.mctx.fillStyle = '#fff';
      r.mctx.fillRect(0, 0, r.mask.width, r.mask.height);
      r.mctx.restore();
      r.maskTouched = false;
    }

    function refreshDisplay(layer) {
      const r = runtimeFor(layer);
      if (!r.img) return;
      const nw = layer.natural_w || r.img.naturalWidth;
      const nh = layer.natural_h || r.img.naturalHeight;
      if (r.cv.width !== nw || r.cv.height !== nh) { r.cv.width = nw; r.cv.height = nh; }
      if (r.mask.width !== nw || r.mask.height !== nh) resetMask(r, nw, nh);
      const c = r.ctx;
      c.clearRect(0, 0, nw, nh);
      c.globalCompositeOperation = 'source-over';
      c.drawImage(r.img, 0, 0, nw, nh);
      c.globalCompositeOperation = 'destination-in';   // mask ALPHA keeps/erases
      c.drawImage(r.mask, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }

    function loadLayerImage(layer, url) {
      const r = runtimeFor(layer);
      r.cutoutUrl = url;
      const img = new Image();
      img.onload = () => {
        r.img = img;
        if (!layer.natural_w) { layer.natural_w = img.naturalWidth; layer.natural_h = img.naturalHeight; }
        refreshDisplay(layer);
      };
      img.src = url;
    }

    function positionLayerEl(layer) {
      const r = runtimeFor(layer);
      r.wrap.style.left = layer.x + 'px';
      r.wrap.style.top = layer.y + 'px';
      r.wrap.style.width = layer.w + 'px';
      r.wrap.style.height = layer.h + 'px';
      r.wrap.style.transform = `rotate(${layer.rotation || 0}deg)`;
      r.wrap.style.display = layer.visible === false ? 'none' : '';
      r.wrap.classList.toggle('sel', layer.id === selectedId);
      r.wrap.style.zIndex = String(state.layers.indexOf(layer) + 1);
    }

    // ------------------------------------------------------------- render
    function renderStage() {
      // prune runtimes of deleted layers
      for (const [id, r] of rt) {
        if (!state.layers.some(l => l.id === id)) { r.wrap.remove(); rt.delete(id); }
      }
      el.stage.style.width = state.canvas.width + 'px';
      el.stage.style.height = state.canvas.height + 'px';
      el.bgimg.style.display = state.canvas.background.type === 'image' && bgUrl ? '' : 'none';
      if (bgUrl) el.bgimg.src = bgUrl;
      el.empty.style.display = state.layers.length ? 'none' : '';
      for (const layer of state.layers) {
        runtimeFor(layer);
        positionLayerEl(layer);
      }
      el.cw.value = state.canvas.width;
      el.ch.value = state.canvas.height;
      if (document.activeElement !== el.pname) el.pname.value = state.name;
      refit();
      renderLayerList();
    }

    function renderLayerList() {
      el.lcount.textContent = state.layers.length ? `(${state.layers.length})` : '';
      el.llist.innerHTML = '';
      const topFirst = state.layers.slice().reverse();
      for (const layer of topFirst) {
        const row = document.createElement('div');
        row.className = 'pt-lrow' + (layer.id === selectedId ? ' sel' : '');
        const mk = (txt, title, fn, dis) => {
          const b = document.createElement('button');
          b.className = 'ee-btn pt-mini'; b.textContent = txt; b.title = title;
          b.disabled = !!dis;
          b.addEventListener('click', e => { e.stopPropagation(); fn(); });
          return b;
        };
        const eye = mk(layer.visible === false ? '🚫' : '👁', 'show/hide', () => {
          layer.visible = layer.visible === false ? true : false;
          commit(); renderStage();
        });
        const nm = document.createElement('span');
        nm.className = 'nm'; nm.textContent = layer.name; nm.title = layer.name;
        nm.addEventListener('click', () => { selectedId = layer.id; renderStage(); });
        row.append(eye, nm,
          mk('⤒', 'send to front', () => zop(layer.id, 'front')),
          mk('↑', 'raise', () => zop(layer.id, 'up')),
          mk('↓', 'lower', () => zop(layer.id, 'down')),
          mk('⤓', 'send to back', () => zop(layer.id, 'back')),
          mk('✕', 'remove layer', () => removeLayer(layer.id)));
        row.addEventListener('click', () => { selectedId = layer.id; renderStage(); });
        el.llist.appendChild(row);
      }
    }

    function zop(id, op) {
      state.layers = moveLayerZ(state.layers, id, op);
      commit(); renderStage();
    }
    function removeLayer(id) {
      state.layers = state.layers.filter(l => l.id !== id);
      if (selectedId === id) selectedId = null;
      commit(); renderStage();
    }

    // ---------------------------------------------------- history + saving
    function serializeMasks() {
      const out = {};
      for (const layer of state.layers) {
        const r = rt.get(layer.id);
        if (r && r.maskTouched) out[layer.id] = maskToGrayDataURL(r);
      }
      return out;
    }
    function snapshot() {
      return JSON.stringify({ state, masks: serializeMasks() });
    }
    function commit() {                      // a finished, undoable change
      history.push(snapshot());
      scheduleSave();
    }
    function restore(snap) {
      try {
        const { state: st, masks } = JSON.parse(snap);
        state = normalizeState(st);
        selectedId = state.layers.some(l => l.id === selectedId) ? selectedId : null;
        renderStage();
        for (const layer of state.layers) {
          const r = runtimeFor(layer);
          const md = masks && masks[layer.id];
          if (md) loadMaskDataURL(layer, r, md);
          else if (r.maskTouched) { resetMask(r, layer.natural_w || r.mask.width, layer.natural_h || r.mask.height); refreshDisplay(layer); }
        }
        scheduleSave();
      } catch (e) { say('undo state unreadable: ' + e.message, 'err'); }
    }
    el.undo.addEventListener('click', () => { const s = history.undo(); if (s !== null) restore(s); });
    el.redo.addEventListener('click', () => { const s = history.redo(); if (s !== null) restore(s); });

    // Mask <-> grayscale dataURL (server assets are L-mode: white = keep).
    function maskToGrayDataURL(r) {
      const t = document.createElement('canvas');
      t.width = r.mask.width; t.height = r.mask.height;
      const c = t.getContext('2d');
      c.drawImage(r.mask, 0, 0);
      const d = c.getImageData(0, 0, t.width, t.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const a = d.data[i + 3];
        d.data[i] = a; d.data[i + 1] = a; d.data[i + 2] = a; d.data[i + 3] = 255;
      }
      c.putImageData(d, 0, 0);
      return t.toDataURL('image/png');
    }
    function loadMaskDataURL(layer, r, dataUrl) {
      const img = new Image();
      img.onload = () => {
        const nw = layer.natural_w || img.naturalWidth;
        const nh = layer.natural_h || img.naturalHeight;
        r.mask.width = nw; r.mask.height = nh;
        const t = document.createElement('canvas');
        t.width = img.naturalWidth; t.height = img.naturalHeight;
        const tc = t.getContext('2d');
        tc.drawImage(img, 0, 0);
        const d = tc.getImageData(0, 0, t.width, t.height);
        for (let i = 0; i < d.data.length; i += 4) {
          d.data[i + 3] = d.data[i];         // gray -> alpha; rgb forced white below
          d.data[i] = 255; d.data[i + 1] = 255; d.data[i + 2] = 255;
        }
        tc.putImageData(d, 0, 0);
        r.mctx.save();
        r.mctx.globalCompositeOperation = 'source-over';
        r.mctx.clearRect(0, 0, nw, nh);
        r.mctx.drawImage(t, 0, 0, nw, nh);
        r.mctx.restore();
        r.maskTouched = true;
        refreshDisplay(layer);
      };
      img.src = dataUrl;
    }

    let saveTimer = null, saving = false, saveAgain = false;
    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { saveTimer = null; save().catch(() => {}); }, 900);
    }
    async function ensureProject() {
      if (projectId) return projectId;
      const j = await jsonPost('/projects', { name: state.name, state });
      projectId = j.id;
      await loadProjectList();
      return projectId;
    }
    async function uploadAsset(kind, dataUrl) {
      await ensureProject();
      const j = await jsonPost(`/projects/${projectId}/assets`,
        { kind, image_b64: dataUrl.split(',')[1] || '' });
      return j;
    }
    async function save() {
      if (saving) { saveAgain = true; return; }
      if (!projectId && !state.layers.length && state.canvas.background.type === 'none') return;
      saving = true;
      try {
        await ensureProject();
        for (const layer of state.layers) {
          const r = rt.get(layer.id);
          if (!r) continue;
          if (!layer.asset && r.cutoutDataUrl) layer.asset = (await uploadAsset('cutout', r.cutoutDataUrl)).file;
          if (!layer.source && r.sourceDataUrl) layer.source = (await uploadAsset('source', r.sourceDataUrl)).file;
          if (r.maskDirty) {
            layer.mask = (await uploadAsset('mask', maskToGrayDataURL(r))).file;
            r.maskDirty = false;
          }
        }
        const j = await jsonPost(`/projects/${projectId}`, { state }, 'PUT');
        state.updated = j.state.updated;
        saveNote(`saved ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        saveNote('save failed: ' + e.message);
      } finally {
        saving = false;
        if (saveAgain) { saveAgain = false; scheduleSave(); }
      }
    }
    el.psave.addEventListener('click', () => save());
    el.pname.addEventListener('input', () => { state.name = el.pname.value; scheduleSave(); });

    async function loadProjectList() {
      try {
        const j = await api('/projects');
        const items = Array.isArray(j.items) ? j.items : [];
        el.popen.innerHTML = '<option value="">Open project…</option>' +
          items.map(p => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)} · ${p.layers} layers</option>`).join('');
      } catch (e) { /* offline: list stays empty */ }
    }
    el.popen.addEventListener('change', async () => {
      const pid = el.popen.value;
      if (!pid) return;
      try {
        say('opening…');
        const j = await api(`/projects/${pid}`);
        projectId = pid;
        state = normalizeState(j.state);
        selectedId = null;
        bgUrl = '';
        rt.clear(); el.stage.querySelectorAll('.pt-layer').forEach(n => n.remove());
        if (state.canvas.background.type === 'image' && state.canvas.background.asset) {
          bgUrl = `${API}/projects/${pid}/assets/${state.canvas.background.asset}`;
        }
        renderStage();
        for (const layer of state.layers) {
          const r = runtimeFor(layer);
          if (layer.asset) loadLayerImage(layer, `${API}/projects/${pid}/assets/${layer.asset}`);
          if (layer.mask) {
            const mimg = new Image();
            mimg.onload = () => {
              r.mask.width = layer.natural_w || mimg.naturalWidth;
              r.mask.height = layer.natural_h || mimg.naturalHeight;
              const t = document.createElement('canvas');
              t.width = mimg.naturalWidth; t.height = mimg.naturalHeight;
              const tc = t.getContext('2d'); tc.drawImage(mimg, 0, 0);
              const d = tc.getImageData(0, 0, t.width, t.height);
              for (let i = 0; i < d.data.length; i += 4) {
                d.data[i + 3] = d.data[i]; d.data[i] = 255; d.data[i + 1] = 255; d.data[i + 2] = 255;
              }
              tc.putImageData(d, 0, 0);
              r.mctx.clearRect(0, 0, r.mask.width, r.mask.height);
              r.mctx.drawImage(t, 0, 0, r.mask.width, r.mask.height);
              r.maskTouched = true;
              refreshDisplay(layer);
            };
            mimg.src = `${API}/projects/${pid}/assets/${layer.mask}`;
          }
        }
        history.init(snapshot());
        say(`Opened “${state.name}”.`, 'ok');
      } catch (e) { say(e.message, 'err'); }
    });
    el.pnew.addEventListener('click', () => {
      projectId = null; selectedId = null; bgUrl = ''; previewAsset = null;
      state = defaultState();
      const last = readLastSize();
      if (last) { state.canvas.width = last.width; state.canvas.height = last.height; el.preset.value = 'last'; }
      rt.clear(); el.stage.querySelectorAll('.pt-layer').forEach(n => n.remove());
      el.preview.style.display = 'none';
      renderStage();
      history.init(snapshot());
      say('Fresh stage. Drop some puppets.');
    });

    // -------------------------------------------------------------- sizing
    function readLastSize() {
      try {
        const j = JSON.parse(localStorage.getItem('ellieedit.puppet.lastSize') || 'null');
        if (j && j.width && j.height) return j;
      } catch (e) { /* private mode */ }
      return null;
    }
    function writeLastSize() {
      try { localStorage.setItem('ellieedit.puppet.lastSize',
        JSON.stringify({ width: state.canvas.width, height: state.canvas.height })); } catch (e) {}
    }
    function refit() {
      const wrap = el.stagewrap;
      const availW = Math.max(200, wrap.clientWidth - 8);
      const availH = Math.max(200, wrap.clientHeight - 8);
      fitScale = Math.min(availW / state.canvas.width, availH / state.canvas.height, 2);
      if (!Number.isFinite(fitScale) || fitScale <= 0) fitScale = 1;
      el.stage.style.transform = `scale(${fitScale})`;
    }
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => refit()).observe(el.stagewrap);
    }
    el['apply-size'].addEventListener('click', () => {
      const p = el.preset.value;
      let size;
      if (p === 'custom' || p === 'last' && !readLastSize()) {
        size = { width: parseInt(el.cw.value) || state.canvas.width,
                 height: parseInt(el.ch.value) || state.canvas.height };
      } else {
        size = presetSize(p, readLastSize());
      }
      state.canvas.width = Math.min(8192, Math.max(16, size.width));
      state.canvas.height = Math.min(8192, Math.max(16, size.height));
      writeLastSize();
      commit(); renderStage();
      say(`Stage ${state.canvas.width}×${state.canvas.height}.`);
    });

    // ------------------------------------------------------------ background
    function setBackground(assetFile, url) {
      state.canvas.background = assetFile
        ? { type: 'image', asset: assetFile } : { type: 'none', asset: null };
      bgUrl = url || '';
      commit(); renderStage();
    }
    el.bgclear.addEventListener('click', () => setBackground(null, ''));
    el.bgup.addEventListener('click', () => el.bgfile.click());
    el.bgfile.addEventListener('change', async () => {
      const f = el.bgfile.files[0]; el.bgfile.value = '';
      if (!f) return;
      try {
        const durl = await fileToDataURL(f);
        const up = await uploadAsset('background', durl);
        setBackground(up.file, up.url);
        say('Background set from upload.', 'ok');
      } catch (e) { say(e.message, 'err'); }
    });
    el.bggen.addEventListener('click', async () => {
      const prompt = el.bgprompt.value.trim();
      if (!prompt) { say('Type a background prompt first.', 'err'); return; }
      try {
        say('generating background (FoxDen path)…');
        const r = await fetch(FOX + '/generate', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflow: 'klein', prompt,
            width: state.canvas.width, height: state.canvas.height, denoise: 1, loras: [] }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
        const url = await pollFoxden(j.prompt_id);
        const blob = await (await fetch(url)).blob();
        const durl = await blobToDataURL(blob);
        const up = await uploadAsset('background', durl);
        setBackground(up.file, up.url);
        say('Background generated.', 'ok');
      } catch (e) { say('Background generation failed: ' + e.message, 'err'); }
    });
    async function pollFoxden(pid) {
      const t0 = Date.now();
      while (Date.now() - t0 < 10 * 60 * 1000) {
        const r = await fetch(`${FOX}/status/${pid}`);
        const s = await r.json().catch(() => ({}));
        if (s.state === 'done' && s.outputs && s.outputs.length) return s.outputs[0];
        if (s.state === 'error') throw new Error(s.error || 'generation failed');
        await new Promise(res => setTimeout(res, 1500));
      }
      throw new Error('timed out waiting for ComfyUI');
    }

    // ------------------------------------------------------------ puppets in
    function fileToDataURL(f) {
      return new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.onerror = rej;
        rd.readAsDataURL(f);
      });
    }
    function blobToDataURL(b) {
      return new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.onerror = rej;
        rd.readAsDataURL(b);
      });
    }
    async function rmbg(dataUrl) {
      const j = await jsonPost('/rmbg', { image_b64: dataUrl.split(',')[1] || '' });
      const t0 = Date.now();
      while (Date.now() - t0 < 180 * 1000) {
        const s = await api(`/rmbg/${j.job_id}`);
        if (s.state === 'done') return s.image_b64;
        if (s.state === 'error') throw new Error(s.error || 'rmbg failed');
        await new Promise(res => setTimeout(res, 800));
      }
      throw new Error('rmbg timed out');
    }
    let cascade = 0;
    async function addPuppetFile(f) {
      const srcUrl = await fileToDataURL(f);
      let cutUrl = null, note = '';
      try {
        say(`removing background: ${f.name}…`);
        const out = await rmbg(srcUrl);
        cutUrl = 'data:image/png;base64,' + out;
      } catch (e) {
        note = ` (rmbg unavailable — placed uncut: ${e.message})`;
      }
      const layer = normalizeState({ layers: [{ id: uid(), name: f.name.replace(/\.[^.]+$/, '') }] }).layers[0];
      const probe = new Image();
      await new Promise(res => { probe.onload = res; probe.onerror = res; probe.src = cutUrl || srcUrl; });
      layer.natural_w = probe.naturalWidth || 256;
      layer.natural_h = probe.naturalHeight || 256;
      const place = fitPlacement(state.canvas, layer.natural_w, layer.natural_h);
      const off = (cascade++ % 5) * 24;
      layer.x = Math.min(place.x + off, state.canvas.width - 40);
      layer.y = Math.min(place.y + off, state.canvas.height - 40);
      layer.w = place.w; layer.h = place.h;
      state.layers.push(layer);
      selectedId = layer.id;
      const r = runtimeFor(layer);
      r.sourceDataUrl = srcUrl;
      r.cutoutDataUrl = cutUrl || '';
      renderStage();
      loadLayerImage(layer, cutUrl || srcUrl);
      commit();
      say(`Placed “${layer.name}”${note}.`, note ? 'err' : 'ok');
    }
    async function addPuppetFiles(files) {
      for (const f of files) {
        if (f && f.type && f.type.startsWith('image/')) {
          try { await addPuppetFile(f); } catch (e) { say(e.message, 'err'); }
        }
      }
    }
    el.add.addEventListener('click', () => el.afile.click());
    el.afile.addEventListener('change', () => { addPuppetFiles([...el.afile.files]); el.afile.value = ''; });
    el.stagewrap.addEventListener('dragover', e => { e.preventDefault(); el.stagewrap.classList.add('dragover'); });
    el.stagewrap.addEventListener('dragleave', () => el.stagewrap.classList.remove('dragover'));
    el.stagewrap.addEventListener('drop', e => {
      e.preventDefault(); el.stagewrap.classList.remove('dragover');
      addPuppetFiles([...(e.dataTransfer ? e.dataTransfer.files : [])]);
    });

    // ------------------------------------------------------- stage pointer
    function stagePoint(e) {
      const rect = el.stage.getBoundingClientRect();
      return { x: (e.clientX - rect.left) * state.canvas.width / Math.max(1, rect.width),
               y: (e.clientY - rect.top) * state.canvas.height / Math.max(1, rect.height) };
    }
    function selected() { return state.layers.find(l => l.id === selectedId) || null; }
    function alphaAt(layer, pt) {
      const r = rt.get(layer.id);
      if (!r || !r.img) return true;
      const loc = stageToLocal(layer, pt.x, pt.y);
      if (loc.x < 0 || loc.y < 0 || loc.x > layer.w || loc.y > layer.h) return false;
      const nx = Math.floor(loc.x / layer.w * r.cv.width);
      const ny = Math.floor(loc.y / layer.h * r.cv.height);
      try { return r.ctx.getImageData(nx, ny, 1, 1).data[3] > 8; }
      catch (e) { return true; }
    }
    function pickAt(pt) {
      for (let i = state.layers.length - 1; i >= 0; i--) {
        const l = state.layers[i];
        if (l.visible !== false && alphaAt(l, pt)) return l;
      }
      return null;
    }

    let op = null;
    el.stage.addEventListener('pointerdown', e => {
      const pt = stagePoint(e);
      const sel = selected();
      // handles of the selected layer first (they sit outside its rect too)
      if (sel && sel.visible !== false) {
        const hp = handlePositions(sel);
        hp.rot = localToStage(sel, sel.w / 2, -28);
        for (const hn of ['nw', 'ne', 'se', 'sw', 'rot']) {
          const d = Math.hypot(pt.x - hp[hn].x, pt.y - hp[hn].y);
          if (d <= Math.max(14 / fitScale, 10)) {
            op = hn === 'rot'
              ? { type: 'rotate', id: sel.id, startAngle: pointerAngle(sel, pt.x, pt.y),
                  startRot: sel.rotation || 0, moved: false }
              : { type: 'resize', id: sel.id, corner: hn, start: { ...sel },
                  lock: !e.shiftKey, moved: false };
            el.stage.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
          }
        }
      }
      const hit = pickAt(pt);
      if ((tool === 'erase' || tool === 'restore') && sel && hit === sel) {
        op = { type: 'mask', id: sel.id, last: pt, moved: false };
        el.stage.setPointerCapture(e.pointerId);
        stampAt(sel, pt);
        e.preventDefault();
        return;
      }
      if (hit) {
        if (hit.id !== selectedId) { selectedId = hit.id; renderStage(); }
        const loc = stageToLocal(hit, pt.x, pt.y);
        op = { type: 'move', id: hit.id, startX: hit.x, startY: hit.y,
               grabDX: pt.x - hit.x, grabDY: pt.y - hit.y, loc, moved: false };
        el.stage.setPointerCapture(e.pointerId);
        e.preventDefault();
      } else {
        selectedId = null;
        renderStage();
      }
    });
    el.stage.addEventListener('pointermove', e => {
      if (!op) return;
      const layer = state.layers.find(l => l.id === op.id);
      if (!layer) { op = null; return; }
      const pt = stagePoint(e);
      if (op.type === 'move') {
        layer.x = Math.round(pt.x - op.grabDX);
        layer.y = Math.round(pt.y - op.grabDY);
        op.moved = true;
        positionLayerEl(layer);
      } else if (op.type === 'resize') {
        const localNow = stageToLocal(op.start, pt.x, pt.y);
        const r = resizeRect(op.start, op.corner, localNow, { lockAspect: op.lock });
        layer.x = Math.round(r.x); layer.y = Math.round(r.y);
        layer.w = Math.round(r.w); layer.h = Math.round(r.h);
        op.moved = true;
        positionLayerEl(layer);
      } else if (op.type === 'rotate') {
        layer.rotation = Math.round(rotationFromPointer(layer, pt.x, pt.y, op.startAngle, op.startRot));
        op.moved = true;
        positionLayerEl(layer);
      } else if (op.type === 'mask') {
        stampLine(layer, op.last, pt);
        op.last = pt;
        op.moved = true;
      }
    });
    function endOp() {
      if (op && op.moved) {
        if (op.type === 'mask') {
          const layer = state.layers.find(l => l.id === op.id);
          const r = layer && rt.get(layer.id);
          if (r) { r.maskDirty = true; r.maskTouched = true; }
        }
        commit();
      }
      op = null;
    }
    el.stage.addEventListener('pointerup', endOp);
    el.stage.addEventListener('pointercancel', endOp);

    // ------------------------------------------------------------- masking
    function brushNatural(layer) {
      const sizeStage = parseFloat(el.bsize.value) || 48;
      const scaleN = (layer.natural_w || layer.w) / Math.max(1, layer.w);
      return { radius: Math.max(1, sizeStage / 2 * scaleN),
               hardness: (parseFloat(el.bhard.value) || 0) / 100, scaleN };
    }
    function stampAt(layer, pt) {
      const r = runtimeFor(layer);
      if (!r.img) return;
      const loc = stageToLocal(layer, pt.x, pt.y);
      const { radius, hardness, scaleN } = brushNatural(layer);
      const nx = loc.x * scaleN, ny = loc.y * scaleN;
      stamp(r, nx, ny, radius, hardness);
      refreshDisplay(layer);
    }
    function stampLine(layer, a, b) {
      const r = runtimeFor(layer);
      if (!r.img) return;
      const { radius, hardness, scaleN } = brushNatural(layer);
      const la = stageToLocal(layer, a.x, a.y);
      const lb = stageToLocal(layer, b.x, b.y);
      const ax = la.x * scaleN, ay = la.y * scaleN;
      const bx = lb.x * scaleN, by = lb.y * scaleN;
      const dist = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.floor(dist / Math.max(1, radius / 3)));
      for (let i = 1; i <= steps; i++) {
        stamp(r, ax + (bx - ax) * i / steps, ay + (by - ay) * i / steps, radius, hardness);
      }
      refreshDisplay(layer);
    }
    function stamp(r, x, y, radius, hardness) {
      const c = r.mctx;
      const g = c.createRadialGradient(x, y, radius * hardness, x, y, radius);
      // gradient alpha follows puppet-core's brushAlpha: 1 in the hard core,
      // easing to 0 at the rim (three stops approximate the curve)
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(Math.min(0.999, hardness + (1 - hardness) * 0.5), 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.save();
      c.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
      c.fillStyle = g;
      c.beginPath(); c.arc(x, y, radius, 0, Math.PI * 2); c.fill();
      c.restore();
      r.maskTouched = true;
    }
    el.bsize.addEventListener('input', () => { el['bsize-val'].textContent = el.bsize.value; });
    el.bhard.addEventListener('input', () => { el['bhard-val'].textContent = el.bhard.value + '%'; });
    el.tools.addEventListener('click', e => {
      const b = e.target.closest('[data-tool]');
      if (!b) return;
      tool = b.dataset.tool;
      el.tools.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b));
      el.stage.classList.toggle('masking', tool !== 'move');
    });
    el.maskreset.addEventListener('click', () => {
      const layer = selected();
      if (!layer) { say('Select a layer first.', 'err'); return; }
      const r = runtimeFor(layer);
      resetMask(r, layer.natural_w || r.mask.width, layer.natural_h || r.mask.height);
      r.maskDirty = true;
      refreshDisplay(layer);
      commit();
      say(`Mask reset for “${layer.name}” — everything is back.`, 'ok');
    });

    // ------------------------------------------------------------- render
    el.denoise.addEventListener('input', () => {
      const d = clampDenoise(parseFloat(el.denoise.value));
      el['dval'].textContent = d.toFixed(2);
    });
    el.render.addEventListener('click', async () => {
      try {
        say('saving stack, then rendering the final pass…');
        await save();
        if (!projectId) throw new Error('could not save the project');
        const j = await jsonPost(`/projects/${projectId}/render`, {
          prompt: el.rprompt.value.trim(),
          denoise: clampDenoise(parseFloat(el.denoise.value)),
          seed: Math.floor(Math.random() * 2 ** 31) });
        previewAsset = j.render_asset || null;
        el.previewimg.src = 'data:image/png;base64,' + j.image_b64;
        el.preview.style.display = 'flex';
        say(`Final pass done at denoise ${Number(j.denoise).toFixed(2)} — accept or discard.`, 'ok');
      } catch (e) { say('Render failed: ' + e.message, 'err'); }
    });
    el.pvdiscard.addEventListener('click', () => {
      el.preview.style.display = 'none';
      previewAsset = null;
      say('Preview discarded — back to the live composite.');
    });
    el.pvaccept.addEventListener('click', async () => {
      // Accept = the harmonized render becomes the stage picture. Layers are
      // hidden, NOT deleted: flip their eyes back on to return to puppeting.
      if (previewAsset && projectId) {
        bgUrl = `${API}/projects/${projectId}/assets/${previewAsset}`;
        state.canvas.background = { type: 'image', asset: previewAsset };
        for (const l of state.layers) l.visible = false;
      } else if (el.previewimg.src) {
        try {
          const up = await uploadAsset('render', el.previewimg.src);
          state.canvas.background = { type: 'image', asset: up.file };
          bgUrl = up.url;
          for (const l of state.layers) l.visible = false;
        } catch (e) { say(e.message, 'err'); return; }
      }
      previewAsset = null;
      el.preview.style.display = 'none';
      commit(); renderStage();
      say('Accepted. Layers are hidden, not deleted — toggle 👁 to puppet again.', 'ok');
    });

    // ------------------------------------------------------------- export
    function downloadBlob(blob, name) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    el.expng.addEventListener('click', async () => {
      try {
        await save();
        if (!projectId) throw new Error('nothing to export yet');
        const r = await fetch(`${API}/projects/${projectId}/export.png`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        downloadBlob(await r.blob(), `puppet-${projectId}.png`);
        say('Composite PNG exported at canvas resolution.', 'ok');
      } catch (e) { say('Export failed: ' + e.message, 'err'); }
    });
    el.exjson.addEventListener('click', async () => {
      try {
        await save();
        if (projectId) {
          const r = await fetch(`${API}/projects/${projectId}/export.json`);
          if (r.ok) { downloadBlob(await r.blob(), `puppet-${projectId}.json`); return; }
        }
        throw new Error('server export unavailable');
      } catch (e) {
        downloadBlob(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
          'puppet-layers.json');
        say('Stack JSON downloaded (local copy).', 'ok');
      }
    });

    // ---------------------------------------------------------------- init
    (async () => {
      try {
        const c = await api('/config');
        const rm = c.rmbg || {};
        el.conn.textContent = rm.available
          ? '● rmbg ready · denoise fence 0.40–0.50'
          : '○ rmbg not available on server (drops place uncut)';
        el.conn.className = 'pt-status ' + (rm.available ? 'ok' : 'err');
      } catch (e) {
        el.conn.textContent = '○ /api/puppet unreachable';
        el.conn.className = 'pt-status err';
      }
      await loadProjectList();
    })();
    const lastSize = readLastSize();
    if (lastSize) { state.canvas.width = lastSize.width; state.canvas.height = lastSize.height; el.preset.value = 'last'; }
    renderStage();
    history.init(snapshot());
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail && e.detail.name === 'puppet') { loadProjectList(); refit(); }
    });
  },
});
