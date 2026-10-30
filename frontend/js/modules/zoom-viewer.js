// Shared viewer zoom (2026-10-29, viewers first): Gallery + Library
// lightboxes. The viewers previously had NO zoom state and a swipe
// detector that could not tell a pinch from a swipe — touchstart
// recorded one finger's x, touchend compared it, and any pinch
// finger that moved > 50px navigated. This module owns the gesture
// state machine for both viewers, so the rules are identical:
//
//   - The transform applies ONLY to the image, never to the page
//     or the viewer bar. The bar stays fixed and reachable.
//   - Two fingers down = pinch/pan mode, always. Pinch distance
//     scales the image; two-finger drag pans it. Swipe is
//     suspended while two fingers are down, and a pinch never
//     completes a swipe — the pending swipe is discarded.
//   - One finger, at fit (scale 1): a horizontal drag > 50px
//     with low vertical movement is a swipe, as before, but
//     only for touch/pen pointers — mouse drags never swipe.
//   - One finger, zoomed (scale > 1): drag pans the image.
//     Swipe is disabled until the image returns to fit, so
//     zoomed means "I am looking", not "I am leaving".
//   - While zoomed, nav zones are hidden (viewer gets the
//     .zoomed class; each viewer's CSS hides its navzones
//     under it) and a click on the image does NOT close the
//     viewer — closing on tap is a fit-only behaviour.
//   - Mouse: wheel zooms around the cursor, and the bar's
//     − / ＋ / Fit buttons step/reset. Reset is also what
//     happens when a new image opens (the caller calls
//     reset() from openViewer) and when a pinch returns to
//     ~1×. Double-tap reset is deliberately NOT offered:
//     the viewers close on a tap on the image, so the first
//     tap of a double-tap would close the viewer before
//     the second could reset it. Fit + pinch-back-to-1 are
//     the reset paths.
//   - touch-action: none on the stage, so the browser never
//     page-zooms or scrolls under a pinch; the module does
//     the whole gesture itself via Pointer Events.
//
// Pure helpers (dist, pinchScale, swipeDir, clampPan,
// wheelScale) are exported for node unit tests; the DOM
// binding is bindViewerZoom.

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const SWIPE_PX = 50;

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pinchScale(scale0, d0, d1) {
  if (!d0) return scale0;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale0 * (d1 / d0)));
}

export function swipeDir(dx, dy, scale) {
  if (scale !== 1) return 0;
  if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
    return dx < 0 ? 1 : -1;
  }
  return 0;
}

export function clampPan(tx, ty, stageW, stageH, fitW, fitH, scale) {
  const maxTx = Math.max(0, (fitW * scale - stageW) / 2);
  const maxTy = Math.max(0, (fitH * scale - stageH) / 2);
  return {
    tx: Math.min(maxTx, Math.max(-maxTx, tx)),
    ty: Math.min(maxTy, Math.max(-maxTy, ty)),
  };
}

export function wheelScale(scale, deltaY) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * Math.exp(-deltaY * 0.0015)));
}

