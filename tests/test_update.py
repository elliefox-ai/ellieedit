"""Update module tests — preset loading/injection, seeded preset integrity,
saved-prompts CRUD, save-family."""

import json
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

os.environ.setdefault("ELLIEEDIT_GALLERY_ROOT", "/tmp/nonexist-gallery")
os.environ.setdefault("ELLIEEDIT_DUPE_ROOT", "/tmp/nonexist-dupes")
os.environ.setdefault("ELLIEEDIT_LIBRARY_ROOT", "/tmp/nonexist-library")

import backend.routers.gallery as gallery_mod
import backend.routers.library as library_mod
import backend.routers.update as update_mod
from backend.main import app


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# Preset loading
# ---------------------------------------------------------------------------

def test_presets_list_two_seeded():
    presets = {p["file"]: p for p in update_mod.load_presets()}
    assert "zengostyle-transform.json" in presets
    assert "plain-transform.json" in presets
    for p in presets.values():
        assert p["name"] and isinstance(p["description"], str)


def test_preset_endpoint(tmp_path, monkeypatch, client):
    monkeypatch.setattr(update_mod, "WORKFLOWS_DIR", tmp_path)
    r = client.get("/api/update/presets")
    assert r.status_code == 200
    assert r.json()["presets"] == []
    (tmp_path / "x.json").write_text('{"name":"X","graph":{},"params":{}}')
    assert client.get("/api/update/presets").json()["presets"][0]["file"] == "x.json"


def test_preset_jail(client):
    assert client.get("/api/update/presets").status_code == 200
    with pytest.raises(Exception):
        update_mod.load_preset("../backend/main.py")
    with pytest.raises(Exception):
        update_mod.load_preset("missing.json")


# ---------------------------------------------------------------------------
# Injection
# ---------------------------------------------------------------------------

def test_build_run_graph_injection():
    preset = update_mod.load_preset("plain-transform.json")
    wf = update_mod.build_run_graph(preset, "uploaded.png", "a cat", 12345)
    assert wf["466"]["inputs"]["image"] == "uploaded.png"
    assert wf["268"]["inputs"]["seed"] == 12345
    assert wf["113"]["inputs"]["text"] == "a cat"
    # originals untouched
    assert preset["graph"]["466"]["inputs"]["image"] == "__IMAGE__"
    assert preset["graph"]["268"]["inputs"]["seed"] == 0


def test_output_prefix_forced():
    for f in ("plain-transform.json", "zengostyle-transform.json"):
        preset = update_mod.load_preset(f)
        wf = update_mod.build_run_graph(preset, "i.png", "p", 1)
        for node in wf.values():
            if node.get("class_type") == "SaveImage":
                assert node["inputs"]["filename_prefix"] == "ellieedit_tmp/update"


def test_build_run_graph_bad_node(tmp_path):
    bad = {"name": "bad", "graph": {"1": {"class_type": "X", "inputs": {}}},
           "params": {"image": {"node": "9", "input": "image"},
                      "seed": {"node": "1", "input": "seed"},
                      "prompt": {"node": "1", "input": "text"}}}
    (tmp_path / "bad.json").write_text(json.dumps(bad))
    import backend.routers.update as u
    old = u.WORKFLOWS_DIR
    u.WORKFLOWS_DIR = tmp_path
    try:
        with pytest.raises(Exception):
            u.build_run_graph(u.load_preset("bad.json"), "i", "p", 1)
    finally:
        u.WORKFLOWS_DIR = old


# ---------------------------------------------------------------------------
# Seeded preset integrity
# ---------------------------------------------------------------------------

CHAIN = [("322", 0.1, -0.1), ("326", 0.8, -0.1), ("464", 0.3, -0.1), ("323", 0.6, -0.1)]


def test_zengo_lora_chain_intact():
    g = update_mod.load_preset("zengostyle-transform.json")["graph"]
    prev_model, prev_clip = "118", "117"
    for node, sm, sc in CHAIN:
        inp = g[node]
        assert inp["class_type"] == "LoraLoader"
        assert inp["inputs"]["strength_model"] == sm
        assert inp["inputs"]["strength_clip"] == sc
        assert inp["inputs"]["model"] == [prev_model, 0]
        # LoraLoader outputs clip on slot 1; UNET/CLIP loaders on slot 0
        assert inp["inputs"]["clip"] == [prev_clip, 1 if prev_clip != "117" else 0]
        prev_model, prev_clip = node, node


