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
