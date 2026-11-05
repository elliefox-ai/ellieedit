"""Issue #14 A1 — unified provenance record.

The shared helper (backend/provenance.py) plus the write paths that
call it: FoxDen recent logging, Update run/inpaint + save-back/save-new/
save-family, Library promote carry, FaceCycle replace-sources, Puppet
render. All tests run against temp roots / temp log files: no test ever
touches the real gallery, dupe, library, or data trees.
"""

import base64
import io
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

os.environ.setdefault("ELLIEEDIT_GALLERY_ROOT", "/tmp/nonexist-gallery")
os.environ.setdefault("ELLIEEDIT_DUPE_ROOT", "/tmp/nonexist-dupes")
os.environ.setdefault("ELLIEEDIT_LIBRARY_ROOT", "/tmp/nonexist-library")

from backend import provenance as prov
import backend.routers.foxden as foxden_mod
import backend.routers.gallery as gallery_mod
import backend.routers.library as library_mod
import backend.routers.update as update_mod
from backend.main import app


@pytest.fixture
def prov_path(tmp_path, monkeypatch):
    """Point the provenance log at a temp file for the whole test."""
    p = tmp_path / "data" / "provenance.jsonl"
    monkeypatch.setenv("ELLIEEDIT_PROVENANCE_PATH", str(p))
    return p


def _png_bytes(color=(10, 120, 200)):
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), color).save(buf, "PNG")
    return buf.getvalue()


def _read_log(p):
    if not p.is_file():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


# ------------------------------------------------------------------ helper

def test_build_record_absent_fields_are_none_not_invented():
    r = prov.build_record("a.png", "foxden")
    assert r["version"] == 1 and r["path"] == "a.png"
    assert r["source_module"] == "foxden" and r["ts"]
    for k in ("prompt", "workflow", "seed", "steps", "width", "height",
              "denoise", "input_image", "parent_image", "sha256"):
        assert r[k] is None, k
    assert r["loras"] == []


def test_build_record_normalises_types():
    class Lo:
        name = "x.safetensors"
        strength_model = 0.5

    r = prov.build_record("a.png", "update", prompt="  ", workflow="klein",
                          seed="42", steps="20", width=1024.5,
                          loras=[{"name": "a.safetensors", "strength_model": 2},
                                 {"name": ""}, Lo(), "junk"],
                          denoise="0.8", extra={"note": "hi", "bad": object()})
    assert r["prompt"] is None and r["seed"] == 42 and r["steps"] == 20
    assert r["width"] == 1024 and r["denoise"] == 0.8
    assert r["loras"] == [{"name": "a.safetensors", "strength_model": 2.0},
                          {"name": "x.safetensors", "strength_model": 0.5}]
    assert r["note"] == "hi" and "bad" not in r and "extra" not in r


def test_append_read_latest_round_trip_and_corrupt_lines(prov_path):
    assert prov.read_records() == []
    prov.record_for_image("a.png", "foxden", prompt="one", seed=1)
    prov.record_for_image("a.png", "foxden", prompt="two", seed=2)
    prov.record_for_image("b.png", "update", prompt="three")
    prov_path.write_text(prov_path.read_text() + "not json\n\n")
    recs = prov.read_records()
    assert [r["prompt"] for r in recs] == ["one", "two", "three"]
    assert prov.latest_for_path("a.png")["prompt"] == "two"
    assert prov.latest_for_path("missing.png") is None


def test_append_failure_never_raises(tmp_path, monkeypatch):
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    monkeypatch.setenv("ELLIEEDIT_PROVENANCE_PATH",
                       str(blocker / "provenance.jsonl"))
    assert prov.append_record(prov.build_record("a.png", "foxden")) is False
    # and the record itself is still returned to the caller
    assert prov.record_for_image("a.png", "foxden", prompt="p")["prompt"] == "p"


