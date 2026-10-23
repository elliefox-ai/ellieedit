"""Puppet Theater tests (work order 2026-10-22) — the denoise fence, state
validation/jails, project save/load round-trip, server-side compositing,
export, the final pass (mocked repaint), and the rmbg endpoint.

No live ComfyUI and no rembg model download: comfy_repaint is monkeypatched
like test_api.py does, and the rmbg happy-path test SKIPS unless rembg is
installed AND the u2net model is already cached (puppet.rmbg_status).
"""

import base64
import io
import json
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.routers import puppet


def png_bytes(size=(40, 30), color=(200, 30, 30, 255), mode="RGBA"):
    im = Image.new(mode, size, color)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("ELLIEEDIT_PUPPET_DATA", str(tmp_path / "puppet-data"))
    return tmp_path


@pytest.fixture
def client(env):
    return TestClient(app)


def make_project(client, name="Show"):
    r = client.post("/api/puppet/projects", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def add_asset(client, pid, kind, data):
    r = client.post(f"/api/puppet/projects/{pid}/assets",
                    json={"kind": kind, "image_b64": b64(data)})
    assert r.status_code == 201, r.text
    return r.json()


# ------------------------------------------------------------- the fence

def test_clamp_denoise_fence():
    assert puppet.clamp_denoise(0.85) == 0.8    # past the fence cap
    assert puppet.clamp_denoise(1.0) == 0.8
    assert puppet.clamp_denoise(0.8) == 0.8     # widened fence honors 0.8 (Alexander, 2026-10-22)
    assert puppet.clamp_denoise(0.1) == 0.2
    assert puppet.clamp_denoise(0.45) == 0.45
    assert puppet.clamp_denoise(None) == puppet.DENOISE_DEFAULT
    assert puppet.clamp_denoise("junk") == puppet.DENOISE_DEFAULT
    assert puppet.clamp_denoise(float("nan")) == puppet.DENOISE_DEFAULT


def test_config_reports_fence_and_rmbg_status(client):
    j = client.get("/api/puppet/config").json()
    assert j["denoise"] == {"min": 0.2, "max": 0.8, "default": 0.45}
    assert j["canvas_presets"]["16:9"] == [1280, 720]
    assert set(j["rmbg"]) >= {"importable", "model_cached", "available"}


# ------------------------------------------------------------ state shape

def test_validate_state_strips_traversal_and_bounds_canvas():
    st = puppet.validate_state({
        "canvas": {"width": 99999, "height": 100},
        "layers": [{"id": "a", "asset": "../evil.png"},
                   {"id": "a", "asset": "fine.png", "w": -5}]})
    assert st["canvas"]["width"] == puppet.MAX_CANVAS_DIM
    assert st["layers"][0]["asset"] is None
    assert st["layers"][1]["asset"] == "fine.png"
    assert st["layers"][0]["id"] != st["layers"][1]["id"]   # deduped
    assert st["layers"][1]["w"] == 1.0                      # floored


def test_validate_state_rejects_non_dict_and_oversize():
    with pytest.raises(Exception):
        puppet.validate_state([1, 2, 3])
    with pytest.raises(Exception):
        puppet.validate_state({"name": "x" * (puppet.STATE_MAX_BYTES + 10)})


def test_project_id_jail(client):
    assert client.get("/api/puppet/projects/..%2Fetc").status_code in (400, 404)
    assert client.get("/api/puppet/projects/bad%20id").status_code in (400, 404)
    r = client.put("/api/puppet/projects/UPPER", json={"state": {}})
    assert r.status_code == 400


# ------------------------------------------------------------ round-trip

def test_project_save_load_round_trip(client):
    pid = make_project(client)
    cut = add_asset(client, pid, "cutout", png_bytes((60, 40)))
    state = {"name": "Round trip",
             "canvas": {"width": 200, "height": 100,
                        "background": {"type": "none", "asset": None}},
             "layers": [{"id": "hero", "name": "Hero", "asset": cut["file"],
                         "x": 10, "y": 5, "w": 60, "h": 40, "rotation": 15,
                         "visible": True, "natural_w": 60, "natural_h": 40}]}
    r = client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    assert r.status_code == 200, r.text
    got = client.get(f"/api/puppet/projects/{pid}").json()["state"]
    assert got["name"] == "Round trip"
    assert got["canvas"]["width"] == 200
    assert got["layers"][0]["asset"] == cut["file"]
    assert got["layers"][0]["rotation"] == 15
    assert got["updated"]
    listing = client.get("/api/puppet/projects").json()["items"]
    assert [i["id"] for i in listing] == [pid]
    assert listing[0]["layers"] == 1
    # asset serves back as a PNG
    r = client.get(f"/api/puppet/projects/{pid}/assets/{cut['file']}")
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG")
    # stack JSON export is the same shape
    r = client.get(f"/api/puppet/projects/{pid}/export.json")
    assert r.status_code == 200
    assert json.loads(r.content)["layers"][0]["id"] == "hero"


def test_missing_project_404(client):
    assert client.get("/api/puppet/projects/nope-123").status_code == 404
    assert client.get("/api/puppet/projects/nope-123/export.png").status_code == 404


def test_asset_rejects_bad_kind_and_non_image(client):
    pid = make_project(client)
    r = client.post(f"/api/puppet/projects/{pid}/assets",
                    json={"kind": "evil", "image_b64": b64(png_bytes())})
    assert r.status_code == 400
    r = client.post(f"/api/puppet/projects/{pid}/assets",
                    json={"kind": "source", "image_b64": b64(b"not an image")})
    assert r.status_code == 400


# ------------------------------------------------------------ compositing

def _two_layer_project(client):
    pid = make_project(client)
    red = add_asset(client, pid, "cutout", png_bytes((20, 20), (255, 0, 0, 255)))
    blue = add_asset(client, pid, "cutout", png_bytes((20, 20), (0, 0, 255, 255)))
    state = {"name": "Comp", "canvas": {"width": 40, "height": 40,
                                        "background": {"type": "none", "asset": None}},
             "layers": [
                 {"id": "red", "asset": red["file"], "x": 0, "y": 0, "w": 20, "h": 20},
                 {"id": "blue", "asset": blue["file"], "x": 10, "y": 10, "w": 20, "h": 20}]}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    return pid


def test_composite_paint_order_and_transparency(client):
    pid = _two_layer_project(client)
    st = puppet.load_project(pid)
    im = puppet.composite_image(pid, puppet.validate_state(st))
    assert im.size == (40, 40)
    assert im.getpixel((5, 5)) == (255, 0, 0, 255)      # red only
    assert im.getpixel((15, 15)) == (0, 0, 255, 255)    # blue paints OVER red
    assert im.getpixel((35, 5)) == (0, 0, 0, 0)         # bare stage stays alpha


def test_composite_mask_erases(client):
    pid = make_project(client)
    red = add_asset(client, pid, "cutout", png_bytes((20, 20), (255, 0, 0, 255)))
    half = Image.new("L", (20, 20), 255)
    for x in range(10, 20):
        for y in range(20):
            half.putpixel((x, y), 0)
    buf = io.BytesIO(); half.save(buf, "PNG")
    mask = add_asset(client, pid, "mask", buf.getvalue())
    state = {"name": "M", "canvas": {"width": 20, "height": 20,
                                     "background": {"type": "none", "asset": None}},
             "layers": [{"id": "r", "asset": red["file"], "mask": mask["file"],
                         "x": 0, "y": 0, "w": 20, "h": 20}]}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    im = puppet.composite_image(pid, puppet.validate_state(
        puppet.load_project(pid)))
    assert im.getpixel((5, 10))[3] == 255               # kept half
    assert im.getpixel((15, 10))[3] == 0                # erased half: alpha gone
    # Nondestructive means the SOURCE survives: drop the mask from the stack
    # and the erased half is fully back — the erase lived in the mask only.
    state["layers"][0]["mask"] = None
    im2 = puppet.composite_image(pid, puppet.validate_state(state))
    assert im2.getpixel((15, 10)) == (255, 0, 0, 255)


def test_composite_rotation_keeps_turned_head_geometry(client):
    """A wide cutout rotated 90° must occupy the tall footprint — the pose is
    baked pixels, and the flatten must not 'correct' it back."""
    pid = make_project(client)
    wide = add_asset(client, pid, "cutout", png_bytes((40, 10), (0, 200, 0, 255)))
    state = {"name": "R", "canvas": {"width": 100, "height": 100,
                                     "background": {"type": "none", "asset": None}},
             "layers": [{"id": "w", "asset": wide["file"], "x": 30, "y": 45,
                         "w": 40, "h": 10, "rotation": 90}]}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    im = puppet.composite_image(pid, puppet.validate_state(
        puppet.load_project(pid)))
    assert im.getpixel((50, 35))[3] == 255   # above center: inside the tall bar
    assert im.getpixel((50, 65))[3] == 255   # below center: also inside
    assert im.getpixel((35, 50))[3] == 0     # beside center: the wide bar is gone


def test_export_png_is_canvas_sized(client):
    pid = _two_layer_project(client)
    r = client.get(f"/api/puppet/projects/{pid}/export.png")
    assert r.status_code == 200
    with Image.open(io.BytesIO(r.content)) as im:
        assert im.size == (40, 40) and im.mode == "RGBA"


def test_white_mask_is_full_white():
    raw = base64.b64decode(puppet.white_mask_b64(8, 6))
    with Image.open(io.BytesIO(raw)) as im:
        assert im.size == (8, 6) and im.convert("L").getextrema() == (255, 255)


# ------------------------------------------------------------- final pass

def test_render_fences_denoise_and_uses_full_mask(client, monkeypatch):
    pid = _two_layer_project(client)
    seen = {}

    def fake_repaint(image_b64, mask_b64, prompt, denoise=0.5, seed=0, timeout=600):
        seen.update(denoise=denoise, prompt=prompt, seed=seed)
        with Image.open(io.BytesIO(base64.b64decode(mask_b64))) as m:
            seen["mask_extrema"] = m.convert("L").getextrema()
            seen["mask_size"] = m.size
        with Image.open(io.BytesIO(base64.b64decode(image_b64))) as im:
            seen["image_size"] = im.size
        return png_bytes((40, 40), (9, 9, 9, 255))

    monkeypatch.setattr("backend.comfy.comfy_repaint", fake_repaint)
    monkeypatch.setattr("backend.comfy.comfy_repaint_klein", fake_repaint)
    r = client.post(f"/api/puppet/projects/{pid}/render",
                    json={"prompt": "golden hour", "denoise": 0.8, "seed": 7})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["denoise"] == 0.8                       # fence widened 2026-10-22: 0.8 honored
    assert seen["denoise"] == 0.8
    # past the cap: clamped INTO the fence, never honored
    r = client.post(f"/api/puppet/projects/{pid}/render",
                    json={"prompt": "golden hour", "denoise": 0.9, "seed": 7})
    assert r.status_code == 200, r.text
    assert r.json()["denoise"] == 0.8
    assert seen["denoise"] == 0.8
    assert seen["mask_extrema"] == (255, 255)        # FULL-canvas context
    assert seen["mask_size"] == (40, 40) == seen["image_size"]
    assert seen["prompt"] == "golden hour" and seen["seed"] == 7
    assert base64.b64decode(j["image_b64"]).startswith(b"\x89PNG")
    assert j["render_asset"] and j["render_asset"].startswith("render-")
    # a render at an already-legal denoise passes through unchanged
    r = client.post(f"/api/puppet/projects/{pid}/render", json={"denoise": 0.42})
    assert r.json()["denoise"] == 0.42


def test_render_failure_is_502_not_silence(client, monkeypatch):
    pid = _two_layer_project(client)

    def boom(*a, **kw):
        raise RuntimeError("ComfyUI down")

    monkeypatch.setattr("backend.comfy.comfy_repaint", boom)
    monkeypatch.setattr("backend.comfy.comfy_repaint_klein", boom)
    r = client.post(f"/api/puppet/projects/{pid}/render", json={})
    assert r.status_code == 502
    assert "ComfyUI down" in r.json()["detail"]


# ------------------------------------------------------------------- rmbg

def test_rmbg_rejects_non_image(client):
    r = client.post("/api/puppet/rmbg", json={"image_b64": b64(b"junk")})
    assert r.status_code == 400


def test_rmbg_unknown_job_404(client):
    assert client.get("/api/puppet/rmbg/deadbeefdeadbeef").status_code == 404


def _poll_job(client, job_id, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = client.get(f"/api/puppet/rmbg/{job_id}").json()
        if j["state"] != "running":
            return j
        time.sleep(0.1)
    raise AssertionError("rmbg job never finished")


def test_rmbg_endpoint_alpha_corners(client):
    """Fixture: a solid red square centered on a white background. A working
    rmbg must return an image WITH alpha whose corners are transparent.
    Skips (never downloads) when rembg/the model aren't already present."""
    if not puppet.rmbg_status()["available"]:
        pytest.skip("rembg or u2net model not present — suite must not download it")
    im = Image.new("RGB", (80, 80), (255, 255, 255))
    for x in range(25, 55):
        for y in range(25, 55):
            im.putpixel((x, y), (220, 0, 0))
    buf = io.BytesIO(); im.save(buf, "PNG")
    r = client.post("/api/puppet/rmbg", json={"image_b64": b64(buf.getvalue())})
    assert r.status_code == 202
    j = _poll_job(client, r.json()["job_id"])
    assert j["state"] == "done", j
    with Image.open(io.BytesIO(base64.b64decode(j["image_b64"]))) as out:
        assert out.mode == "RGBA"
        assert out.getpixel((0, 0))[3] == 0          # corner: background removed
        assert out.getpixel((79, 79))[3] == 0


# ------------------------------------------------- v1.1: Fill Area + D

def _gray_png(size, painter):
    im = Image.new("L", size, 0)
    painter(im)
    buf = io.BytesIO(); im.save(buf, "PNG")
    return buf.getvalue()


def _fill_project(client, rendermask_data=None, mode_canvas=(40, 40)):
    """One project whose state references a rendermask asset uploaded INTO
    that same project (assets are project-scoped)."""
    pid = make_project(client)
    layer = add_asset(client, pid, "source", png_bytes((20, 20), (255, 0, 0, 255)))
    rm_file = None
    if rendermask_data is not None:
        rm_file = add_asset(client, pid, "rendermask", rendermask_data)["file"]
    state = {"name": "Fill", "canvas": {"width": mode_canvas[0], "height": mode_canvas[1],
                                        "background": {"type": "none", "asset": None}},
             "layers": [{"id": "r", "asset": layer["file"], "x": 0, "y": 0,
                         "w": 20, "h": 20}],
             "rendermask": rm_file}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    return pid


def _capture_repaint(monkeypatch):
    seen = {}

    def fake_repaint(image_b64, mask_b64, prompt, denoise=0.5, seed=0, timeout=600):
        seen["mask_b64"] = mask_b64
        with Image.open(io.BytesIO(base64.b64decode(mask_b64))) as m:
            seen["mask"] = m.convert("L").copy()
        return png_bytes((40, 40), (9, 9, 9, 255))

    monkeypatch.setattr("backend.comfy.comfy_repaint", fake_repaint)
    monkeypatch.setattr("backend.comfy.comfy_repaint_klein", fake_repaint)
    return seen


def test_validate_state_carries_cutout_and_rendermask():
    st = puppet.validate_state({
        "canvas": {"width": 40, "height": 40},
        "rendermask": "rendermask-abc.png",
        "layers": [{"id": "a", "cutout": "cutout-x.png", "mask": "mask-y.png",
                    "asset": "../evil.png"}]})
    assert st["rendermask"] == "rendermask-abc.png"
    assert st["layers"][0]["cutout"] == "cutout-x.png"
    assert st["layers"][0]["mask"] == "mask-y.png"
    assert st["layers"][0]["asset"] is None          # traversal stripped
    # three separate channels, never aliased
    assert len({st["rendermask"], st["layers"][0]["cutout"],
                st["layers"][0]["mask"]}) == 3
    st2 = puppet.validate_state({"rendermask": "../evil.png", "layers": []})
    assert st2["rendermask"] is None                 # jail applies here too


def test_rendermask_asset_round_trip(client):
    pid = make_project(client)
    data = _gray_png((40, 40), lambda im: [im.putpixel((x, y), 255)
                                           for x in range(20) for y in range(40)])
    a = add_asset(client, pid, "rendermask", data)
    assert a["file"].startswith("rendermask-")
    state = {"name": "RT", "canvas": {"width": 40, "height": 40,
                                      "background": {"type": "none", "asset": None}},
             "layers": [], "rendermask": a["file"]}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    got = client.get(f"/api/puppet/projects/{pid}").json()["state"]
    assert got["rendermask"] == a["file"]
    r = client.get(f"/api/puppet/projects/{pid}/assets/{a['file']}")
    assert r.status_code == 200
    with Image.open(io.BytesIO(r.content)) as im:
        m = im.convert("L")
        assert m.getpixel((5, 5)) == 255 and m.getpixel((30, 5)) == 0


def test_render_passes_painted_mask_through(client, monkeypatch):
    data = _gray_png((40, 40), lambda im: [im.putpixel((x, y), 255)
                                           for x in range(20) for y in range(40)])
    pid = _fill_project(client, rendermask_data=data)
    seen = _capture_repaint(monkeypatch)
    r = client.post(f"/api/puppet/projects/{pid}/render",
                    json={"prompt": "", "denoise": 0.45, "mode": "fill"})
    assert r.status_code == 200, r.text
    assert r.json()["mask_used"] == "fill"
    m = seen["mask"]
    assert m.size == (40, 40)
    assert m.getpixel((5, 5)) == 255      # painted: regenerate
    assert m.getpixel((30, 5)) == 0       # unpainted: locked
    assert m.getextrema() == (0, 255)     # NOT the full-white v1 mask


def test_render_empty_mask_behaves_like_v1(client, monkeypatch):
    pid = _fill_project(client, rendermask_data=_gray_png((40, 40), lambda im: None))
    seen = _capture_repaint(monkeypatch)
    r = client.post(f"/api/puppet/projects/{pid}/render", json={"mode": "fill"})
    assert r.json()["mask_used"] == "full"
    assert seen["mask"].getextrema() == (255, 255)    # empty = white behavior


def test_render_mode_all_ignores_painted_mask(client, monkeypatch):
    data = _gray_png((40, 40), lambda im: [im.putpixel((x, y), 255)
                                           for x in range(20) for y in range(40)])
    pid = _fill_project(client, rendermask_data=data)
    seen = _capture_repaint(monkeypatch)
    r = client.post(f"/api/puppet/projects/{pid}/render", json={"mode": "all"})
    assert r.json()["mask_used"] == "full"
    assert seen["mask"].getextrema() == (255, 255)


def test_render_no_mask_default_unchanged(client, monkeypatch):
    pid = _fill_project(client, rendermask_data=None)
    seen = _capture_repaint(monkeypatch)
    r = client.post(f"/api/puppet/projects/{pid}/render", json={})
    assert r.json()["mask_used"] == "full"
    assert seen["mask"].getextrema() == (255, 255)


def test_cutout_mask_composites_and_restores(client):
    """Amendment D at the flatten level: the cutout is a MASK over the
    untouched original — left half cut away, and dropping the mask
    reference brings the full original back (Restore)."""
    pid = make_project(client)
    src = add_asset(client, pid, "source", png_bytes((20, 20), (255, 0, 0, 255)))
    half = _gray_png((20, 20), lambda im: [im.putpixel((x, y), 255)
                                           for x in range(10, 20) for y in range(20)])
    cut = add_asset(client, pid, "cutout", half)
    state = {"name": "D", "canvas": {"width": 20, "height": 20,
                                     "background": {"type": "none", "asset": None}},
             "layers": [{"id": "r", "asset": src["file"], "source": src["file"],
                         "cutout": cut["file"], "x": 0, "y": 0, "w": 20, "h": 20}]}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    im = puppet.composite_image(pid, puppet.validate_state(puppet.load_project(pid)))
    assert im.getpixel((5, 10))[3] == 0        # cut away by the rmbg mask
    assert im.getpixel((15, 10)) == (255, 0, 0, 255)
    # Both masks multiply: erase the kept half too and everything is gone.
    em = add_asset(client, pid, "mask", _gray_png((20, 20), lambda im2:
                   [im2.putpixel((x, y), 255) for x in range(10) for y in range(20)]))
    state["layers"][0]["mask"] = em["file"]
    im2 = puppet.composite_image(pid, puppet.validate_state(state))
    assert im2.getpixel((15, 10))[3] == 0
    assert im2.getpixel((5, 10))[3] == 0
    # Restore: cutout reference dropped -> original pixels fully back.
    state["layers"][0]["cutout"] = None
    state["layers"][0]["mask"] = None
    im3 = puppet.composite_image(pid, puppet.validate_state(state))
    assert im3.getpixel((5, 10)) == (255, 0, 0, 255)


def test_saved_project_assets_all_fetchable(client):
    """Amendment C, server half: every asset a saved state references —
    layer base, cutout, erase mask, rendermask, background — must come
    back over HTTP with image bytes, or reload has nothing to paint."""
    pid = make_project(client)
    src = add_asset(client, pid, "source", png_bytes((16, 16), (1, 2, 3, 255)))
    cut = add_asset(client, pid, "cutout", _gray_png((16, 16), lambda im: None))
    msk = add_asset(client, pid, "mask", _gray_png((16, 16), lambda im: None))
    rm = add_asset(client, pid, "rendermask", _gray_png((32, 32), lambda im: None))
    bg = add_asset(client, pid, "background", png_bytes((32, 32), (9, 9, 9, 255)))
    state = {"name": "C", "canvas": {"width": 32, "height": 32,
                                     "background": {"type": "image", "asset": bg["file"]}},
             "layers": [{"id": "r", "asset": src["file"], "source": src["file"],
                         "cutout": cut["file"], "mask": msk["file"],
                         "x": 0, "y": 0, "w": 16, "h": 16}],
             "rendermask": rm["file"]}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    saved = client.get(f"/api/puppet/projects/{pid}").json()["state"]
    refs = [saved["layers"][0][k] for k in ("asset", "source", "cutout", "mask")]
    refs += [saved["rendermask"], saved["canvas"]["background"]["asset"]]
    assert all(refs)
    for f in refs:
        r = client.get(f"/api/puppet/projects/{pid}/assets/{f}")
        assert r.status_code == 200, f
        assert r.content.startswith(b"\x89PNG"), f


# ------------------------------------------------- v1.2: engines + render layers

def _engine_mocks(monkeypatch):
    calls = {"klein": [], "krea2": []}

    def mk(tag):
        def fake(image_b64, mask_b64, prompt, denoise=0.45, seed=0, timeout=600):
            calls[tag].append({"denoise": denoise, "prompt": prompt, "seed": seed})
            return png_bytes((40, 40), (9, 9, 9, 255))
        return fake

    monkeypatch.setattr("backend.comfy.comfy_repaint_klein", mk("klein"))
    monkeypatch.setattr("backend.comfy.comfy_repaint", mk("krea2"))
    return calls


def test_engine_default_is_klein_krea2_selectable(client, monkeypatch):
    pid = _fill_project(client)
    calls = _engine_mocks(monkeypatch)
    # omitted engine -> Klein (Alexander: preserves context better)
    r = client.post(f"/api/puppet/projects/{pid}/render", json={})
    assert r.json()["engine"] == "klein"
    assert len(calls["klein"]) == 1 and len(calls["krea2"]) == 0
    # explicit Krea2 -> the old path
    r = client.post(f"/api/puppet/projects/{pid}/render", json={"engine": "krea2"})
    assert r.json()["engine"] == "krea2"
    assert len(calls["krea2"]) == 1
    # garbage engine -> Klein, never an error, never a silent third path
    r = client.post(f"/api/puppet/projects/{pid}/render", json={"engine": "sdxl-turbo"})
    assert r.json()["engine"] == "klein"
    assert len(calls["klein"]) == 2


def test_engine_fence_holds_on_both_paths(client, monkeypatch):
    pid = _fill_project(client)
    calls = _engine_mocks(monkeypatch)
    for engine in ("klein", "krea2"):
        client.post(f"/api/puppet/projects/{pid}/render",
                    json={"engine": engine, "denoise": 0.95})
        client.post(f"/api/puppet/projects/{pid}/render",
                    json={"engine": engine, "denoise": 0.05})
        got = [c["denoise"] for c in calls[engine]]
        assert got == [0.8, 0.2], (engine, got)   # the 0.2-0.8 fence, both engines


def test_config_advertises_engines(client):
    j = client.get("/api/puppet/config").json()
    assert j["default_engine"] == "klein"
    assert j["engines"] == ["klein", "krea2"]


def test_render_layer_round_trips_like_any_layer(client):
    """v1.2 item 3 at the data level: an accepted render is a layer whose
    asset/source are the render file; it saves, reloads and composites on
    top exactly like a dropped puppet."""
    pid = make_project(client)
    base = add_asset(client, pid, "source", png_bytes((20, 20), (255, 0, 0, 255)))
    top = add_asset(client, pid, "render", png_bytes((40, 40), (0, 0, 255, 255)))
    state = {"name": "Iter", "canvas": {"width": 40, "height": 40,
                                        "background": {"type": "none", "asset": None}},
             "layers": [
                 {"id": "p", "asset": base["file"], "source": base["file"],
                  "x": 0, "y": 0, "w": 20, "h": 20},
                 {"id": "r1", "name": "Render 1", "asset": top["file"],
                  "source": top["file"], "x": 0, "y": 0, "w": 40, "h": 40}]}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    saved = client.get(f"/api/puppet/projects/{pid}").json()["state"]
    assert saved["layers"][1]["asset"] == top["file"]
    assert saved["layers"][1]["source"] == top["file"]
    im = puppet.composite_image(pid, puppet.validate_state(saved))
    assert im.getpixel((5, 5)) == (0, 0, 255, 255)   # render layer paints over
    assert im.getpixel((30, 30)) == (0, 0, 255, 255)