def test_plain_zero_lora_loaders():
    g = update_mod.load_preset("plain-transform.json")["graph"]
    loras = [k for k, v in g.items() if v["class_type"] == "LoraLoader"]
    assert loras == []
    # model/clip come straight from the UNET/CLIP loaders
    assert g["124"]["inputs"]["model"] == ["118", 0]
    assert g["113"]["inputs"]["clip"] == ["117", 0]
    # no prompt language nodes survive
    for gone in ("322", "326", "464", "323", "320", "480", "469"):
        assert gone not in g


def test_zengo_prompt_append_order():
    """Style block (480) is string_a, page prompt box (469) is string_b —
    style text first, user text appended after."""
    preset = update_mod.load_preset("zengostyle-transform.json")
    g = preset["graph"]
    concat = g["320"]["inputs"]
    assert concat["string_a"] == ["480", 0]
    assert concat["string_b"] == ["469", 0]
    # 480 carries the verbatim style block; 469 is the injected placeholder
    assert "__PROMPT__" not in g["480"]["inputs"]["string"]
    assert g["469"]["inputs"]["string"] == "__PROMPT__"
    assert preset["params"]["prompt"]["node"] == "469"
    # positive encode consumes the concat
    assert g["113"]["inputs"]["text"] == ["320", 0]


def test_both_presets_keep_getimagesize_chain():
    """Dimensions follow the source at runtime: GetImageSize (110) feeds the
    latent (112) and scheduler (125) — no hardcoded width/height."""
    for f in ("plain-transform.json", "zengostyle-transform.json"):
        g = update_mod.load_preset(f)["graph"]
        assert g["110"]["class_type"] == "GetImageSize"
        assert g["112"]["inputs"]["width"] == ["110", 0]
        assert g["112"]["inputs"]["height"] == ["110", 1]
        assert g["125"]["inputs"]["width"] == ["110", 0]


# ---------------------------------------------------------------------------
# Saved prompts CRUD
# ---------------------------------------------------------------------------

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(update_mod, "SAVED_PROMPTS_PATH", tmp_path / "saved-prompts.json")
    return update_mod


def test_saved_prompts_crud(store):
    assert update_mod.list_prompts() == []
    update_mod.add_prompt("B style", "line two\nline three")
    update_mod.add_prompt("alpha", "first")
    names = [e["name"] for e in update_mod.list_prompts()]
    assert names == ["alpha", "B style"]  # sorted, case-insensitive
    update_mod.add_prompt("alpha", "replaced")  # upsert by name
    entries = update_mod.list_prompts()
    assert len(entries) == 2
    assert entries[0]["text"] == "replaced"
    update_mod.delete_prompt("alpha")
    assert [e["name"] for e in update_mod.list_prompts()] == ["B style"]
    with pytest.raises(Exception):
        update_mod.add_prompt("  ", "x")


def test_saved_prompts_endpoints(store, client):
    r = client.post("/api/update/prompts",
                    json={"name": "night", "text": "dark scene"})
    assert r.status_code == 200
    assert [p["name"] for p in r.json()["prompts"]] == ["night"]
    assert client.get("/api/update/prompts").json()["prompts"][0]["text"] == "dark scene"
    r = client.request("DELETE", "/api/update/prompts?name=night")
    assert r.json()["prompts"] == []


# ---------------------------------------------------------------------------
# Run endpoint through a fixture Comfy server (real submit path, no GPU)
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_comfy(tmp_path, monkeypatch, roots):
    """Fixture Comfy + temp gallery root; mimics the real shared output root
    (Comfy writes outputs into GALLERY_ROOT/ellieedit_tmp)."""
    from tests.fake_comfy import start_fake_comfy
    groot, _lroot = roots
    (groot / "src.png").write_bytes(_png_bytes())
    fake = start_fake_comfy(output_dir=groot)
    monkeypatch.setattr(update_mod, "COMFY_URL", fake.url)
    yield fake
    fake.stop()


def _png_bytes():
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (10, 120, 200)).save(buf, "PNG")
    return buf.getvalue()


def test_run_plain_via_fixture_server(fake_comfy, client):
    r = client.post("/api/update/run", json={
        "preset": "plain-transform.json", "path": "src.png",
        "prompt": "a cat on a roof", "random": False, "seed": 999})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["seed"] == 999
    assert data["render_path"] == "ellieedit_tmp/update_00001_.png"
    assert data["image"].startswith("data:image/png;base64,")
    g = fake_comfy.graphs[-1]
    assert g["113"]["inputs"]["text"] == "a cat on a roof"
    assert g["268"]["inputs"]["seed"] == 999
    assert sum(1 for n in g.values() if n["class_type"] == "LoraLoader") == 0


