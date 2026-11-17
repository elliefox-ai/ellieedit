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
//     scales the image; two-finger drag pans it. A pinch finger
//     may start on a nav zone: pointers are tracked at the viewer
//     root (stage + nav zones + bar), so the pinch forms wherever
//     the fingers land. Before 2026-11-16 the binder listened on
//     the stage only, so a pinch starting near the edge put one
//     finger on a nav zone, the stage saw a single finger, and its
//     horizontal travel read as a swipe on release — the image
//     cycled instead of zooming.
//   - NO SWIPE (2026-11-16): no drag ever changes images. Cycling
//     is only by tap/click — the nav zones, the prev/next controls,
//     or the keyboard arrows. One finger at fit: a drag does
//     nothing; one finger zoomed: a drag pans the image.
//   - Pointer capture happens only once a gesture is a pinch or a
//     pan, and only for pointers that started on the stage — a tap
//     never captures, so it still clicks its nav zone or button.
//   - While zoomed, nav zones are hidden (viewer gets the
//     .zoomed class; each viewer's CSS hides its navzones
//     under it) and a click on the image does NOT close the
//     viewer — closing on tap is a fit-only behaviour.
//   - Mouse: wheel zooms around the cursor, and the bar's
//     − / ＋ / Fit buttons step/reset. Reset is also what
//     happens when a new image opens (the caller calls
//     reset() from openViewer) and when a pinch returns to
//     ~1×.
//   - Double-tap reset, WHILE ZOOMED ONLY (2026-10-29 stuck-
//     zoom fix): at fit, the viewers close on an image tap,
//     so double-tap there would close on the first tap —
//     correctly not offered. While zoomed, tap-to-close is
//     already disabled, so a double-tap is safe, and it is
//     the escape hatch when the bar (with Fit) is unreachable
//     for any reason. The click that follows the second tap
//     is suppressed (suppressClickUntil), so a double-tap
//     reset does not reset and then close.
//   - touch-action: none on the WHOLE VIEWER (2026-10-29
//     stuck-zoom fix), not just the stage. The original code
//     set it only on stage + image, but the nav zones cover
//     30% each side of the stage and the bar covers the top,
//     so a pinch starting on either let the browser page-zoom
//     at the same time as the image zoomed — and once the
//     page is zoomed, the bar holding Fit/close can be panned
//     off-screen, leaving refresh as the only escape. With
//     none on the viewer root, any gesture starting inside
//     the viewer is the app's, never the browser's. Taps
//     still work; only gestures are blocked.
//
// Pure helpers (dist, pinchScale, clampPan, wheelScale) are
// exported for node unit tests; the DOM binding is bindViewerZoom.

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pinchScale(scale0, d0, d1) {
  if (!d0) return scale0;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale0 * (d1 / d0)));
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

