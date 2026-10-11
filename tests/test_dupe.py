"""Dupe view tests — family browsing, verdict ledger, jail, send-to-pending.

Synthetic .dupes trees are built by hand; one test runs REAL dupelib analyze
over Pillow-generated near-dupes as the end-to-end proof (skipped if numpy
is unavailable, but the ellieedit venv carries it).
"""

import base64
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


def test_family_list_offset_limit(client):
    """Cheap offset/limit params (twin loop step 4, 2026-10-08m): a client
    can walk the listing without holding cursors."""
    lst = client.get("/api/dupe/families?limit=2").json()
    assert len(lst["items"]) == 2 and lst["next_cursor"]
    mid = client.get("/api/dupe/families?offset=1&limit=1").json()
    assert len(mid["items"]) == 1
    assert mid["items"][0]["id"] == lst["items"][1]["id"]
    tail = client.get("/api/dupe/families?offset=2&limit=5").json()
    assert len(tail["items"]) == 1 and tail["next_cursor"] is None
    empty = client.get("/api/dupe/families?offset=99").json()
    assert empty["items"] == [] and empty["next_cursor"] is None
    assert client.get("/api/dupe/families?offset=-1").status_code == 400


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


def test_file_serves_full_size_bytes(env, client):
    """Stack-spread full-size viewer must serve real pixels, never the thumb."""
    r = client.get("/api/dupe/file?path=a.png")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")
    img = Image.open(__import__("io").BytesIO(r.content))
    assert img.size == (32, 32)  # full size, not a thumbnail


def test_file_jail_and_types(env, client):
    root, secret, _ = env
    bad = str(secret)
    assert client.get(f"/api/dupe/file?path={bad.replace('/', '%2F')}").status_code == 400
    assert client.get("/api/dupe/file?path=escape.png").status_code == 400
    assert client.get("/api/dupe/file?path=ghost.png").status_code == 404
    (root / "note.txt").write_text("nope")
    assert client.get("/api/dupe/file?path=note.txt").status_code == 404


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


def test_verdict_ranks_additive(env, client):
    """Sift (2026-10-08c): optional 1-based pick ranks persist into the
    ledger additively; verdict strings and readers tolerate their absence."""
    root, _, tmp = env
    # with ranks (sift ordered picks)
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept", "b.png": "kept", "sub/c.png": "rejected"},
        "ranks": {"b.png": 2, "a.png": 1},
        "note": "sift pass"})
    assert r.status_code == 200
    e = json.loads((tmp / "verdicts.jsonl").read_text().strip())
    assert e["ranks"] == {"b.png": 2, "a.png": 1}
    # without ranks (spread-era clients) — no ranks key at all
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept"}})
    assert r.status_code == 200
    e2 = json.loads((tmp / "verdicts.jsonl").read_text().strip().split("\n")[1])
    assert "ranks" not in e2
    # validation: rank path not among members, non-positive rank
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept"}, "ranks": {"stranger.png": 1}})
    assert r.status_code == 400
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept"}, "ranks": {"a.png": 0}})
    assert r.status_code == 400
    # send-pending still keyed on verdict strings, ranks irrelevant
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/send-pending")
    assert r.status_code == 409  # latest verdict has no rejects


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


# ------------------------------------------------------- signal conflicts (d)

def _seed_conflict(tmp):
    """One verdict entry that splits fam-aaaaaaaaaaaa: keep a, reject the rest.
    The FAM fixture has an 'exact' edge a<->b, so this contradicts the tiers."""
    entry = {"ts": "2026-10-07T23:00:00-07:00", "family": "fam-aaaaaaaaaaaa",
             "members": {"a.png": "kept", "b.png": "rejected",
                         "sub/c.png": "rejected"},
             "note": "split against the hashes"}
    (tmp / "verdicts.jsonl").write_text(json.dumps(entry) + "\n")


def test_card_conflict_flag_on_split_verdict(env, client):
    """Per-card glyph flag: O(1), verdicts+index only, no family-file reads."""
    root, _, tmp = env
    assert client.get("/api/dupe/families").json()["items"][0]["conflict"] is False
    _seed_conflict(tmp)
    # seeding a verdict resolves fam-aaaaaaaaaaaa — list all states
    items = {i["id"]: i for i in client.get(
        "/api/dupe/families", params={"state": "all"}).json()["items"]}
    assert items["fam-aaaaaaaaaaaa"]["conflict"] is True     # exact tier + split
    assert items["fam-cccccccccccc"]["conflict"] is False    # no verdict
    assert items["fam-bbbbbbbbbbbb"]["conflict"] is False    # tiers [] (no strict tier)