def test_run_zengo_random_seed_via_fixture_server(fake_comfy, client):
    r = client.post("/api/update/run", json={
        "preset": "zengostyle-transform.json", "path": "src.png",
        "prompt": "user text", "random": True})
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data["seed"], int) and data["seed"] > 0
    g = fake_comfy.graphs[-1]
    assert g["268"]["inputs"]["seed"] == data["seed"]
    assert g["469"]["inputs"]["string"] == "user text"  # appended after 480
    assert g["480"]["inputs"]["string"].startswith(
        "depict this in a strong flatdeep style")  # style block verbatim
    assert sum(1 for n in g.values() if n["class_type"] == "LoraLoader") == 4


def test_run_unknown_preset_404(fake_comfy, client):
    r = client.post("/api/update/run", json={
        "preset": "nope.json", "path": "src.png", "prompt": "x", "random": True})
    assert r.status_code == 404


def test_run_missing_source_404(fake_comfy, client):
    r = client.post("/api/update/run", json={
        "preset": "plain-transform.json", "path": "gone.png",
        "prompt": "x", "random": True})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# save-family
# ---------------------------------------------------------------------------

@pytest.fixture
def roots(tmp_path, monkeypatch):
    groot, droot, lroot = tmp_path / "gallery", tmp_path / "dupes", tmp_path / "library"
    groot.mkdir(); droot.mkdir(); lroot.mkdir()
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", groot)
    monkeypatch.setattr(library_mod, "LIBRARY_ROOT", lroot)
    monkeypatch.setattr(update_mod, "_library_mod", library_mod)
    return groot, lroot


def make_png(p: Path):
    from PIL import Image
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), (200, 10, 10)).save(p)


