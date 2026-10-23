// Puppet Theater — pure logic (no DOM), node-testable like foxden-state.js.
// Transform math, z-order ops, mask compositing arithmetic, state shape,
// history. The DOM module (puppet.js) is a thin skin over these.
//
// Layer model: layers are kept in an array ordered BOTTOM -> TOP (paint
// order). Each layer: { id, name, asset, source, mask, x, y, w, h,
// rotation (deg, clockwise, CSS semantics), visible, natural_w, natural_h }
// where (x, y) is the TOP-LEFT of the layer's unrotated rect on the canvas
// and rotation pivots about the rect's center — exactly how CSS
// `transform: rotate()` on an absolutely-positioned element behaves, and
// exactly how the backend compositor (puppet.py) flattens the stack.

export const DENOISE_MIN = 0.2;
export const DENOISE_MAX = 0.8;
export const DENOISE_DEFAULT = 0.45;

export const CANVAS_PRESETS = { '1:1': [1024, 1024], '3:2': [1152, 768], '16:9': [1280, 720] };
export const MAX_LAYERS = 64;
export const MIN_SIZE = 8;

/** The denoise fence, client mirror of puppet.py's clamp_denoise. */
export function clampDenoise(v) {
  if (v === null || v === undefined || v === '') return DENOISE_DEFAULT;
  const d = Number(v);
  if (!Number.isFinite(d)) return DENOISE_DEFAULT;
  return Math.min(DENOISE_MAX, Math.max(DENOISE_MIN, d));
}

export function presetSize(preset, fallback) {
  const p = CANVAS_PRESETS[preset];
  if (p) return { width: p[0], height: p[1] };
  const f = fallback || {};
  const w = Number.isFinite(Number(f.width)) ? Number(f.width) : 1024;
  const h = Number.isFinite(Number(f.height)) ? Number(f.height) : 1024;
  return { width: w, height: h };
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const assetName = v => (typeof v === 'string' && v && !v.includes('/') && !v.includes('\\')
  && /\.(png|jpe?g|webp)$/i.test(v) ? v : null);

export function normalizeLayer(raw, i = 0) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(r.id || `layer-${i + 1}`).slice(0, 64),
    name: String(r.name || `Layer ${i + 1}`).slice(0, 80),
    asset: assetName(r.asset),
    source: assetName(r.source),
    mask: assetName(r.mask),
    cutout: assetName(r.cutout),
    x: num(r.x), y: num(r.y),
    w: Math.max(1, num(r.w, 100)), h: Math.max(1, num(r.h, 100)),
    rotation: ((num(r.rotation) % 360) + 360) % 360,
    visible: r.visible !== false,
    natural_w: Math.max(0, Math.trunc(num(r.natural_w))),
    natural_h: Math.max(0, Math.trunc(num(r.natural_h))),
  };
}

export function normalizeState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const c = r.canvas && typeof r.canvas === 'object' ? r.canvas : {};
  const bg = c.background && typeof c.background === 'object' ? c.background : {};
  const layers = Array.isArray(r.layers) ? r.layers.slice(0, MAX_LAYERS).map(normalizeLayer) : [];
  // de-dupe ids (later duplicates get a suffix) so ops stay unambiguous
  const seen = new Set();
  for (let i = 0; i < layers.length; i++) {
    if (seen.has(layers[i].id)) layers[i] = { ...layers[i], id: `${layers[i].id}-${i + 1}` };
    seen.add(layers[i].id);
  }
  return {
    name: String(r.name || 'Untitled theater').slice(0, 120),
    canvas: {
      width: Math.min(8192, Math.max(16, Math.trunc(num(c.width, 1024)))),
      height: Math.min(8192, Math.max(16, Math.trunc(num(c.height, 1024)))),
      background: {
        type: bg.type === 'image' ? 'image' : 'none',
        asset: bg.type === 'image' ? assetName(bg.asset) : null,
      },
    },
    layers,
    // The Fill Area render mask lives at STATE level, never on a layer:
    // the per-layer erase/cutout masks and the canvas rendermask are three
    // separate channels and must never alias (v1.1 spec item 4).
    rendermask: assetName(r.rendermask),
  };
}

/** A grayscale mask (one byte per pixel) is EMPTY when every byte is 0 —
 * nothing painted. An empty Fill Area mask must behave exactly like no
 * mask at all (full-canvas render), on both client and server. */
export function grayMaskIsEmpty(gray) {
  if (!gray || !gray.length) return true;
  for (let i = 0; i < gray.length; i++) if (gray[i] > 0) return false;
  return true;
}