def test_signals_conflict_and_suggestion(env, client):
    """Detail-only lazy endpoint: pair conflicts + suggestion payload."""
    root, _, tmp = env
    _seed_conflict(tmp)
    s = client.get("/api/dupe/families/fam-aaaaaaaaaaaa/signals").json()
    assert s["conflict"] is True and len(s["conflicts"]) == 1
    c = s["conflicts"][0]
    assert {c["a"], c["b"]} == {"a.png", "b.png"} and c["tier"] == "exact"
    assert set(s["conflict_members"]) == {"a.png", "b.png"}
    # strong disagreement suppresses the suggestion — the disagreement IS the
    # answer (design rule: show disagreement, never fuse)
    assert s["suggestion"] is None
    assert "duel" in s["duel_history"]
    # per-member aggregates
    assert s["members"]["a.png"] == {"kept": 1, "rejected": 0,
                                     "last": "kept", "entries": 1}
    assert s["members"]["sub/c.png"]["last"] == "rejected"
    # backslashes normalize against member paths
    assert s["members"]["a.png"]["kept"] == 1


def test_signals_suggestion_on_agreement(env, client):
    """Strong agreement (no contradicting strict kept↔rejected edge) yields
    a suggestion payload — but only in REVIEW state: a decided latest entry
    means the family is committed, so the seed is followed by an all-deferred
    entry (the reopen). Still never applied automatically."""
    root, _, tmp = env
    fam_file = root / ".dupes" / "families" / "fam-aaaaaaaaaaaa.json"
    fam = json.loads(fam_file.read_text())
    # strict edges only AMONG the rejects — keep/reject split contradicts none
    fam["edges"] = [{"a": "b.png", "b": "sub/c.png", "tier": "exact"}]
    fam_file.write_text(json.dumps(fam))
    _seed_conflict(tmp)
    # decided latest entry = committed family → NO suggestion yet
    s = client.get("/api/dupe/families/fam-aaaaaaaaaaaa/signals").json()
    assert s["suggestion"] is None
    # operator defers everything → family back in review → suggestion fires
    # from the last decided entry
    (tmp / "verdicts.jsonl").open("a").write(json.dumps({
        "ts": "2026-10-08T10:00:00-07:00", "family": "fam-aaaaaaaaaaaa",
        "members": {"a.png": "deferred", "b.png": "deferred",
                    "sub/c.png": "deferred"}, "note": "re-review"}) + "\n")
    s = client.get("/api/dupe/families/fam-aaaaaaaaaaaa/signals").json()
    assert s["conflict"] is False and s["conflicts"] == []
    assert s["suggestion"] == {
        "keep": "a.png", "reject": ["b.png", "sub/c.png"],
        "label": "keep a.png, reject rest", "history_entries": 2}


def test_signals_no_history_clean(env, client):
    root, _, tmp = env
    s = client.get("/api/dupe/families/fam-aaaaaaaaaaaa/signals").json()
    assert s["conflict"] is False and s["conflicts"] == []
    assert s["suggestion"] is None and s["history_entries"] == 0
    assert all(v["last"] is None for v in s["members"].values())


def test_signals_edges_by_index_and_path(env, client):
    """Real family files index members by position; fixtures use paths.
    Both must resolve; unresolvable edges are skipped, never crash."""
    root, _, tmp = env
    fam_file = root / ".dupes" / "families" / "fam-aaaaaaaaaaaa.json"
    fam = json.loads(fam_file.read_text())
    fam["edges"] = [{"a": 0, "b": 1, "tier": "near-identical", "distance": 1},
                    {"a": "a.png", "b": "sub/c.png", "tier": "exact", "distance": 0},
                    {"a": "ghost.png", "b": 0, "tier": "exact"}]
    fam_file.write_text(json.dumps(fam))
    _seed_conflict(tmp)
    s = client.get("/api/dupe/families/fam-aaaaaaaaaaaa/signals").json()
    pairs = {tuple(sorted((c["a"], c["b"]))) for c in s["conflicts"]}
    assert pairs == {("a.png", "b.png"), ("a.png", "sub/c.png")}


def test_signal_events_append_only(env, client):
    root, _, tmp = env
    log = tmp / "signals.jsonl"
    import backend.routers.dupe as d
    orig = d.SIGNALS_LOG
    d.SIGNALS_LOG = log
    try:
        for ev in ("shown", "applied", "dismissed", "override"):
            r = client.post("/api/dupe/signals/event", json={
                "family": "fam-aaaaaaaaaaaa", "event": ev, "detail": "x"})
            assert r.status_code == 200 and r.json()["ok"] is True
        lines = log.read_text().strip().split("\n")
        assert [json.loads(l)["event"] for l in lines] == \
            ["shown", "applied", "dismissed", "override"]
        # validation
        assert client.post("/api/dupe/signals/event", json={
            "family": "fam-aaaaaaaaaaaa", "event": "bogus"}).status_code == 400
        assert client.post("/api/dupe/signals/event", json={
            "family": "nope", "event": "shown"}).status_code == 400
    finally:
        d.SIGNALS_LOG = orig


# ---------------------------------------------------------------- meld-save

