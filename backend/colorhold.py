"""Colorhold Lineart transform — the Filters tab's headline effect.

Port of the adopted v5 pipeline from the 2026-10-31 colorhold package
(`colorhold_lineart5.py`, itself built on `colorhold_lineart.py`'s
hand-written numpy HSV, float [0, 1], hue 0-1 — kept as the ONE HSV
convention everywhere, frontend tunes included). The math is unchanged
from v5 unless a comment below flags a deliberate deviation:

  1. Soft alpha from darkness: alpha = clamp((dark_t - V) / dark_t, 0, 1)
  2. Fill per line pixel = nearest clean (V >= dark_t) pixel.
     v5 does this in ONE cv2.distanceTransformWithLabels pass; that
     path is used verbatim when cv2 is importable.
  3. 7px median blur on the fill field (0 = off).
  4. Darken rule: hue kept, sat * 1.45 (floor 0.10), val * 0.72.
  5. Composite: out = rgb * (1 - alpha) + dark * alpha.
  6. Universal strength (workorder): out = lerp(original, filtered,
     strength / 100). Strength is clamped to 0-100 — >100 is NOT
     extrapolated, per the workorder.

Deliberate deviations from the reference script, both flagged here:

  - cv2 is NOT a hard dependency. This repo's backend venv ships no
    cv2 (and requirements.txt lists heavy optional deps, rembg /
    onnxruntime, that are likewise lazy-imported, not installed in
    dev). When cv2 is missing, the fill field falls back to a
    deterministic numpy BFS label propagation (8-neighbour, Chebyshev
    distance) and the median blur falls back to Pillow's MedianFilter.
    The fallback is NOT byte-identical to the cv2 path — ties between
    equidistant clean pixels resolve differently — but on thin lineart
    the nearest clean pixel is usually 1-3 px away and both metrics
    agree there; the smoke test grades within tolerance, not
    byte-equality, for exactly this reason. `fill_engine()` reports
    which path ran so a caller can tell.
  - Line smoothing (workorder tier 1, secondary): a Gaussian on the
    alpha layer before composite, sigma 0-2, default 0 (off, so v5
    defaults are untouched). Implemented with Pillow's GaussianBlur
    on the uint8-scaled alpha, so it behaves identically on both
    fill engines.

The expensive stage is the fill field: it depends ONLY on the image
and dark_t. The router caches it keyed by (image bytes hash, dark_t)
and recomputes only the cheap stage (median, darken, composite,
strength) when sat/val/smoothing/strength change — the workorder's
preferred preview flow (b).
"""

import hashlib
from collections import OrderedDict

import numpy as np
from PIL import Image, ImageFilter, ImageOps

# v5 validated defaults — do not change without flagging (workorder).
DEFAULT_DARK_T = 0.45
DEFAULT_SAT_MUL = 1.45
DEFAULT_VAL_MUL = 0.72
DEFAULT_SMOOTH = 7
DEFAULT_LINE_SIGMA = 0.0
DEFAULT_STRENGTH = 100.0

# Explicitly rejected by eye-testing 2026-10-31 (workorder) — do NOT add:
# line-sat boost beyond ~1.75 (indistinguishable), charcoal/parabolic
# black-value attenuation (crushed values at full res).

_FILL_CACHE_MAX = 4
_fill_cache: "OrderedDict[tuple, np.ndarray]" = OrderedDict()