/** Resolve which mask the final pass should use.
 * mode 'all' always renders the full canvas; mode 'fill' uses the painted
 * Fill Area mask only when one exists AND is non-empty. */
export function resolveRenderMask({ mode, hasFill, fillEmpty } = {}) {
  if (mode === 'fill' && hasFill && !fillEmpty) return 'fill';
  return 'full';
}

/**
 * Plan restoring a saved project onto the stage (Amendment C). Pure: for
 * each layer, the ordered candidate asset files to try for its BASE image
 * (primary first, then the fallback), plus its mask files. v1 restored
 * only `asset` and only on a single unretried load — a layer whose cutout
 * asset failed (or was never the right ref) came back as metadata with no
 * pixels. The plan's fallback to `source` and runRestore's retry are the
 * fix; the stage is only "restored" when pixels actually arrive.
 */
export function planRestore(state) {
  const s = normalizeState(state);
  return s.layers.map(l => {
    const candidates = [];
    for (const f of [l.asset, l.source]) {
      if (f && !candidates.includes(f)) candidates.push(f);
    }
    return { id: l.id, name: l.name, candidates,
             mask: l.mask, cutout: l.cutout,
             hasBase: candidates.length > 0 };
  });
}

/** The empty-stage drop hint (v1.2 item 1) shows ONLY when the stage is
 * truly empty — no layers AND no background — or during an active
 * drag-over (when it reads as a drop target, not a label on the art). */
export function stageHintVisible({ layerCount = 0, hasBackground = false, dragOver = false } = {}) {
  if (dragOver) return true;
  return layerCount === 0 && !hasBackground;
}

/**
 * A fresh layer for an accepted final-pass render (v1.2 item 3): the
 * render becomes a puppet ON TOP of the stack — full-canvas placement,
 * fully transformable, background untouched. asset and source both point
 * at the render asset so it save/reload round-trips like any layer.
 * Numbered "Render N" after existing render layers.
 */
export function makeRenderLayer(state, { id, asset } = {}) {
  const s = normalizeState(state);
  const n = s.layers.filter(l => /^Render \d+$/.test(l.name)).length;
  return normalizeLayer({
    id: id || `layer-${s.layers.length + 1}`,
    name: `Render ${n + 1}`,
    asset, source: asset,
    x: 0, y: 0, w: s.canvas.width, h: s.canvas.height,
    rotation: 0, visible: true,
    natural_w: s.canvas.width, natural_h: s.canvas.height,
  });
}

// ------------------------------------------- layer-scoped Fill Area (v1.2)
// When a layer is selected, Fill Area strokes are GATED to the layer's
// footprint ∪ the fill painted so far: a stroke must start on (or
// connected to) the puppet or existing fill, and can then grow outward —
// "fill the body below this headshot" is a stroke that starts at the neck
// and walks down. The gate arithmetic below is the scalar mirror of the
// canvas implementation (destination-in IS this multiply).

/** Union of the layer-footprint alpha and the existing fill gray at a
 * point: either one admits paint. */
export function unionClipAlpha(layerAlpha, fillGray) {
  return Math.max(layerAlpha | 0, fillGray | 0);
}

/** A stamp's effective alpha after gating through the clip: stamp alpha
 * scaled by clip alpha (fully admitted at clip 255, blocked at 0). */
export function gateStampAlpha(stampAlpha, clipAlpha) {
  return Math.floor((stampAlpha * clipAlpha) / 255);
}

/**
 * Execute a restore plan. `load(file)` returns a Promise for the decoded
 * image (any truthy value) or rejects. Each candidate is tried up to
 * `attempts` times (a cold server / transient 404 must not blank a layer),
 * then the next candidate. Resolves to a map:
 *   { [layerId]: { ok, file, value, tries } }
 * A layer is only ok when its pixels actually loaded.
 */
export async function runRestore(plan, load, attempts = 2) {
  const out = {};
  for (const entry of plan || []) {
    let res = { ok: false, file: null, value: null, tries: 0 };
    for (const file of entry.candidates || []) {
      for (let a = 0; a < attempts && !res.ok; a++) {
        res.tries++;
        try {
          const v = await load(file, entry);
          if (v) res = { ok: true, file, value: v, tries: res.tries };
        } catch { /* retry, then fall back to the next candidate */ }
      }
      if (res.ok) break;
    }
    out[entry.id] = res;
  }
  return out;
}

export function defaultState() {
  return normalizeState({ name: 'Untitled theater',
    canvas: { width: 1024, height: 1024, background: { type: 'none', asset: null } },
    layers: [] });
}

/** Next placement for a dropped puppet: centered, fit within the canvas at
 * natural size (shrunk to fit, never upscaled). Pure placement math. */