def test_save_family(roots, client):
    groot, lroot = roots
    make_png(groot / "ellieedit_tmp" / "update_00001_.png")
    make_png(groot / "original.png")
    r = client.post("/api/update/save-family", json={
        "render_path": "ellieedit_tmp/update_00001_.png",
        "original_path": "original.png",
        "tag": "zengosoft"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["tags"] == ["zengosoft"]
    assert (lroot / data["final"]).is_file()
    assert (lroot / data["original"]).is_file()
    # original sits next to the final, named for it
    assert Path(data["original"]).parent == Path(data["final"]).parent
    assert "-original" in Path(data["original"]).name
    recs = [json.loads(l) for l in
            (lroot / ".library-index.jsonl").read_text().splitlines() if l.strip()]
    fam = [r for r in recs if r.get("kind") == "version-family"]
    assert len(fam) == 1
    assert fam[0]["final"] == data["final"]
    assert fam[0]["original"] == data["original"]
    kinds = {r["path"]: r.get("kind") for r in recs}
    assert kinds[data["original"]] == "version-original"


def test_save_family_rejects_escape(roots, client):
    r = client.post("/api/update/save-family", json={
        "render_path": "../../../etc/passwd", "original_path": "x.png", "tag": "t"})
    assert r.status_code in (400, 404)


# -------------------------------------------------- Update masked inpaint
# (2026-10-24): async jobs + Klein inpaint recipe on Puppet's engine.

def _poll_job(client, jid, tries=100):
    import time as _t
    for _ in range(tries):
        r = client.get(f"/api/update/jobs/{jid}")
        assert r.status_code == 200, r.text
        job = r.json()
        if job["status"] in ("done", "error"):
            return job
        _t.sleep(0.05)
    raise AssertionError(f"job {jid} never finished")


def _mask_b64(white=True, size=16):
    import base64, io
    from PIL import Image
    im = Image.new("L", (size, size), 255 if white else 0)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_run_async_flow(roots, client, monkeypatch):
    groot, _lroot = roots
    (groot / "src.png").write_bytes(_png_bytes())
    (groot / "out.png").write_bytes(_png_bytes())
    monkeypatch.setattr(update_mod._comfy, "_comfy_upload", lambda b, n: "src.png")
    monkeypatch.setattr(update_mod, "comfy_submit", lambda wf: "pid1")
    monkeypatch.setattr(update_mod, "comfy_poll",
                        lambda pid: {"filename": "out.png", "subfolder": "", "type": "output"})
    monkeypatch.setattr(update_mod, "comfy_fetch_image", lambda im: _png_bytes())
    r = client.post("/api/update/run-async", json={
        "preset": "plain-transform.json", "path": "src.png",
        "prompt": "a cat", "random": False, "seed": 7})
    assert r.status_code == 200, r.text
    job = _poll_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    res = job["result"]
    assert res["seed"] == 7 and res["render_path"] == "out.png"
    assert res["recipe"] == "plain-transform.json" and res["masked"] is False
    assert res["image"].startswith("data:image/png;base64,")
    assert client.get("/api/update/jobs/nope").status_code == 404


def test_inpaint_async_flow_bounded_write(roots, client, monkeypatch):
    groot, _lroot = roots
    (groot / "src.png").write_bytes(_png_bytes())
    seen = []
    def fake_inpaint(image_b64, mask_b64, prompt, denoise=0.45, seed=0, timeout=600):
        seen.append((prompt, denoise, seed))
        return _png_bytes()
    monkeypatch.setattr(update_mod._comfy, "comfy_inpaint_klein", fake_inpaint)
    upd_dir = groot / "ellieedit_tmp" / "update"
    before = len(list(upd_dir.iterdir())) if upd_dir.is_dir() else 0
    r = client.post("/api/update/inpaint-async", json={
        "path": "src.png", "prompt": "a red door", "mask_b64": _mask_b64(),
        "denoise": 0.5, "random": False, "seed": 42})
    assert r.status_code == 200, r.text
    job = _poll_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    res = job["result"]
    assert res["seed"] == 42 and res["denoise"] == 0.5
    assert res["recipe"] == "masked-inpaint" and res["masked"] is True
    assert seen[0][0] == "a red door"
    # Exactly ONE bounded result write — no per-poll/per-attempt temp files.
    assert len(list(upd_dir.iterdir())) - before == 1
    assert (groot / res["render_path"]).is_file()


def test_inpaint_empty_mask_rejected(roots, client, monkeypatch):
    groot, _lroot = roots
    (groot / "src.png").write_bytes(_png_bytes())
    monkeypatch.setattr(update_mod._comfy, "comfy_inpaint_klein",
                        lambda *a, **k: _png_bytes())
    r = client.post("/api/update/inpaint-async", json={
        "path": "src.png", "prompt": "x", "mask_b64": _mask_b64(white=False),
        "random": True})
    assert r.status_code == 200
    job = _poll_job(client, r.json()["job_id"])
    assert job["status"] == "error"
    assert "empty" in job["error"]


def test_mask_normalize_and_decode():
    import base64, io
    from PIL import Image
    src = _png_bytes()  # 16x16
    # 8x8 white mask resizes to the 16x16 source.
    buf = io.BytesIO()
    Image.new("L", (8, 8), 255).save(buf, "PNG")
    out = update_mod._normalize_mask(buf.getvalue(), src)
    with Image.open(io.BytesIO(base64.b64decode(out))) as im:
        assert im.size == (16, 16) and im.mode == "L"
    with pytest.raises(Exception):
        update_mod._decode_mask("not-base64!!")
    black_raw = base64.b64decode(_mask_b64(white=False).split(",", 1)[1])
    with pytest.raises(Exception):
        update_mod._normalize_mask(black_raw, src)


def test_comfy_upload_disk_hint(monkeypatch):
    import io as _io
    import urllib.error
    import backend.comfy as comfy_mod
    def boom(req, timeout=60):
        raise urllib.error.HTTPError(
            req.full_url, 500, "Internal Server Error", {},
            _io.BytesIO(b"Server got itself in trouble"))
    monkeypatch.setattr(comfy_mod.urllib.request, "urlopen", boom)
    with pytest.raises(RuntimeError) as ei:
        comfy_mod._comfy_upload(b"fake", "x.png")
    assert "full" in str(ei.value) and "drive" in str(ei.value)


def test_save_family_recipe_noted(roots, client):
    groot, lroot = roots
    make_png(groot / "ellieedit_tmp" / "update_00001_.png")
    make_png(groot / "original.png")
    r = client.post("/api/update/save-family", json={
        "render_path": "ellieedit_tmp/update_00001_.png",
        "original_path": "original.png", "tag": "zengosoft",
        "recipe": "masked-inpaint", "masked": True})
    assert r.status_code == 200, r.text
    recs = [json.loads(l) for l in
            (lroot / ".library-index.jsonl").read_text().splitlines() if l.strip()]
    fam = next(x for x in recs if x.get("kind") == "version-family")
    assert fam["recipe"] == "masked-inpaint" and fam["masked"] is True


def test_update_inpaint_frontend_wiring():
    """Update masked inpaint (2026-10-24): mask editor, masked recipe,
    async submit/poll, denoise slider; FoxDen viewer exposes Update."""
    upd = (REPO / "frontend" / "js" / "modules" / "update.js").read_text()
    for needle in ('upd-mask-canvas', 'inpaint-async', 'run-async',
                   'pollJob', '__masked_inpaint', 'upd-denoise',
                   'masked-inpaint', 'paint a region to regenerate first'):
        assert needle in upd, needle
    fx = (REPO / "frontend" / "js" / "modules" / "foxden.js").read_text()
    assert "{ label: '✎ Update', target: 'update' }" in fx


# ---------------------------------------------------------------------------
# Update tab redesign (2026-10-29): comparer opt-in, mask overlay fix,
# P0 bugs, EXIF orientation, stored-render warning.
# ---------------------------------------------------------------------------

def _rotated_jpeg_bytes():
    """20x10 JPEG with EXIF orientation 6 (rotate 90 CW): displayed 10x20."""
    import io
    from PIL import Image
    buf = io.BytesIO()
    im = Image.new("RGB", (20, 10), (10, 120, 200))
    exif = Image.Exif()
    exif[274] = 6
    im.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


def test_normalize_mask_exif_orientation():
    import base64, io
    from PIL import Image
    src = _rotated_jpeg_bytes()
    # Oriented source is 10x20; a mask painted on the displayed image is too.
    buf = io.BytesIO()
    Image.new("L", (10, 20), 255).save(buf, "PNG")
    out = update_mod._normalize_mask(buf.getvalue(), src)
    with Image.open(io.BytesIO(base64.b64decode(out))) as im:
        assert im.size == (10, 20), im.size
    # And the oriented source itself is 10x20, not the stored 20x10.
    with Image.open(io.BytesIO(update_mod._oriented_png(src))) as im:
        assert im.size == (10, 20), im.size


def test_inpaint_uses_oriented_source(roots, client, monkeypatch):
    import base64, io
    from PIL import Image
    groot, _lroot = roots
    (groot / "src.jpg").write_bytes(_rotated_jpeg_bytes())
    seen = []
    def fake_inpaint(image_b64, mask_b64, prompt, denoise=0.45, seed=0, timeout=600):
        seen.append(image_b64)
        return _png_bytes()
    monkeypatch.setattr(update_mod._comfy, "comfy_inpaint_klein", fake_inpaint)
    r = client.post("/api/update/inpaint-async", json={
        "path": "src.jpg", "prompt": "x", "mask_b64": _mask_b64(),
        "random": False, "seed": 1})
    assert r.status_code == 200, r.text
    job = _poll_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    with Image.open(io.BytesIO(base64.b64decode(seen[0]))) as im:
        assert im.size == (10, 20), im.size


def test_store_update_render_failure_returns_none(monkeypatch):
    # GALLERY_ROOT pointing at a file makes mkdir/write raise OSError.
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", Path("/tmp"))
    # Use a file path as the root via a tmp file instead: mkdir under a
    # file raises NotADirectoryError, a subclass of OSError.
    import tempfile, os
    fd, fpath = tempfile.mkstemp()
    os.close(fd)
    try:
        monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", Path(fpath))
        assert update_mod._store_update_render(b"png") is None
    finally:
        os.unlink(fpath)


def test_update_tab_redesign_frontend_wiring():
    """Comparer opt-in/closed, luminance mask overlay, P0 fixes, cancel."""
    upd = (REPO / "frontend" / "js" / "modules" / "update.js").read_text()
    for needle in ('upd-compare', 'upd-cancel', 'upd-mask-undo',
                   'upd-mask-opacity', 'upd-mask-show', 'compareOn',
                   'this.cmpPct = 100', 'dataset.text',
                   'luminance', 'maskHasWhite', 'jobCancelled',
                   'job timed out after 15 minutes',
                   'render could not be stored'):
        assert needle in upd, needle
    assert 'updateRunEnabled' not in upd, 'dead updateRunEnabled call remains'
    assert "globalCompositeOperation = 'destination-in'" not in upd, \
        'alpha-based mask overlay remains'
