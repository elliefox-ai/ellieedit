"""Thumbnail generation locking + background warm-ahead (2026-10-15)."""

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.routers import gallery as g
from backend.routers import pending as pending_mod


def mkimg(path, mtime, size=(600, 400)):
    Image.new("RGB", size, (9, 9, 9)).save(path, "PNG")
    os.utime(path, (mtime, mtime))


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = tmp_path / "gallery"
    root.mkdir()
    for i in range(12):                                  # i00 oldest .. i11 newest
        mkimg(root / f"i{i:02d}.png", 1000 + i)
    monkeypatch.setattr(g, "GALLERY_ROOT", root)
    monkeypatch.setattr(g, "THUMB_CACHE_DIR", tmp_path / ".thumbs")
    monkeypatch.setattr(g, "PAGE_SIZE", 4)
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    monkeypatch.setattr(g, "_warm_pool", ThreadPoolExecutor(max_workers=2))   # private, drainable
    g._DIR_INDEX.clear(); g._DIMS.clear(); g._warm_inflight.clear(); g._thumb_locks.clear()
    return root


def drain(monkeypatch=None):
    g._warm_pool.shutdown(wait=True)


def cached(tmp_path):
    d = tmp_path / ".thumbs"
    return sorted(p.name for p in d.glob("*.webp")) if d.exists() else []


# --------------------------------------------------- one generation per thumb

def test_concurrent_requests_generate_each_thumbnail_once(env, tmp_path, monkeypatch):
    real_open, opens = Image.open, []

    def slow_open(*a, **k):
        opens.append(1); time.sleep(0.05)               # widen the race window
        return real_open(*a, **k)
    monkeypatch.setattr(g.Image, "open", slow_open)
    with ThreadPoolExecutor(8) as ex:
        paths = list(ex.map(lambda _: g.get_thumbnail(env / "i00.png"), range(8)))
    assert len(set(paths)) == 1 and paths[0].exists()
    assert len(opens) == 1                               # waiters reused the finished file
    assert len(cached(tmp_path)) == 1
    assert not list((tmp_path / ".thumbs").glob("*.tmp"))
    assert g._thumb_locks == {}                          # lock table doesn't grow


def test_failed_generation_leaves_no_partial_files_and_recovers(env, tmp_path):
    bad = env / "i11.png"
    bad.write_bytes(b"not an image")
    with pytest.raises(Exception):
        g.get_thumbnail(bad)
    assert not list((tmp_path / ".thumbs").glob("*.tmp")) and g._thumb_locks == {}
    mkimg(bad, 4242)                                     # fixed file -> works next time
    assert g.get_thumbnail(bad).exists()


# ------------------------------------------------------------- warm-ahead

def test_list_warms_current_and_next_page(env, tmp_path, monkeypatch):
    monkeypatch.setattr(g, "THUMB_WARM", True)
    c = TestClient(app)
    r = c.get("/api/gallery/list").json()                # page 1: i11..i08; ahead: i07..i04
    assert [i["name"] for i in r["items"]] == ["i11.png", "i10.png", "i09.png", "i08.png"]
    drain()
    assert len(cached(tmp_path)) == 8                    # current + next page, nothing beyond
    # a later /thumb is a pure cache hit (no regeneration)
    before = {p.name: p.stat().st_mtime_ns for p in (tmp_path / ".thumbs").glob("*.webp")}
    assert c.get("/api/gallery/thumb", params={"path": "i05.png"}).status_code == 200
    after = {p.name: p.stat().st_mtime_ns for p in (tmp_path / ".thumbs").glob("*.webp")}
    assert before == after


def test_pending_view_warms_too(env, tmp_path, monkeypatch):
    import json
    (tmp_path / "pending.json").write_text(json.dumps({f"i{i:02d}.png": "t" for i in range(6)}))
    monkeypatch.setattr(g, "THUMB_WARM", True)
    TestClient(app).get("/api/gallery/list", params={"pending": "pending"})
    drain()
    assert len(cached(tmp_path)) == 6


def test_warming_off_submits_nothing(env, tmp_path):
    TestClient(app).get("/api/gallery/list")             # conftest default: THUMB_WARM False
    drain()
    assert cached(tmp_path) == [] and not g._warm_inflight


def test_warm_failures_never_break_listing_and_inflight_drains(env, tmp_path, monkeypatch):
    monkeypatch.setattr(g, "THUMB_WARM", True)
    (env / "i11.png").write_bytes(b"corrupt")
    os.utime(env / "i11.png", (1011, 1011))
    r = TestClient(app).get("/api/gallery/list")
    assert r.status_code == 200
    drain()
    assert g._warm_inflight == set()                     # failed items released too


def test_warm_dedupes_queued_paths_and_respects_cap(env, tmp_path, monkeypatch):
    monkeypatch.setattr(g, "THUMB_WARM", True)
    gate = threading.Event()
    monkeypatch.setattr(g, "get_thumbnail", lambda p: gate.wait(5))    # hold workers busy
    paths = [str(env / f"i{i:02d}.png") for i in range(6)]
    f1 = g.warm_thumbs(paths)
    assert len(f1) == 6
    assert g.warm_thumbs(paths) == []                    # all still in flight -> skipped
    monkeypatch.setattr(g, "WARM_MAX_INFLIGHT", 8)
    extra = [str(env / f"i{i:02d}.png") for i in range(6, 12)]
    assert len(g.warm_thumbs(extra)) == 2                # cap: 6 in flight + 2 = 8
    gate.set(); drain()
    assert g._warm_inflight == set()


def test_warm_does_not_block_the_response(env, tmp_path, monkeypatch):
    monkeypatch.setattr(g, "THUMB_WARM", True)
    gate = threading.Event()
    monkeypatch.setattr(g, "get_thumbnail", lambda p: gate.wait(5))
    t0 = time.perf_counter()
    r = TestClient(app).get("/api/gallery/list")
    assert r.status_code == 200 and time.perf_counter() - t0 < 2   # workers still blocked
    gate.set(); drain()


def test_jpeg_thumbnail_uses_reduced_decode(env, tmp_path):
    p = env / "photo.jpg"
    Image.new("RGB", (3000, 2000), (50, 60, 70)).save(p, "JPEG")
    tp = g.get_thumbnail(p)
    with Image.open(tp) as im:
        assert max(im.size) <= g.THUMB_SIZE
