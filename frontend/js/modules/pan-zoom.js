// Shared pan/zoom component (2026-11-11, Chunk C foundation): one gesture
// machine any image stage can bind, plus the mirrored-pair math the Ladder
// needs. Pure helpers are node-testable; bindPanZoom is the DOM binding.
//
//   - Pointer events only: mouse drag pans (when zoomed), touch drag pans,
//     two pointers pinch-zoom and pinch-pan. Trackpad pinch and ctrl+scroll
//     arrive as wheel events with ctrlKey — the wheel handler zooms for both,
//     to the cursor.
//   - Transforms are CSS translate+scale on the element the caller chooses,
//     so arbitrary-sized images work: fit size is computed per frame from
//     natural dims and the stage box (contain), never stored.
//   - The caller owns the view object { scale, tx, ty } and an apply()
//     callback; the binder only mutates the view through pure helpers and
//     calls apply(). A gate() hook lets hosts refuse gestures (e.g. while
//     painting a mask), and onPinchStart lets them cancel in-flight drags.
//
// Mirroring (Ladder): two images with different dimensions track the same
// RELATIVE viewport. Both share the zoom factor and the viewport centre in
// normalized image coords. viewCenter()/viewTranslate() convert between a
// local transform and that shared representation; mirrorView() derives the
// second image's transform from the first's.

import { dist, pinchScale, clampPan, wheelScale } from './zoom-viewer.js';

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;

// ---- pure transform helpers ------------------------------------------------

// Centre of the visible viewport in normalized image coords (0..1), given the
// fit box (fitW×fitH) and the local transform. Derivation: a point p (0..1)
// sits at screen x = centreX + (p - 0.5) * fitW * scale + tx, so the screen
// centre shows p = 0.5 - tx / (fitW * scale).
export function viewCenter(fitW, fitH, scale, tx, ty) {
  const s = Math.max(scale, 1e-6);
  return {
    cx: 0.5 - tx / (fitW * s),
    cy: 0.5 - ty / (fitH * s),
  };
}

// Inverse: local translate that puts normalized centre (cx, cy) at the
// viewport centre for the given fit box and scale.
export function viewTranslate(fitW, fitH, scale, cx, cy) {
  return {
    tx: (0.5 - cx) * fitW * scale,
    ty: (0.5 - cy) * fitH * scale,
  };
}

// Mirrored pair: given image A's full view (fitW, fitH, scale, tx, ty) and
// image B's fit box + its own current scale, return B's translate so both
// show the same relative area. B adopts A's zoom; the centre is shared, and
// each side's fit box already contains its own aspect ratio, so different
// image dimensions track the same relative viewport by construction.
export function mirrorView(src, dst) {
  const { cx, cy } = viewCenter(src.fitW, src.fitH, src.scale, src.tx, src.ty);
  const scale = src.scale;
  const { tx, ty } = viewTranslate(dst.fitW, dst.fitH, scale, cx, cy);
  const c = clampPan(tx, ty, dst.stageW, dst.stageH, dst.fitW, dst.fitH, scale);
  return { scale, tx: c.tx, ty: c.ty };
}

// Clamp a local view against the stage and fit boxes.
export function clampView(view, stageW, stageH, fitW, fitH) {
  const c = clampPan(view.tx, view.ty, stageW, stageH, fitW, fitH, view.scale);
  return { ...view, tx: c.tx, ty: c.ty };
}

// Wheel/trackpad zoom about a cursor point expressed relative to the viewport
// centre (clientX - centreX). Keeps the point under the cursor fixed.
export function zoomAt(view, relX, relY, newScale, stageW, stageH, fitW, fitH) {
  let v = { ...view, scale: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newScale)) };
  if (v.scale <= ZOOM_MIN) return { scale: ZOOM_MIN, tx: 0, ty: 0 };
  const k = v.scale / view.scale;
  v.tx += relX * (1 - k);
  v.ty += relY * (1 - k);
  return clampView(v, stageW, stageH, fitW, fitH);
}