export function fitPlacement(canvas, naturalW, naturalH) {
  const nw = Math.max(1, num(naturalW, 256));
  const nh = Math.max(1, num(naturalH, 256));
  const scale = Math.min(1, (canvas.width * 0.9) / nw, (canvas.height * 0.9) / nh);
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  return { x: Math.round((canvas.width - w) / 2), y: Math.round((canvas.height - h) / 2), w, h };
}

// ------------------------------------------------------------ z-order ops
// Array order IS z-order (index 0 = bottom). All ops return a NEW array and
// never mutate; unknown ids return an equal-order copy.

export function moveLayerZ(layers, id, op) {
  const out = (layers || []).slice();
  const i = out.findIndex(l => l.id === id);
  if (i < 0) return out;
  const [it] = out.splice(i, 1);
  if (op === 'front') out.push(it);
  else if (op === 'back') out.unshift(it);
  else if (op === 'up') out.splice(Math.min(out.length, i + 1), 0, it);
  else if (op === 'down') out.splice(Math.max(0, i - 1), 0, it);
  else out.splice(i, 0, it);
  return out;
}

/** Visible layers in paint order (bottom first). */
export function paintOrder(layers) {
  return (layers || []).filter(l => l.visible !== false);
}

// --------------------------------------------------------- transform math

export function layerCenter(l) {
  return { x: l.x + l.w / 2, y: l.y + l.h / 2 };
}

const rad = deg => (deg * Math.PI) / 180;

/** Stage point -> layer-local point (in the layer's unrotated rect space,
 * origin at its top-left). The inverse of the CSS rotate about center. */
export function stageToLocal(layer, px, py) {
  const c = layerCenter(layer);
  const dx = px - c.x, dy = py - c.y;
  const a = rad(-(layer.rotation || 0));
  return { x: dx * Math.cos(a) - dy * Math.sin(a) + layer.w / 2,
           y: dx * Math.sin(a) + dy * Math.cos(a) + layer.h / 2 };
}

/** Layer-local point -> stage point. */
export function localToStage(layer, lx, ly) {
  const c = layerCenter(layer);
  const dx = lx - layer.w / 2, dy = ly - layer.h / 2;
  const a = rad(layer.rotation || 0);
  return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a),
           y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
}

/** Is a stage point inside the layer's (rotated) rect? */
export function hitLayer(layer, px, py) {
  const p = stageToLocal(layer, px, py);
  return p.x >= 0 && p.y >= 0 && p.x <= layer.w && p.y <= layer.h;
}

/** Topmost visible layer under a stage point; layers are bottom->top. */
export function topmostAt(layers, px, py) {
  const ls = layers || [];
  for (let i = ls.length - 1; i >= 0; i--) {
    if (ls[i].visible !== false && hitLayer(ls[i], px, py)) return ls[i];
  }
  return null;
}

/** Topmost visible layer whose BOUNDS contain the point — bounds, not
 * alpha (v1.3 focus stickiness): a pointer-down on a selected layer's
 * fully transparent or erased region still belongs to that layer; only
 * clicks outside its bounds may fall through to layers underneath. */
export function topmostBoundsAt(layers, px, py) {
  return topmostAt(layers, px, py);
}

/** Is the layer already extended to full project bounds (the Fill
 * precondition): full-canvas rect, unrotated. */
export function layerIsFullBounds(layer, canvas) {
  return !!layer && !!canvas
    && Math.round(layer.x) === 0 && Math.round(layer.y) === 0
    && Math.round(layer.w) === Math.round(canvas.width)
    && Math.round(layer.h) === Math.round(canvas.height)
    && ((layer.rotation || 0) % 360) === 0;
}

export const HANDLE_NAMES = ['nw', 'ne', 'se', 'sw'];

/** Handle centers in stage coords: the rect's corners, rotated with it. */
export function handlePositions(layer) {
  const local = { nw: [0, 0], ne: [layer.w, 0], se: [layer.w, layer.h], sw: [0, layer.h] };
  const out = {};
  for (const k of HANDLE_NAMES) out[k] = localToStage(layer, local[k][0], local[k][1]);
  return out;
}

/**
 * Resize by dragging a corner. Coordinates are in the layer's LOCAL space:
 * the caller converts the pointer via stageToLocal against the ORIGINAL
 * rect each move (so rotation never distorts the drag), and `start` is the
 * rect at drag start. The opposite corner stays anchored in local space.
 * Aspect-locked by default (uses the axis with the larger movement);
 * free-stretch when lockAspect is false. Returns a new rect {x,y,w,h} in
 * CANVAS space — the anchored corner is a local point whose canvas position
 * is preserved by construction when rotation is 0; for rotated layers the
 * center pivot is kept and x/y are recomputed so the rect's center moves
 * only as the size change dictates (center-anchored growth about the
 * opposite corner in local space).
 */
