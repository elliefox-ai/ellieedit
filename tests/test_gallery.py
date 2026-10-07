"""Gallery endpoint tests — listing, path jail, thumbnails, pagination."""

import io
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.routers import gallery as gallery_mod


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