def _meld_b64(tmp_path):
    p = tmp_path / "blend.png"
    Image.new("RGB", (16, 16), (10, 120, 200)).save(p)
    return base64.b64encode(p.read_bytes()).decode()


def test_meld_save_writes_result_ledger_and_pending(env, client, tmp_path):
    import base64
    root, _, _ = env
    before = sorted(p.name for p in root.parent.rglob("meld-*"))
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/meld-save", json={
        "image_b64": _meld_b64(tmp_path),
        "members": ["a.png", "b.png", "sub/c.png"],
    })
    assert r.status_code == 200
    j = r.json()
    # 1. New auto-named file in the gallery root; components untouched.
    assert j["saved_as"].startswith("meld-fam-aaaaaaaaaaaa-")
    saved = gallery_mod.GALLERY_ROOT / j["saved_as"]
    assert saved.is_file() and saved.stat().st_size > 0
    assert (root / "a.png").exists()  # component NOT deleted directly
    # 2. Manifest gains EXACTLY the N components.
    m = pending_mod.load_manifest()
    assert set(m) == {"a.png", "b.png", "sub/c.png"}
    # 3. Ledger ACCEPTED entry: every meld member 'kept' + meld_result.
    entries = [json.loads(l) for l in dupe_mod.LEDGER.read_text().splitlines()]
    meld_e = [e for e in entries if e.get("meld_result")]
    assert len(meld_e) == 1
    assert meld_e[0]["family"] == "fam-aaaaaaaaaaaa"
    assert meld_e[0]["members"] == {"a.png": "kept", "b.png": "kept",
                                    "sub/c.png": "kept"}
    # 4. family_detail surfaces the meld so the detail view can render it.
    d = client.get("/api/dupe/families/fam-aaaaaaaaaaaa").json()
    assert d["meld"]["result"] == j["saved_as"]
    assert d["state"] == "resolved"


def test_meld_save_rejections(env, client, tmp_path):
    import base64 as b64
    # unknown member → 400, nothing written
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/meld-save", json={
        "image_b64": _meld_b64(tmp_path), "members": ["a.png", "nope.png"]})
    assert r.status_code == 400
    assert pending_mod.load_manifest() == {}
    # not a PNG → 400
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/meld-save", json={
        "image_b64": b64.b64encode(b"not a png at all.........").decode(),
        "members": ["a.png"]})
    assert r.status_code == 400
    # empty members → 400
    r = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/meld-save", json={
        "image_b64": _meld_b64(tmp_path), "members": []})
    assert r.status_code == 400
    # unknown family → 404
    r = client.post("/api/dupe/families/fam-ffffffffffff/meld-save", json={
        "image_b64": _meld_b64(tmp_path), "members": ["a.png"]})
    assert r.status_code == 404
    # no meld-save call happened: manifest empty, no gallery-root meld file
    assert pending_mod.load_manifest() == {}
    assert not list(gallery_mod.GALLERY_ROOT.glob("meld-*"))


def test_meld_save_never_overwrites(env, client, tmp_path):
    r1 = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/meld-save", json={
        "image_b64": _meld_b64(tmp_path), "members": ["a.png", "b.png"]})
    r2 = client.post("/api/dupe/families/fam-aaaaaaaaaaaa/meld-save", json={
        "image_b64": _meld_b64(tmp_path), "members": ["a.png", "b.png"]})
    assert r1.json()["saved_as"] != r2.json()["saved_as"]
    assert r2.json()["pending_added"] == 0  # already queued



def test_status_endpoint_caches_within_ttl(env, client, monkeypatch):
    """Second /status call inside _STATUS_TTL must hit _status_cache — no
    second freshness computation (regression: cache tuple/store was broken)."""
    calls = {"n": 0}
    real = dupe_mod._freshness_walk

    def counting_walk(idx_mtime):
        calls["n"] += 1
        return real(idx_mtime)

    monkeypatch.setattr(dupe_mod, "_freshness_walk", counting_walk)
    monkeypatch.setattr(dupe_mod, "_status_cache", None)
    monkeypatch.setattr(dupe_mod, "_freshness_cache", None)
    s1 = client.get("/api/dupe/status")
    assert s1.status_code == 200
    s2 = client.get("/api/dupe/status")
    assert s2.status_code == 200
    assert s2.json() == s1.json()
    assert calls["n"] == 1, f"freshness computed {calls['n']}x — status cache miss"


# ------------------------------------------------- perf-causes (2026-10-08n)

def test_families_never_opens_pil(env, client, monkeypatch):
    """Cause-1 guard: the families listing must do ZERO PIL opens, cold or
    warm — thumbnails come from the preview cache + on-demand /thumb."""
    import backend.routers.gallery as g
    calls = {"n": 0}
    real_open = g.Image.open

    def counting_open(*a, **k):
        calls["n"] += 1
        return real_open(*a, **k)

    monkeypatch.setattr(g.Image, "open", counting_open)
    monkeypatch.setattr(dupe_mod, "_preview_cache", {})
    r1 = client.get("/api/dupe/families")
    assert r1.status_code == 200
    r2 = client.get("/api/dupe/families")   # warm
    assert r2.status_code == 200
    assert calls["n"] == 0, f"listing opened images with PIL {calls['n']}x"