def test_carry_copies_recipe_sets_parent_drops_input(prov_path):
    prov.record_for_image("src.png", "foxden", prompt="lantern",
                          workflow="klein", seed=7, steps=20,
                          width=1024, height=576,
                          loras=[{"name": "a", "strength_model": 1.0}],
                          denoise=0.9, input_image="in.png")
    rec = prov.carry(["src.png"], "dst.png", "update-save-new")
    assert rec["prompt"] == "lantern" and rec["seed"] == 7
    assert rec["parent_image"] == "src.png"
    assert rec["input_image"] is None          # parent's input is not ours
    assert rec["source_module"] == "update-save-new"
    assert prov.latest_for_path("dst.png")["prompt"] == "lantern"


def test_carry_without_parent_record_is_absent_not_invented(prov_path):
    rec = prov.carry(["ghost.png"], "dst.png", "update-save-back")
    assert rec["parent_image"] == "ghost.png"
    assert rec["prompt"] is None and rec["seed"] is None and rec["loras"] == []


def test_recipe_fields_empty_without_record():
    assert prov.recipe_fields(None) == {}
    assert prov.recipe_fields({"prompt": "x", "seed": 1, "path": "a.png"}) == {
        "prompt": "x", "workflow": None, "seed": 1, "steps": None,
        "width": None, "height": None, "loras": [], "denoise": None,
        "input_image": None}


# ------------------------------------------------------------------ FoxDen

def test_foxden_log_recent_writes_provenance(tmp_path, monkeypatch, prov_path):
    monkeypatch.setenv("ELLIEEDIT_FOXDEN_DATA", str(tmp_path / "foxden-data"))
    foxden_mod._pending_meta.clear()
    foxden_mod._logged.clear()
    foxden_mod._pending_meta["pid-1"] = {
        "prompt": "a lantern", "workflow": "klein", "seed": 7,
        "width": 1024, "height": 576, "steps": 20,
        "loras": [{"name": "a.safetensors", "strength_model": 0.8}],
        "suspended_loras": [], "denoise": 1.0, "input_image": "in.png",
        "parent_image": "gallery/in.png", "submitted": 0}
    foxden_mod._log_recent("pid-1", [{"filename": "foxden_00001_.png",
                                      "subfolder": "", "type": "output"}])
    recs = _read_log(prov_path)
    assert len(recs) == 1
    r = recs[0]
    assert r["path"] == "foxden_00001_.png" and r["source_module"] == "foxden"
    assert r["prompt"] == "a lantern" and r["seed"] == 7
    assert r["parent_image"] == "gallery/in.png"
    assert r["loras"] == [{"name": "a.safetensors", "strength_model": 0.8}]


# ------------------------------------------------------------------ Update

@pytest.fixture
def roots(tmp_path, monkeypatch):
    groot, droot, lroot = (tmp_path / "gallery", tmp_path / "dupes",
                          tmp_path / "library")
    groot.mkdir()
    droot.mkdir()
    lroot.mkdir()
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", groot)
    monkeypatch.setattr(library_mod, "LIBRARY_ROOT", lroot)
    monkeypatch.setattr(update_mod, "_library_mod", library_mod)
    return groot, lroot


@pytest.fixture
def client():
    return TestClient(app)


def _make_png(p: Path):
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), (200, 10, 10)).save(p)


def test_update_run_writes_provenance(roots, monkeypatch, prov_path):
    groot, _lroot = roots
    _make_png(groot / "src.png")
    _make_png(groot / "ellieedit_tmp" / "out.png")
    monkeypatch.setattr(update_mod._comfy, "_comfy_upload",
                        lambda b, n: "src.png")
    monkeypatch.setattr(update_mod, "comfy_submit", lambda wf: "pid-1")
    monkeypatch.setattr(update_mod, "comfy_poll",
                        lambda pid: {"filename": "out.png",
                                     "subfolder": "ellieedit_tmp",
                                     "type": "output"})
    monkeypatch.setattr(update_mod, "comfy_fetch_image",
                        lambda im: _png_bytes())
    body = update_mod.RunBody(preset="plain-transform.json", path="src.png",
                              prompt="a cat on a roof", random=False, seed=999)
    out = update_mod._execute_run(body)
    assert out["render_path"] == "ellieedit_tmp/out.png"
    recs = _read_log(prov_path)
    assert len(recs) == 1
    r = recs[0]
    assert r["path"] == "ellieedit_tmp/out.png" and r["source_module"] == "update"
    assert r["prompt"] == "a cat on a roof" and r["seed"] == 999
    assert r["workflow"] == "plain-transform.json"
    assert r["parent_image"] == "src.png"
    # preset graphs expose no standard steps/size/loras: absent, not invented
    assert r["steps"] is None and r["width"] is None and r["loras"] == []


