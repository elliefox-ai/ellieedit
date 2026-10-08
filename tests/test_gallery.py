"""Gallery endpoint tests — listing, path jail, thumbnails, pagination."""

import io
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.routers import gallery as gallery_mod
from backend.routers import pending as pending_mod


@pytest.fixture
def client(tmp_path, monkeypatch):
    root = tmp_path / "gallery"
    (root / "sub").mkdir(parents=True)
    # Newest first: b newer than a.
    for name, mtime in [("a.png", 1000), ("b.jpg", 2000),
                        ("sub/c.png", 3000), ("notes.txt", 4000)]:
        img = Image.new("RGB", (640, 480), (1, 2, 3))
        buf = io.BytesIO()
        img.save(buf, "PNG" if name.endswith("png") else "JPEG")
        f = root / name
        f.write_bytes(buf.getvalue())
        import os
        os.utime(f, (mtime, mtime))
    # Symlink escaping the root.
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"not really an image")
    (root / "escape.png").symlink_to(outside)
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", root)
    monkeypatch.setattr(gallery_mod, "THUMB_CACHE_DIR", tmp_path / ".thumbs")
    return TestClient(app)


def test_list_newest_first(client):
    r = client.get("/api/gallery/list")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["name"] for i in items] == ["b.jpg", "a.png"]  # txt excluded, sub not listed as file
    assert items[0]["width"] == 640 and items[0]["height"] == 480
    assert "sub" in r.json()["subdirs"]


def test_list_subdir(client):
    r = client.get("/api/gallery/list", params={"dir": "sub"})
    assert r.status_code == 200
    assert [i["name"] for i in r.json()["items"]] == ["c.png"]


def test_list_dir_escape(client):
    r = client.get("/api/gallery/list", params={"dir": "../"})
    assert r.status_code == 400
    r = client.get("/api/gallery/list", params={"dir": "/etc"})
    assert r.status_code == 400


def test_file_jail_dotdot(client):
    r = client.get("/api/gallery/file", params={"path": "../secret.png"})
    assert r.status_code == 400


def test_file_jail_absolute(client):
    r = client.get("/api/gallery/file", params={"path": "/etc/passwd"})
    assert r.status_code == 400


def test_file_jail_symlink(client):
    r = client.get("/api/gallery/file", params={"path": "escape.png"})
    assert r.status_code == 400


