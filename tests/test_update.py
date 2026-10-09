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