def test_update_inpaint_writes_provenance(roots, monkeypatch, prov_path):
    groot, _lroot = roots
    _make_png(groot / "src.png")
    mask = io.BytesIO()
    Image.new("L", (16, 16), 255).save(mask, "PNG")
    monkeypatch.setattr(
        update_mod._comfy, "comfy_inpaint_klein",
        lambda *a, **kw: _png_bytes((1, 2, 3)))
    out = update_mod._execute_inpaint(update_mod.InpaintBody(
        path="src.png", prompt="fill the roof",
        mask_b64=base64.b64encode(mask.getvalue()).decode(),
        random=False, seed=5, denoise=0.45))
    assert out["render_path"] and out["render_path"].startswith("ellieedit_tmp/update/")
    r = prov.latest_for_path(out["render_path"])
    assert r is not None and r["workflow"] == "masked-inpaint"
    assert r["prompt"] == "fill the roof" and r["seed"] == 5
    assert r["denoise"] == 0.45 and r["parent_image"] == "src.png"


def test_save_back_and_save_new_carry_recipe(roots, prov_path):
    groot, _lroot = roots
    _make_png(groot / "ellieedit_tmp" / "render.png")
    _make_png(groot / "source.png")
    prov.record_for_image("ellieedit_tmp/render.png", "update",
                          prompt="lantern", workflow="klein", seed=3)
    out = update_mod.save_back("ellieedit_tmp/render.png", "source.png")
    assert out["ok"] and out["overwritten"] == "source.png"
    r = prov.latest_for_path("source.png")
    assert r["prompt"] == "lantern" and r["seed"] == 3
    assert r["parent_image"] == "ellieedit_tmp/render.png"
    assert r["source_module"] == "update-save-back"
    out = update_mod.save_new("ellieedit_tmp/render.png", "source.png")
    assert out["ok"] and out["new_path"] == "source-update.png"
    r = prov.latest_for_path("source-update.png")
    assert r["prompt"] == "lantern" and r["source_module"] == "update-save-new"


def test_save_family_embeds_provenance_in_library_index(roots, prov_path):
    groot, lroot = roots
    _make_png(groot / "ellieedit_tmp" / "render.png")
    _make_png(groot / "original.png")
    prov.record_for_image("ellieedit_tmp/render.png", "update",
                          prompt="lantern", workflow="klein", seed=3)
    out = update_mod.save_family("ellieedit_tmp/render.png", "original.png",
                                 "zengosoft", recipe="plain-transform")
    assert out["ok"]
    recs = [json.loads(l) for l in
            (lroot / ".library-index.jsonl").read_text().splitlines() if l.strip()]
    finals = [r for r in recs if r.get("kind") == "version-family"]
    assert len(finals) == 1
    assert finals[0]["provenance"]["prompt"] == "lantern"
    assert finals[0]["provenance"]["seed"] == 3
    assert finals[0]["provenance"]["path"] == finals[0]["path"]
    # the travelling original keeps the source's recipe too (via carry)
    orig = prov.latest_for_path(out["original"])
    assert orig is not None and orig["parent_image"] == "original.png"


# ------------------------------------------------------------------ Library

