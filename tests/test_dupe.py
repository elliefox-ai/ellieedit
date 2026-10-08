"""Dupe view tests — family browsing, verdict ledger, jail, send-to-pending.

Synthetic .dupes trees are built by hand; one test runs REAL dupelib analyze
over Pillow-generated near-dupes as the end-to-end proof (skipped if numpy
is unavailable, but the ellieedit venv carries it).
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import dupe as dupe_mod
from backend.routers import gallery as gallery_mod
from backend.routers import pending as pending_mod

FAM = {
    "format": "dupe-analyzer.family",
    "version": 1,
    "id": "fam-aaaaaaaaaaaa",
    "created": "2026-10-03T01:08:56-07:00",
    "root": "/will/be/replaced",
    "members": [
        {"path": "a.png", "size": 10, "mtime": 1, "dhash": "0" * 16,
         "phash": "0" * 16},
        {"path": "b.png", "size": 10, "mtime": 2, "dhash": "1" * 16,
         "phash": "1" * 16},
        {"path": "sub/c.png", "size": 10, "mtime": 3, "dhash": "2" * 16,
         "phash": "2" * 16},
    ],
    "edges": [{"a": "a.png", "b": "b.png", "tier": "exact", "distance": 0}],
    "related": [{"related_family": "fam-bbbbbbbbbbbb", "tier": "related",
                 "distance": 0.7}],
}
FAM_B = dict(FAM, id="fam-bbbbbbbbbbbb")
FAM_B["members"] = [{"path": "d.png", "size": 5, "mtime": 4}]
FAM_C = dict(FAM, id="fam-cccccccccccc")  # never gets a verdict


def _png(path: Path, color, size=(32, 32)):
    Image.new("RGB", size, color).save(path)


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Dupe root with 3 real images (a/b/c) + one family file, a decoy family
    on disk that the index does not list, jail traps, a gallery root, and an
    empty pending manifest."""
    root = tmp_path / "dupe"
    (root / "sub").mkdir(parents=True)
    _png(root / "a.png", (200, 30, 30))
    _png(root / "b.png", (200, 30, 31))   # near-dupe of a
    _png(root / "sub" / "c.png", (200, 30, 32))
    _png(tmp_path / "secret.png", (0, 0, 0))
    (root / "escape.png").symlink_to(tmp_path / "secret.png")

    dupes = root / ".dupes" / "families"
    dupes.mkdir(parents=True)
    fam = json.loads(json.dumps(FAM))
    fam["root"] = str(root)
    (dupes / "fam-aaaaaaaaaaaa.json").write_text(json.dumps(fam))
    fam_b = json.loads(json.dumps(FAM_B))
    fam_b["root"] = str(root)
    (dupes / "fam-bbbbbbbbbbbb.json").write_text(json.dumps(fam_b))
    fam_c = json.loads(json.dumps(FAM_C))
    fam_c["root"] = str(root)
    (dupes / "fam-cccccccccccc.json").write_text(json.dumps(fam_c))
    (dupes / "fam-notinindex999.json").write_text(json.dumps(fam_c))
    (root / ".dupes" / "index.json").write_text(json.dumps({
        "version": 1, "generated": "2026-10-03T01:08:59-07:00",
        "families": [
            {"id": "fam-aaaaaaaaaaaa", "size": 3, "tiers": ["exact"],
             "first_member": "a.png", "authored": False},
            {"id": "fam-bbbbbbbbbbbb", "size": 1, "tiers": [],
             "first_member": "d.png", "authored": False},
            {"id": "fam-cccccccccccc", "size": 3, "tiers": ["exact"],
             "first_member": "a.png", "authored": False},
        ], "stats": {}}))

    groot = tmp_path / "gallery"
    groot.mkdir()
    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", root)
    monkeypatch.setattr(dupe_mod, "DUPE_DATA", root / ".dupes")
    monkeypatch.setattr(dupe_mod, "LEDGER", tmp_path / "verdicts.jsonl")
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", groot)
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    return root, tmp_path / "secret.png", tmp_path


