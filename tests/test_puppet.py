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
    assert puppet.clamp_denoise(0.8) == 0.5       # the d0.8 that re-conceives faces
    assert puppet.clamp_denoise(1.0) == 0.5
    assert puppet.clamp_denoise(0.0) == 0.4
    assert puppet.clamp_denoise(0.45) == 0.45
    assert puppet.clamp_denoise(None) == puppet.DENOISE_DEFAULT
    assert puppet.clamp_denoise("junk") == puppet.DENOISE_DEFAULT
    assert puppet.clamp_denoise(float("nan")) == puppet.DENOISE_DEFAULT


def test_config_reports_fence_and_rmbg_status(client):
    j = client.get("/api/puppet/config").json()
    assert j["denoise"] == {"min": 0.4, "max": 0.5, "default": 0.45}
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
    r = client.post(f"/api/puppet/projects/{pid}/render",
                    json={"prompt": "golden hour", "denoise": 0.8, "seed": 7})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["denoise"] == 0.5                       # 0.8 fenced down, not honored
    assert seen["denoise"] == 0.5
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