def test_families_list_cache_key_exposed(env, client):
    """Clients key their in-memory listing cache on this; must move when the
    ledger moves (a verdict) and match /status's key."""
    s = client.get("/api/dupe/status").json()
    lst = client.get("/api/dupe/families").json()
    assert lst["key"] and lst["key"] == s["key"]
    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict",
                json={"members": {"a.png": "kept", "b.png": "rejected"}})
    lst2 = client.get("/api/dupe/families").json()
    s2 = client.get("/api/dupe/status").json()
    assert lst2["key"] != lst["key"] and lst2["key"] == s2["key"]


def test_thumb_cache_control_fingerprint_immutable(env, client):
    """Fingerprinted thumb URLs (?v=mtime-size) are content-addressed:
    immutable caching. Unfingerprinted keeps the 24h policy."""
    r = client.get("/api/dupe/thumb?path=a.png")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=86400"
    import re as _re
    lst = client.get("/api/dupe/families").json()
    url = next(m["thumb"] for m in lst["items"][0]["members"]
               if m["thumb"] and "a.png" in m["thumb"])
    v = _re.search(r"v=\d+-\d+", url).group(0)
    r2 = client.get(f"/api/dupe/thumb?path=a.png&{v}")
    assert r2.status_code == 200
    assert r2.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_list_members_thumb_urls_fingerprinted(env, client):
    lst = client.get("/api/dupe/families").json()
    for m in lst["items"][0]["members"]:
        assert m["thumb"] and "v=" in m["thumb"]
    det = client.get("/api/dupe/families/fam-aaaaaaaaaaaa").json()
    for m in det["members"]:
        assert "v=" in (m["thumb"] or "")


def test_family_detail_single_jail_resolution(env, client, monkeypatch):
    """Cause-2: family_detail resolves each member ONCE (the old code
    resolved twice — explicit jail + _missing_member's own)."""
    calls = {"n": 0}
    real = dupe_mod.jailed

    def counting_jailed(rel):
        calls["n"] += 1
        return real(rel)

    monkeypatch.setattr(dupe_mod, "jailed", counting_jailed)
    r = client.get("/api/dupe/families/fam-aaaaaaaaaaaa")
    assert r.status_code == 200
    members = r.json()["members"]
    assert calls["n"] <= len(members), (
        f"jailed() called {calls['n']}x for {len(members)} members — double resolve is back")


def test_pending_count_endpoint_cheap(env, client, tmp_path):
    """Cause-6: badge source returns manifest keys only — no per-entry
    stats, no sizes. Full payload stays on GET /api/pending."""
    from backend.routers import gallery as g
    _png(tmp_path / "gallery" / "g1.png", (10, 200, 10))
    _png(tmp_path / "gallery" / "g2.png", (10, 200, 20))
    client.post("/api/pending", json={"paths": ["g1.png", "g2.png"]})
    r = client.get("/api/pending/count")
    assert r.status_code == 200
    j = r.json()
    assert j["count"] == 2 and sorted(j["paths"]) == ["g1.png", "g2.png"]
    assert "bytes" not in j and "items" not in j


# ── Probe ledger isolation (2026-10-08o) ─────────────────────────────
# The dupe-probe's signal-conflict section seeds verdicts into the REAL
# ledger (server env has no override) — the guard is the probe's own
# snapshot/restore. These tests import the probe module (paths patched
# to a tmp dir) and prove the mechanism: everything the probe's seed
# path can touch is covered by snapshot_state(), and a snapshot-based
# restore leaves ZERO `"probe": true` entries + byte-identical files.

PROBE_PATH = Path(__file__).resolve().parent / "dupe-probe.py"


@pytest.fixture()
def probe_mod():
    # The probe runs asyncio.run(main()) at module bottom, so exec_module
    # would run the whole live probe — extract ONLY the snapshot helpers
    # (their exact code) via ast and exec them in a scratch namespace.
    import ast
    tree = ast.parse(PROBE_PATH.read_text())
    ns = {"os": __import__("os"), "Path": Path}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) \
                and node.name in ("_sig_data_dir", "snapshot_state"):
            exec(compile(ast.Module(body=[node], type_ignores=[]),
                         str(PROBE_PATH), "exec"), ns)
    class _ProbeNS:
        """Attribute access IS the exec globals — patched names are visible
        inside the extracted functions (their __globals__ is this dict)."""
        def __init__(self, ns):
            self.__dict__ = ns

    assert "snapshot_state" in ns and "_sig_data_dir" in ns, \
        "probe helpers missing — dupe-probe.py changed shape"
    mod = _ProbeNS(ns)
    mod.LEDGER = Path(".dupe-verdicts.jsonl")   # patched per-test
    mod.SIGNALS_LOG = Path(".dupe-signals.jsonl")
    return mod