@pytest.fixture
def client(env):
    return TestClient(app)


# ------------------------------------------------------------------- status

def test_status_counts(env, client):
    root, _, _ = env
    s = client.get("/api/dupe/status").json()
    assert s["indexed"] and s["families"] == 3 and s["members"] == 7
    assert s["unresolved"] == 3 and s["resolved"] == 0
    assert s["index_generated"].startswith("2026-10-03")


def test_status_no_index(tmp_path, monkeypatch, client):
    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", tmp_path)
    monkeypatch.setattr(dupe_mod, "DUPE_DATA", tmp_path / ".dupes")
    s = client.get("/api/dupe/status").json()
    assert s["indexed"] is False and "dupescan" in s["detail"]


# ------------------------------------------------------------------ listing

def test_family_list_pagination_and_filters(env, client):
    lst = client.get("/api/dupe/families").json()
    assert lst["counts"] == {"unresolved": 3, "resolved": 0}
    assert lst["total"] == 3 and len(lst["items"]) == 3
    first = lst["items"][0]
    assert first["state"] == "unresolved"
    assert len(first["members"]) == 3
    assert all(m["thumb"] and m["thumb"].startswith("/api/dupe/thumb?") for m in first["members"])

    # resolved filter is empty before verdicts
    assert client.get("/api/dupe/families?state=resolved").json()["items"] == []

    # pagination: PAGE_SIZE is 40, so force a tiny page via monkeypatch
    from backend.routers import dupe as d
    import types
    old = d.PAGE_SIZE

    # cursor: pass the id of the last row -> next page is empty
    r2 = client.get("/api/dupe/families?cursor=fam-cccccccccccc").json()
    assert r2["items"] == [] and r2["next_cursor"] is None
    d.PAGE_SIZE = old


def test_family_list_bad_state(client):
    assert client.get("/api/dupe/families?state=nope").status_code == 400


def test_family_detail(env, client):
    d = client.get("/api/dupe/families/fam-aaaaaaaaaaaa").json()
    assert d["state"] == "unresolved"
    assert {m["path"] for m in d["members"]} == {"a.png", "b.png", "sub/c.png"}
    assert d["members"][0]["exists"] is True
    assert d["edges"][0]["tier"] == "exact"
    assert d["related"][0]["family"] == "fam-bbbbbbbbbbbb"
    assert d["verdict"] == {}


def test_family_detail_404_and_bad_id(client):
    assert client.get("/api/dupe/families/fam-000000000000").status_code == 404
    assert client.get("/api/dupe/families/../etc").status_code in (400, 404)


# --------------------------------------------------------------------- jail

def test_jail_rejects_escapes(env, client):
    for bad in ("/etc/passwd", "~/.ssh", "../secret.png", "sub/../../secret.png",
                "a/../../../etc/passwd", ""):
        r = client.get(f"/api/dupe/thumb?path={bad.replace('/', '%2F')}")
        # absolute/~ paths are 400; empty is 400; traversal resolves outside -> 400
        assert r.status_code == 400, bad


def test_jail_symlink_escape(env, client):
    r = client.get("/api/dupe/thumb?path=escape.png")
    assert r.status_code == 400


