// CanvasStack — shared canvas layer stack for EllieEdit modules.
// Layers (bottom→top): base image → edit layer → module region-state content
// (via drawUnder hook) → module overlays (via drawContent hook) → interaction
// overlay.
//
// The overlay is a display-resolution canvas: during strokes/drags only it is
// touched (coalesced pointer events + dirty-rect clearing per facecycle commit
// 18cb4e3); the full stack redraws once on commit (pointerup).

export class CanvasStack {
  /**
   * @param {HTMLElement} container element to host the canvases
   * @param {object} opts { onPointerDown/Move/Up(e, pt), drawContent(ctx, opts), cursor }
   *   pt = {x, y} in world (source-image) coordinates.
   */
  constructor(container, opts = {}) {
    this.opts = opts;
    this.width = 0;
    this.height = 0;
    this.zoom = 1;          // 1 = fit (default); 0.25..3 scales both canvases in lockstep

    this.wrap = document.createElement('div');
    this.wrap.style.position = 'relative';
    this.wrap.style.display = 'inline-block';
    container.appendChild(this.wrap);

    this.canvas = document.createElement('canvas');
    this.canvas.style.touchAction = 'none';
    this.canvas.style.maxWidth = '100%';
    this.canvas.style.maxHeight = '100%';
    this.canvas.style.borderRadius = '6px';
    this.canvas.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5)';
    this.canvas.style.display = 'block';
    this.ctx = this.canvas.getContext('2d', { desynchronized: true });
    this.wrap.appendChild(this.canvas);

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCanvas.style.borderRadius = '6px';
    this.wrap.appendChild(this.overlayCanvas);
    this._octx = null;

    // Offscreen layers
    this.baseData = null;   // ImageData of the base image
    this.editLayer = null;  // canvas, committed repaints
    this.editLayerVisible = true;
    this.hideContent = false;

    if (opts.cursor) this.canvas.style.cursor = opts.cursor;
    else this.canvas.style.cursor = 'pointer';

    this._attachPointer();
  }

  setSize(w, h) {
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
    this._applyZoom();
  }

  /** Zoom: 1 = fit (max-100% behavior, the default), 0.25..3 of the fit size
   *  (below 1 SHRINKS the working image for overview/margin).
   *  Drives explicit CSS px width/height on the canvas (NOT transform:scale —
   *  transforms don't grow scrollable overflow, so panning would break). The
   *  overlay is re-synced to the canvas's laid-out box right after, so both
   *  canvases always share one computed CSS size; eventToWorld() normalizes by
   *  canvas.width / rect.width and is therefore zoom-invariant. */
  setZoom(z) {
    this.zoom = Math.min(3, Math.max(0.25, Number(z) || 1));
    this._applyZoom();
    return this.zoom;
  }

  _applyZoom() {
    const cv = this.canvas, st = cv.style;
    // Always measure the FIT size first (clear any explicit size).
    st.width = ''; st.height = '';
    st.maxWidth = '100%'; st.maxHeight = '100%';
    if (this.zoom !== 1 && this.width) {
      const fw = cv.offsetWidth, fh = cv.offsetHeight;
      if (fw && fh) {
        st.maxWidth = 'none'; st.maxHeight = 'none';
        st.width = (fw * this.zoom) + 'px';
        st.height = (fh * this.zoom) + 'px';
      }
    }
    if (this.width) this.ensureOverlay();
  }

  setCursor(c) { this.canvas.style.cursor = c; }

  ensureEditLayer() {
    if (!this.editLayer || this.editLayer.width !== this.width || this.editLayer.height !== this.height) {
      const c = document.createElement('canvas');
      c.width = this.width; c.height = this.height;
      this.editLayer = c;
    }
  }

  // ── Overlay (display-resolution interaction layer) ──
  ensureOverlay() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.overlayCanvas.width !== w || this.overlayCanvas.height !== h) {
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
      this._octx = this.overlayCanvas.getContext('2d', { desynchronized: true });
    }
    this.overlayCanvas.style.left = this.canvas.offsetLeft + 'px';
    this.overlayCanvas.style.top = this.canvas.offsetTop + 'px';
    this.overlayCanvas.style.width = this.canvas.offsetWidth + 'px';
    this.overlayCanvas.style.height = this.canvas.offsetHeight + 'px';
  }

  get overlayCtx() {
    if (!this._octx) { this.ensureOverlay(); }
    return this._octx;
  }

  /** Clear the overlay, optionally only a world-space dirty rect. */
  clearOverlay(dirtyWorldRect = null) {
    const octx = this._octx;
    if (!octx) return;
    if (!dirtyWorldRect) {
      octx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      return;
    }
    const sx = this.overlayCanvas.width / this.width;
    const sy = this.overlayCanvas.height / this.height;
    const r = dirtyWorldRect;
    const pad = 4;
    octx.clearRect(
      (r.x - pad) * sx, (r.y - pad) * sy,
      (r.w + pad * 2) * sx, (r.h + pad * 2) * sy);
  }

  worldToDisplay(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = rect.width / this.width, sy = rect.height / this.height;
    return { x: x * sx, y: y * sy, sx, sy };
  }

  eventToWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  // ── Full stack render ──
  render(opts = {}) {
    // zoom couldn't be applied while hidden (offsetWidth 0) — retry once visible
    if (this.zoom !== 1 && !this.canvas.style.width) this._applyZoom();
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    if (this.baseData) this.ctx.putImageData(this.baseData, 0, 0);

    if (this.editLayerVisible && this.editLayer) this.ctx.drawImage(this.editLayer, 0, 0);

    if (this.opts.drawUnder && !this.hideContent) this.opts.drawUnder(this.ctx, opts);

    if (this.opts.drawContent && !this.hideContent) this.opts.drawContent(this.ctx, opts);
    if (this.baseData) this.ensureOverlay();
  }

  // ── Pointer input: coalesced events + rAF throttle ──
  _attachPointer() {
    const cv = this.canvas;
    let pendingMove = null, moveRaf = false;

    cv.addEventListener('pointerdown', e => {
      if (!e.isPrimary) return; // second touch = pinch, ignore over canvas
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      if (this.opts.onPointerDown) this.opts.onPointerDown(e, this.eventToWorld(e));
    });

    cv.addEventListener('pointermove', e => {
      pendingMove = e;
      if (moveRaf) return;
      moveRaf = true;
      requestAnimationFrame(() => {
        moveRaf = false;
        const ev = pendingMove;
        pendingMove = null;
        if (!ev || !ev.isPrimary) return;
        if (this.opts.onPointerMove) {
          // Coalesced samples give strokes every sub-frame sample — but Chromium
          // sometimes returns coalesced events with clientX/clientY = 0 (observed
          // 2026-10-15: drags yanked to the canvas origin on desktop mouse).
          // Drop zero-coordinate samples and always append the real event last,
          // so the drag's final position is the browser's actual pointer spot.
          const ce = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
          const evts = ce.filter(s => s.clientX !== 0 || s.clientY !== 0);
          evts.push(ev);
          const pts = evts.map(sample => this.eventToWorld(sample));
          this.opts.onPointerMove(ev, pts);
        }
      });
    });

    cv.addEventListener('pointerup', e => {
      if (!e.isPrimary) return;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) {}
      if (this.opts.onPointerUp) this.opts.onPointerUp(e, this.eventToWorld(e));
    });

    cv.addEventListener('pointerenter', () => { if (this.opts.onPointerEnter) this.opts.onPointerEnter(); });
    cv.addEventListener('pointerleave', () => { if (this.opts.onPointerLeave) this.opts.onPointerLeave(); });
    cv.addEventListener('pointercancel', e => { if (this.opts.onPointerCancel) this.opts.onPointerCancel(e); });
    cv.addEventListener('contextmenu', e => e.preventDefault());
  }
}

