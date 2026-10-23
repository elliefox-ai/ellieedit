// Puppet Theater — multi-subject compose stage (work order 2026-10-22).
// Humans place rmbg cutouts as baked pixels (drag / resize / rotate,
// nondestructive alpha-mask erase); the model only gets a final fenced
// low-denoise harmonization pass (0.2–0.8, server-clamped) via
// /api/puppet/render. Poses are pixels, not prompt-wishes.
// Backend: /api/puppet/*. Pure logic: puppet-core.js (node-tested).
import { registerModule } from '../shell.js';
import { clampDenoise, presetSize, normalizeState, defaultState, fitPlacement,
  moveLayerZ, stageToLocal, localToStage, handlePositions, resizeRect,
  rotationFromPointer, pointerAngle, History, CANVAS_PRESETS,
  planRestore, runRestore, grayMaskIsEmpty, resolveRenderMask,
  stageHintVisible, makeRenderLayer, hitLayer, topmostBoundsAt,
  layerIsFullBounds } from './puppet-core.js';

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
        <div class="pt-hint">…or drop images straight onto the stage — they place
          instantly, exactly as dropped. Background removal is a separate,
          reversible step: ✂ Cut Out in Tools, with a layer selected.</div>
        <div class="pt-sec">Stage step</div>
        <div class="pt-row" data-id="steps">
          <button class="ee-btn pt-btn on" data-step="place">🧩 Place</button>
          <button class="ee-btn pt-btn" data-step="fill">🖌 Fill Area</button>
          <button class="ee-btn pt-btn" data-id="fillclear">Clear fill</button>
        </div>
        <div class="pt-hint" data-id="fillhint" style="display:none">Fill Area: paint
          where generation should happen (white = fill, everything else stays
          locked). With nothing selected, Erase paints lock on the Fill Area.
          With a layer selected, Erase/Restore work that LAYER's mask instead —
          they are layer tools in every step. Undo and Clear work; the tint
          only shows during this step.</div>
        <button class="ee-btn primary pt-go" data-id="fillgo">✨ Fill background</button>
        <div class="pt-hint" data-id="fillnote"></div>
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
          <button class="ee-btn pt-btn" data-id="cutgo">✂ Cut Out</button>
          <button class="ee-btn pt-btn" data-id="restorecut">↩ Undo cut</button>
        </div>
        <div class="pt-hint">Cut Out runs rmbg on the selected layer into its
          own mask channel — the original pixels are never touched, and Undo
          cut drops the mask at any time.</div>
        <div class="pt-row">
          <button class="ee-btn pt-btn" data-id="maskreset">Reset mask</button>
          <button class="ee-btn pt-btn" data-id="undo">↩ Undo</button>
          <button class="ee-btn pt-btn" data-id="redo">↪ Redo</button>
        </div>
        <div class="pt-sec">Final pass — harmonize</div>
        <div><label>Atmosphere (optional)</label>
          <input type="text" data-id="rprompt" placeholder="golden hour, soft rim light…"></div>
        <div><label>Denoise <span data-id="dval">0.45</span> — fenced 0.20–0.80</label>
          <input type="range" data-id="denoise" min="0.2" max="0.8" step="0.01" value="0.45" aria-label="Final pass denoise"></div>
        <div class="pt-row" data-id="engines">
          <button class="ee-btn pt-btn on" data-engine="klein">Klein · preserves more</button>
          <button class="ee-btn pt-btn" data-engine="krea2">Krea2 · repaints more</button>
        </div>
        <div class="pt-row" data-id="rmodes">
          <button class="ee-btn pt-btn on" data-rmode="fill">Fill Area only</button>
          <button class="ee-btn pt-btn" data-rmode="all">Render all</button>
        </div>
        <div class="pt-hint" data-id="rmnote"></div>
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
            <canvas class="pt-fillov" data-id="fillov"></canvas>
            <div class="pt-empty" data-id="empty">Drop puppet images here — poses stay exactly as placed.</div>
          </div>
          <div class="pt-dropind" data-id="dropind"></div>
          <div class="pt-preview" data-id="preview">
            <img data-id="previewimg" alt="final pass preview">
            <div class="pt-pvbar">
              <span data-id="pvnote">Final pass preview — accepting adds it as a new layer on top; the stack underneath stays live.</span>
              <button class="ee-btn primary pt-btn" data-id="pvaccept">✓ Accept as new layer</button>
              <button class="ee-btn pt-btn" data-id="pvdiscard">✕ Discard</button>
            </div>
          </div>
        </div>
      </div>
      <div class="pt-layers">
        <div class="pt-sec">Layers <span data-id="lcount"></span></div>
        <div class="pt-llist" data-id="llist"></div>
        <div class="pt-hint">Top of the list paints last (on top). Click a layer
          to select it (click again to deselect); drag it on stage, corners
          resize (Shift = free-stretch), the stalk rotates. Erase works the
          selected layer's mask in every step — the pixels are never
          destroyed, and whatever shows through is whatever is underneath.</div>
      </div>
    </div>`;
    const $ = id => panel.querySelector(`[data-id="${id}"]`);
    const ids = ['conn', 'pname', 'popen', 'pnew', 'psave', 'savestat', 'preset', 'cw', 'ch',
      'apply-size', 'bgprompt', 'bggen', 'bgup', 'bgclear', 'bgfile', 'add', 'afile',
      'steps', 'fillclear', 'fillhint', 'fillgo', 'fillnote',
      'tools', 'bsize', 'bsize-val', 'bhard', 'bhard-val', 'cutgo', 'restorecut', 'maskreset', 'undo', 'redo',
      'rprompt', 'denoise', 'dval', 'engines', 'rmodes', 'rmnote', 'render', 'expng', 'exjson', 'status',
      'stagewrap', 'stage', 'bgimg', 'fillov', 'dropind', 'empty', 'preview', 'previewimg', 'pvnote', 'pvaccept',
      'pvdiscard', 'lcount', 'llist'];
    const el = Object.fromEntries(ids.map(k => [k, $(k)]));

    // ------------------------------------------------------------ state
    let state = defaultState();
    let projectId = null;
    let selectedId = null;
    let tool = 'move';
    let fitScale = 1;
    let previewAsset = null;               // render_asset filename while previewing
    let pvMode = 'render';                 // 'render' | 'fill' (v1.3)
    let pvTarget = null;                   // fill target: layer id | 'background'
    let pvTargetName = '';
    const rt = new Map();                  // layer id -> runtime (canvases, urls)
    const history = new History(50);
    let bgUrl = '';                        // object/data/asset URL for the stage bg
    // v1.1: stage step (place | fill), final-pass mask choice, per-layer
    // rmbg jobs in flight, and the canvas-level Fill Area mask. The fill
    // canvas is grayscale RGB at canvas resolution: white = regenerate,
    // black = locked; an all-black canvas is "no fill painted".
    let step = 'place';
    let renderMode = 'fill';
    let engine = 'klein';                    // v1.2: Klein default final pass
    let dragOver = false;                    // v1.2: drop-hint predicate input
    const cutPending = new Set();
    const fillCv = document.createElement('canvas');
    const fillCx = fillCv.getContext('2d', { willReadFrequently: true });
    const fill = { touched: false, dirty: false, ovAt: 0 };

    // Amendment A: no silent waits. Every async action marks its control
    // busy SYNCHRONOUSLY (same tick as the click/drop, well under 200ms)
    // and clears it when done; failures surface in the status line.
    function setBusy(btn, on, label) {
      if (!btn) return;
      if (on) {
        if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
        btn.disabled = true;
        btn.classList.add('busy');
        if (label) btn.textContent = label;
      } else {
        btn.disabled = false;
        btn.classList.remove('busy');
        if (btn.dataset.label !== undefined) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
      }
    }
    function dropSay(msg) {
      el.dropind.textContent = msg || '';
      el.dropind.style.display = msg ? 'block' : 'none';
    }

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
      const cut = document.createElement('canvas');
      r = { wrap, cv, ctx: cv.getContext('2d', { willReadFrequently: true }),
            mask, mctx: mask.getContext('2d'), img: null,
            cut, cctx: cut.getContext('2d'),   // rmbg Cut Out mask (v1.1 D)
            baseUrl: '', sourceDataUrl: '',
            maskTouched: false, maskDirty: false,
            cutTouched: false, cutDirty: false };
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

    // The Cut Out mask uses the same canvas discipline as the erase mask
    // (white RGB, alpha = keep) but lives in its own channel: clearing it
    // (alpha 0 everywhere) means "no cut applied" — the full original
    // shows. Reset = Restore in Amendment D terms.
    function resetCut(r, w, h) {
      r.cut.width = Math.max(1, w || r.cut.width || 1);
      r.cut.height = Math.max(1, h || r.cut.height || 1);
      r.cctx.save();
      r.cctx.globalCompositeOperation = 'source-over';
      r.cctx.clearRect(0, 0, r.cut.width, r.cut.height);
      r.cctx.restore();
      r.cutTouched = false;
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
      if (r.cutTouched) c.drawImage(r.cut, 0, 0, nw, nh);  // Cut Out mask first
      c.drawImage(r.mask, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }

    function loadLayerImage(layer, url) {
      const r = runtimeFor(layer);
      r.baseUrl = url;
      const img = new Image();
      img.onload = () => {
        r.img = img;
        if (!layer.natural_w) { layer.natural_w = img.naturalWidth; layer.natural_h = img.naturalHeight; }
        refreshDisplay(layer);
      };
      img.src = url;
    }

    // Load an image and resolve only once it is DECODED (Amendment C: a
    // layer counts as restored when its pixels are actually paintable,
    // not when a fetch merely started). Rejects on error so callers can
    // retry / fall back / report instead of silently showing nothing.
    function loadImageDecoded(url) {
      return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          if (img.decode) img.decode().then(() => res(img), () => res(img));
          else res(img);
        };
        img.onerror = () => rej(new Error('image failed to load'));
        img.src = url;
      });
    }
    const assetUrl = file => (projectId && file)
      ? `${API}/projects/${projectId}/assets/${file}` : '';

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

    // The drop hint (v1.2 item 1) shows only on a truly empty stage or
    // during drag-over — never stamped over a background or the puppets.
    function updateHint() {
      el.empty.style.display = stageHintVisible({
        layerCount: state.layers.length,
        hasBackground: state.canvas.background.type === 'image',
        dragOver }) ? '' : 'none';
    }

    // ------------------------------------------------------------- render
    function renderStage() {
      // prune runtimes of deleted layers
      for (const [id, r] of rt) {
        if (!state.layers.some(l => l.id === id)) { r.wrap.remove(); rt.delete(id); }
      }
      el.stage.style.width = state.canvas.width + 'px';
      el.stage.style.height = state.canvas.height + 'px';
      syncFillSize();
      el.bgimg.style.display = state.canvas.background.type === 'image' && bgUrl ? '' : 'none';
      if (bgUrl) el.bgimg.src = bgUrl;
      updateHint();
      for (const layer of state.layers) {
        runtimeFor(layer);
        positionLayerEl(layer);
      }
      el.cw.value = state.canvas.width;
      el.ch.value = state.canvas.height;
      if (document.activeElement !== el.pname) el.pname.value = state.name;
      refit();
      updateFillHint();
      updateFillUI();
      updateCutUI();
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
        nm.addEventListener('click', ev => { ev.stopPropagation(); toggleSelect(layer.id); });
        const line1 = document.createElement('div');
        line1.className = 'pt-lr';
        line1.append(eye, nm, mk('✕', 'remove layer', () => removeLayer(layer.id)));
        const line2 = document.createElement('div');
        line2.className = 'pt-lr';
        // v1.3.1: Cut Out / Undo cut moved to Tools (they act on the
        // selection now) — the rows keep identity + stacking only.
        line2.append(
          mk('⤒', 'send to front', () => zop(layer.id, 'front')),
          mk('↑', 'raise', () => zop(layer.id, 'up')),
          mk('↓', 'lower', () => zop(layer.id, 'down')),
          mk('⤓', 'send to back', () => zop(layer.id, 'back')),
          mk('⇓', 'merge down into the layer below (or the background) — masks consolidate', () => mergeDown(layer)));
        row.append(line1, line2);
        row.addEventListener('click', () => toggleSelect(layer.id));
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
    function serializeCuts() {
      const out = {};
      for (const layer of state.layers) {
        const r = rt.get(layer.id);
        // The cut canvas itself (white RGB, alpha = keep) round-trips
        // through PNG alpha, so snapshots store it verbatim; the GRAYSCALE
        // conversion happens only at server-upload time.
        if (r && r.cutTouched) out[layer.id] = r.cut.toDataURL('image/png');
      }
      return out;
    }
    function snapshot() {
      return JSON.stringify({ state, masks: serializeMasks(), cuts: serializeCuts(),
        fill: fill.touched ? fillCv.toDataURL('image/png') : null });
    }
    function commit() {                      // a finished, undoable change
      history.push(snapshot());
      scheduleSave();
    }
    function restore(snap) {
      try {
        const { state: st, masks, cuts, fill: fillData } = JSON.parse(snap);
        state = normalizeState(st);
        selectedId = state.layers.some(l => l.id === selectedId) ? selectedId : null;
        renderStage();
        for (const layer of state.layers) {
          const r = runtimeFor(layer);
          const md = masks && masks[layer.id];
          if (md) loadMaskDataURL(layer, r, md);
          else if (r.maskTouched) { resetMask(r, layer.natural_w || r.mask.width, layer.natural_h || r.mask.height); refreshDisplay(layer); }
          const cd = cuts && cuts[layer.id];
          if (cd) loadCutDataURL(layer, r, cd);
          else if (r.cutTouched) { resetCut(r, layer.natural_w || r.cut.width, layer.natural_h || r.cut.height); refreshDisplay(layer); }
          // A layer whose runtime was pruned (undo of a remove/merge, say)
          // needs its pixels re-fetched, not just its masks — otherwise
          // the restored layer is metadata with a blank stage presence.
          if (!r.img && projectId && (layer.asset || layer.source)) {
            loadLayerImage(layer, assetUrl(layer.asset || layer.source));
          }
        }
        // Fill Area channel restores independently of the layer masks —
        // undoing a fill stroke must never touch a layer's erase mask.
        if (fillData) {
          const img = new Image();
          img.onload = () => {
            syncFillSize();
            fillCx.save();
            fillCx.globalCompositeOperation = 'source-over';
            fillCx.fillStyle = '#000'; fillCx.fillRect(0, 0, fillCv.width, fillCv.height);
            fillCx.drawImage(img, 0, 0, fillCv.width, fillCv.height);
            fillCx.restore();
            fill.touched = true; fill.dirty = true;
            refreshFillOverlay(true); updateRenderNote();
          };
          img.src = fillData;
        } else if (fill.touched) {
          clearFill(false); fill.dirty = true; updateRenderNote();
        }
        scheduleSave();
      } catch (e) { say('undo state unreadable: ' + e.message, 'err'); }
    }
    el.undo.addEventListener('click', () => { const s = history.undo(); if (s !== null) restore(s); });
    el.redo.addEventListener('click', () => { const s = history.redo(); if (s !== null) restore(s); });

    // Mask <-> grayscale dataURL (server assets are L-mode: white = keep).
    // The alpha-mask canvas rep keeps visibility in ALPHA (white RGB);
    // the wire/storage rep is grayscale (gray = keep).
    function alphaMaskToGrayDataURL(cv) {
      const t = document.createElement('canvas');
      t.width = cv.width; t.height = cv.height;
      const c = t.getContext('2d');
      c.drawImage(cv, 0, 0);
      const d = c.getImageData(0, 0, t.width, t.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const a = d.data[i + 3];
        d.data[i] = a; d.data[i + 1] = a; d.data[i + 2] = a; d.data[i + 3] = 255;
      }
      c.putImageData(d, 0, 0);
      return t.toDataURL('image/png');
    }
    function maskToGrayDataURL(r) { return alphaMaskToGrayDataURL(r.mask); }
    // Paint a loaded GRAYSCALE mask image into an alpha-mask canvas.
    function paintGrayIntoMask(img, cv, cx2) {
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
      cx2.save();
      cx2.globalCompositeOperation = 'source-over';
      cx2.clearRect(0, 0, cv.width, cv.height);
      cx2.drawImage(t, 0, 0, cv.width, cv.height);
      cx2.restore();
    }
    // The Cut Out mask starts life as an rmbg RGBA cutout: its ALPHA is
    // the subject. Convert alpha -> the alpha-mask channel.
    function loadCutDataURL(layer, r, dataUrl) {
      const img = new Image();
      img.onload = () => {
        const nw = layer.natural_w || img.naturalWidth;
        const nh = layer.natural_h || img.naturalHeight;
        r.cut.width = nw; r.cut.height = nh;
        const t = document.createElement('canvas');
        t.width = img.naturalWidth; t.height = img.naturalHeight;
        const tc = t.getContext('2d');
        tc.drawImage(img, 0, 0);
        const d = tc.getImageData(0, 0, t.width, t.height);
        for (let i = 0; i < d.data.length; i += 4) {
          const keep = d.data[i + 3];      // alpha carries the subject
          d.data[i] = 255; d.data[i + 1] = 255; d.data[i + 2] = 255; d.data[i + 3] = keep;
        }
        tc.putImageData(d, 0, 0);
        r.cctx.save();
        r.cctx.globalCompositeOperation = 'source-over';
        r.cctx.clearRect(0, 0, nw, nh);
        r.cctx.drawImage(t, 0, 0, nw, nh);
        r.cctx.restore();
        r.cutTouched = true;
        refreshDisplay(layer);
      };
      img.src = dataUrl;
    }
    function loadCutGrayImage(layer, r, img) {
      const nw = layer.natural_w || img.naturalWidth;
      const nh = layer.natural_h || img.naturalHeight;
      r.cut.width = nw; r.cut.height = nh;
      paintGrayIntoMask(img, r.cut, r.cctx);
      r.cutTouched = true;
      refreshDisplay(layer);
    }
    function loadMaskDataURL(layer, r, dataUrl) {
      const img = new Image();
      img.onload = () => {
        const nw = layer.natural_w || img.naturalWidth;
        const nh = layer.natural_h || img.naturalHeight;
        r.mask.width = nw; r.mask.height = nh;
        paintGrayIntoMask(img, r.mask, r.mctx);
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
      if (!projectId && !state.layers.length && state.canvas.background.type === 'none' && !state.rendermask) return;
      saving = true;
      try {
        await ensureProject();
        for (const layer of state.layers) {
          const r = rt.get(layer.id);
          if (!r) continue;
          // v1.1 (Amendment D): the layer's base image is its ORIGINAL.
          // The rmbg result is only ever a mask ('cutout' asset), never
          // the pixels themselves.
          if (!layer.source && r.sourceDataUrl) layer.source = (await uploadAsset('source', r.sourceDataUrl)).file;
          if (!layer.asset && layer.source) layer.asset = layer.source;
          if (r.maskDirty) {
            layer.mask = (await uploadAsset('mask', maskToGrayDataURL(r))).file;
            r.maskDirty = false;
          }
          if (r.cutDirty) {
            layer.cutout = r.cutTouched
              ? (await uploadAsset('cutout', alphaMaskToGrayDataURL(r.cut))).file
              : null;                      // Restore: drop the mask reference
            r.cutDirty = false;
          }
        }
        if (fill.dirty) {
          state.rendermask = (fill.touched && !fillIsEmptyNow())
            ? (await uploadAsset('rendermask', fillCv.toDataURL('image/png'))).file
            : null;                        // empty fill = no mask, by design
          fill.dirty = false;
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
    el.psave.addEventListener('click', async () => {
      setBusy(el.psave, true, '💾…');
      try { await save(); } finally { setBusy(el.psave, false); }
    });
    el.pname.addEventListener('input', () => { state.name = el.pname.value; scheduleSave(); });

    async function loadProjectList() {
      try {
        const j = await api('/projects');
        const items = Array.isArray(j.items) ? j.items : [];
        el.popen.innerHTML = '<option value="">Open project…</option>' +
          items.map(p => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)} · ${p.layers} layers</option>`).join('');
      } catch (e) { /* offline: list stays empty */ }
    }
    // Amendment C: restore is AWAITED and pixel-verified. v1 fired image
    // loads and declared the project open immediately; a layer whose
    // asset fetch failed (or whose only ref was a never-uploaded cutout)
    // came back as panel metadata with no pixels, silently. Now the plan
    // (puppet-core planRestore) tries asset -> source with a retry each,
    // waits for decode, and any layer that still has no pixels is NAMED
    // in the status line instead of vanishing.
    async function openProject(pid) {
      say('opening…');
      const j = await api(`/projects/${pid}`);
      projectId = pid;
      try { localStorage.setItem('ellieedit.puppet.lastProject', pid); } catch (e) {}
      state = normalizeState(j.state);
      selectedId = null;
      bgUrl = '';
      el.preview.style.display = 'none';
      rt.clear(); el.stage.querySelectorAll('.pt-layer').forEach(n => n.remove());
      if (state.canvas.background.type === 'image' && state.canvas.background.asset) {
        bgUrl = `${API}/projects/${pid}/assets/${state.canvas.background.asset}`;
      }
      renderStage();
      await loadFillFromState();
      const plan = planRestore(state);
      const results = await runRestore(plan, file =>
        loadImageDecoded(`${API}/projects/${pid}/assets/${file}`));
      const failed = [];
      for (const layer of state.layers) {
        const r = runtimeFor(layer);
        const res = results[layer.id];
        const planned = plan.find(p => p.id === layer.id);
        if (res && res.ok) {
          r.img = res.value;
          r.baseUrl = `${API}/projects/${pid}/assets/${res.file}`;
          if (!layer.natural_w) { layer.natural_w = res.value.naturalWidth; layer.natural_h = res.value.naturalHeight; }
          refreshDisplay(layer);
        } else if (planned && planned.hasBase) {
          failed.push(layer.name);
        }
        if (layer.mask) {
          loadImageDecoded(`${API}/projects/${pid}/assets/${layer.mask}`)
            .then(img => {
              r.mask.width = layer.natural_w || img.naturalWidth;
              r.mask.height = layer.natural_h || img.naturalHeight;
              paintGrayIntoMask(img, r.mask, r.mctx);
              r.maskTouched = true;
              refreshDisplay(layer);
            }).catch(() => say(`Erase mask for “${layer.name}” failed to load.`, 'err'));
        }
        if (layer.cutout) {
          loadImageDecoded(`${API}/projects/${pid}/assets/${layer.cutout}`)
            .then(img => loadCutGrayImage(layer, r, img))
            .catch(() => say(`Cut Out mask for “${layer.name}” failed to load.`, 'err'));
        }
      }
      history.init(snapshot());
      updateRenderNote();
      if (failed.length) {
        say(`Opened “${state.name}” — ⚠ layer image(s) failed to load after retries: ${failed.join(', ')}. The layers are listed but have no pixels yet; re-adding the image fixes it.`, 'err');
      } else {
        say(`Opened “${state.name}” — ${state.layers.length} layer(s) restored with pixels.`, 'ok');
      }
    }
    el.popen.addEventListener('change', async () => {
      const pid = el.popen.value;
      if (!pid) return;
      try { await openProject(pid); } catch (e) { say(e.message, 'err'); }
    });
    el.pnew.addEventListener('click', () => {
      projectId = null; selectedId = null; bgUrl = ''; previewAsset = null;
      try { localStorage.removeItem('ellieedit.puppet.lastProject'); } catch (e) {}
      state = defaultState();
      const last = readLastSize();
      if (last) { state.canvas.width = last.width; state.canvas.height = last.height; el.preset.value = 'last'; }
      rt.clear(); el.stage.querySelectorAll('.pt-layer').forEach(n => n.remove());
      el.preview.style.display = 'none';
      renderStage();
      clearFill(false); fill.dirty = false;
      updateRenderNote();
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
      setBusy(el.bgup, true, '⬆ Uploading…');
      try {
        const durl = await fileToDataURL(f);
        const up = await uploadAsset('background', durl);
        setBackground(up.file, up.url);
        say('Background set from upload.', 'ok');
      } catch (e) { say(e.message, 'err'); }
      finally { setBusy(el.bgup, false); }
    });
    el.bggen.addEventListener('click', async () => {
      const prompt = el.bgprompt.value.trim();
      if (!prompt) { say('Type a background prompt first.', 'err'); return; }
      setBusy(el.bggen, true, '🎨 Generating…');
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
      finally { setBusy(el.bggen, false); }
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
    // Amendment D1: drop/add places the ORIGINAL image immediately — no
    // server round-trip on the drop path at all, so the drop can never
    // freeze behind a cold rmbg session (Amendment B's bug class, gone).
    async function addPuppetFile(f) {
      dropSay(`placing ${f.name}…`);           // feedback in the same tick
      try {
        const srcUrl = await fileToDataURL(f);
        const layer = normalizeState({ layers: [{ id: uid(), name: f.name.replace(/\.[^.]+$/, '') }] }).layers[0];
        const probe = await loadImageDecoded(srcUrl).catch(() => null);
        layer.natural_w = (probe && probe.naturalWidth) || 256;
        layer.natural_h = (probe && probe.naturalHeight) || 256;
        const place = fitPlacement(state.canvas, layer.natural_w, layer.natural_h);
        const off = (cascade++ % 5) * 24;
        layer.x = Math.min(place.x + off, state.canvas.width - 40);
        layer.y = Math.min(place.y + off, state.canvas.height - 40);
        layer.w = place.w; layer.h = place.h;
        state.layers.push(layer);
        selectedId = layer.id;
        const r = runtimeFor(layer);
        r.sourceDataUrl = srcUrl;
        renderStage();
        loadLayerImage(layer, srcUrl);
        commit();
        say(`Placed “${layer.name}” (original). ✂ Cut Out is in Tools when you want the background gone.`, 'ok');
      } finally { dropSay(''); }
    }
    async function addPuppetFiles(files) {
      for (const f of files) {
        if (f && f.type && f.type.startsWith('image/')) {
          try { await addPuppetFile(f); } catch (e) { say(e.message, 'err'); }
        }
      }
    }

    // Amendment D2/D3/D4: Cut Out runs rmbg as a job (spinner lives on the
    // layer's own button; other layers and the stage stay fully usable —
    // jobs run in parallel) and stores the result as the layer's MASK.
    // The original pixels are never modified; Restore drops the mask.
    async function originalDataURL(layer, r) {
      if (r.sourceDataUrl) return r.sourceDataUrl;
      const file = layer.source || layer.asset;
      if (file && projectId) {
        const blob = await (await fetch(assetUrl(file))).blob();
        return blobToDataURL(blob);
      }
      if (r.baseUrl && r.baseUrl.startsWith('data:')) return r.baseUrl;
      throw new Error('no original image available for this layer');
    }
    async function cutOut(layer) {
      if (cutPending.has(layer.id)) return;    // one job per layer
      cutPending.add(layer.id);
      setBusy(el.cutgo, true, '✂ Cutting out…');   // feedback within the click
      updateCutUI();
      try {
        const r = runtimeFor(layer);
        const dataUrl = await originalDataURL(layer, r);
        const out = await rmbg(dataUrl);
        loadCutDataURL(layer, r, 'data:image/png;base64,' + out);
        r.cutDirty = true;
        commit();
        say(`Cut Out applied to “${layer.name}” — it's a mask; ↩ Undo cut in Tools brings the full original back.`, 'ok');
      } catch (e) {
        say(`Cut Out failed for “${layer.name}”: ${e.message}`, 'err');
      } finally {
        cutPending.delete(layer.id);
        setBusy(el.cutgo, false);
        updateCutUI();
      }
    }
    function restoreCut(layer) {
      const r = runtimeFor(layer);
      resetCut(r, layer.natural_w || r.cut.width, layer.natural_h || r.cut.height);
      layer.cutout = null;
      r.cutDirty = true;                       // save drops the reference
      refreshDisplay(layer);
      commit();
      renderLayerList();
      updateCutUI();
      say(`“${layer.name}” restored — full original, no cut mask.`, 'ok');
    }

    // Cut Out / Undo cut live in Tools now (v1.3.1) and act on the
    // SELECTED layer; their enabled state follows the selection.
    function toggleSelect(id) {
      selectedId = (selectedId === id) ? null : id;
      renderStage();
    }
    function updateCutUI() {
      const sel = selected();
      el.cutgo.disabled = !sel || cutPending.size > 0;
      el.cutgo.title = sel ? `run rmbg on “${sel.name}” — result becomes its cut mask`
                           : 'select a layer first';
      const r = sel ? runtimeFor(sel) : null;
      el.restorecut.disabled = !(sel && (sel.cutout || (r && r.cutTouched)));
      el.restorecut.title = sel ? `drop “${sel.name}”'s Cut Out mask` : 'select a layer first';
    }
    el.cutgo.addEventListener('click', () => { const s = selected(); if (s) cutOut(s); });
    el.restorecut.addEventListener('click', () => { const s = selected(); if (s) restoreCut(s); });

    // ------------------------------------------------ v1.3 layer operations
    // Extend a layer's canvas to full project bounds — PERMANENT (the
    // layer's rect becomes the whole canvas, its pixels re-homed inside).
    // Unrotated layers keep their original pixels and both masks exactly
    // (pure offset re-home). A rotated layer's appearance is baked at its
    // stage transform (masks consolidated into the pixels) — the same
    // consolidation merge-down uses. Returns true if it changed anything.
    function extendLayerToCanvas(layer) {
      const W = state.canvas.width, H = state.canvas.height;
      if (layerIsFullBounds(layer, state.canvas)) return false;
      const r = runtimeFor(layer);
      if (!r.img) return false;
      const src = document.createElement('canvas');
      src.width = W; src.height = H;
      const sx = src.getContext('2d');
      if (((layer.rotation || 0) % 360) === 0) {
        sx.drawImage(r.img, layer.x, layer.y, layer.w, layer.h);
        // masks re-home at the same offset (erase onto white = keep,
        // cutout onto transparent = no cut outside the old footprint)
        const nm = document.createElement('canvas');
        nm.width = W; nm.height = H;
        const nmx = nm.getContext('2d');
        nmx.fillStyle = '#fff'; nmx.fillRect(0, 0, W, H);
        nmx.drawImage(r.mask, layer.x, layer.y, layer.w, layer.h);
        r.mask = nm; r.mctx = nm.getContext('2d');
        if (r.cutTouched) {
          const nc = document.createElement('canvas');
          nc.width = W; nc.height = H;
          nc.getContext('2d').drawImage(r.cut, layer.x, layer.y, layer.w, layer.h);
          r.cut = nc; r.cctx = nc.getContext('2d');
        }
        r.maskDirty = r.maskTouched;
        r.cutDirty = r.cutTouched;
      } else {
        drawLayerAppearance(sx, layer);        // bake the rotated appearance
        resetMask(r, W, H);
        r.maskDirty = true; layer.mask = null;
        resetCut(r, W, H);
        r.cutDirty = true; layer.cutout = null;
      }
      r.sourceDataUrl = src.toDataURL('image/png');
      layer.source = null;
      layer.asset = null;                      // save() mirrors the new source
      layer.natural_w = W; layer.natural_h = H;
      layer.x = 0; layer.y = 0; layer.w = W; layer.h = H;
      layer.rotation = 0;
      loadLayerImage(layer, r.sourceDataUrl);
      return true;
    }

    // Merge down (v1.3): the layer's visible pixels alpha-over onto the
    // layer below (which is extended to full bounds by the merge), or
    // onto the background when it is the lowest layer. Both layers' erase
    // masks are consolidated — they live in the merged pixels now — and
    // the surviving layer keeps a fresh, fully-working mask channel.
    async function mergeDown(layer) {
      const idx = state.layers.indexOf(layer);
      if (idx < 0) return;
      const r = runtimeFor(layer);
      if (!r.img) { say(`“${layer.name}” has no pixels to merge yet.`, 'err'); return; }
      const W = state.canvas.width, H = state.canvas.height;
      const below = state.layers[idx - 1] || null;
      try {
        if (below) {
          const rb = runtimeFor(below);
          if (!rb.img) { say(`“${below.name}” has no pixels to merge into.`, 'err'); return; }
          const m = document.createElement('canvas');
          m.width = W; m.height = H;
          const mx = m.getContext('2d');
          extendLayerToCanvas(below);         // full bounds: appearance == source
          drawLayerAppearance(mx, below);
          drawLayerAppearance(mx, layer);     // alpha-over at stage transforms
          rb.sourceDataUrl = m.toDataURL('image/png');
          below.source = null; below.asset = null;
          below.natural_w = W; below.natural_h = H;
          below.x = 0; below.y = 0; below.w = W; below.h = H; below.rotation = 0;
          resetMask(rb, W, H); rb.maskDirty = true; below.mask = null;
          resetCut(rb, W, H); rb.cutDirty = true; below.cutout = null;
          loadLayerImage(below, rb.sourceDataUrl);
          state.layers = state.layers.filter(l => l.id !== layer.id);
          if (selectedId === layer.id) selectedId = below.id;
          commit(); renderStage();
          say(`Merged “${layer.name}” down into “${below.name}” — masks consolidated; “${below.name}” is still erasable.`, 'ok');
        } else {
          const m = document.createElement('canvas');
          m.width = W; m.height = H;
          const mx = m.getContext('2d');
          if (state.canvas.background.type === 'image' && bgUrl) {
            const bimg = await loadImageDecoded(bgUrl).catch(() => null);
            if (bimg) {                              // cover-fit, as staged
              const s = Math.max(W / bimg.naturalWidth, H / bimg.naturalHeight);
              mx.drawImage(bimg, (W - bimg.naturalWidth * s) / 2,
                           (H - bimg.naturalHeight * s) / 2,
                           bimg.naturalWidth * s, bimg.naturalHeight * s);
            }
          }
          drawLayerAppearance(mx, layer);
          const up = await uploadAsset('background', m.toDataURL('image/png'));
          state.canvas.background = { type: 'image', asset: up.file };
          bgUrl = up.url;
          state.layers = state.layers.filter(l => l.id !== layer.id);
          if (selectedId === layer.id) selectedId = null;
          commit(); renderStage();
          say(`Merged “${layer.name}” down into the background.`, 'ok');
        }
      } catch (e) { say('Merge down failed: ' + e.message, 'err'); }
    }

    // Targeted Fill (v1.3): the painted rendermask + ONE target. A layer
    // target is extended to full bounds first (permanent), saved, then the
    // server generates from that layer's own pixels only; the background
    // target generates from the background alone.
    function updateFillUI() {
      const sel = selected();
      el.fillgo.textContent = sel && sel.visible !== false
        ? `✨ Fill “${sel.name}”` : '✨ Fill background';
      el.fillnote.textContent = fillPainted()
        ? (sel && sel.visible !== false
            ? `Target: layer “${sel.name}” — the fill sees only its own pixels. It will be extended to full project bounds (permanent) if it isn't already. Uses the prompt, engine and denoise from the Final pass section.`
            : 'Target: the background — layers are untouched by a background fill. Uses the prompt, engine and denoise from the Final pass section.')
        : 'Paint a Fill Area region first (this step), then Fill. The same painted mask also drives a Fill-Area final pass.';
    }
    el.fillgo.addEventListener('click', async () => {
      if (!fillPainted()) { say('Paint a Fill Area region first — there is nothing to fill yet.', 'err'); return; }
      const sel = selected();
      const targetLayer = (sel && sel.visible !== false) ? sel : null;
      setBusy(el.fillgo, true, '✨ Filling…');
      try {
        say('saving, then filling…');
        if (targetLayer && extendLayerToCanvas(targetLayer)) {
          commit(); renderStage();
          say(`Extended “${targetLayer.name}” to full project bounds (permanent) so the fill region aligns.`);
        }
        await save();
        if (!projectId) throw new Error('could not save the project');
        const j = await jsonPost(`/projects/${projectId}/fill`, {
          prompt: el.rprompt.value.trim(),
          denoise: clampDenoise(parseFloat(el.denoise.value)),
          engine,
          target: targetLayer ? targetLayer.id : 'background',
          seed: Math.floor(Math.random() * 2 ** 31) });
        pvMode = 'fill';
        pvTarget = targetLayer ? targetLayer.id : 'background';
        pvTargetName = j.target_name || (targetLayer ? targetLayer.name : 'background');
        previewAsset = j.asset || null;
        el.previewimg.src = 'data:image/png;base64,' + j.image_b64;
        el.pvaccept.textContent = `✓ Accept fill on ${pvTarget === 'background' ? 'the background' : '“' + pvTargetName + '”'}`;
        el.pvnote.textContent = `Fill preview — accepting applies it to ${pvTarget === 'background' ? 'the background only' : 'layer “' + pvTargetName + '” only'}; nothing else changes.`;
        el.preview.style.display = 'flex';
        say(`Fill done — ${j.engine === 'krea2' ? 'Krea2' : 'Klein inpaint'} at denoise ${Number(j.denoise).toFixed(2)}. Accept applies it to ${pvTarget === 'background' ? 'the background' : '“' + pvTargetName + '” only'}.`, 'ok');
      } catch (e) { say('Fill failed: ' + e.message, 'err'); }
      finally { setBusy(el.fillgo, false); }
    });
    el.add.addEventListener('click', () => el.afile.click());
    el.afile.addEventListener('change', () => { addPuppetFiles([...el.afile.files]); el.afile.value = ''; });
    el.stagewrap.addEventListener('dragover', e => { e.preventDefault(); el.stagewrap.classList.add('dragover'); dragOver = true; updateHint(); });
    el.stagewrap.addEventListener('dragleave', () => { el.stagewrap.classList.remove('dragover'); dragOver = false; updateHint(); });
    el.stagewrap.addEventListener('drop', e => {
      e.preventDefault(); el.stagewrap.classList.remove('dragover'); dragOver = false; updateHint();
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
      // Fill Area step: the canvas itself is the paint surface; layer
      // transforms are inert here so a stroke can never move a puppet.
      // With a layer selected, painting is scoped to that puppet (v1.2):
      // clicking ANOTHER puppet re-scopes instead of painting.
      if (step === 'fill') {
        const sel = selected();
        if (sel && sel.visible !== false) {
          const hit = topmostBoundsAt(state.layers, pt.x, pt.y);
          if (hit && hit.id !== sel.id) {
            selectedId = hit.id;
            renderStage();
            say(`Fill Area re-scoped to “${hit.name}”.`);
            return;
          }
          // Erase/Restore are LAYER tools in every step (v1.3.1): with a
          // layer selected they work that layer's nondestructive mask —
          // pass-through cleanup for whatever Cut Out missed — and never
          // the Fill Area mask. Paint is the fill-mask brush here.
          if (tool === 'erase' || tool === 'restore') {
            op = { type: 'mask', id: sel.id, last: pt, moved: false };
            el.stage.setPointerCapture(e.pointerId);
            stampAt(sel, pt);
            e.preventDefault();
            return;
          }
          op = { type: 'fill', scoped: true, clip: buildClipCanvas(sel), last: pt, moved: false };
          stampFillGated(pt, op.clip);
        } else {
          op = { type: 'fill', scoped: false, last: pt, moved: false };
          stampFill(pt);
        }
        el.stage.setPointerCapture(e.pointerId);
        op.moved = true;
        e.preventDefault();
        return;
      }
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
      // Focus stickiness (v1.3): a pointer-down inside the SELECTED
      // layer's bounds — even on fully transparent/erased pixels —
      // belongs to that layer. Only clicks outside its bounds fall
      // through to whatever is underneath. (This is also what makes the
      // Restore brush usable: erased regions have no alpha to hit.)
      if (sel && sel.visible !== false && hitLayer(sel, pt.x, pt.y)) {
        if (tool === 'erase' || tool === 'restore') {
          op = { type: 'mask', id: sel.id, last: pt, moved: false };
          el.stage.setPointerCapture(e.pointerId);
          stampAt(sel, pt);
        } else {
          op = { type: 'move', id: sel.id, startX: sel.x, startY: sel.y,
                 grabDX: pt.x - sel.x, grabDY: pt.y - sel.y,
                 loc: stageToLocal(sel, pt.x, pt.y), moved: false };
          el.stage.setPointerCapture(e.pointerId);
        }
        e.preventDefault();
        return;
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
      const pt = stagePoint(e);
      if (op.type === 'fill') {
        if (op.scoped) stampFillLineGated(op.last, pt, op.clip);
        else stampFillLine(op.last, pt);
        op.last = pt;
        op.moved = true;
        return;
      }
      const layer = state.layers.find(l => l.id === op.id);
      if (!layer) { op = null; return; }
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
        if (op.type === 'fill') {
          fill.dirty = true;
          refreshFillOverlay(true);
          updateRenderNote();
          updateFillUI();
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

    // ---------------------------------------------------------- Fill Area
    // The Fill Area step (v1.1 spec 1-3): a canvas-level paintable mask.
    // fillCv is grayscale at canvas resolution — white regenerates, black
    // locks. It is a SEPARATE channel from every layer mask: painting or
    // clearing it never touches a layer's erase/cutout mask (spec item 4).
    function syncFillSize() {
      const w = state.canvas.width, h = state.canvas.height;
      if (fillCv.width === w && fillCv.height === h) return;
      const old = document.createElement('canvas');
      old.width = fillCv.width; old.height = fillCv.height;
      old.getContext('2d').drawImage(fillCv, 0, 0);
      fillCv.width = w; fillCv.height = h;
      fillCx.save();
      fillCx.globalCompositeOperation = 'source-over';
      fillCx.fillStyle = '#000';
      fillCx.fillRect(0, 0, w, h);
      if (old.width > 1) fillCx.drawImage(old, 0, 0, w, h);
      fillCx.restore();
    }
    function clearFill(markDirty = true) {
      syncFillSize();
      fillCx.save();
      fillCx.globalCompositeOperation = 'source-over';
      fillCx.fillStyle = '#000';
      fillCx.fillRect(0, 0, fillCv.width, fillCv.height);
      fillCx.restore();
      fill.touched = false;
      if (markDirty) fill.dirty = true;
      refreshFillOverlay(true);
    }
    function fillIsEmptyNow() {
      try {
        const d = fillCx.getImageData(0, 0, fillCv.width, fillCv.height).data;
        const gray = new Uint8Array(fillCv.width * fillCv.height);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = d[i];
        return grayMaskIsEmpty(gray);
      } catch (e) { return !fill.touched; }
    }
    function fillPainted() { return fill.touched && !fillIsEmptyNow(); }
    // Subtle violet tint over painted regions — only while in the step.
    function refreshFillOverlay(force = false) {
      if (step !== 'fill') { el.fillov.style.display = 'none'; return; }
      const now = performance.now();
      if (!force && now - fill.ovAt < 120) return;
      fill.ovAt = now;
      el.fillov.width = fillCv.width; el.fillov.height = fillCv.height;
      el.fillov.style.display = 'block';
      const oc = el.fillov.getContext('2d');
      const src = fillCx.getImageData(0, 0, fillCv.width, fillCv.height);
      const out = oc.createImageData(fillCv.width, fillCv.height);
      for (let i = 0; i < src.data.length; i += 4) {
        const g = src.data[i];
        out.data[i] = 168; out.data[i + 1] = 140; out.data[i + 2] = 255;
        out.data[i + 3] = Math.round(g * 0.5);
      }
      oc.putImageData(out, 0, 0);
    }
    function updateRenderNote() {
      const painted = fillPainted();
      const used = resolveRenderMask({ mode: renderMode,
        hasFill: painted, fillEmpty: !painted });
      if (renderMode === 'all') {
        el.rmnote.textContent = 'Render all: the final pass repaints the whole canvas (Fill Area ignored).';
      } else if (used === 'fill') {
        el.rmnote.textContent = 'Fill Area only: painted regions regenerate at the fenced denoise; everything else stays locked, pixel for pixel.';
      } else {
        el.rmnote.textContent = 'Fill Area only — but nothing is painted yet, so this renders the full canvas (same as v1). Paint in the Fill Area step to lock regions.';
      }
    }
    async function loadFillFromState() {
      clearFill(false);
      fill.dirty = false;
      if (!state.rendermask || !projectId) { refreshFillOverlay(true); return; }
      try {
        const img = await loadImageDecoded(assetUrl(state.rendermask));
        syncFillSize();
        fillCx.save();
        fillCx.globalCompositeOperation = 'source-over';
        fillCx.fillStyle = '#000'; fillCx.fillRect(0, 0, fillCv.width, fillCv.height);
        fillCx.drawImage(img, 0, 0, fillCv.width, fillCv.height);
        fillCx.restore();
        fill.touched = !fillIsEmptyNow();
      } catch (e) { say('Fill Area mask failed to load — treating as empty.', 'err'); }
      refreshFillOverlay(true);
    }
    function stampFill(pt) {
      const radius = Math.max(1, (parseFloat(el.bsize.value) || 48) / 2);
      const hardness = (parseFloat(el.bhard.value) || 0) / 100;
      const white = tool !== 'erase';          // Erase tool = paint LOCK
      const g = fillCx.createRadialGradient(pt.x, pt.y, radius * hardness, pt.x, pt.y, radius);
      const rgb = white ? '255,255,255' : '0,0,0';
      g.addColorStop(0, `rgba(${rgb},1)`);
      g.addColorStop(Math.min(0.999, hardness + (1 - hardness) * 0.5), `rgba(${rgb},0.5)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      fillCx.save();
      fillCx.globalCompositeOperation = 'source-over';
      fillCx.fillStyle = g;
      fillCx.beginPath(); fillCx.arc(pt.x, pt.y, radius, 0, Math.PI * 2); fillCx.fill();
      fillCx.restore();
      fill.touched = true;
      refreshFillOverlay();
    }
    function stampFillLine(a, b) {
      const radius = Math.max(1, (parseFloat(el.bsize.value) || 48) / 2);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.floor(dist / Math.max(1, radius / 3)));
      for (let i = 1; i <= steps; i++) {
        stampFill({ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps });
      }
    }

    // Layer-scoped Fill Area (v1.2 item 2). The clip canvas holds, in its
    // ALPHA channel, where paint is admitted: the selected layer's current
    // visible footprint (its display canvas at its stage transform) UNION
    // the fill painted so far. Each stamp is gated through the clip
    // (destination-in == puppet-core's gateStampAlpha multiply), lands on
    // the SAME canvas-level rendermask as unscoped painting — scoping is
    // an interaction gate, not a new storage channel — and then joins the
    // clip, so a stroke can grow outward from the puppet: start at the
    // neck, walk down, and the body region accrues. A stroke that starts
    // in empty space away from puppet and fill paints nothing.
    const stampCv = document.createElement('canvas');
    // Draw a layer's current stage appearance (display canvas, masks
    // applied, at its stage transform) into a canvas-sized context.
    function drawLayerAppearance(cx2, layer) {
      const r = rt.get(layer.id);
      if (!r || !r.cv || !r.cv.width) return;
      const c = layerCenterOf(layer);
      cx2.save();
      cx2.translate(c.x, c.y);
      cx2.rotate((layer.rotation || 0) * Math.PI / 180);
      cx2.drawImage(r.cv, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
      cx2.restore();
    }
    function buildClipCanvas(layer) {
      const w = state.canvas.width, h = state.canvas.height;
      const clip = document.createElement('canvas');
      clip.width = w; clip.height = h;
      const cx2 = clip.getContext('2d');
      drawLayerAppearance(cx2, layer);
      // union with the fill so far: fill luminance becomes alpha
      const fa = document.createElement('canvas');
      fa.width = w; fa.height = h;
      const fx = fa.getContext('2d');
      fx.drawImage(fillCv, 0, 0);
      const d = fx.getImageData(0, 0, w, h);
      for (let i = 0; i < d.data.length; i += 4) {
        d.data[i + 3] = d.data[i];
        d.data[i] = 255; d.data[i + 1] = 255; d.data[i + 2] = 255;
      }
      fx.putImageData(d, 0, 0);
      cx2.drawImage(fa, 0, 0);
      return clip;
    }
    function layerCenterOf(layer) {
      return { x: layer.x + layer.w / 2, y: layer.y + layer.h / 2 };
    }
    function stampFillGated(pt, clip) {
      const radius = Math.max(1, (parseFloat(el.bsize.value) || 48) / 2);
      const hardness = (parseFloat(el.bhard.value) || 0) / 100;
      const white = tool !== 'erase';
      stampCv.width = state.canvas.width; stampCv.height = state.canvas.height;
      const sc = stampCv.getContext('2d');
      const g = sc.createRadialGradient(pt.x, pt.y, radius * hardness, pt.x, pt.y, radius);
      const rgb = white ? '255,255,255' : '0,0,0';
      g.addColorStop(0, `rgba(${rgb},1)`);
      g.addColorStop(Math.min(0.999, hardness + (1 - hardness) * 0.5), `rgba(${rgb},0.5)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      sc.save();
      sc.globalCompositeOperation = 'source-over';
      sc.fillStyle = g;
      sc.beginPath(); sc.arc(pt.x, pt.y, radius, 0, Math.PI * 2); sc.fill();
      sc.globalCompositeOperation = 'destination-in';   // the gate
      sc.drawImage(clip, 0, 0);
      sc.restore();
      fillCx.save();
      fillCx.globalCompositeOperation = 'source-over';
      fillCx.drawImage(stampCv, 0, 0);
      fillCx.restore();
      // the fresh paint joins the clip: the stroke may keep growing
      const cc = clip.getContext('2d');
      cc.save(); cc.globalCompositeOperation = 'source-over';
      cc.drawImage(stampCv, 0, 0); cc.restore();
      fill.touched = true;
      refreshFillOverlay();
    }
    function stampFillLineGated(a, b, clip) {
      const radius = Math.max(1, (parseFloat(el.bsize.value) || 48) / 2);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.floor(dist / Math.max(1, radius / 3)));
      for (let i = 1; i <= steps; i++) {
        stampFillGated({ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, clip);
      }
    }
    function updateFillHint() {
      if (step !== 'fill') return;
      const sel = selected();
      el.fillhint.textContent = (sel && sel.visible !== false)
        ? `Fill Area is scoped to “${sel.name}”: paint must grow from the puppet (or from fill already painted) — start on the puppet and stroke outward, e.g. the body below a headshot. Click another puppet to re-scope it; deselect (Place step, click empty stage) for whole-canvas fill. Brush = fill, Erase tool = lock.`
        : 'Fill Area: paint where generation should happen (white = fill, everything else stays locked). Brush paints fill; the Erase tool paints lock. Undo and Clear work; the tint only shows during this step.';
    }
    function enterStep(next) {
      step = next;
      el.steps.querySelectorAll('[data-step]').forEach(x =>
        x.classList.toggle('on', x.dataset.step === next));
      el.fillhint.style.display = next === 'fill' ? '' : 'none';
      el.stage.classList.toggle('filling', next === 'fill');
      refreshFillOverlay(true);
      updateFillHint();
      updateFillUI();
      updateRenderNote();
      if (next === 'fill') say('Fill Area: paint where generation should happen. Brush = fill, Erase tool = lock.');
    }
    el.steps.addEventListener('click', e => {
      const b = e.target.closest('[data-step]');
      if (b) enterStep(b.dataset.step);
    });
    el.fillclear.addEventListener('click', () => {
      clearFill(true);
      updateRenderNote();
      updateFillUI();
      commit();
      say('Fill Area cleared — the next render covers the full canvas.');
    });
    el.rmodes.addEventListener('click', e => {
      const b = e.target.closest('[data-rmode]');
      if (!b) return;
      renderMode = b.dataset.rmode;
      el.rmodes.querySelectorAll('[data-rmode]').forEach(x =>
        x.classList.toggle('on', x === b));
      updateRenderNote();
    });
    el.engines.addEventListener('click', e => {
      const b = e.target.closest('[data-engine]');
      if (!b) return;
      engine = b.dataset.engine;
      el.engines.querySelectorAll('[data-engine]').forEach(x =>
        x.classList.toggle('on', x === b));
    });

    // ------------------------------------------------------------- render
    el.denoise.addEventListener('input', () => {
      const d = clampDenoise(parseFloat(el.denoise.value));
      el['dval'].textContent = d.toFixed(2);
    });
    el.render.addEventListener('click', async () => {
      setBusy(el.render, true, '✨ Rendering…');   // state shows immediately
      try {
        say('saving stack, then rendering the final pass…');
        await save();
        if (!projectId) throw new Error('could not save the project');
        const j = await jsonPost(`/projects/${projectId}/render`, {
          prompt: el.rprompt.value.trim(),
          denoise: clampDenoise(parseFloat(el.denoise.value)),
          mode: renderMode,
          engine,
          seed: Math.floor(Math.random() * 2 ** 31) });
        previewAsset = j.render_asset || null;
        pvMode = 'render';
        el.pvaccept.textContent = '✓ Accept as new layer';
        el.pvnote.textContent = 'Final pass preview — accepting adds it as a new layer on top; the stack underneath stays live.';
        el.previewimg.src = 'data:image/png;base64,' + j.image_b64;
        el.preview.style.display = 'flex';
        say(`Final pass done — ${j.engine === 'krea2' ? 'Krea2' : 'Klein'} at denoise ${Number(j.denoise).toFixed(2)} (mask: ${j.mask_used === 'fill' ? 'Fill Area' : 'full canvas'}) — accept (adds a layer) or discard.`, 'ok');
      } catch (e) { say('Render failed: ' + e.message, 'err'); }
      finally { setBusy(el.render, false); }
    });
    el.pvdiscard.addEventListener('click', () => {
      el.preview.style.display = 'none';
      previewAsset = null;
      pvMode = 'render';
      say('Preview discarded — back to the live composite.');
    });
    el.pvaccept.addEventListener('click', async () => {
      setBusy(el.pvaccept, true, '✓ Accepting…');
      try {
        if (pvMode === 'fill') {
          // v1.3: a fill lands on its TARGET and nowhere else — a layer
          // target keeps the result on that layer (never stamped onto
          // the background); a background target replaces the background.
          let file = previewAsset;
          if (!file) {
            if (!el.previewimg.src) throw new Error('no fill to accept');
            file = (await uploadAsset('render', el.previewimg.src)).file;
          }
          if (pvTarget === 'background') {
            state.canvas.background = { type: 'image', asset: file };
            bgUrl = projectId ? assetUrl(file) : el.previewimg.src;
            say('Fill accepted onto the background — layers untouched.', 'ok');
          } else {
            const layer = state.layers.find(l => l.id === pvTarget);
            if (!layer) throw new Error('the fill target layer is gone');
            const r = runtimeFor(layer);
            layer.source = file; layer.asset = file;
            r.sourceDataUrl = '';
            // The filled pixels are the layer's new truth; its old masks
            // were baked into the fill input, so both channels reset
            // (undo restores the pre-fill state, masks included).
            layer.mask = null; resetMask(r, layer.natural_w || state.canvas.width, layer.natural_h || state.canvas.height); r.maskDirty = false;
            layer.cutout = null; resetCut(r, layer.natural_w || state.canvas.width, layer.natural_h || state.canvas.height); r.cutDirty = false;
            loadLayerImage(layer, projectId ? assetUrl(file) : el.previewimg.src);
            selectedId = layer.id;
            say(`Fill accepted onto “${layer.name}” — it stayed on the layer.`, 'ok');
          }
          previewAsset = null;
          pvMode = 'render';
          el.preview.style.display = 'none';
          commit(); renderStage();
          return;
        }
      // v1.2 item 3: Accept = the render becomes a NEW PUPPET LAYER on top
      // of the stack (iterative compositing). The background and every
      // existing layer stay exactly as they are — the render layer can be
      // dragged, resized, rotated, erased into, or rendered over again.
        let file = previewAsset;
        if (!file) {
          if (!el.previewimg.src) throw new Error('no render to accept');
          file = (await uploadAsset('render', el.previewimg.src)).file;
        }
        const layer = makeRenderLayer(state, { id: uid(), asset: file });
        state.layers.push(layer);
        selectedId = layer.id;
        runtimeFor(layer);
        loadLayerImage(layer, projectId ? assetUrl(file) : el.previewimg.src);
        previewAsset = null;
        el.preview.style.display = 'none';
        commit(); renderStage();
        say(`Accepted as layer “${layer.name}” — it's a puppet now: move it, mask it, or render again on top.`, 'ok');
      } catch (e) { say('Accept failed: ' + e.message, 'err'); }
      finally { setBusy(el.pvaccept, false); }
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
      setBusy(el.expng, true, '⬇ Exporting…');
      try {
        await save();
        if (!projectId) throw new Error('nothing to export yet');
        const r = await fetch(`${API}/projects/${projectId}/export.png`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        downloadBlob(await r.blob(), `puppet-${projectId}.png`);
        say('Composite PNG exported at canvas resolution.', 'ok');
      } catch (e) { say('Export failed: ' + e.message, 'err'); }
      finally { setBusy(el.expng, false); }
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
          ? '● rmbg ready · denoise fence 0.20–0.80'
          : '○ rmbg not available on server (✂ Cut Out will report it; drops still place instantly)';
        el.conn.className = 'pt-status ' + (rm.available ? 'ok' : 'err');
      } catch (e) {
        el.conn.textContent = '○ /api/puppet unreachable';
        el.conn.className = 'pt-status err';
      }
      await loadProjectList();
      // Reload continuity (Amendment C): reopen the last project so a
      // page reload restores the stage — through the same awaited,
      // pixel-verified restore path as a manual Open.
      let lastPid = null;
      try { lastPid = localStorage.getItem('ellieedit.puppet.lastProject'); } catch (e) {}
      if (lastPid) {
        try { await openProject(lastPid); } catch (e) { say(e.message, 'err'); }
      }
    })();
    const lastSize = readLastSize();
    if (lastSize) { state.canvas.width = lastSize.width; state.canvas.height = lastSize.height; el.preset.value = 'last'; }
    renderStage();
    updateRenderNote();
    history.init(snapshot());
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail && e.detail.name === 'puppet') { loadProjectList(); refit(); }
    });
  },
});