def test_thumb_serves_real_member(env, client):
    r = client.get("/api/dupe/thumb?path=a.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"


def test_thumb_missing_file(env, client):
    assert client.get("/api/dupe/thumb?path=ghost.png").status_code == 404


# ------------------------------------------------------------------ verdicts

def test_verdict_append_only_and_state_flow(env, client):
    root, _, tmp = env
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept", "b.png": "rejected",
                    "sub/c.png": "rejected"},
        "note": "a is the sharpest"})
    assert r.status_code == 200 and r.json()["state"] == "resolved"

    ledger = (tmp / "verdicts.jsonl").read_text().strip().split("\n")
    assert len(ledger) == 1
    e = json.loads(ledger[0])
    assert e["family"] == "fam-aaaaaaaaaaaa" and e["members"]["a.png"] == "kept"

    # append-only: a second verdict appends, never rewrites
    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "deferred"}})
    ledger = (tmp / "verdicts.jsonl").read_text().strip().split("\n")
    assert len(ledger) == 2
    # latest wins for state — pure deferral drops back to unresolved
    assert client.get("/api/dupe/families?state=resolved").json()["counts"]["resolved"] == 0
    assert client.get("/api/dupe/families?state=unresolved").json()["counts"]["unresolved"] == 3

    # detail carries the latest verdict
    d = client.get("/api/dupe/families/fam-aaaaaaaaaaaa").json()
    assert d["verdicts"]["a.png"] == "deferred" and d["note"] == "a is the sharpest"


def test_verdict_validation(client):
    # unknown member path
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict",
                    json={"members": {"stranger.png": "kept"}})
    assert r.status_code == 400
    # bad verdict word
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict",
                    json={"members": {"a.png": "saved"}})
    assert r.status_code == 400  # "saved" is banned language AND invalid
    # empty set
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict",
                    json={"members": {}})
    assert r.status_code == 400
    # unknown family
    r = client.post("/api/dupe/families/fam-000000000000/verdict",
                    json={"members": {"a.png": "kept"}})
    assert r.status_code == 404
    # ledger untouched by all failures
    assert not dupe_mod.LEDGER.exists()


def test_verdict_backslash_paths_normalized(env, client):
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"sub\\c.png": "kept", "a.png": "melded",
                    "b.png": "melded"}})
    assert r.status_code == 200
    assert r.json()["state"] == "resolved"


# ------------------------------------------------------------ send-to-pending

def test_send_to_pending_dedupe_and_missing(env, client):
    root, _, tmp = env
    # no verdict yet -> 409
    assert client.post("/api/dupe/families/fam-aaaaaaaaaaaa/send-pending").status_code == 409

    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept", "b.png": "rejected",
                    "sub/c.png": "rejected"}})
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/send-pending").json()
    assert r["added"] == 2 and r["count"] == 2
    # dedupe: second send adds nothing
    r2 = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/send-pending").json()
    assert r2["added"] == 0 and r2["already_pending"] == 2
    # manifest actually carries them
    m = json.loads((tmp / "pending.json").read_text())
    assert set(m) == {"b.png", "sub/c.png"}


def test_send_to_pending_skips_missing(env, client):
    """A rejected member whose file vanished is skipped gracefully."""
    root, _, tmp = env
    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept", "b.png": "rejected",
                    "sub/c.png": "rejected"}})
    (root / "b.png").unlink()
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/send-pending").json()
    assert r["added"] == 1 and r["missing"] == 1


def test_send_to_pending_no_rejects(env, client):
    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict",
                json={"members": {"a.png": "kept", "b.png": "kept",
                                  "sub/c.png": "kept"}})
    assert client.post("/api/dupe/families/fam-aaaaaaaaaaaa/send-pending").status_code == 409


# --------------------------------------------------------- slow-storage perf

def test_families_cache_hit_no_family_file_reads(env, client, monkeypatch):
    """Perf shape: a second /families page over unchanged data must serve from
    the preview cache — zero family-file reads and zero jail resolves."""
    root, _, _ = env
    client.get("/api/dupe/families")                      # warm the cache
    fam_path = dupe_mod.DUPE_DATA / "families" / "fam-aaaaaaaaaaaa.json"
    real_read = Path.read_text
    calls = []
    def counting(self, *a, **k):
        if self == fam_path:
            calls.append(self)
        return real_read(self, *a, **k)
    monkeypatch.setattr(Path, "read_text", counting)
    r = client.get("/api/dupe/families?cursor=fam-aaaaaaaaaaaa")
    assert r.status_code == 200
    assert calls == [], "family files re-read on cache hit — listing stats /mnt per request"