export function panBy(view, dx, dy, stageW, stageH, fitW, fitH) {
  return clampView({ ...view, tx: view.tx + dx, ty: view.ty + dy },
    stageW, stageH, fitW, fitH);
}

export function pinchTo(view, d0, d1, midDx, midDy, stageW, stageH, fitW, fitH) {
  const scale = pinchScale(view.scale, d0, d1);
  const v = { ...view, scale, tx: view.tx + midDx, ty: view.ty + midDy };
  if (scale <= ZOOM_MIN) return { scale: ZOOM_MIN, tx: 0, ty: 0 };
  return clampView(v, stageW, stageH, fitW, fitH);
}

// ---- fit geometry ----------------------------------------------------------

// Contain-fit box for natural image dims inside a stage box.
export function fitBox(natW, natH, stageW, stageH) {
  if (!natW || !natH || !stageW || !stageH) return null;
  const s = Math.min(stageW / natW, stageH / natH);
  return { fitW: natW * s, fitH: natH * s };
}

// ---- DOM binding -----------------------------------------------------------

// bindPanZoom({ stage, getView, setView, gate, onPinchStart, onEnd })
//   stage       element receiving pointer/wheel events (set touch-action:none).
//   getView()   current { scale, tx, ty }.
//   setView(v)  store + render the new view (caller applies CSS transform).
//   gate()      optional; return false to ignore this gesture entirely.
//   onPinchStart() optional; called when a second pointer lands (host may
//               cancel in-flight drags/strokes before pinching).
//   onEnd()     optional; called when all pointers leave.
// Wheel zoom-to-cursor is always bound (a zoom stage has nothing to scroll);
// ctrl+wheel (trackpad pinch) is included because the handler zooms on any
// wheel over the stage.
export function bindPanZoom({ stage, getView, setView, gate, onPinchStart, onEnd }) {
  stage.style.touchAction = 'none';
  const pointers = new Map();
  let pinch = null; // { d0, mid0 } — gesture-relative, applied to start view

  function geom() {
    const r = stage.getBoundingClientRect();
    const img = stage.querySelector('img');
    const natW = img && img.naturalWidth, natH = img && img.naturalHeight;
    const fit = fitBox(natW, natH, r.width, r.height);
    return { r, fit };
  }

  stage.addEventListener('pointerdown', e => {
    if (gate && !gate()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size >= 2) {
      if (onPinchStart) onPinchStart();
      const [a, b] = [...pointers.values()];
      pinch = { d0: dist(a, b), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                start: getView() };
    }
  });

  stage.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    const { r, fit } = geom();
    if (!fit) return;
    const v = getView();
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setView(pinchTo(pinch.start, pinch.d0, dist(a, b),
        m.x - pinch.mid0.x, m.y - pinch.mid0.y, r.width, r.height, fit.fitW, fit.fitH));
    } else if (pointers.size === 1 && v.scale > 1) {
      setView(panBy(v, dx, dy, r.width, r.height, fit.fitW, fit.fitH));
    }
  });

  const up = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      pinch = null;
      const v = getView();
      // Settle: a pinch that ended near fit snaps to exact fit.
      if (pointers.size === 0 && v.scale > ZOOM_MIN && v.scale <= 1.05) {
        setView({ scale: ZOOM_MIN, tx: 0, ty: 0 });
      }
      if (pointers.size === 0 && onEnd) onEnd();
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  stage.addEventListener('wheel', e => {
    if (gate && !gate()) return;
    e.preventDefault();
    const { r, fit } = geom();
    if (!fit) return;
    const v = getView();
    const ns = wheelScale(v.scale, e.deltaY);
    if (ns === v.scale) return;
    setView(zoomAt(v, e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2),
      ns, r.width, r.height, fit.fitW, fit.fitH));
  }, { passive: false });

  return {
    release() {
      pointers.clear(); pinch = null;
    },
    get active() { return pointers.size > 0; },
  };
}