export function bindViewerZoom({ stage, img, viewer }) {
  let scale = 1, tx = 0, ty = 0;
  const pointers = new Map();
  let pinch = null;   // { d0, mid0, scale0, tx0, ty0 }

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
    pointers.clear(); pinch = null;
    // A tap on the previous image must not pair with a tap on
    // the next one as a double-tap. (reset() is only called
    // after binding completes, so these are initialized.)
    lastTap = null; tapStart = null;
    apply();
  }

  function step(factor) {
    const old = scale;
    scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * factor));
    if (scale === 1) { tx = 0; ty = 0; }
    else if (scale !== old) clamp();
    apply();
  }

  // Viewer-root touch-action (stuck-zoom fix): the CSS in both
  // viewers also sets this, but the binder sets it too, so the
  // guarantee does not depend on a stylesheet landing.
  viewer.style.touchAction = 'none';
  stage.style.touchAction = 'none';
  if (img) img.style.touchAction = 'none';

  // Double-tap reset state (while zoomed only, see header).
  let lastTap = null, tapStart = null, suppressClickUntil = 0;

  // Pointer tracking lives on the VIEWER root, not the stage: the nav
  // zones cover 30% of each side, and a pinch finger starting on one
  // must still join the pinch (see header). Events bubble from every
  // descendant, so no capture is needed while fingers stay inside the
  // viewer. Capture happens only once a gesture is a pinch or a pan,
  // and only for pointers that started on the stage — a tap never
  // captures, so it still clicks its nav zone or button.
  viewer.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY,
      onStage: e.target === stage || stage.contains(e.target) });
    if (pointers.size === 2) {
      // Pinch wins, wherever the fingers landed.
      tapStart = null;
      const [a, b] = [...pointers.values()];
      pinch = { d0: dist(a, b), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                scale0: scale, tx0: tx, ty0: ty };
      for (const [id, p] of pointers) {
        if (p.onStage) { try { viewer.setPointerCapture(id); } catch (_) {} }
      }
    } else if (pointers.size === 1 && e.pointerType !== 'mouse') {
      tapStart = { x: e.clientX, y: e.clientY };
    }
  });

  viewer.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 25) {
      tapStart = null;  // moved too far to be a tap
    }
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      scale = pinchScale(pinch.scale0, pinch.d0, dist(a, b));
      tx = pinch.tx0 + (m.x - pinch.mid0.x);
      ty = pinch.ty0 + (m.y - pinch.mid0.y);
      clamp(); apply();
    } else if (pointers.size === 1 && scale > 1 && p.onStage) {
      // First pan move: capture so the pan keeps tracking past the
      // viewer's edge. A tap never moves, so it never captures; a
      // drag starting on a bar button is a click attempt, not a pan.
      try { viewer.setPointerCapture(e.pointerId); } catch (_) {}
      tx += dx; ty += dy; clamp(); apply();
    }
    // At fit with one finger, a drag does nothing — no swipe, ever.
  });

  function onUp(e) {
    const wasPinch = pointers.size >= 2;
    pointers.delete(e.pointerId);
    if (wasPinch) {
      pinch = null; tapStart = null;
      if (pointers.size < 2) {
        if (scale <= 1.05) { scale = 1; tx = 0; ty = 0; }
        else clamp();
        apply();
      }
      return;
    }
    // Double-tap reset, while zoomed only: a tap here cannot
    // close the viewer (click-to-close is disabled while
    // zoomed), so two quick taps in place reset to fit. At fit
    // this branch never runs (scale is 1), so the first tap's
    // close behaviour at fit is untouched.
    if (tapStart && scale > 1 && pointers.size === 0) {
      const now = Date.now();
      if (lastTap && now - lastTap.t < 350 &&
          Math.hypot(tapStart.x - lastTap.x, tapStart.y - lastTap.y) < 25) {
        lastTap = null; tapStart = null;
        reset();
        // The click following this second tap would otherwise
        // close the viewer now that zoomed is gone — suppress it.
        suppressClickUntil = now + 600;
        return;
      }
      lastTap = { t: now, x: tapStart.x, y: tapStart.y };
    }
    tapStart = null;
    // No swipe: a drag never changes images. Cycling is tap/click
    // on the nav zones or buttons, or the keyboard arrows.
  }
  viewer.addEventListener('pointerup', onUp);
  viewer.addEventListener('pointercancel', e => {
    pointers.delete(e.pointerId);
    pinch = null; tapStart = null;
    if (pointers.size === 0 && scale <= 1) { scale = 1; tx = 0; ty = 0; apply(); }
  });

  // While zoomed, a click on the image must not close the viewer
  // (that is fit-only behaviour) and a pan must not end as a click.
  // Capture on the stage runs before the image's click handler.
  // Also suppress the click after a double-tap reset, which
  // arrives after zoomed has already been removed.
  stage.addEventListener('click', e => {
    if (viewer.classList.contains('zoomed') || Date.now() < suppressClickUntil) {
      e.stopPropagation();
    }
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