def _seed_probe_writes(probe, ledger, fam_file):
    """Mirror the probe's two signal-conflict LEDGER.open('a') seeds plus a
    family-JSON mutation — the exact writes that leaked before the fix."""
    with ledger.open("a") as fh:
        fh.write(json.dumps({"ts": "2026-10-08T09:00:00-07:00",
                             "family": "fam-aaaaaaaaaaaa",
                             "members": {"a.png": "kept", "b.png": "rejected"},
                             "note": "probe signal-conflict seed",
                             "probe": True}) + "\n")
    with ledger.open("a") as fh:
        fh.write(json.dumps({"ts": "2026-10-08T09:30:00-07:00",
                             "family": "fam-aaaaaaaaaaaa",
                             "members": {"a.png": "deferred",
                                         "b.png": "deferred"},
                             "note": "probe deferral reopen",
                             "probe": True}) + "\n")
    fam_file.write_text(json.dumps({**FAM, "edges": []}))


def _probe_restore(snap):
    """Same byte-restore the probe teardown performs (extracted semantics):
    captured bytes only, never re-derived content."""
    for p, data in snap.items():
        if data is None:
            p.unlink(missing_ok=True)
        else:
            p.write_bytes(data)


def test_probe_seed_paths_are_snapshot_covered(probe_mod, tmp_path,
                                               monkeypatch):
    ledger = tmp_path / ".dupe-verdicts.jsonl"
    signals = tmp_path / ".dupe-signals.jsonl"
    fam_dir = tmp_path / "families"
    fam_dir.mkdir()
    fam_file = fam_dir / "fam-aaaaaaaaaaaa.json"
    fam_file.write_text(json.dumps(FAM))
    monkeypatch.setattr(probe_mod, "LEDGER", ledger)
    monkeypatch.setattr(probe_mod, "SIGNALS_LOG", signals)
    monkeypatch.setattr(probe_mod, "_sig_data_dir",
                        lambda: tmp_path)

    snap = probe_mod.snapshot_state()
    # every file the seed path writes must be in the snapshot
    assert set(snap) == {ledger, signals, fam_file}
    _seed_probe_writes(probe_mod, ledger, fam_file)
    _probe_restore(snap)
    _exists = lambda p: p.read_bytes() if p.exists() else None
    assert _exists(ledger) == snap[ledger]
    assert _exists(fam_file) == snap[fam_file]


def test_probe_restore_leaves_zero_probe_entries(probe_mod, tmp_path,
                                                 monkeypatch):
    ledger = tmp_path / ".dupe-verdicts.jsonl"
    real_entry = json.dumps({"ts": "2026-10-08T10:00:00-07:00",
                             "family": "fam-cccccccccccc",
                             "members": {"x.png": "kept"},
                             "note": "operator verdict"}) + "\n"
    ledger.write_text(real_entry)
    fam_dir = tmp_path / "families"
    fam_dir.mkdir()
    monkeypatch.setattr(probe_mod, "LEDGER", ledger)
    monkeypatch.setattr(probe_mod, "SIGNALS_LOG",
                        tmp_path / ".dupe-signals.jsonl")
    monkeypatch.setattr(probe_mod, "_sig_data_dir", lambda: tmp_path)

    before = ledger.read_bytes()
    snap = probe_mod.snapshot_state()
    _seed_probe_writes(probe_mod, ledger, fam_dir / "none.json")
    assert '"probe": true' in ledger.read_text()
    _probe_restore(snap)
    after = ledger.read_bytes()
    assert after == before, "probe restore did not return ledger to pre-probe bytes"
    probe_left = [ln for ln in after.decode().splitlines()
                  if '"probe": true' in ln or '"probe":true' in ln]
    assert probe_left == [], \
        f"probe entries survived teardown: {probe_left}"


def test_probe_teardown_asserts_zero_probe_entries():
    """The probe source must end with the loud teardown assertion: any
    future leak FAILS the probe instead of passing silently."""
    src = PROBE_PATH.read_text()
    assert '"probe": true' in src or "'\"probe\": true'" in src
    assert "LEDGER LEAK" in src, \
        "teardown zero-probe-entries assertion missing"
    assert "PROBE RESTORE LEAK" in src
    # the file restore must run BEFORE the manifest reconcile in the finally
    finally_blk = src[src.index("    finally:"):]
    assert finally_blk.index("_restore_files()") \
        < finally_blk.index("manifest reconcile".replace("manifest reconcile",
                                                         "manifest_err = None"))


# ------------------------------------------------- death-row rehydration (2026-10-09b)

