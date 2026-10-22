// Meld divergence-mask pre-seed (Increment 1 of the Meld integration).
// Contract: /home/zengonzo/workspace/meld/SALVAGE.md §3 — the /api/diff
// algorithm, ported client-side. Ported exactly: gray float32 both images,
// diff = GaussianBlur(|ga − gb|, (0,0), sigma=2), threshold
// diff > max(8.0, 6·MAD) with MAD = median(diff) + 1e-6 (the 8.0 floor is
// absolute — below it, noise on clean images triggers everywhere; the 6×MAD
// term adapts to noisy folders), then one 9×9 dilate pass to close hairline
// gaps. Thresholds (σ=2, 8.0, 6×MAD, 9×9) are the only tuning surface.

/** ITU-R BT.601 luma on 0..255 float32, per pixel. */
export function toGray(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

// OpenCV getGaussianKernel auto-size for ksize=(0,0): the kernel length is
// round((sigma − 0.8)/0.3 + 1) ×2 |1 → 11 taps at σ=2. Same normalised
// symmetric kernel OpenCV's GaussianBlur builds, applied separably.
export function gaussianKernel1D(sigma) {
  const ksize = Math.round(((sigma - 0.8) / 0.3 + 1)) * 2 + 1;
  const k = new Float32Array(ksize);
  const r = (ksize - 1) / 2;
  let sum = 0;
  for (let i = 0; i < ksize; i++) {
    const x = i - r;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < ksize; i++) k[i] /= sum;
  return k;
}

function convolve1D(src, dst, w, h, kernel, horizontal) {
  const r = (kernel.length - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let sx = x, sy = y;
        if (horizontal) sx = Math.min(w - 1, Math.max(0, x + i));
        else sy = Math.min(h - 1, Math.max(0, y + i));
        acc += src[sy * w + sx] * kernel[i + r];
      }
      dst[y * w + x] = acc;
    }
  }
}

/** Separable Gaussian blur, σ pixels, OpenCV border replication. */
export function gaussianBlur(src, w, h, sigma) {
  const k = gaussianKernel1D(sigma);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  convolve1D(src, tmp, w, h, k, true);
  convolve1D(tmp, out, w, h, k, false);
  return out;
}

/** Exact median of a Float32Array (sorts a copy; leaves the input alone). */
export function median(arr) {
  const s = Float32Array.from(arr).sort();
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// 9×9 square dilate == separable max filter (run 9-wide horizontal max, then
// 9-tall vertical max) — identical result to the single cv2.dilate pass.
function dilate9x9(mask, w, h) {
  const R = 4;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let i = -R; i <= R && !m; i++) {
        const sx = Math.min(w - 1, Math.max(0, x + i));
        m = mask[y * w + sx];
      }
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let i = -R; i <= R && !m; i++) {
        const sy = Math.min(h - 1, Math.max(0, y + i));
        m = tmp[sy * w + x];
      }
      mask[y * w + x] = m;
    }
  }
}

/**
 * Divergence suggestion mask between two same-size ImageData buffers.
 * Returns { mask: Uint8Array (0/255, 255 = the twins disagree), count }.
 * Both inputs must already share the working space (FaceCycle normalizes
 * every loaded image to state.width×state.height — C1's "work where the
 * preview is").
 */
export function divergenceMask(dataA, dataB, w, h) {
  const ga = toGray(dataA.data ?? dataA, w, h);
  const gb = toGray(dataB.data ?? dataB, w, h);
  const diff = new Float32Array(w * h);
  for (let i = 0; i < diff.length; i++) diff[i] = Math.abs(ga[i] - gb[i]);
  const blurred = gaussianBlur(diff, w, h, 2);
  const mad = median(blurred) + 1e-6;
  const thr = Math.max(8.0, 6 * mad);
  const mask = new Uint8Array(w * h);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (blurred[i] > thr) { mask[i] = 255; count++; }
  }
  dilate9x9(mask, w, h);
  return { mask, count };
}
