"""FaceCycle 'Replace sources' — result next to base, sources to the queue."""

import base64
import json
import struct

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import dupe as dupe_mod
from backend.routers import gallery as gallery_mod
from backend.routers import pending as pending_mod


def _png(path, color):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color).save(path)


def _b64(tmp_path):
    p = tmp_path / "result.png"
    Image.new("RGB", (16, 16), (1, 2, 3)).save(p)
    return base64.b64encode(p.read_bytes()).decode()


@pytest.fixture
def env(tmp_path, monkeypatch):
    groot = tmp_path / "gallery"
    _png(groot / "a" / "one.png", (200, 0, 0))
    _png(groot / "b" / "two.png", (0, 200, 0))
    droot = tmp_path / "dupe"
    _png(droot / "x.png", (9, 9, 9))
    _png(droot / "sub" / "y.png", (8, 8, 8))
    fams = droot / ".dupes" / "families"
    fams.mkdir(parents=True)
    (fams / "fam-aaaaaaaaaaaa.json").write_text(json.dumps({
        "format": "dupe-analyzer.family", "version": 1,
        "id": "fam-aaaaaaaaaaaa", "root": str(droot), "edges": [], "related": [],
        "members": [{"path": "x.png", "size": 1, "mtime": 1},
                    {"path": "sub/y.png", "size": 1, "mtime": 2}]}))
    (droot / ".dupes" / "index.json").write_text(json.dumps({
        "version": 1, "generated": "2026-10-03T01:08:59-07:00", "stats": {},
        "families": [{"id": "fam-aaaaaaaaaaaa", "size": 2, "tiers": [],
                      "first_member": "x.png", "authored": False}]}))
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", groot)
    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", droot)
    monkeypatch.setattr(dupe_mod, "DUPE_DATA", droot / ".dupes")
    monkeypatch.setattr(dupe_mod, "LEDGER", tmp_path / "verdicts.jsonl")
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    monkeypatch.setattr(pending_mod, "AUDIT", tmp_path / "audit.jsonl")
    return groot, droot, tmp_path


@pytest.fixture
def client(env):
    return TestClient(app)


def test_gallery_result_lands_in_base_folder_sources_queued(env, client):
    groot, _, tmp = env
    r = client.post("/api/facecycle/replace-sources", json={
        "image_b64": _b64(tmp), "kind": "gallery", "base": "b/two.png",
        "sources": ["a/one.png", "b/two.png"]})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["saved_as"] == "b/two-fc.png"           # next to the BASE, not a/
    saved = groot / j["saved_as"]
    assert saved.is_file()
    assert (groot / "a" / "one.png").exists()        # nothing unlinked here
    assert set(pending_mod.load_manifest()) == {"a/one.png", "b/two.png"}
    assert "two-fc.png" not in "".join(pending_mod.load_manifest())
    # metadata is best-effort but present: PNG still opens, tEXt carries sources
    assert Image.open(saved).size == (16, 16)
    meta = json.loads(Image.open(saved).text["ellieedit"])
    assert meta["sources"] == ["one.png", "two.png"] and meta["base"] == "two.png"
    # never overwrites: a second run gets -2
    j2 = client.post("/api/facecycle/replace-sources", json={
        "image_b64": _b64(tmp), "kind": "gallery", "base": "b/two.png",
        "sources": ["b/two.png"]}).json()
    assert j2["saved_as"] == "b/two-fc-2.png"


def test_dupe_family_ledger_and_queue(env, client):
    _, droot, tmp = env
    r = client.post("/api/facecycle/replace-sources", json={
        "image_b64": _b64(tmp), "kind": "dupe", "family": "fam-aaaaaaaaaaaa",
        "base": "sub/y.png", "sources": ["x.png", "sub/y.png"]})
    assert r.status_code == 200, r.text
    assert (droot / "sub" / "y-fc.png").is_file()
    assert set(pending_mod.load_manifest()) == {"x.png", "sub/y.png"}
    e = [json.loads(l) for l in dupe_mod.LEDGER.read_text().splitlines()][-1]
    assert e["family"] == "fam-aaaaaaaaaaaa"
    assert e["members"] == {"x.png": "kept", "sub/y.png": "kept"}
    assert e["meld_result"]


@pytest.mark.parametrize("body,code", [
    ({"kind": "nope", "base": "a/one.png", "sources": ["a/one.png"]}, 400),
    ({"kind": "gallery", "base": "b/two.png", "sources": ["a/one.png"]}, 400),
    ({"kind": "gallery", "base": "../x.png", "sources": ["../x.png"]}, 400),
    ({"kind": "gallery", "base": "a/gone.png", "sources": ["a/gone.png"]}, 404),
    ({"kind": "gallery", "base": "a/one.png", "sources": []}, 400),
    ({"kind": "dupe", "base": "x.png", "sources": ["x.png"]}, 400),   # no family
    ({"kind": "dupe", "family": "fam-aaaaaaaaaaaa", "base": "x.png",
      "sources": ["x.png", "a/one.png"]}, 400),                        # not member
    ({"kind": "dupe", "family": "fam-ffffffffffff", "base": "x.png",
      "sources": ["x.png"]}, 404),
])
def test_rejections_write_and_queue_nothing(env, client, body, code):
    groot, _, tmp = env
    r = client.post("/api/facecycle/replace-sources",
                    json={"image_b64": _b64(tmp), **body})
    assert r.status_code == code, r.text
    assert pending_mod.load_manifest() == {}
    assert not list(groot.rglob("*-fc*.png"))


def test_not_a_png_rejected(env, client):
    r = client.post("/api/facecycle/replace-sources", json={
        "image_b64": base64.b64encode(b"x" * 64).decode(), "kind": "gallery",
        "base": "a/one.png", "sources": ["a/one.png"]})
    assert r.status_code == 400 and pending_mod.load_manifest() == {}
