"""Filters tab: colorhold math, endpoint, presets, and the frontend
tunes (node). Workorder 2026-10-31 requires: alpha curve, darken
rule, strength lerp, fill-field determinism (same input twice =>
byte-identical output), and a smoke test that v5 defaults on
lineart-test.png match the reference output within tolerance.

Premise correction, flagged not silently fixed: the workorder names
lineart-test-out3.png as the v5 reference, but running the package's
own scripts shows out3 is byte-identical to a lineart2.py run
(mean diff 0.0), not a v5 run (the v5 script itself lands at mean
0.031 / 6.9% of pixels >10/255 against out3). So the smoke fixture
here is lineart-test-out-v5.png, generated fresh by the reference
v5 script in the cv2 venv, and the test grades against that.
cv2 path: matches the reference script to within 1/255 rounding
(measured mean 0.00018, 0% of pixels >10/255). Numpy fallback path:
graded looser (measured mean 0.016, 3.8% >10/255 in dev) — the
Chebyshev-vs-Euclidean fill difference, documented in colorhold.py.
"""

import base64
import io
import subprocess
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import colorhold as ch
from backend import vibrance as _vib
from backend.main import app

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures" / "filters"


def _ref(name):
    return np.asarray(Image.open(FIX / name).convert("RGB"), dtype=np.float32) / 255


def test_alpha_curve():
    v = np.array([0.0, 0.225, 0.45, 0.9])
    np.testing.assert_allclose(ch.alpha_curve(v, 0.45), [1.0, 0.5, 0.0, 0.0])
    with pytest.raises(ValueError):
        ch.alpha_curve(v, 0)


def test_darken_rule_keeps_hue_darkens_and_saturates():
    # Pure red fill: hue must survive, value must drop by 0.72, sat stays 1.
    fill = np.zeros((1, 1, 3), np.float32)
    fill[0, 0] = [1.0, 0.0, 0.0]
    dark = ch.darken_fill(fill, 1.45, 0.72)
    assert dark[0, 0, 0] == pytest.approx(0.72, abs=1e-5)
    assert dark[0, 0, 1] == pytest.approx(0.0, abs=1e-5)
    # Near-grey fill: saturation floor 0.10 applies before the multiplier.
    grey = np.full((1, 1, 3), 0.5, np.float32)
    dark_grey = ch.darken_fill(grey, 1.45, 0.72)
    h, s, v = ch.rgb_to_hsv(dark_grey)
    assert s[0, 0] == pytest.approx(0.145, abs=1e-5)
    assert v[0, 0] == pytest.approx(0.36, abs=1e-5)


def test_strength_lerp_clamps_no_extrapolation():
    orig = np.zeros((1, 1, 3), np.float32)
    filt = np.ones((1, 1, 3), np.float32)
    assert ch.apply_strength(orig, filt, 0)[0, 0, 0] == 0.0
    assert ch.apply_strength(orig, filt, 50)[0, 0, 0] == pytest.approx(0.5)
    assert ch.apply_strength(orig, filt, 100)[0, 0, 0] == 1.0
    # >100 is NOT extrapolated (workorder): it clamps to the full effect.
    assert ch.apply_strength(orig, filt, 150)[0, 0, 0] == 1.0
    assert ch.apply_strength(orig, filt, -20)[0, 0, 0] == 0.0


def test_fill_field_determinism_same_input_twice():
    rgb = _ref("lineart-test.png")
    out1, _ = ch.colorhold_lineart(rgb)
    out2, _ = ch.colorhold_lineart(rgb)
    assert np.array_equal(out1, out2)
    png1 = ch.array_to_png_bytes(out1)
    png2 = ch.array_to_png_bytes(out2)
    assert png1 == png2  # byte-identical output, per the workorder