export function resizeRect(start, corner, localNow, opts = {}) {
  const lock = opts.lockAspect !== false;
  const aspect = start.w / start.h;
  // The anchor is the corner OPPOSITE the one being dragged.
  const anchorLocal = { nw: [start.w, start.h], ne: [0, start.h],
                        se: [0, 0], sw: [start.w, 0] }[corner];
  if (!anchorLocal) return { ...start };
  let w = Math.abs(localNow.x - anchorLocal[0]);
  let h = Math.abs(localNow.y - anchorLocal[1]);
  if (lock) {
    if (w / aspect >= h) h = w / aspect; else w = h * aspect;
  }
  w = Math.max(MIN_SIZE, w);
  h = Math.max(MIN_SIZE, lock ? w / aspect : h);
  // The anchor corner's local coords inside the NEW rect (e.g. dragging
  // 'se', the anchor is the nw corner = (0,0) at any size).
  const anchorInNew = { nw: [w, h], ne: [0, h], se: [0, 0], sw: [w, 0] }[corner];
  // Keep the anchor's STAGE position fixed. With center-pivot rotation,
  // stage(p) = C + R * (p - half), so:
  //   C_new = stage(anchor) - R * (anchorInNew - half_new)
  //   x_new = C_new - half_new
  const a = rad(start.rotation || 0);
  const cos = Math.cos(a), sin = Math.sin(a);
  const anchorStage = localToStage(start, anchorLocal[0], anchorLocal[1]);
  const dx = anchorInNew[0] - w / 2, dy = anchorInNew[1] - h / 2;
  const cx = anchorStage.x - (dx * cos - dy * sin);
  const cy = anchorStage.y - (dx * sin + dy * cos);
  return { x: cx - w / 2, y: cy - h / 2, w, h, rotation: start.rotation || 0 };
}

/** Rotation from a pointer around the layer center, relative to drag start. */
export function rotationFromPointer(layer, px, py, startPointerAngle, startRotation) {
  const c = layerCenter(layer);
  const now = Math.atan2(py - c.y, px - c.x) * 180 / Math.PI;
  const delta = now - startPointerAngle;
  return ((startRotation + delta) % 360 + 360) % 360;
}

export function pointerAngle(layer, px, py) {
  const c = layerCenter(layer);
  return Math.atan2(py - c.y, px - c.x) * 180 / Math.PI;
}

// ------------------------------------------------------- mask compositing

/**
 * Apply a grayscale mask to RGBA pixel data (pure Array math, the same
 * arithmetic as the backend's ImageChops.multiply): out_alpha =
 * in_alpha * mask / 255. `rgba` is a Uint8ClampedArray (or plain array) of
 * length w*h*4; `mask` is one byte per pixel. Returns a NEW array; inputs
 * are never mutated — the mask is nondestructive, the source pixels are
 * never touched by erasing.
 */
export function applyMaskToAlpha(rgba, mask, w, h) {
  const out = new Uint8ClampedArray(rgba);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    out[i * 4 + 3] = Math.floor((out[i * 4 + 3] * (mask[i] ?? 255)) / 255);
  }
  return out;
}

/** Brush stamp alpha at distance d from the stamp center: 1 inside the
 * hard core (hardness * radius), easing to 0 at the rim. hardness 1 = a
 * hard-edged brush, 0 = fully soft. */
export function brushAlpha(distance, radius, hardness) {
  const r = Math.max(0.001, radius);
  const hard = Math.min(1, Math.max(0, hardness));
  const core = r * hard;
  if (distance <= core) return 1;
  if (distance >= r) return 0;
  return 1 - (distance - core) / (r - core);
}

// ---------------------------------------------------------------- history

/**
 * Snapshot undo stack for transforms + mask strokes. Snapshots are opaque
 * strings (the UI serializes state + mask dataURLs); the stack only manages
 * ordering. push() clears the redo branch; cap keeps memory bounded.
 */
export class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.current = null;
  }
  init(snapshot) { this.past = []; this.future = []; this.current = snapshot; }
  push(snapshot) {
    if (snapshot === this.current) return;
    if (this.current !== null) this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = snapshot;
    this.future = [];
  }
  undo() {
    if (!this.past.length) return null;
    this.future.push(this.current);
    this.current = this.past.pop();
    return this.current;
  }
  redo() {
    if (!this.future.length) return null;
    this.past.push(this.current);
    this.current = this.future.pop();
    return this.current;
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}