// ── Compositing helpers (ported from facecycle index.html) ──

// Feathered composite of a full-size source canvas into a region.
export function drawFeatheredSource(targetCtx, sourceCanvas, region) {
  const fw = Math.round(region.w);
  const fh = Math.round(region.h);
  const feather = Math.min(18, Math.min(fw, fh) / 3.5);

  const tmp = document.createElement('canvas');
  tmp.width = fw; tmp.height = fh;
  const tctx = tmp.getContext('2d');

  tctx.drawImage(sourceCanvas, -Math.round(region.x), -Math.round(region.y));

  tctx.globalCompositeOperation = 'destination-in';
  const grad = tctx.createLinearGradient(0, 0, fw, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(Math.min(0.3, feather / fw), 'rgba(0,0,0,1)');
  grad.addColorStop(Math.max(0.7, 1 - feather / fw), 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, fw, fh);

  const gradV = tctx.createLinearGradient(0, 0, 0, fh);
  gradV.addColorStop(0, 'rgba(0,0,0,0)');
  gradV.addColorStop(Math.min(0.3, feather / fh), 'rgba(0,0,0,1)');
  gradV.addColorStop(Math.max(0.7, 1 - feather / fh), 'rgba(0,0,0,1)');
  gradV.addColorStop(1, 'rgba(0,0,0,0)');
  tctx.fillStyle = gradV;
  tctx.fillRect(0, 0, fw, fh);

  tctx.globalCompositeOperation = 'source-over';
  targetCtx.drawImage(tmp, region.x, region.y);
}

// Clip a source to the painted-mask shape (feathered by the brush strokes).
export function drawMaskedSource(targetCtx, sourceCanvas, p) {
  const fw = Math.round(p.w);
  const fh = Math.round(p.h);
  const tmp = document.createElement('canvas');
  tmp.width = fw; tmp.height = fh;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(sourceCanvas, -Math.round(p.x), -Math.round(p.y));
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(p.maskCanvas, 0, 0);
  tctx.globalCompositeOperation = 'source-over';
  targetCtx.drawImage(tmp, p.x, p.y);
}