def test_v5_defaults_smoke_within_tolerance():
    rgb = _ref("lineart-test.png")
    out, info = ch.colorhold_lineart(rgb)
    ref = _ref("lineart-test-out-v5.png")
    diff = np.abs(out - ref)
    pct = (diff.max(axis=2) > 10 / 255).mean()
    if info["engine"] == "cv2":
        assert diff.mean() <= 0.005, f"cv2 mean diff {diff.mean():.5f}"
        assert pct == 0, f"cv2 pct>10/255 {pct}"
    else:
        # Numpy fallback: Chebyshev fill, tolerance-graded (see header).
        assert diff.mean() <= 0.03, f"numpy mean diff {diff.mean():.4f}"
        assert pct <= 0.06, f"numpy pct>10/255 {pct}"


def test_gate_off_is_exact_v5_and_strength_zero_is_too():
    rgb = _ref("lineart-test.png")
    plain, _ = ch.colorhold_lineart(rgb)
    gated_off, _ = ch.colorhold_lineart(rgb, gate=False)
    gated_zero, _ = ch.colorhold_lineart(rgb, gate=True, gate_strength=0)
    assert np.array_equal(plain, gated_off)
    assert np.array_equal(plain, gated_zero)


def test_gate_protects_wide_bars_keeps_thin_ones():
    # Synthetic: white canvas, black bars 2/6/12/20/40px. Gate at
    # reference maxw 6 must keep thin strokes tinted and wide bars'
    # centres black.
    # Engine note: the reference-exact cv2 fill leaves wide-line
    # interiors black by construction (LUT miss = reference look), so
    # "thin bars must be tinted" only holds where the fill tints at all.
    # The engine-robust gate contract is: the gate NEVER brightens a
    # black pixel and NEVER removes a tint the ungated run had, and the
    # thin mask itself separates 2/6/12 from 20/40 identically on both
    # engines (asserted directly below).
    img = np.ones((200, 400, 3), np.float32)
    x = 10
    bars = []
    for w in [2, 6, 12, 20, 40]:
        img[:, x:x + w] = 0.0
        bars.append((w, x + w // 2))
        x += w + 30
    # Thin-mask unit contract (both engines, verified identical).
    _, _, v = ch.rgb_to_hsv(img)
    thin = ch.thin_mask(v, 22, 0.06)
    for w, cx in bars[:3]:
        assert thin[100, cx] > 0.99, f"thin mask w={w} not ~1"
    for w, cx in bars[3:]:
        assert thin[100, cx] < 0.01, f"wide mask w={w} not ~0"
    # Reference maxw 22 on this small canvas scales to effective 6
    # (22 * sqrt(80000 / 1085440) = 5.97 -> 6), the kernel the earlier
    # unscaled synthetic run used. This also pins the scaling itself.
    gated, info = ch.colorhold_lineart(img, gate=True, gate_maxw=22)
    ungated, _ = ch.colorhold_lineart(img, gate=False)
    for w, cx in bars:
        g, u = gated[100, cx], ungated[100, cx]
        if u.max() <= 0.05:
            # wide mass (or reference fill miss): gate must protect it
            assert g.max() <= 0.05 + 1e-4, f"w={w} gained color under gate"
        else:
            # tinted thin stroke: gate must not remove the tint
            assert g.max() > 0.1, f"thin stroke w={w} lost its tint"
    assert info["gate"] is True
    assert info["gate_effective_maxw"] == 6


def test_gate_maxw_scales_with_image_size():
    # Same reference maxw quotes a larger effective width on a larger
    # image (v7 scale convention) — preview and full-res must agree
    # on relative width, not absolute pixels.
    small = ch.effective_gate_maxw(640, 640, 6)
    large = ch.effective_gate_maxw(1280, 1040, 6)
    assert small < large
    assert ch.effective_gate_maxw(1280, 848, 6) == 6
    with pytest.raises(ValueError):
        ch.effective_gate_maxw(100, 100, 0)
    rgb = np.zeros((4, 4, 3), np.float32) + 0.8
    # Even smooth kernels are SNAPPED to a valid odd one (2026-10-31:
    # the tab's own slider only produced evens, so rejecting them meant
    # every nonzero slider position 400'd). smooth=4 must now succeed.
    out4, _ = ch.colorhold_lineart(rgb, smooth=4)
    assert out4.shape == (4, 4, 3)
    with pytest.raises(ValueError):
        ch.colorhold_lineart(rgb, line_sigma=3)  # sigma slider caps at 2


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("ELLIEEDIT_FILTERS_DATA", str(tmp_path / "filters-data"))
    return TestClient(app)


def test_filters_defaults_and_apply_b64(client):
    r = client.get("/api/filters/defaults")
    assert r.status_code == 200
    d = r.json()
    assert (d["dark_t"], d["sat_mul"], d["val_mul"], d["smooth"]) == (0.45, 1.45, 0.72, 7)
    assert d["engine"] in ("cv2", "numpy")

    buf = io.BytesIO()
    Image.open(FIX / "lineart-test.png").save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    r = client.post("/api/filters/apply", json={"image_b64": b64})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["image"].startswith("data:image/png;base64,")
    assert (out["width"], out["height"]) == (640, 640)
    # Second identical call hits the fill cache (cheap-stage-only recompute).
    r2 = client.post("/api/filters/apply", json={"image_b64": b64, "sat_mul": 1.0})
    assert r2.json()["cached_fill"] is True
    # Gate is opt-in and reported back; off by default (exact v5).
    rg = client.post("/api/filters/apply", json={"image_b64": b64, "gate": True})
    assert rg.status_code == 200
    assert rg.json()["gate"] is True
    assert rg.json()["gate_effective_maxw"] >= 1
    assert client.get("/api/filters/defaults").json()["gate"] is False
    # Bad params are a 400, not a 500.
    r3 = client.post("/api/filters/apply", json={"image_b64": b64, "smooth": 4})
    # Even smooth is snapped to a valid odd kernel, not rejected (the
    # tab's own slider produced only evens — 2026-10-31 live bug).
    assert r3.status_code == 200
    r4 = client.post("/api/filters/apply", json={})
    assert r4.status_code == 400


def test_filters_presets_roundtrip(client):
    state = {"dark_t": 0.45, "sat_mul": 1.45, "strength": 80}
    r = client.post("/api/filters/presets", json={"name": "test-preset", "state": state})
    assert r.status_code == 200
    assert client.put("/api/filters/last", json={"state": state}).status_code == 200
    d = client.get("/api/filters/presets").json()
    assert d["presets"][0]["name"] == "test-preset"
    assert d["last"] == state
    assert client.delete("/api/filters/presets/test-preset").status_code == 200
    assert client.get("/api/filters/presets").json()["presets"] == []


def test_js_filters_tunes():
    r = subprocess.run(["node", str(HERE / "js" / "filters-tunes.test.mjs")],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


# ---------------------------------------------------------------------------
# Vibrance (Chunk B, 2026-11-11) — selective saturation in OKLCH.
# ---------------------------------------------------------------------------

def _warm_hue_rgb(hue01=0.0, sat=0.6):
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(hue01, sat, 0.7)
    return np.full((4, 4, 3), (r, g, b), np.float32)


def test_vibrance_zero_is_bit_identical_passthrough():
    rng = np.random.default_rng(7)
    rgb = rng.random((8, 8, 3)).astype(np.float32)
    out, info = _vib.apply_vibrance(rgb, strength=0)
    assert np.array_equal(out, np.clip(rgb, 0, 1))
    assert info["clamped_px"] == 0


def test_vibrance_boosts_muted_more_than_saturated():
    # A muted blue-grey vs a saturated red: same strength, the muted pixel's
    # chroma must rise MORE than the saturated pixel's (Photoshop model).
    rgb = np.zeros((1, 2, 3), np.float32)
    rgb[0, 0] = [0.55, 0.60, 0.75]   # muted, low chroma
    rgb[0, 1] = [0.9, 0.1, 0.1]      # saturated red
    _, C0, _ = _vib.rgb_to_oklch(rgb)
    out, _ = _vib.apply_vibrance(rgb, strength=60, falloff=0.25, protect=0.5)
    _, C1, _ = _vib.rgb_to_oklch(out)
    assert C1[0, 0] > C0[0, 0]
    assert C1[0, 1] > C0[0, 1]
    assert (C1[0, 1] - C0[0, 1]) < (C1[0, 0] - C0[0, 0]) * 0.5


def test_vibrance_muted_weight_monotone_and_bounded():
    C = np.linspace(0, 0.5, 50, dtype=np.float32)
    w = _vib.muted_weight(C, 0.25)
    assert np.all(np.diff(w) <= 1e-6)          # non-increasing
    assert w[0] == 1.0 and w[-1] == 0.0        # muted=1, saturated=0
    with pytest.raises(ValueError):
        _vib.apply_vibrance(np.zeros((2, 2, 3), np.float32), strength=101)
    with pytest.raises(ValueError):
        _vib.apply_vibrance(np.zeros((2, 2, 3), np.float32), strength=-1)


def test_vibrance_skin_protection_resists_warm_hues():
    warm = _warm_hue_rgb(0.02)     # near-red (skin territory)
    cool = _warm_hue_rgb(0.55)     # cyan — unprotected
    lw, Cw, _ = _vib.rgb_to_oklch(warm)
    lc, Cc, _ = _vib.rgb_to_oklch(cool)
    pw = _vib.skin_protect_weight(np.array([0.0]))
    pc = _vib.skin_protect_weight(np.array([0.55]))
    assert pw > pc
    assert pw == pytest.approx(1.0) and pc == 0.0
    out_w, _ = _vib.apply_vibrance(warm, strength=80, protect=1.0)
    out_c, _ = _vib.apply_vibrance(cool, strength=80, protect=1.0)
    _, Cw1, _ = _vib.rgb_to_oklch(out_w)
    _, Cc1, _ = _vib.rgb_to_oklch(out_c)
    # Relative chroma gain: protected warm hue gains far less than cool.
    assert (Cw1[0, 0] / Cw[0, 0]) < (Cc1[0, 0] / Cc[0, 0])


def test_vibrance_lightness_untouched_and_in_gamut():
    rgb = np.random.default_rng(3).random((16, 16, 3)).astype(np.float32)
    out, _ = _vib.apply_vibrance(rgb, strength=100, falloff=0.4, protect=0.5)
    L0, _, _ = _vib.rgb_to_oklch(rgb)
    L1, _, _ = _vib.rgb_to_oklch(out)
    np.testing.assert_allclose(L1, L0, atol=1e-4)   # chroma-only change
    # (atol 1e-4: float32 noise at the gamut boundary, ~3.7e-5 worst-case —
    # not a real lightness shift; the pre-fix bug was 0.068.)
    assert out.min() >= 0.0 and out.max() <= 1.0     # always in sRGB


def test_vibrance_deterministic_and_endpoint_wired(client):
    rgb = np.random.default_rng(9).random((8, 8, 3)).astype(np.float32)
    a, _ = _vib.apply_vibrance(rgb, strength=50, falloff=0.3, protect=0.5)
    b, _ = _vib.apply_vibrance(rgb, strength=50, falloff=0.3, protect=0.5)
    np.testing.assert_array_equal(a, b)
    b64 = base64.b64encode(ch.array_to_png_bytes(rgb)).decode()
    r = client.post("/api/filters/apply",
                    json={"image_b64": b64, "vibrance": 50,
                          "vibrance_falloff": 0.3, "vibrance_protect": 0.5})
    assert r.status_code == 200
    assert r.json()["vibrance_clamped_px"] >= 0
    # Off by default: no vibrance fields -> still exact v5 path.
    d = client.get("/api/filters/defaults").json()
    assert d["vibrance"] == 0.0 and d["vibrance_falloff"] > 0
