"""Library endpoint tests — promote validation, move-not-copy, index
discipline, tag normalization. All tests run against temp roots: no test
ever touches the real gallery, dupe, or library trees."""

import hashlib
import io
import json
import shutil

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.routers import dupe as dupe_mod
from backend.routers import gallery as gallery_mod
from backend.routers import library as library_mod


def _png(color=(9, 8, 7)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Temp gallery root + dupe root + library root, all inside tmp_path."""
    groot = tmp_path / "gallery"
    droot = tmp_path / "dupes"
    lroot = tmp_path / "library"
    (groot / "ZengoSoft Face").mkdir(parents=True)
    (droot / "flatdeep_v5_kreagen").mkdir(parents=True)
    (groot / "ZengoSoft Face" / "a.png").write_bytes(_png())
    (groot / "loose.png").write_bytes(_png((1, 2, 3)))
    (droot / "flatdeep_v5_kreagen" / "b.png").write_bytes(_png((4, 5, 6)))
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "evil.png").write_bytes(_png((7, 7, 7)))
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", groot)
    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", droot)
    monkeypatch.setattr(library_mod, "LIBRARY_ROOT", lroot)
    return {"gallery": groot, "dupe": droot, "library": lroot,
            "outside": outside, "tmp": tmp_path}


@pytest.fixture
def client(env):
    return TestClient(app)


def test_promote_move_not_copy(client, env):
    src = env["gallery"] / "ZengoSoft Face" / "a.png"
    digest_before = hashlib.sha256(src.read_bytes()).hexdigest()
    r = client.post("/api/library/promote",
                    json={"path": "ZengoSoft Face/a.png"})
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True
    assert j["tags"] == ["zengosoft"]  # folder noise 'Face' stripped
    # Source GONE (move, not copy)
    assert not src.exists()
    # Dest exists with identical bytes
    dest = env["library"] / "zengosoft" / "a.png"
    assert dest.is_file()
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == digest_before
    assert j["sha256"] == digest_before
    # No stray copies anywhere in tmp outside the library
    strays = [p for p in env["tmp"].rglob("a.png")
              if env["library"] not in p.parents]
    assert strays == []


def test_promote_drvfs_copystat_fallback(client, env, monkeypatch):
    # DrvFS sources (/mnt/*): shutil.move's copy2 dies on copystat utime
    # AFTER the bytes landed. Promote must still complete as a move.
    import errno as _errno
    import backend.routers.library as lib
    def drvfs_move(src, dst):
        shutil.copyfile(src, dst)
        raise PermissionError(1, "Operation not permitted")  # utime stage
    def exdev_replace(a, b):
        raise OSError(_errno.EXDEV, "Invalid cross-device link")
    monkeypatch.setattr(lib.shutil, "move", drvfs_move)
    monkeypatch.setattr(lib.os, "replace", exdev_replace)
    src = env["gallery"] / "loose.png"
    digest = hashlib.sha256(src.read_bytes()).hexdigest()
    r = client.post("/api/library/promote", json={"path": "loose.png", "tag": "probe"})
    assert r.status_code == 200, r.text
    assert not src.exists(), "source survived the DrvFS fallback"
    dest = env["library"] / "probe" / "loose.png"
    assert dest.is_file()
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == digest


def test_promote_dupe_root_source(client, env):
    r = client.post("/api/library/promote",
                    json={"path": "flatdeep_v5_kreagen/b.png"})
    assert r.status_code == 200
    assert r.json()["tags"] == ["flatdeep"]
    assert not (env["dupe"] / "flatdeep_v5_kreagen" / "b.png").exists()
    assert (env["library"] / "flatdeep" / "b.png").is_file()


def test_promote_outside_root_rejected(client, env):
    r = client.post("/api/library/promote", json={"path": "../../outside/evil.png"})
    assert r.status_code == 400
    assert (env["outside"] / "evil.png").is_file()  # untouched
    # Absolute path also rejected
    r = client.post("/api/library/promote",
                    json={"path": str(env["outside"] / "evil.png")})
    assert r.status_code == 400


def test_promote_missing_source_is_404(client, env):
    r = client.post("/api/library/promote", json={"path": "no/such.png"})
    assert r.status_code == 404


def test_double_promote_noop(client, env):
    """First promote moves the file; a repeated click finds the source gone
    → 404 (frontend treats it as a no-op toast, not an error dialog)."""
    r1 = client.post("/api/library/promote", json={"path": "loose.png"})
    assert r1.status_code == 200
    r2 = client.post("/api/library/promote", json={"path": "loose.png"})
    assert r2.status_code == 404
    # Library holds exactly one copy
    assert len(list(env["library"].rglob("loose.png"))) == 1


def test_index_append_discipline(client, env):
    client.post("/api/library/promote", json={"path": "loose.png", "tag": "flatdeep"})
    client.post("/api/library/promote", json={"path": "ZengoSoft Face/a.png"})
    idx = env["library"] / ".library-index.jsonl"
    lines = [json.loads(l) for l in idx.read_text().splitlines() if l.strip()]
    assert len(lines) == 2  # appended, one record per promote
    assert [r["tags"][0] for r in lines] == ["flatdeep", "zengosoft"]
    for r in lines:
        assert set(r) == {"path", "tags", "promoted_from", "ts", "sha256"}
        assert len(r["sha256"]) == 64
    # Retag appends a third record; latest wins.
    r = client.post("/api/library/retag",
                    json={"path": "flatdeep/loose.png", "tags": ["Toon", "flatdeep"]})
    assert r.status_code == 200
    lines = [json.loads(l) for l in idx.read_text().splitlines() if l.strip()]
    assert len(lines) == 3  # append-only: nothing rewritten
    listing = client.get("/api/library/list").json()
    item = next(i for i in listing["items"] if i["name"] == "loose.png")
    assert item["tags"] == ["flatdeep", "toon"]


def test_list_tag_filter_and_paging(client, env, monkeypatch):
    monkeypatch.setattr(library_mod, "PAGE_SIZE", 1)
    client.post("/api/library/promote", json={"path": "loose.png", "tag": "toon"})
    client.post("/api/library/promote", json={"path": "ZengoSoft Face/a.png"})
    full = client.get("/api/library/list").json()
    assert full["total"] == 2
    filtered = client.get("/api/library/list", params={"tag": "toon"}).json()
    assert filtered["total"] == 1
    assert filtered["items"][0]["name"] == "loose.png"
    p1 = client.get("/api/library/list").json()
    assert p1["shown"] == 1 and p1["next_cursor"] == 1
    p2 = client.get("/api/library/list", params={"cursor": 1}).json()
    assert p2["shown"] == 1 and p2["next_cursor"] is None


def test_library_jail(client, env):
    r = client.get("/api/library/file", params={"path": "../../outside/evil.png"})
    assert r.status_code == 400


def test_migrate_dry_run(tmp_path, monkeypatch, capsys):
    """Bulk migration dry-run: counts kept verdicts, verifies existence,
    moves nothing, writes no index."""
    droot = tmp_path / "dupes"
    (droot / "flatdeep_v5_top").mkdir(parents=True)
    (droot / "flatdeep_v5_top" / "k1.png").write_bytes(_png())
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text(
        json.dumps({"ts": "t", "family": "fam-aaaaaaaaaaaa",
                    "members": {"flatdeep_v5_top/k1.png": "kept"}}) + "\n" +
        json.dumps({"ts": "t2", "family": "fam-aaaaaaaaaaaa",
                    "members": {"flatdeep_v5_top/k1.png": "rejected"}}) + "\n" +
        json.dumps({"ts": "t3", "family": "fam-bbbbbbbbbbbb",
                    "members": {"flatdeep_v5_top/k1.png": "kept"}}) + "\n")
    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", droot)
    monkeypatch.setattr(library_mod, "LIBRARY_ROOT", tmp_path / "library")
    from backend.library_migrate import kept_paths, main
    kp = kept_paths(ledger)
    assert kp == ["flatdeep_v5_top/k1.png"]  # latest verdict wins
    rc = main(["--dry-run", "--ledger", str(ledger)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "flatdeep" in out and "DRY RUN" in out and "APPROVAL GATE" in out
    assert not (tmp_path / "library").exists()  # nothing moved
    assert (droot / "flatdeep_v5_top" / "k1.png").is_file()


# ---- tag normalization ------------------------------------------------------

def test_normalize_tag():
    f = library_mod.normalize_tag
    assert f("ZengoSoft Face") == "zengosoft"
    assert f("flatdeep_v5_kreagen") == "flatdeep"
    assert f("flatdeep_v5_kreagen_sd15pass") == "flatdeep"
    assert f("flatdeep_v5_top") == "flatdeep"
    assert f("FlatDeep") == "flatdeep"
    assert f("f2k4b_zengodraw") == "zengosoft"  # numeric-mush prefix + alias
    assert f("Toon") == "toon"
    assert f("") == "misc"


def test_derive_tag_bare_file(env):
    assert library_mod.derive_tag(env["gallery"] / "loose.png") == "misc"


# ---- deletion queue: library pending-delete (2026-10-09e) ------------------

def test_pending_delete_moves_not_unlinks(client, env):
    """Library delete enqueues: the file SURVIVES on disk (moved into the
    pending area), the original path is gone from the listing, and the
    index carries deleted_soon."""
    r = client.post("/api/library/promote", json={"path": "loose.png", "tag": "misc"})
    assert r.status_code == 200
    rel = r.json()["path"]
    src = env["library"] / rel
    assert src.is_file()

    r = client.post("/api/library/pending-delete", json={"path": rel})
    assert r.status_code == 200
    # Never unlinked: bytes live in the pending area.
    pdir = env["library"] / ".pending-delete"
    assert not src.exists()
    queued = list(pdir.iterdir())
    assert len(queued) == 1 and queued[0].is_file()

    # Listing skips it; index marks deleted_soon.
    items = client.get("/api/library/list").json()["items"]
    assert all(i["path"] != rel for i in items)
    recs = [json.loads(l) for l in (env["library"] / ".library-index.jsonl").read_text().splitlines() if l.strip()]
    assert recs[-1]["path"] == rel and recs[-1]["deleted_soon"] is True


def test_pending_delete_jail(client, env):
    r = client.post("/api/library/pending-delete", json={"path": "../../outside/evil.png"})
    assert r.status_code == 400
    r = client.post("/api/library/pending-delete", json={"path": "never-promoted.png"})
    assert r.status_code == 404


def test_pending_queue_list_and_confirm(client, env):
    """GET /pending reports the queue; /pending/confirm is the only purge."""
    r = client.post("/api/library/promote", json={"path": "loose.png", "tag": "misc"})
    rel = r.json()["path"]
    client.post("/api/library/pending-delete", json={"path": rel})
    q = client.get("/api/library/pending").json()
    assert q["count"] == 1 and q["bytes"] > 0
    confirm = client.post("/api/library/pending/confirm").json()
    assert confirm["deleted"] == 1
    assert client.get("/api/library/pending").json()["count"] == 0
    assert not (env["library"] / ".pending-delete").exists() or \
        not list((env["library"] / ".pending-delete").iterdir())


def test_derive_tag_deepest_folder(env):
    """2026-10-09e: promote derives the tag from the DEEPEST folder."""
    deep = env["gallery"] / "zengostyle" / "passes"
    deep.mkdir(parents=True)
    (deep / "d.png").write_bytes(_png())
    assert library_mod.derive_tag(deep / "d.png") == "passes"
    assert library_mod.derive_tag(env["gallery"] / "ZengoSoft Face" / "a.png") == "zengosoft"


# ------------------------------------------------------------ banks (v1.5)

import json as _json


def test_promote_readonly_bank_blocked(client, env, monkeypatch):
    home = env["tmp"] / "home"
    home.mkdir()
    (home / "h.png").write_bytes(_png((9, 9, 9)))
    monkeypatch.setenv("ELLIEEDIT_GALLERY_BANKS", _json.dumps([
        {"label": "Home", "root": str(home)}]))
    r = client.post("/api/library/promote",
                    json={"path": "h.png", "bank": "home", "tag": "home"})
    assert r.status_code == 400
    assert "read-only" in r.json()["detail"]
    assert (home / "h.png").exists()   # nothing moved


def test_promote_writable_bank_moves(client, env, monkeypatch):
    work = env["tmp"] / "work"
    work.mkdir()
    (work / "w.png").write_bytes(_png((8, 8, 8)))
    monkeypatch.setenv("ELLIEEDIT_GALLERY_BANKS", _json.dumps([
        {"label": "Work", "root": str(work), "writable": True}]))
    r = client.post("/api/library/promote",
                    json={"path": "w.png", "bank": "work", "tag": "worktag"})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "worktag/w.png"
    assert not (work / "w.png").exists()
    assert (env["library"] / "worktag" / "w.png").exists()
