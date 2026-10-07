// CanvasStack — shared canvas layer stack for EllieEdit modules.
// Layers (bottom→top): base image → edit layer → pending preview → module
// content (regions etc., via drawContent hook) → interaction overlay.
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

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCanvas.style.borderRadius = '6px';
    this.wrap.appendChild(this.overlayCanvas);
    let octx = null;

    // Offscreen layers
    this.baseData = null;   // ImageData of the base image
    this.editLayer = null;  // canvas, committed repaints
    this.editLayerVisible = true;
    this.pending = null;    // pending-preview state (see pending.js store)
    this.hideContent = false;

    if (opts.cursor) this.canvas.style.cursor = opts.cursor;
    else this.canvas.style.cursor = 'pointer';

    this._attachPointer();
  }

  setSize(w, h) {
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
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
      octx = this.overlayCanvas.getContext('2d', { desynchronized: true });
    }
    this.overlayCanvas.style.left = this.canvas.offsetLeft + 'px';
    this.overlayCanvas.style.top = this.canvas.offsetTop + 'px';
    this.overlayCanvas.style.width = this.canvas.offsetWidth + 'px';
    this.overlayCanvas.style.height = this.canvas.offsetHeight + 'px';
  }

  get overlayCtx() {
    if (!octx) { this.ensureOverlay(); }
    return octx;
  }

  /** Clear the overlay, optionally only a world-space dirty rect. */
  clearOverlay(dirtyWorldRect = null) {
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
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    if (this.baseData) this.ctx.putImageData(this.baseData, 0, 0);

    if (this.editLayerVisible && this.editLayer) this.ctx.drawImage(this.editLayer, 0, 0);

    // Pending preview: its own layer, clipped to its box — never baked until Keep.
    const p = this.pending;
    if (p && p.vsel >= 0) {
      if (p.maskCanvas) {
        drawMaskedSource(this.ctx, p.variants[p.vsel], p);
        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(232, 122, 208, 0.9)';
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([8, 5]);
        this.ctx.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2);
        this.ctx.restore();
      } else {
        drawFeatheredSource(this.ctx, p.variants[p.vsel], p);
        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(125, 224, 138, 0.9)';
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([8, 5]);
        this.ctx.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2);
        this.ctx.restore();
      }
    }

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
          // Coalesced pen samples: strokes get every sample, not just frame-rate samples.
          const evts = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
          const pts = evts.map(ce => this.eventToWorld(ce));
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
