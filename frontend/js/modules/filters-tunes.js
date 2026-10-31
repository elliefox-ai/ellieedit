// Filters tab — tier-2 per-pixel tunes, client-side canvas.
//
// Pure functions over [r, g, b] triples in [0, 1], no DOM, so they are
// node-testable (tests/js/filters-tunes.test.mjs). The HSV convention
// is the SAME one the backend uses (backend/colorhold.py, from the
// colorhold package's hand-written numpy HSV): float [0, 1], hue 0-1.
// Keeping one convention everywhere is what makes a tune mean the same
// thing on both sides of the tab.
//
// Tunes, each with its own minimal slider, all composed under the ONE
// universal strength (see applyStrength / the tab module):
//   saturation:  s' = clamp(s * satMul)          (satMul 0..2, 1 = identity)
//   brightness:  v' = clamp(v + brightness)      (brightness -0.5..0.5)
//   contrast:    v' = clamp((v - 0.5) * contrast + 0.5)  (contrast 0..2, 1 = identity)
//   value curve: v' = valueCurve(v) — identity above `edge`, and below
//     it a quadratic ease-in from `lift` at black up to `edge` at the
//     edge: lift + (edge - lift) * (v / edge)^2. With lift = 0 the curve
//     is the identity at the edge and darkens below it; with lift > 0
//     blacks are lifted to `lift` instead of crushed to 0. lift and
//     edge are both 0 by default (curve off).
// Order (fixed, documented): saturation, then brightness/contrast on
// value, then the value curve last — the curve is the final word on
// the black point, so it must not be undone by a later brightness step.

export function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
  const v = mx;
  const s = mx > 0 ? df / mx : 0;
  let h = 0;
  if (df !== 0) {
    if (mx === r) h = ((g - b) / df) % 6;
    else if (mx === g) h = (b - r) / df + 2;
    else h = (r - g) / df + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, s, v];
}

export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const table = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]];
  return table[((i % 6) + 6) % 6];
}

const clamp01 = x => Math.min(1, Math.max(0, x));

export function liftBlacks(v, lift, edge) {
  if (!lift && !edge) return v;
  if (v >= edge) return v;
  if (edge <= 0) return v;
  const t = v / edge;
  return lift + (edge - lift) * t * t;
}

export function tunePixel(r, g, b, tune) {
  const t = tune || {};
  let [h, s, v] = rgbToHsv(r, g, b);
  if (t.satMul !== undefined) s = clamp01(s * t.satMul);
  if (t.brightness) v = clamp01(v + t.brightness);
  if (t.contrast !== undefined) v = clamp01((v - 0.5) * t.contrast + 0.5);
  v = liftBlacks(v, t.lift || 0, t.edge || 0);
  return hsvToRgb(h, s, clamp01(v));
}

// Apply a tune to an ImageData-like { data: Uint8ClampedArray } in place.
export function tuneImageData(imageData, tune) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = tunePixel(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, tune);
    d[i] = Math.round(r * 255);
    d[i + 1] = Math.round(g * 255);
    d[i + 2] = Math.round(b * 255);
  }
  return imageData;
}

// Universal strength (workorder): out = lerp(original, tuned, t),
// t = strength / 100 clamped to [0, 1]. No extrapolation past 100.
export function applyStrength(original, tuned, strength) {
  const t = Math.min(1, Math.max(0, strength / 100));
  return original * (1 - t) + tuned * t;
}

export function tunesAreIdentity(tune) {
  const t = tune || {};
  return (t.satMul === undefined || t.satMul === 1)
    && !t.brightness
    && (t.contrast === undefined || t.contrast === 1)
    && !t.lift && !t.edge;
}