export function bindViewerZoom({ stage, img, viewer, onSwipe }) {
  let scale = 1, tx = 0, ty = 0;
  const pointers = new Map();
  let pinch = null;   // { d0, mid0, scale0, tx0, ty0 }
  let swipe = null;   // { x, y } — touch/pen only, at fit only

  function fitSize() {
    const r = stage.getBoundingClientRect();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh || !r.width || !r.height) {
      const ir = img.getBoundingClientRect();
      return [ir.width / Math.max(scale, 1), ir.height / Math.max(scale, 1)];
    }
    const fitW = Math.min(r.width, r.height * (nw / nh));
    const fitH = Math.min(r.height, r.width * (nh / nw));
    return [fitW, fitH];
  }

  function apply() {
    img.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.cursor = scale > 1 ? 'grab' : '';
    viewer.classList.toggle('zoomed', scale > 1);
  }

  function clamp() {
    const r = stage.getBoundingClientRect();
    const [fw, fh] = fitSize();
    const c = clampPan(tx, ty, r.width, r.height, fw, fh, scale);
    tx = c.tx; ty = c.ty;
  }

  function reset() {
    scale = 1; tx = 0; ty = 0;
    pointers.clear(); pinch = null; swipe = null;
    apply();
  }

  function step(factor) {
    const old = scale;
    scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * factor));
    if (scale === 1) { tx = 0; ty = 0; }
    else if (scale !== old) clamp();
    apply();
  }

  stage.style.touchAction = 'none';
  if (img) img.style.touchAction = 'none';

  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size === 2) {
      // Pinch wins: discard any pending swipe, enter pinch mode.
      swipe = null;
      const [a, b] = [...pointers.values()];
      pinch = { d0: dist(a, b), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                scale0: scale, tx0: tx, ty0: ty };
    } else if (pointers.size === 1 && e.pointerType !== 'mouse') {
      swipe = { x: e.clientX, y: e.clientY };
    }
  });

  stage.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      scale = pinchScale(pinch.scale0, pinch.d0, dist(a, b));
      tx = pinch.tx0 + (m.x - pinch.mid0.x);
      ty = pinch.ty0 + (m.y - pinch.mid0.y);
      clamp(); apply();
    } else if (pointers.size === 1 && scale > 1) {
      tx += dx; ty += dy; clamp(); apply();
    }
    // At fit with one finger, no visual pan — the swipe is
    // decided on pointerup, exactly as the old code did.
  });

  function onUp(e) {
    const wasPinch = pointers.size >= 2;
    pointers.delete(e.pointerId);
    if (wasPinch) {
      pinch = null; swipe = null;
      if (pointers.size < 2) {
        if (scale <= 1.05) { scale = 1; tx = 0; ty = 0; }
        else clamp();
        apply();
      }
      return;
    }
    if (swipe && pointers.size === 0) {
      const dir = swipeDir(e.clientX - swipe.x, e.clientY - swipe.y, scale);
      swipe = null;
      if (dir && onSwipe) onSwipe(dir);
    }
  }
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', e => {
    pointers.delete(e.pointerId);
    pinch = null; swipe = null;
    if (pointers.size === 0 && scale <= 1) { scale = 1; tx = 0; ty = 0; apply(); }
  });

  // While zoomed, a click on the image must not close the viewer
  // (that is fit-only behaviour) and a pan must not end as a click.
  // Capture on the stage runs before the image's click handler.
  stage.addEventListener('click', e => {
    if (viewer.classList.contains('zoomed')) e.stopPropagation();
  }, true);

  // Mouse wheel: zoom around the cursor, plain wheel (the viewer
  // stage has nothing to scroll, so there is no page-scroll fight).
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const old = scale;
    const ns = wheelScale(scale, e.deltaY);
    if (ns === old) return;
    const r = stage.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2);
    const cy = e.clientY - (r.top + r.height / 2);
    const k = ns / old;
    tx += cx * (1 - k); ty += cy * (1 - k);
    scale = ns;
    if (scale <= 1) { scale = 1; tx = 0; ty = 0; }
    else clamp();
    apply();
  }, { passive: false });

  // Bar buttons, added to both viewers' bars by the caller.
  const zi = viewer.querySelector('[data-act="viewer-zoom-in"]');
  const zo = viewer.querySelector('[data-act="viewer-zoom-out"]');
  const zf = viewer.querySelector('[data-act="viewer-zoom-fit"]');
  if (zi) zi.addEventListener('click', () => step(1.25));
  if (zo) zo.addEventListener('click', () => step(1 / 1.25));
  if (zf) zf.addEventListener('click', reset);

  return { reset, zoomIn: () => step(1.25), zoomOut: () => step(1 / 1.25),
           get scale() { return scale; } };
}