def test_file_serves(client):
    r = client.get("/api/gallery/file", params={"path": "a.png"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_thumb_generation_and_cache(client, tmp_path):
    r = client.get("/api/gallery/thumb", params={"path": "a.png"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    im = Image.open(io.BytesIO(r.content))
    assert max(im.size) <= gallery_mod.THUMB_SIZE
    thumbs = list((tmp_path / ".thumbs").glob("*.webp"))
    assert len(thumbs) == 1
    # Second call served from cache (same file count).
    client.get("/api/gallery/thumb", params={"path": "a.png"})
    assert len(list((tmp_path / ".thumbs").glob("*.webp"))) == 1


def test_thumb_jail(client):
    assert client.get("/api/gallery/thumb", params={"path": "../secret.png"}).status_code == 400
    assert client.get("/api/gallery/thumb", params={"path": "/etc/passwd"}).status_code == 400
    assert client.get("/api/gallery/thumb", params={"path": "escape.png"}).status_code == 400


def test_pagination(client):
    r1 = client.get("/api/gallery/list", params={"cursor": ""})
    d1 = r1.json()
    assert d1["next_cursor"] is None  # only 2 files, under PAGE_SIZE

    # Force tiny pages to exercise cursoring.
    import backend.routers.gallery as g
    old = g.PAGE_SIZE
    g.PAGE_SIZE = 1
    try:
        r1 = client.get("/api/gallery/list")
        d1 = r1.json()
        assert [i["name"] for i in d1["items"]] == ["b.jpg"]
        assert d1["next_cursor"]
        r2 = client.get("/api/gallery/list", params={"cursor": d1["next_cursor"]})
        d2 = r2.json()
        assert [i["name"] for i in d2["items"]] == ["a.png"]
        assert d2["next_cursor"] is None
    finally:
        g.PAGE_SIZE = old


def test_bad_cursor(client):
    assert client.get("/api/gallery/list", params={"cursor": "garbage"}).status_code == 400


# ---- pending filter (2026-10-07t) -----------------------------------------

@pytest.fixture
def pclient(client, tmp_path, monkeypatch):
    """Gallery client with a manifest containing b.jpg (newest file)."""
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    r = client.post("/api/pending", json={"paths": ["b.jpg"]})
    assert r.json() == {"added": 1, "count": 1}
    return client


def test_list_pending_tag(pclient):
    items = pclient.get("/api/gallery/list").json()["items"]
    assert {i["name"]: i["pending"] for i in items} == {"b.jpg": True, "a.png": False}


def test_list_active_excludes_manifest(pclient):
    names = [i["name"] for i in pclient.get(
        "/api/gallery/list", params={"pending": "active"}).json()["items"]]
    assert names == ["a.png"]


def test_list_pending_only_manifest(pclient):
    names = [i["name"] for i in pclient.get(
        "/api/gallery/list", params={"pending": "pending"}).json()["items"]]
    assert names == ["b.jpg"]


def test_list_pending_bad_value(client):
    assert client.get("/api/gallery/list", params={"pending": "bogus"}).status_code == 400


def test_list_pending_pagination_both_views(pclient):
    """PAGE_SIZE=1: each filtered view paginates over its own file set only."""
    import backend.routers.gallery as g
    old = g.PAGE_SIZE
    g.PAGE_SIZE = 1
    try:
        # Active view: a.png only (b.jpg is in the manifest).
        d1 = pclient.get("/api/gallery/list", params={"pending": "active"}).json()
        assert [i["name"] for i in d1["items"]] == ["a.png"]
        assert d1["next_cursor"] is None
        # Pending view: b.jpg only, same single page.
        d2 = pclient.get("/api/gallery/list", params={"pending": "pending"}).json()
        assert [i["name"] for i in d2["items"]] == ["b.jpg"]
        assert d2["next_cursor"] is None
        # All view still paginates over both, newest first.
        d3 = pclient.get("/api/gallery/list").json()
        assert [i["name"] for i in d3["items"]] == ["b.jpg"]
        d4 = pclient.get("/api/gallery/list", params={"cursor": d3["next_cursor"]}).json()
        assert [i["name"] for i in d4["items"]] == ["a.png"]
    finally:
        g.PAGE_SIZE = old


def test_list_pending_subdir_filter(pclient):
    """Manifest entries outside the listed dir simply never appear."""
    names = [i["name"] for i in pclient.get(
        "/api/gallery/list", params={"dir": "sub", "pending": "active"}).json()["items"]]
    assert names == ["c.png"]


def test_list_excludes_temp_dir(client):
    """ellieedit_tmp at the gallery root is never listed or offered."""
    (gallery_mod.GALLERY_ROOT / "ellieedit_tmp").mkdir(exist_ok=True)
    (gallery_mod.GALLERY_ROOT / "ellieedit_tmp" / "junk.png").write_bytes(b"x")
    r = client.get("/api/gallery/list")
    assert r.status_code == 200
    assert "ellieedit_tmp" not in r.json()["subdirs"]
    assert [i["name"] for i in r.json()["items"]] == ["b.jpg", "a.png"]
    # Deeper inside, a same-named dir is still a normal subdir (root-only filter).
    (gallery_mod.GALLERY_ROOT / "sub" / "ellieedit_tmp").mkdir(exist_ok=True)
    assert "ellieedit_tmp" in client.get(
        "/api/gallery/list", params={"dir": "sub"}).json()["subdirs"]


def test_cleanup_tmp_dir_missing_dir_ok(tmp_path, monkeypatch):
    monkeypatch.setattr(gallery_mod, "TMP_DIR", tmp_path / "nope")
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", tmp_path)
    assert gallery_mod.cleanup_tmp_dir() == 0


def test_cleanup_tmp_dir_deletes_old_keeps_new(tmp_path, monkeypatch):
    import os
    root = tmp_path
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", root)
    tmpd = root / "ellieedit_tmp"
    tmpd.mkdir()
    old, new = tmpd / "old.png", tmpd / "new.png"
    old.write_bytes(b"x")
    new.write_bytes(b"y")
    ancient = time.time() - 25 * 3600
    os.utime(old, (ancient, ancient))
    # Legacy mess at output root: deleted unconditionally.
    legacy = root / "facecycle_repaint_00001_.png"
    legacy.write_bytes(b"z")
    monkeypatch.setattr(gallery_mod, "TMP_DIR", tmpd)
    removed = gallery_mod.cleanup_tmp_dir()
    assert removed == 2
    assert not old.exists() and not legacy.exists()
    assert new.exists()