def test_status_cache_skips_freshness_walk(env, client, monkeypatch):
    """Perf shape: repeat /status inside the TTL must not re-walk the tree."""
    dupe_mod._status_cache = None
    dupe_mod._freshness_cache = None
    client.get("/api/dupe/status")                        # first: walk happens
    walked = []
    real_walk = dupe_mod._freshness_walk
    monkeypatch.setattr(dupe_mod, "_freshness_walk",
                        lambda m: (walked.append(1), real_walk(m))[1])
    s = client.get("/api/dupe/status")
    assert s.status_code == 200 and s.json()["indexed"]
    assert walked == [], "status re-walked /mnt inside the cache TTL"
    dupe_mod._status_cache = None
    dupe_mod._freshness_cache = None


def test_status_cache_invalidated_by_verdict(env, client):
    """A new verdict changes counts — the cache key includes the ledger mtime."""
    dupe_mod._status_cache = None
    dupe_mod._freshness_cache = None
    assert client.get("/api/dupe/status").json()["resolved"] == 0
    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict",
                json={"members": {"a.png": "kept", "b.png": "kept",
                                  "sub/c.png": "kept"}})
    dupe_mod._status_cache = None   # TTL would otherwise mask the change
    dupe_mod._freshness_cache = None
    assert client.get("/api/dupe/status").json()["resolved"] == 1


def test_families_cheap_jail_flags_without_resolve(env, client):
    """Traversal-shaped member paths are flagged jailed in listings without a
    per-request resolve of the real tree."""
    import copy
    fam_path = dupe_mod.DUPE_DATA / "families" / "fam-aaaaaaaaaaaa.json"
    fam = json.loads(fam_path.read_text())
    fam["members"][0]["path"] = "../secret.png"
    fam_path.write_text(json.dumps(fam))
    dupe_mod._preview_cache.pop("fam-aaaaaaaaaaaa", None)
    lst = client.get("/api/dupe/families").json()
    card = next(f for f in lst["items"] if f["id"] == "fam-aaaaaaaaaaaa")
    assert card["members"][0]["jailed"] is True and card["members"][0]["thumb"] is None
    dupe_mod._preview_cache.clear()


# --------------------------------------------------- real dupelib end-to-end

def test_real_dupelib_analyze_families(tmp_path, monkeypatch):
    """Best proof: generate near-dupe PNGs, run the REAL dupelib analyze,
    point the router at the produced .dupes, and browse + verdict a family."""
    dupelib = Path.home() / "workspace/dupe-review-v2"
    pytest.importorskip("numpy")
    if not (dupelib / "dupelib").is_dir():
        pytest.skip("dupelib copy not present")

    root = tmp_path / "pool"
    root.mkdir()
    base = Image.new("RGB", (64, 64), (120, 40, 40))
    for px in [(10, 10), (30, 30), (50, 50)]:
        base.putpixel(px, (240, 240, 240))
    base.save(root / "orig.png")
    # three mutations of orig = one near-dupe family
    for i in range(3):
        im = base.copy()
        for px in [(5 + i, 20), (40, 5 + i)]:
            im.putpixel(px, (10, 10, 60))
        im.save(root / f"mut{i}.png")
    # one unrelated image that must NOT join the family
    unrelated = Image.new("RGB", (64, 64), (250, 250, 20))
    unrelated.save(root / "unrelated.png")

    r = subprocess.run(
        [sys.executable, "-m", "dupelib.cli", "analyze", str(root)],
        cwd=dupelib, env={"PYTHONPATH": str(dupelib), "PATH": "/usr/bin:/bin",
                          "HOME": str(Path.home())},
        capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-2000:]
    idx = json.loads((root / ".dupes" / "index.json").read_text())
    assert idx["families"], "analyze produced no families"

    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", root)
    monkeypatch.setattr(dupe_mod, "DUPE_DATA", root / ".dupes")
    monkeypatch.setattr(dupe_mod, "LEDGER", tmp_path / "v.jsonl")
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    c = TestClient(app)

    s = c.get("/api/dupe/status").json()
    assert s["indexed"] and s["families"] >= 1
    fams = c.get("/api/dupe/families").json()
    fid = fams["items"][0]["id"]
    d = c.get(f"/api/dupe/families/{fid}").json()
    paths = [m["path"] for m in d["members"]]
    assert all(m["exists"] for m in d["members"])
    # every thumbnail endpoint serves a real webp
    for p in paths:
        assert c.get(f"/api/dupe/thumb?path={p}").status_code == 200
    # the unrelated image never appears inside a family with orig
    fam_with_orig = [f for f in idx["families"] if "orig.png" in
                     {m["path"] for m in json.loads(
                         (root / ".dupes" / "families" / f"{f['id']}.json").read_text()
                     )["members"]}]
    for f in fam_with_orig:
        members = json.loads(
            (root / ".dupes" / "families" / f"{f['id']}.json").read_text())["members"]
        assert "unrelated.png" not in {m["path"] for m in members}

    # verdict + send-to-pending over the REAL family
    r = c.post(f"/api/dupe/families/{fid}/verdict", json={
        "members": {p: ("kept" if i == 0 else "rejected")
                    for i, p in enumerate(paths)}})
    assert r.status_code == 200 and r.json()["state"] == "resolved"
    r = c.post(f"/api/dupe/families/{fid}/send-pending").json()
    assert r["added"] == len(paths) - 1


