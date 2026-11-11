"""Vibrance — selective saturation (Chunk B, 2026-11-11).

Photoshop/Lightroom model: boost LESS-saturated colors first and
protect already-saturated colors, instead of the raw saturation
multiplier `sat_mul` (which pushes every pixel equally). Exposed in
the Filters tab as controls alongside sat_mul, applied server-side as
a post-pass on the composited colorhold result in /api/filters/apply.

The math lives in OKLCH (perceptual), reusing the lessons from the
2026-11-11 colorhold R&D prototype
(~/clawd/autonomy-outputs/ee-colorhold-rnd-2026-11-11/prototype.py):

  - Binary-search gamut clamp (gamut_clamp): raising chroma can push
    colors out of sRGB. Instead of a hard clip (hue shifts, banding),
    we binary-search the largest in-gamut chroma — 8 iterations is
    visually exact (each halves the interval; 8 gives ~1/256 of the
    original chroma range).
  - NO chroma floor: the prototype's floor sweep (2026-11-11) found
    0.0 beats 0.005-0.02 — any floor over-saturates mids. Vibrance
    adds none either.

Model per pixel:

  1. (L, C, h) = OKLCH(rgb).
  2. Muted weight w(C) in [0, 1]: 1 below the threshold chroma,
     smoothstep-falloff to 0 across `falloff` width above it —
     so already-saturated pixels get no boost.
  3. Skin/hue protection p(h) in [0, 1]: reds/oranges/yellows sit
     near HSV hue 0 (the repo's ONE HSV convention, hue 0-1); p
     smoothsteps down across PROT_HUE across that warm band.
  4. Boost: C' = C * (1 + t * w(C) * (1 - protect * p(h))), where
     t = strength/100 and protect in [0, 1]. Lightness is untouched —
     vibrance changes chroma only (that is what makes it "vibrance"
     rather than "saturation + contrast").
  5. Gamut clamp at the original L, then back to sRGB.

Pure numpy, no cv2 dependency. All helpers are deterministic and
directly unit-testable.
"""

import numpy as np

# Warm-band edge: HSV hue below this (plus wraparound above ~0.92 for
# near-red magentas is NOT included — keep it simple and tunable; only
# the red->yellow band, hue in [0, PROT_HUE], is protected) counts as
# skin tone territory (reds/oranges/yellows).
PROT_HUE = 0.16

# Valid input ranges (mirrors the router's clamping posture).
STRENGTH_MAX = 100.0

# Defaults for the Filters-tab controls (tunable at the API).
DEFAULT_FALLOFF = 0.25   # chroma units for the muted->saturated ramp
DEFAULT_PROTECT = 0.5    # 0-1 warm-hue (skin) protection strength


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    # NEGATIVE LINEAR VALUES ARE PRESERVED (negative sRGB out). The R&D
    # prototype clamped negatives to 0 before the gamma curve, which made
    # its gamut check blind to out-of-gamut colors on the black faces —
    # the binary search then "verified" colors that clip hard (hue/L
    # shifts). Gamut testing needs the raw, possibly-negative value; the
    # final render clip in oklch_to_rgb handles display range.
    pos = np.maximum(c, 0)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * pos ** (1 / 2.4) - 0.055)


# sRGB (linear) -> XYZ -> LMS' matrices ( OKLab reference, Björn Ottosson).
M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
               [0.2119034982, 0.6806995451, 0.1073969566],
               [0.0883024619, 0.2817188376, 0.6299787005]])
M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
               [1.9779984951, -2.4285922050, 0.4505937099],
               [0.0259040371, 0.7827717662, -0.8086757660]])
_M2_INV = np.linalg.inv(M2)
_M1_INV = np.linalg.inv(M1)


def rgb_to_oklch(rgb: np.ndarray):
    """Float [0,1] sRGB -> (L, C, h) with OKLab L in ~[0,1], C >= 0,
    h in radians (-pi, pi]. Grey pixels get h = 0 by convention."""
    lin = srgb_to_linear(np.clip(rgb, 0, 1))
    xyz = lin @ M1.T
    lab = np.cbrt(xyz) @ M2.T
    a, b = lab[..., 1], lab[..., 2]
    C = np.sqrt(a * a + b * b)
    h = np.arctan2(b, a)
    return lab[..., 0], C, h


def oklch_to_rgb_raw(L: np.ndarray, C: np.ndarray, h: np.ndarray) -> np.ndarray:
    """OKLCH -> sRGB WITHOUT the final clip — for gamut testing."""
    lab = np.stack([L, C * np.cos(h), C * np.sin(h)], axis=-1)
    lms = lab @ _M2_INV.T
    xyz = lms ** 3
    lin = xyz @ _M1_INV.T
    return linear_to_srgb(lin)


