// PendingPreview — shared Keep/Discard/Undo model (suite-wide interaction
// contract, promoted from FaceCycle-internal). State machine:
//   begin(win, opts) → variants arrive via addVariant → user cycles →
//   keep() bakes into the CanvasStack edit layer (with undo snapshot)
//   or discard() drops it. Deleting/redrawing boxes never touches it.

import { drawFeatheredSource, drawMaskedSource } from './canvas-stack.js';

export class PendingPreview {
  constructor(stack, onChange = () => {}) {
    this.stack = stack;
    this.onChange = onChange;
    this.keepHistory = []; // edit-layer snapshots (max 10) for Undo of Keep
  }

  begin(win, { maskCanvas = null, variantCount = 1 } = {}) {
    this.stack.pending = {
      x: win.x, y: win.y, w: win.w, h: win.h,
      maskCanvas,
      variants: [], vsel: -1, generating: variantCount,
    };
    this.onChange();
  }

  get current() { return this.stack.pending; }

  addVariant(canvas) {
    const p = this.stack.pending;
    if (!p) return; // discarded/replaced mid-flight; drop it
    p.variants.push(canvas);
    p.vsel = p.variants.length - 1;
    this.onChange();
  }

  cycle(dir) {
    const p = this.stack.pending;
    if (!p || p.variants.length === 0) return false;
    p.vsel = ((p.vsel + dir) % p.variants.length + p.variants.length) % p.variants.length;
    this.onChange();
    return true;
  }

  keep() {
    const p = this.stack.pending;
    if (!p || p.vsel < 0) return false;
    const stack = this.stack;
    stack.ensureEditLayer();
    const snap = document.createElement('canvas');
    snap.width = stack.width; snap.height = stack.height;
    snap.getContext('2d').drawImage(stack.editLayer, 0, 0);
    this.keepHistory.push(snap);
    if (this.keepHistory.length > 10) this.keepHistory.shift();
    const ectx = stack.editLayer.getContext('2d');
    if (p.maskCanvas) drawMaskedSource(ectx, p.variants[p.vsel], p);
    else drawFeatheredSource(ectx, p.variants[p.vsel], p);
    stack.pending = null;
    this.onChange();
    return true;
  }

  discard() {
    if (!this.stack.pending) return false;
    this.stack.pending = null;
    this.onChange();
    return true;
  }

  undo() {
    const snap = this.keepHistory.pop();
    if (!snap) return false;
    const stack = this.stack;
    stack.ensureEditLayer();
    const ectx = stack.editLayer.getContext('2d');
    ectx.clearRect(0, 0, stack.width, stack.height);
    ectx.drawImage(snap, 0, 0);
    this.onChange();
    return true;
  }

  get canUndo() { return this.keepHistory.length > 0; }

  reset() {
    this.stack.pending = null;
    this.keepHistory = [];
    this.onChange();
  }
}