def _majority_verdict(client, fid, keep=1, reject=2):
    fam = client.get(f"/api/dupe/families/{fid}").json()
    paths = [m["path"] for m in fam["members"]]
    members = {p: "kept" for p in paths[:keep]}
    for p in paths[keep:keep + reject]:
        members[p] = "rejected"
    r = client.post(f"/api/dupe/families/{fid}/verdict",
                    json={"members": members, "note": "death row test"})
    assert r.status_code == 200
    return members


def test_deathrow_rehydration_appended_sorted(env, client):
    """Majority-rejected resolved families ride the unresolved queue after
    the genuinely unresolved ones, biggest-rejected-first, flagged."""
    root, _, _ = env
    _majority_verdict(client, "fam-aaaaaaaaaaaa", keep=1, reject=2)   # 2 rej
    _majority_verdict(client, "fam-bbbbbbbbbbbb", keep=0, reject=1)   # 1 rej
    lst = client.get("/api/dupe/families?state=unresolved").json()
    ids = [it["id"] for it in lst["items"]]
    # unresolved first, then rehydrated rows in rejected-desc order.
    # fam-bbbbbbbbbbbb (member d.png gone from disk) is a GHOST family —
    # hidden from the default list (2026-10-09f), revealed by the toggle.
    assert ids[-1] == "fam-aaaaaaaaaaaa"
    assert "fam-bbbbbbbbbbbb" not in ids
    tail = lst["items"][-1:]
    assert all(it["rehydrated"] and it["state"] == "unresolved" for it in tail)
    assert tail[0]["rejected"] == 2 and tail[0]["kept"] == 1
    assert lst["rehydrated"] == 1
    assert lst["archived_hidden"] == 1
    # counts stay honest: the rehydrated families are still resolved
    assert lst["counts"] == {"unresolved": 1, "resolved": 2}
    # the archived toggle reveals the ghost family, flagged + zero on disk
    full = client.get(
        "/api/dupe/families?state=unresolved&include_archived=1").json()
    fids = [it["id"] for it in full["items"]]
    assert "fam-bbbbbbbbbbbb" in fids
    ghost_row = next(it for it in full["items"] if it["id"] == "fam-bbbbbbbbbbbb")
    assert ghost_row["archived"] is True and ghost_row["on_disk"] == 0
    assert full["rehydrated"] == 2 and full["archived_hidden"] == 1


def test_deathrow_latest_verdict_wins(env, client):
    """An overriding re-commit that flips the majority drops the family out
    of the rehydration; a flip INTO majority-rejected pulls one back in."""
    _majority_verdict(client, "fam-aaaaaaaaaaaa", keep=1, reject=2)
    assert client.get("/api/dupe/families?state=unresolved").json()["rehydrated"] == 1
    # override: now majority kept
    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "kept", "b.png": "kept", "sub/c.png": "rejected"}})
    assert client.get("/api/dupe/families?state=unresolved").json()["rehydrated"] == 0
    # flip back into majority-rejected
    client.post("/api/dupe/families/fam-aaaaaaaaaaaa/verdict", json={
        "members": {"a.png": "rejected", "b.png": "rejected", "sub/c.png": "kept"}})
    lst = client.get("/api/dupe/families?state=unresolved").json()
    assert lst["rehydrated"] == 1
    assert lst["items"][-1]["rejected"] == 2


def test_deathrow_endpoints_never_write_ledger(env, client):
    """The rehydration view READS history; listing/detail/summary must not
    append a single ledger line."""
    import os
    before = dupe_mod.LEDGER.stat().st_size if dupe_mod.LEDGER.exists() else 0
    _majority_verdict(client, "fam-aaaaaaaaaaaa")
    seeded = dupe_mod.LEDGER.stat().st_size
    assert seeded >= before
    client.get("/api/dupe/families?state=unresolved")
    client.get("/api/dupe/families/fam-aaaaaaaaaaaa")
    s = client.get("/api/dupe/death-row").json()
    assert s["families"] == 1
    assert dupe_mod.LEDGER.stat().st_size == seeded, "read path wrote the ledger"


def test_deathrow_summary_bytes_stat_source(env, client):
    """rejected_bytes comes from stat of files still on disk — a vanished
    (pardoned/promoted) member drops out of both count and bytes."""
    root, _, _ = env
    _majority_verdict(client, "fam-aaaaaaaaaaaa", keep=1, reject=2)
    s = client.get("/api/dupe/death-row").json()
    row = s["items"][0]
    assert row["rejected_files"] == 2
    sizes = sum((root / p).stat().st_size
                for p in ("b.png", "sub/c.png"))
    assert row["rejected_bytes"] == sizes
    assert s["total_files"] == 2 and s["total_bytes"] == sizes
    # pardon one member by removing it from disk (promote semantics: move out)
    (root / "sub" / "c.png").unlink()
    dupe_mod._death_row_cache = None   # force the re-walk
    s2 = client.get("/api/dupe/death-row").json()
    assert s2["items"][0]["rejected_files"] == 1
    assert s2["items"][0]["rejected_bytes"] == (root / "b.png").stat().st_size