def oklch_to_rgb(L: np.ndarray, C: np.ndarray, h: np.ndarray) -> np.ndarray:
    return np.clip(oklch_to_rgb_raw(L, C, h), 0, 1)


def gamut_clamp(L: np.ndarray, C: np.ndarray, h: np.ndarray, iters: int = 8) -> np.ndarray:
    """Largest chroma <= C still in sRGB at (L, h), per pixel, by
    binary search (vectorized). Lesson from the R&D prototype: graceful
    compression instead of clip."""
    C_lo = np.zeros_like(C)
    C_hi = C.copy()
    for _ in range(iters):
        C_mid = (C_lo + C_hi) / 2
        rgb = oklch_to_rgb_raw(L, C_mid, h)
        ok = ((rgb >= -1e-4) & (rgb <= 1 + 1e-4)).all(axis=-1)
        C_lo = np.where(ok, C_mid, C_lo)
        C_hi = np.where(ok, C_hi, C_mid)
    return C_lo


def smoothstep(x: np.ndarray) -> np.ndarray:
    """Smooth 0..1 ramp with zero slope at both ends."""
    t = np.clip(x, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def muted_weight(C: np.ndarray, falloff: float) -> np.ndarray:
    """1 for muted (low-chroma) pixels, smoothstep to 0 across the
    falloff width in chroma units — already-saturated pixels get no
    boost. falloff <= 0 is a hard step at C=0 (every pixel muted).
    Monotone non-increasing in C."""
    if falloff <= 0:
        return (C <= 0).astype(np.float32)
    return 1.0 - smoothstep(C / falloff)


def skin_protect_weight(h_hsv: np.ndarray) -> np.ndarray:
    """Hue protection for reds/oranges/yellows (HSV hue 0-1 convention):
    1 at hue 0, smoothstep down to 0 across [0, PROT_HUE]. Every other
    hue is unprotected (weight 0)."""
    return 1.0 - smoothstep(h_hsv / PROT_HUE)


def apply_vibrance(rgb: np.ndarray, strength: float = 0.0,
                   falloff: float = 0.25, protect: float = 0.5):
    """Selective saturation on a float [0,1] HxWx3 RGB array.

    strength: 0-100 (0 = exact passthrough, never even round-trips the
    transform — bit-identical input). falloff: chroma units for the
    muted->saturated ramp (clamped to >= 0.05 at the call boundary).
    protect: 0-1, how strongly warm (red/orange/yellow) hues resist
    the boost.

    Returns (output_array, info); info carries how many pixels were
    gamut-clamped (diagnostic for tests/UI)."""
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must be an HxWx3 array")
    if strength < 0 or strength > STRENGTH_MAX:
        raise ValueError("strength must be 0-100")
    if protect < 0 or protect > 1:
        raise ValueError("protect must be 0-1")
    falloff = max(0.05, float(falloff))
    t = strength / 100.0
    if t == 0.0:
        return np.clip(rgb, 0, 1), {"clamped_px": 0}
    L, C, h_ok = rgb_to_oklch(rgb)
    w = muted_weight(C, falloff)
    h_hsv = _hsv_hue(rgb)
    p = skin_protect_weight(h_hsv)
    boost = 1.0 + t * w * (1.0 - protect * p)
    C2 = C * boost
    C2 = gamut_clamp(L, C2, h_ok)
    out = oklch_to_rgb(L, C2, h_ok)
    clamped = int(np.count_nonzero(C2 < C * boost - 1e-6))
    return out, {"clamped_px": clamped}


def _hsv_hue(rgb: np.ndarray) -> np.ndarray:
    """HSV hue 0-1 — same hand-written convention as colorhold's
    rgb_to_hsv (kept local so vibrance has no import cycle with the
    lineart module and stays independently testable)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(axis=2)
    df = mx - rgb.min(axis=2)
    h = np.zeros_like(mx)
    m = (mx == r)
    h[m] = ((g - b)[m] / np.maximum(df[m], 1e-6)) % 6
    m2 = (mx == g) & ~m
    h[m2] = ((b - r)[m2] / np.maximum(df[m2], 1e-6)) + 2
    m3 = (mx == b) & ~m & ~m2
    h[m3] = ((r - g)[m3] / np.maximum(df[m3], 1e-6)) + 4
    return h / 6.0