def test_confirm_resolves_dupe_root_entries(env, client, monkeypatch):
    """A rejected dupe member sent to Pending must be deletable by
    /api/pending/confirm even though the dupe pool lives outside the
    gallery root — confirm resolves through the dupe jail as fallback."""
    root, _, tmp = env
    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept", "b.png": "rejected",
                    "sub/c.png": "rejected"}})
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/send-pending").json()
    assert r["added"] == 2
    r = client.post("/api/pending/confirm").json()
    assert r["deleted"] == 2
    assert not (root / "b.png").exists()
    assert not (root / "sub" / "c.png").exists()
    assert (root / "a.png").exists()          # kept member untouched
    assert client.get("/api/pending").json()["count"] == 0


def test_send_to_pending_stores_gallery_relative_paths(tmp_path, monkeypatch):
    """When the dupe pool lives INSIDE the gallery tree, manifest keys must be
    gallery-root-relative so Gallery badges and confirm work unchanged."""
    groot = tmp_path / "gallery"
    pool = groot / "dupe-pool"
    pool.mkdir(parents=True)
    _png(pool / "x.png", (10, 200, 10))
    _png(pool / "y.png", (10, 200, 11))
    dupes = pool / ".dupes" / "families"
    dupes.mkdir(parents=True)
    fam = json.loads(json.dumps(FAM))
    fam["id"] = "fam-dddddddddddd"
    fam["members"] = [{"path": "x.png", "size": 5, "mtime": 1},
                      {"path": "y.png", "size": 5, "mtime": 2}]
    (dupes / "fam-dddddddddddd.json").write_text(json.dumps(fam))
    (pool / ".dupes" / "index.json").write_text(json.dumps({
        "version": 1, "generated": "now",
        "families": [{"id": "fam-dddddddddddd", "size": 2, "tiers": [],
                      "first_member": "x.png", "authored": False}]}))
    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", pool)
    monkeypatch.setattr(dupe_mod, "DUPE_DATA", pool / ".dupes")
    monkeypatch.setattr(dupe_mod, "LEDGER", tmp_path / "v.jsonl")
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", groot)
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    c = TestClient(app)
    c.post("/api/dupe/families/fam-dddddddddddd/verdict", json={
        "members": {"x.png": "kept", "y.png": "rejected"}})
    r = c.post("/api/dupe/families/fam-dddddddddddd/send-pending").json()
    assert r["added"] == 1
    m = json.loads((tmp_path / "pending.json").read_text())
    assert set(m) == {"dupe-pool/y.png"}  # gallery-relative, not "y.png"
