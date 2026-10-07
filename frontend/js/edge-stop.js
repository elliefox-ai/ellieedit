// Edge-stopped containment for rect-mask feathering.
// Ported from Meld (~/workspace/meld, meld.py: compute_edge + api_save blend path).
// Core algorithm, faithful to Meld:
//   1. Edge map: grayscale → Gaussian pre-blur (sigma = max(2, minDim/100)) →
//      Sobel magnitude → 90th-percentile normalize → clip [0,1] → gamma 0.7 →
//      Gaussian smooth (sigma 1.2) → dilate 5x5.
//   2. Cap: cap = 1 - edge * estop; mask = mask * cap; THEN feather-blur.
//      Cap BEFORE blur — same order as Meld's save path.
// Pure functions only (no DOM) so the mask math is unit-testable in node.

// ── separable Gaussian blur (Float32, in place on a copy) ──
function gaussianBlur(src, w, h, sigma) {
  if (sigma <= 0) return src.slice();
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v; sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        a += src[y * w + xx] * k[i + r];
      }
      tmp[y * w + x] = a;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        a += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = a;
    }
  return out;
}

// ── 5x5 max dilate (Meld uses cv2.dilate with 5x5 ones) ──
function dilate5(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -2; dy <= 2 && m < 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const v = src[yy * w + xx];
          if (v > m) m = v;
          if (m >= 1) break;
        }
      }
      out[y * w + x] = m;
    }
  return out;
}

function percentile(arr, p) {
  const s = arr.slice().sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

const EDGE_BLUR_FRAC = 1 / 100;   // Meld: pre-blur sigma as fraction of shorter side

// computeEdgeMap(rgba, w, h) → Float32Array edge map in [0,1], white = strong edge.
// rgba: Uint8ClampedArray RGBA pixel data of the BASE image (A).
export function computeEdgeMap(rgba, w, h) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const sigma = Math.max(2.0, Math.min(w, h) * EDGE_BLUR_FRAC);
  const g = gaussianBlur(gray, w, h, sigma);
  // Sobel magnitude
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] +
        g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy =
        -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] +
        g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  const hi = percentile(mag, 90) + 1e-6;
  for (let i = 0; i < w * h; i++)
    mag[i] = Math.pow(Math.min(1, mag[i] / hi), 0.7);
  return dilate5(gaussianBlur(mag, w, h, 1.2), w, h);
}

// applyEdgeStop(mask, edge, estop) → new Float32Array: mask * (1 - edge*estop).
// Cap BEFORE feather, per Meld's save path. estop in [0,1]; 0 = no containment.
export function applyEdgeStop(mask, edge, estop) {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++)
    out[i] = mask[i] * (1 - edge[i] * estop);
  return out;
}

// Build the final feathered rect mask with containment, operating on an
// offscreen-canvas-shaped Float mask. Returns Float32Array alpha per pixel.
// full pipeline: hard rect → cap → blur (Meld's order).
export function buildRectMask(w, h, rect, edge, estop, feather) {
  const mask = new Float32Array(w * h);
  const x0 = Math.round(rect.x + feather), y0 = Math.round(rect.y + feather);
  const x1 = Math.round(rect.x + rect.w - feather), y1 = Math.round(rect.y + rect.h - feather);
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++)
      mask[y * w + x] = 1;
  const capped = applyEdgeStop(mask, edge, estop);
  return gaussianBlur(capped, w, h, feather);
}

export { gaussianBlur, dilate5, percentile };