def test_promote_carries_recipe_from_provenance_log(roots, prov_path):
    groot, lroot = roots
    _make_png(groot / "a.png")
    prov.record_for_image("a.png", "foxden", prompt="lantern",
                          workflow="klein", seed=7)
    rec = library_mod.promote_move(groot / "a.png", "zengosoft")
    assert rec["provenance"]["prompt"] == "lantern"
    assert rec["provenance"]["seed"] == 7
    assert rec["provenance"]["path"] == rec["path"]
    assert rec["provenance"]["parent_image"] == "a.png"
    assert not (groot / "a.png").exists()      # still a move, not a copy
    logged = prov.latest_for_path(rec["path"])
    assert logged is not None and logged["prompt"] == "lantern"


def test_promote_without_recipe_has_no_provenance_field(roots, prov_path):
    groot, lroot = roots
    _make_png(groot / "plain.png")
    rec = library_mod.promote_move(groot / "plain.png", "zengosoft")
    assert "provenance" not in rec
    assert prov.read_records() == []


# ---------------------------------------------------------------- FaceCycle

def test_facecycle_replace_sources_writes_provenance(tmp_path, monkeypatch,
                                                    prov_path, client):
    import backend.routers.pending as pending_mod
    groot = tmp_path / "gallery"
    for rel, color in (("a/one.png", (200, 0, 0)), ("b/two.png", (0, 200, 0))):
        _make_png(groot / rel)
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", groot)
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    monkeypatch.setattr(pending_mod, "AUDIT", tmp_path / "audit.jsonl")
    img = _png_bytes((1, 2, 3))
    r = client.post("/api/facecycle/replace-sources", json={
        "image_b64": base64.b64encode(img).decode(), "kind": "gallery",
        "base": "a/one.png", "sources": ["a/one.png", "b/two.png"]})
    assert r.status_code == 200, r.text
    rec = prov.latest_for_path(r.json()["saved_as"])
    assert rec is not None and rec["source_module"] == "facecycle"
    assert rec["parent_image"] == "a/one.png"
    assert rec["prompt"] is None and rec["seed"] is None
    assert rec["sources"] == ["a/one.png", "b/two.png"]


# ------------------------------------------------------------------- Puppet

def _two_layer_project(client):
    pid = client.post("/api/puppet/projects", json={"name": "Show"}).json()["id"]

    def add(kind, color):
        r = client.post(f"/api/puppet/projects/{pid}/assets", json={
            "kind": kind,
            "image_b64": base64.b64encode(_png_bytes(color)).decode()})
        assert r.status_code == 201, r.text
        return r.json()["file"]

    red = add("cutout", (255, 0, 0))
    blue = add("cutout", (0, 0, 255))
    state = {"name": "Comp", "canvas": {"width": 40, "height": 40,
                                         "background": {"type": "none",
                                                        "asset": None}},
             "layers": [{"id": "red", "asset": red, "x": 0, "y": 0,
                         "w": 20, "h": 20},
                        {"id": "blue", "asset": blue, "x": 10, "y": 10,
                         "w": 20, "h": 20}]}
    client.put(f"/api/puppet/projects/{pid}", json={"state": state})
    return pid


def test_puppet_render_writes_provenance(tmp_path, monkeypatch, prov_path,
                                         client):
    monkeypatch.setenv("ELLIEEDIT_PUPPET_DATA", str(tmp_path / "puppet-data"))

    def fake_repaint(image_b64, mask_b64, prompt, denoise=0.5, seed=0,
                     timeout=600):
        return _png_bytes((9, 9, 9))

    monkeypatch.setattr("backend.comfy.comfy_repaint", fake_repaint)
    monkeypatch.setattr("backend.comfy.comfy_repaint_klein", fake_repaint)
    pid = _two_layer_project(client)
    r = client.post(f"/api/puppet/projects/{pid}/render",
                    json={"prompt": "golden hour", "denoise": 0.5, "seed": 7})
    assert r.status_code == 200, r.text
    asset_name = r.json()["render_asset"]
    assert asset_name and asset_name.startswith("render-")
    rec = prov.latest_for_path(f"projects/{pid}/assets/{asset_name}")
    assert rec is not None and rec["source_module"] == "puppet"
    assert rec["prompt"] == "golden hour" and rec["seed"] == 7
    assert rec["workflow"] == "klein" and rec["project"] == pid