def rgb_to_hsv(rgb: np.ndarray):
    """Hand-written numpy HSV, float [0, 1], hue 0-1. Verbatim from the
    package's colorhold_lineart.py (no library, on purpose)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    df = mx - mn
    v = mx
    s = np.where(mx > 0, df / np.maximum(mx, 1e-6), 0)
    h = np.zeros_like(mx)
    m = (mx == r)
    h[m] = ((g - b)[m] / np.maximum(df[m], 1e-6)) % 6
    m2 = (mx == g) & ~m
    h[m2] = ((b - r)[m2] / np.maximum(df[m2], 1e-6)) + 2
    m3 = (mx == b) & ~m & ~m2
    h[m3] = ((r - g)[m3] / np.maximum(df[m3], 1e-6)) + 4
    return h / 6.0, s, v


def hsv_to_rgb(h, s, v):
    """Inverse of rgb_to_hsv above. Verbatim from the package."""
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)
    out = np.zeros((h.shape[0], h.shape[1], 3), dtype=np.float32)
    for idx, (rr, gg, bb) in enumerate([(v, t, p), (q, v, p), (p, v, t),
                                        (p, q, v), (t, p, v), (v, p, q)]):
        m = i == idx
        out[..., 0][m] = rr[m]
        out[..., 1][m] = gg[m]
        out[..., 2][m] = bb[m]
    return out


def alpha_curve(v: np.ndarray, dark_t: float = DEFAULT_DARK_T) -> np.ndarray:
    """Soft line mask from darkness (v5 step 1). 1 = solid black stroke."""
    if not 0 < dark_t <= 1:
        raise ValueError("dark_t must be in (0, 1]")
    return np.clip((dark_t - v) / dark_t, 0, 1)


def darken_fill(fill: np.ndarray, sat_mul: float = DEFAULT_SAT_MUL,
                val_mul: float = DEFAULT_VAL_MUL) -> np.ndarray:
    """v5 darken rule (step 3): hue kept, sat * sat_mul (floor 0.10),
    val * val_mul, both clipped to [0, 1]."""
    fh, fs, fv = rgb_to_hsv(np.clip(fill, 0, 1))
    fs = np.maximum(fs, 0.10)
    return hsv_to_rgb(fh, np.clip(fs * sat_mul, 0, 1),
                      np.clip(fv * val_mul, 0, 1))


def apply_strength(original: np.ndarray, filtered: np.ndarray,
                   strength: float = DEFAULT_STRENGTH) -> np.ndarray:
    """Universal strength (workorder): lerp(original, filtered, t),
    t = strength / 100 clamped to [0, 1]. No extrapolation past 100."""
    t = min(1.0, max(0.0, float(strength) / 100.0))
    return original * (1 - t) + filtered * t


def _cv2():
    try:
        import cv2  # type: ignore
    except Exception:
        return None
    return cv2


def fill_engine() -> str:
    """Which fill-field path this process will use: 'cv2' or 'numpy'."""
    return "cv2" if _cv2() is not None else "numpy"


def _fill_field_cv2(rgb: np.ndarray, v: np.ndarray, dark_t: float) -> np.ndarray:
    cv2 = _cv2()
    clean = (v >= dark_t).astype(np.uint8)
    ys, xs = np.where(clean == 1)
    if not len(ys):
        return rgb.copy()
    _, lbl = cv2.distanceTransformWithLabels(
        clean, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    lut = np.zeros((int(lbl.max()) + 1, 3), np.float32)
    lut[lbl[ys, xs]] = rgb[ys, xs]
    return lut[lbl]


def _fill_field_numpy(rgb: np.ndarray, v: np.ndarray, dark_t: float) -> np.ndarray:
    """Deterministic fallback when cv2 is unavailable: multi-source BFS
    label propagation over 8 neighbours. Cost per step is 1 (Chebyshev),
    so this is the Chebyshev nearest clean pixel, not the Euclidean one
    cv2 returns — see the module docstring for why that is acceptable
    here, and why the smoke test is tolerance-graded, not byte-graded."""
    h, w = v.shape
    clean = v >= dark_t
    if not clean.any():
        return rgb.copy()
    flat = np.arange(h * w, dtype=np.int64).reshape(h, w)
    label = np.where(clean, flat, -1)
    dist = np.where(clean, 0, np.iinfo(np.int32).max).astype(np.int32)
    # 8 neighbour offsets; slice pairs avoid wrap-around at the edges.
    for _ in range(h + w):
        changed = False
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                ys = slice(max(0, -dy), h - max(0, dy))
                yt = slice(max(0, dy), h - max(0, -dy))
                xs = slice(max(0, -dx), w - max(0, dx))
                xt = slice(max(0, dx), w - max(0, -dx))
                src_label = label[ys, xs]
                cand_dist = dist[ys, xs] + 1
                take = (src_label >= 0) & (cand_dist < dist[yt, xt])
                if take.any():
                    dist[yt, xt][take] = cand_dist[take]
                    label[yt, xt][take] = src_label[take]
                    changed = True
        if not changed:
            break
    filled = np.where(label >= 0, label, flat)
    return rgb.reshape(-1, 3)[filled.ravel()].reshape(h, w, 3)


def fill_field(rgb: np.ndarray, v: np.ndarray, dark_t: float) -> np.ndarray:
    """Nearest-clean-pixel fill field, cv2 path when available."""
    if _cv2() is not None:
        return _fill_field_cv2(rgb, v, dark_t)
    return _fill_field_numpy(rgb, v, dark_t)


def _median_smooth(fill: np.ndarray, smooth: int) -> np.ndarray:
    """Median blur on the fill field. cv2 path matches v5 exactly;
    Pillow path matches it on interiors (edges differ slightly)."""
    if not smooth:
        return fill
    if smooth < 3 or smooth % 2 == 0:
        raise ValueError("smooth must be 0 or an odd integer >= 3")
    cv2 = _cv2()
    if cv2 is not None:
        return cv2.medianBlur((fill * 255).astype(np.uint8), smooth).astype(np.float32) / 255
    img = Image.fromarray((np.clip(fill, 0, 1) * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.MedianFilter(size=smooth)),
                      dtype=np.float32) / 255


def _gaussian_alpha(alpha: np.ndarray, sigma: float) -> np.ndarray:
    """Line smoothing: Gaussian on the alpha layer before composite."""
    if not sigma:
        return alpha
    if not 0 < sigma <= 2:
        raise ValueError("line_sigma must be in (0, 2]")
    img = Image.fromarray((np.clip(alpha, 0, 1) * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius=sigma)),
                      dtype=np.float32) / 255


def cached_fill_field(rgb: np.ndarray, v: np.ndarray, dark_t: float):
    """Fill field with the router cache: key is (image bytes hash,
    dark_t). Returns (fill, was_cached). The cached field is the RAW
    field — median smoothing stays in the cheap stage, so a smoothing
    change does not invalidate the cache."""
    key = (hashlib.sha256(rgb.tobytes()).hexdigest(), float(dark_t))
    if key in _fill_cache:
        _fill_cache.move_to_end(key)
        return _fill_cache[key], True
    fill = fill_field(rgb, v, dark_t)
    _fill_cache[key] = fill
    while len(_fill_cache) > _FILL_CACHE_MAX:
        _fill_cache.popitem(last=False)
    return fill, False


def colorhold_lineart(rgb: np.ndarray, dark_t: float = DEFAULT_DARK_T,
                      sat_mul: float = DEFAULT_SAT_MUL,
                      val_mul: float = DEFAULT_VAL_MUL,
                      smooth: int = DEFAULT_SMOOTH,
                      line_sigma: float = DEFAULT_LINE_SIGMA,
                      strength: float = DEFAULT_STRENGTH):
    """Full v5 pipeline on a float [0, 1] RGB array. Returns
    (output_array, info) where info carries the fill engine and whether
    the fill field came from cache (for the preview UI / tests)."""
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must be an HxWx3 array")
    if sat_mul < 0 or val_mul < 0:
        raise ValueError("sat_mul and val_mul must be >= 0")
    _, _, v = rgb_to_hsv(rgb)
    alpha = alpha_curve(v, dark_t)
    fill, cached = cached_fill_field(rgb, v, dark_t)
    fill = _median_smooth(fill, smooth)
    dark = darken_fill(fill, sat_mul, val_mul)
    alpha = _gaussian_alpha(alpha, line_sigma)
    out = rgb * (1 - alpha[..., None]) + dark * alpha[..., None]
    out = apply_strength(rgb, out, strength)
    return np.clip(out, 0, 1), {"engine": fill_engine(), "cached_fill": cached}


def array_to_png_bytes(rgb: np.ndarray) -> bytes:
    """Float [0, 1] RGB array -> PNG bytes (v5's save step, in memory)."""
    import io
    buf = io.BytesIO()
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def png_bytes_to_rgb(data: bytes, max_side: int | None = None) -> np.ndarray:
    """PNG/JPEG bytes -> float [0, 1] RGB array, EXIF-oriented (browsers
    auto-rotate by EXIF; PIL does not — same lesson as Update's
    _oriented_png). Optionally downscales to max_side on the long side
    for the preview flow (a)."""
    import io
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if max_side and max(im.size) > max_side:
            im.thumbnail((max_side, max_side), Image.LANCZOS)
        return np.asarray(im, dtype=np.float32) / 255