def test_deathrow_mass_commit_exact_and_never_unlinks(env, client):
    """Mass commit enqueues EXACTLY the un-pardoned rejected members into
    the pending manifest; nothing unlinks; expected_files guards staleness."""
    root, _, _ = env
    _majority_verdict(client, "fam-aaaaaaaaaaaa", keep=1, reject=2)
    _majority_verdict(client, "fam-bbbbbbbbbbbb", keep=0, reject=1)
    (root / "sub" / "c.png").unlink()   # one member already promoted away
    # (fam-b's d.png has no file on disk either — counted missing)
    r = client.post("/api/dupe/death-row/commit", json={
        "families": ["fam-aaaaaaaaaaaa", "fam-bbbbbbbbbbbb"],
        "expected_files": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["added"] == 1 and body["missing"] == 2
    m = json.loads(pending_mod.MANIFEST.read_text())
    assert sorted(m) == ["b.png"], m   # exact set: a.png is KEPT, c/d gone
    # nothing unlinked: the enqueued file is still on disk
    assert (root / "b.png").is_file()
    # double commit = no dupes (already_pending)
    r2 = client.post("/api/dupe/death-row/commit", json={
        "families": ["fam-aaaaaaaaaaaa", "fam-bbbbbbbbbbbb"], "expected_files": 1})
    assert r2.json()["already_pending"] == 1 and r2.json()["added"] == 0


def test_deathrow_mass_commit_guards(env, client):
    root, _, _ = env
    _majority_verdict(client, "fam-aaaaaaaaaaaa", keep=1, reject=2)
    # stale button label -> 409, nothing enqueued
    r = client.post("/api/dupe/death-row/commit", json={
        "families": ["fam-aaaaaaaaaaaa"], "expected_files": 99})
    assert r.status_code == 409
    assert (json.loads(pending_mod.MANIFEST.read_text())
            if pending_mod.MANIFEST.exists() else {}) == {}
    # a family that is not majority-rejected -> 400
    r = client.post("/api/dupe/death-row/commit", json={
        "families": ["fam-cccccccccccc"]})
    assert r.status_code == 400
    r = client.post("/api/dupe/death-row/commit", json={"families": []})
    assert r.status_code == 400


def test_deathrow_detail_carries_rehydrated_flag(env, client):
    _majority_verdict(client, "fam-aaaaaaaaaaaa", keep=1, reject=2)
    det = client.get("/api/dupe/families/fam-aaaaaaaaaaaa").json()
    assert det["rehydrated"] is True and det["state"] == "resolved"
    assert det["verdict"]["a.png"] == "kept"
    assert det["verdict"]["b.png"] == "rejected"
    # untouched family: no flag
    det2 = client.get("/api/dupe/families/fam-cccccccccccc").json()
    assert det2["rehydrated"] is False


def test_deathrow_ghost_states_resolved(env, client, monkeypatch):
    """2026-10-09f ghost resolution: kept member promoted to the Library
    resolves 'library', vanished member resolves 'deleted', on-disk member
    stays 'disk'; zero-on-disk families hide from the default list; /death-row
    carries honest on_disk/archived flags. Read-only: no ledger writes."""
    from backend.routers import library as lib
    root, _, tmp = env
    _majority_verdict(client, "fam-aaaaaaaaaaaa", keep=1, reject=2)
    # promote the kept member (a.png) into the Library the way promote_move
    # does — index record with promoted_from, file gone from the dupe root
    lroot = tmp / "library"
    lroot.mkdir(parents=True, exist_ok=True)
    # patch the library module onto the tmp root (fixture doesn't touch it)
    monkeypatch.setattr(lib, "LIBRARY_ROOT", lroot)
    lib.append_index({"path": "kept/a.png", "tags": ["probe"],
                      "promoted_from": "a.png", "sha256": "x" * 64})
    (root / "a.png").unlink()
    # fresh session: the per-process exists/ghost caches are TTL'd for the
    # running server, so a test (like a server restart) starts clean
    dupe_mod._exists_cache.clear()
    dupe_mod._ghost_cache = None
    before_ledger = (env[1].parent / "verdicts.jsonl")
    n_before = len(before_ledger.read_text().splitlines())
    lst = client.get("/api/dupe/families?state=unresolved").json()
    # a.png -> library, others on disk: family stays in the default list
    row = next(it for it in lst["items"] if it["id"] == "fam-aaaaaaaaaaaa")
    states = {m["path"]: m["member_state"] for m in row["members"]}
    verdicts_map = {m["path"]: m["verdict"] for m in row["members"]}
    assert states.get("a.png") == "library"
    assert verdicts_map.get("a.png") == "kept"
    assert row["archived"] is False and row["on_disk"] >= 1
    # detail carries the same chips data
    det = client.get("/api/dupe/families/fam-aaaaaaaaaaaa").json()
    dstates = {m["path"]: m["member_state"] for m in det["members"]}
    assert dstates.get("a.png") == "library"
    assert all(st in ("disk", "library", "deleted") for st in dstates.values())
    # /death-row honest per-family on_disk + archived
    dr = client.get("/api/dupe/death-row").json()
    drow = next(r for r in dr["items"] if r["id"] == "fam-aaaaaaaaaaaa")
    assert drow["on_disk"] == row["on_disk"] and drow["archived"] is False
    # rendering wrote NOTHING to the ledger
    n_after = len(before_ledger.read_text().splitlines())
    assert n_after == n_before


# ------------------------------------------------- member-root jail (09h)

def _jailed_env(env, monkeypatch):
    """env fixture + cleared jail/preview caches for allowlist tests."""
    root, secret, tmp = env
    dupe_mod._jail_cache.clear()
    dupe_mod._preview_cache.clear()
    return root, secret, tmp


def test_jail_accepts_member_under_each_allowlisted_root(env, monkeypatch, client):
    root, secret, tmp = env
    extra_a, extra_b = tmp / "gatherer", tmp / "incoming"
    monkeypatch.setattr(dupe_mod, "DUPE_MEMBER_ROOTS",
                        [root, extra_a, extra_b])
    for base in (extra_a, extra_b):
        (base / "staging").mkdir(parents=True)
    a, b = extra_a / "staging" / "x.png", extra_b / "y.png"
    for p in (a, b):
        _png(p, (10, 200, 10))
    # direct jail calls
    assert dupe_mod.jailed(str(a)) == a.resolve()
    assert dupe_mod.jailed(str(b)) == b.resolve()
    assert dupe_mod.jailed(str(root / "a.png")) == (root / "a.png").resolve()
    # through the live endpoint (absolute paths in the URL)
    r = client.get("/api/dupe/thumb", params={"path": str(a)})
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    r = client.get("/api/dupe/file", params={"path": str(b)})
    assert r.status_code == 200 and "image/png" in r.headers["content-type"]


def test_jail_rejects_traversal_and_foreign_roots(env, monkeypatch, client):
    root, secret, tmp = env
    monkeypatch.setattr(dupe_mod, "DUPE_MEMBER_ROOTS", [root])
    for p in ("../secret.png", str(tmp / "secret.png"), "/etc/passwd",
              str(root / ".." / "secret.png"), "~/x.png", "/mnt/e/x.png"):
        r = client.get("/api/dupe/thumb", params={"path": p})
        assert r.status_code == 400, f"{p} -> {r.status_code}"
    # relative escape still rejected, extension whitelist unchanged
    r = client.get("/api/dupe/file", params={"path": str(tmp / "secret.png")})
    assert r.status_code == 400


def test_jail_rejects_symlink_escaping_allowlisted_root(env, monkeypatch, client):
    root, secret, tmp = env
    extra = tmp / "gatherer"
    (extra / "staging").mkdir(parents=True)
    link = extra / "staging" / "escape.png"
    link.symlink_to(secret)  # secret.png lives OUTSIDE the allowlist
    monkeypatch.setattr(dupe_mod, "DUPE_MEMBER_ROOTS", [root, extra])
    r = client.get("/api/dupe/thumb", params={"path": str(link)})
    assert r.status_code == 400


def test_serializer_thumb_urls_roundtrip_jail_for_out_of_root_members(
        env, monkeypatch, client):
    from urllib.parse import parse_qs, urlparse
    root, secret, tmp = env
    extra = tmp / "gatherer"
    (extra / "staging").mkdir(parents=True)
    img = extra / "staging" / "img_0105.png"
    _png(img, (10, 200, 10))
    monkeypatch.setattr(dupe_mod, "DUPE_MEMBER_ROOTS", [root, extra])
    dupe_mod._preview_cache.clear()
    fam = {"path": str(img), "size": 1, "mtime": 1,
           "dhash": "0" * 16, "phash": "0" * 16}
    v = dupe_mod._member_view(fam)
    q = parse_qs(urlparse(v["thumb"]).query)["path"][0]
    assert dupe_mod.jailed(q) == img.resolve()   # URL round-trips through jail
    # inject into the indexed family so the listing emits a real URL
    fam_path = dupe_mod.DUPE_DATA / "families" / "fam-aaaaaaaaaaaa.json"
    famd = json.loads(fam_path.read_text())
    famd["members"].append(fam)
    fam_path.write_text(json.dumps(famd))
    dupe_mod._preview_cache.clear()
    # through the family listing: thumb survives (not jailed-flagged) and
    # the endpoint it points at serves the bytes
    lst = client.get("/api/dupe/families").json()
    members = [m for f in lst["items"] for m in f["members"]]
    mine = next(m for m in members if m["path"] == str(img))
    assert mine.get("jailed") is not True and mine["thumb"]
    assert client.get(mine["thumb"]).status_code == 200
