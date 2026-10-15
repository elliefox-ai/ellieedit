"""Gallery listing performance + paging robustness (2026-10-15).

The listing used to re-walk and stat the whole folder and open 100 files for
dimensions on EVERY page request, and a cursor whose item had since gone
pending/deleted failed with 400. These pin the cached, tolerant behavior."""

import json
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.routers import gallery as g
from backend.routers import pending as pending_mod

N = 12


def mkimg(path, mtime):
    Image.new("RGB", (32, 24), (1, 2, 3)).save(path, "PNG")
    os.utime(path, (mtime, mtime))


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = tmp_path / "gallery"
    root.mkdir()
    for i in range(N):                                   # i00 oldest .. i11 newest
        mkimg(root / f"i{i:02d}.png", 1000 + i)
    monkeypatch.setattr(g, "GALLERY_ROOT", root)
    monkeypatch.setattr(g, "THUMB_CACHE_DIR", tmp_path / ".thumbs")
    monkeypatch.setattr(g, "PAGE_SIZE", 5)
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    g._DIR_INDEX.clear()
    g._DIMS.clear()
    return root


@pytest.fixture
def client(env):
    return TestClient(app)


def names(r):
    return [i["name"] for i in r.json()["items"]]


def set_pending(tmp_path, *rels):
    (tmp_path / "pending.json").write_text(json.dumps({r: "2026-10-15T00:00:00" for r in rels}))


@pytest.fixture
def counters(monkeypatch):
    c = {"entry": 0, "path": 0, "dims": 0}
    real_entry, real_path, real_dims = g._entry_mtime, g._path_mtime, g._read_dims

    def entry(e): c["entry"] += 1; return real_entry(e)
    def path(p): c["path"] += 1; return real_path(p)
    def dims(p): c["dims"] += 1; return real_dims(p)
    monkeypatch.setattr(g, "_entry_mtime", entry)
    monkeypatch.setattr(g, "_path_mtime", path)
    monkeypatch.setattr(g, "_read_dims", dims)
    return c


# ------------------------------------------------------------ paging

def test_paging_covers_everything_once_in_order_even_with_mtime_ties(client, env):
    for i in range(7):                                    # same-second batch outputs
        mkimg(env / f"tie{i}.png", 5000)
    seen, cur = [], ""
    for _ in range(10):
        r = client.get("/api/gallery/list", params={"cursor": cur})
        seen += names(r)
        cur = r.json()["next_cursor"]
        if not cur:
            break
    assert len(seen) == len(set(seen)) == N + 7
    assert seen[:7] == [f"tie{i}.png" for i in range(6, -1, -1)]   # newest, ties name-desc
    assert seen[7:] == [f"i{i:02d}.png" for i in range(N - 1, -1, -1)]


def test_cursor_survives_its_item_going_pending_or_vanishing(client, env, tmp_path):
    p1 = client.get("/api/gallery/list", params={"pending": "active"}).json()
    assert [i["name"] for i in p1["items"]] == [f"i{i:02d}.png" for i in range(11, 6, -1)]
    cur = p1["next_cursor"]                               # points at i07
    assert cur.endswith(":i07.png")
    set_pending(tmp_path, "i07.png", "i05.png")           # cursor item itself now pending
    r = client.get("/api/gallery/list", params={"pending": "active", "cursor": cur})
    assert r.status_code == 200
    assert names(r) == ["i06.png", "i04.png", "i03.png", "i02.png", "i01.png"]  # no skip, no dup
    set_pending(tmp_path)                                 # ...or the file is deleted outright
    (env / "i07.png").unlink()
    r = client.get("/api/gallery/list", params={"pending": "active", "cursor": cur})
    assert r.status_code == 200 and names(r)[0] == "i06.png"


def test_bad_cursors_still_400(client):
    for bad in ("garbage", "x:y.png", ":"):
        assert client.get("/api/gallery/list", params={"cursor": bad}).status_code == 400


def test_pending_view_cursor_survives_pardon(client, env, tmp_path):
    set_pending(tmp_path, *[f"i{i:02d}.png" for i in range(8)])
    p1 = client.get("/api/gallery/list", params={"pending": "pending"}).json()
    assert len(p1["items"]) == 5
    cur = p1["next_cursor"]                               # last item of page 1: i03
    set_pending(tmp_path, *[f"i{i:02d}.png" for i in (0, 1, 2, 4, 5, 6, 7)])   # i03 returned
    r = client.get("/api/gallery/list", params={"pending": "pending", "cursor": cur})
    assert r.status_code == 200 and names(r) == ["i02.png", "i01.png", "i00.png"]


# ------------------------------------------------------------ caching

def test_warm_listing_does_not_restat_the_folder(client, env, counters):
    client.get("/api/gallery/list")
    assert counters["entry"] == N                         # cold: one stat per image
    cur = client.get("/api/gallery/list").json()["next_cursor"]
    assert counters["entry"] == N                         # warm: none
    base_path = counters["path"]
    client.get("/api/gallery/list", params={"cursor": cur})
    assert counters["entry"] == N and counters["path"] == base_path   # paging: no stats at all


def test_new_and_deleted_files_show_up_without_stale_data(client, env, counters):
    client.get("/api/gallery/list")
    mkimg(env / "fresh.png", 9000)
    (env / "i11.png").unlink()
    r = client.get("/api/gallery/list")
    assert names(r)[0] == "fresh.png" and "i11.png" not in names(r)
    assert counters["entry"] == N + 1                     # only the new name was stat'ed


def test_recent_overwrite_resorts_and_old_needs_refresh(client, env, monkeypatch):
    monkeypatch.setattr(g, "RECENT_RESTAT", 3)
    client.get("/api/gallery/list")
    os.utime(env / "i10.png", (9000, 9000))               # recent file rewritten in place
    assert names(client.get("/api/gallery/list"))[0] == "i10.png"
    os.utime(env / "i00.png", (9999, 9999))               # OLD file rewritten in place
    assert "i00.png" not in names(client.get("/api/gallery/list"))[:1]    # documented limit
    assert names(client.get("/api/gallery/list", params={"refresh": "true"}))[0] == "i00.png"


def test_dimensions_are_cached_per_file_version(client, env, counters):
    client.get("/api/gallery/list")                       # page 1 = 5 files
    client.get("/api/gallery/list")
    assert counters["dims"] == 5
    os.utime(env / "i11.png", (7777, 7777))               # new mtime -> new cache key
    client.get("/api/gallery/list")
    assert counters["dims"] == 6


def test_unreadable_image_is_skipped_not_fatal(client, env):
    (env / "i11.png").write_bytes(b"truncated")
    os.utime(env / "i11.png", (1011, 1011))
    r = client.get("/api/gallery/list")
    assert r.status_code == 200 and "i11.png" not in names(r)
    assert "i10.png" in names(r)


def test_folder_rules_unchanged(client, env):
    (env / "ellieedit_tmp").mkdir()
    (env / "albums").mkdir()
    (env / ".hidden.png").write_bytes(b"x")
    (env / "notes.txt").write_text("x")
    j = client.get("/api/gallery/list").json()
    assert j["subdirs"] == ["albums"]                     # temp dir hidden at root
    assert all(not n.startswith(".") and n.endswith(".png") for n in names(client.get("/api/gallery/list")))


def test_server_timing_header(client):
    h1 = client.get("/api/gallery/list").headers["server-timing"]
    assert 'walk;dur=' in h1 and 'desc="cold"' in h1 and "dims;dur=" in h1 and "total;dur=" in h1
    assert 'desc="warm"' in client.get("/api/gallery/list").headers["server-timing"]
