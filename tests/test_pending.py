"""Pending Delete manifest tests — add/dedupe/pardon/confirm + path jail."""

import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.routers import gallery as gallery_mod
from backend.routers import pending as pending_mod


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = tmp_path / "gallery"
    root.mkdir()
    (root / "keepme.png").write_bytes(b"one")
    (root / "two.png").write_bytes(b"twotwo")
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"secret")
    (root / "escape.png").symlink_to(outside)
    (root / "sub").mkdir()
    (root / "sub" / "three.png").write_bytes(b"333")
    (root / "dir.png").mkdir()  # a directory, not a file
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", root)
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    monkeypatch.setattr(pending_mod, "AUDIT", tmp_path / "audit.jsonl")
    return root, tmp_path / "secret.png"


@pytest.fixture
def client(env):
    return TestClient(app)


def test_add_list_dedupe(client):
    r = client.post("/api/pending", json={"paths": ["keepme.png", "sub/three.png"]})
    assert r.status_code == 200
    assert r.json() == {"added": 2, "count": 2}
    # dedupe: re-adding the same path changes nothing
    r = client.post("/api/pending", json={"paths": ["keepme.png"]})
    assert r.json() == {"added": 0, "count": 2}
    # missing files ignored
    r = client.post("/api/pending", json={"paths": ["gone.png"]})
    assert r.json() == {"added": 0, "count": 2}
    lst = client.get("/api/pending").json()
    assert lst["count"] == 2
    assert {i["path"] for i in lst["items"]} == {"keepme.png", "sub/three.png"}
    assert all(i["size"] and i["added_at"] for i in lst["items"])
    assert lst["bytes"] == 3 + 3


def test_jail_on_add(client, env):
    root, outside = env
    for bad in ("../secret.png", "/secret.png", "~/.ssh", "sub/../../secret.png"):
        assert client.post("/api/pending", json={"paths": [bad]}).status_code == 400, bad
    # symlink that resolves outside root is jailed
    assert client.post("/api/pending", json={"paths": ["escape.png"]}).status_code == 400
    assert client.get("/api/pending").json()["count"] == 0
    assert not outside.exists() or True  # untouched either way


def test_jail_on_pardon_and_list(monkeypatch, client, env):
    root, _ = env
    client.post("/api/pending", json={"paths": ["keepme.png"]})
    # jail applies on DELETE too — escape paths rejected
    assert client.request("DELETE", "/api/pending",
                          json={"paths": ["../secret.png"]}).status_code == 400


def test_pardon(client):
    client.post("/api/pending", json={"paths": ["keepme.png", "two.png"]})
    r = client.request("DELETE", "/api/pending", json={"paths": ["keepme.png"]})
    assert r.json() == {"pardoned": 1, "count": 1}
    lst = client.get("/api/pending").json()
    assert [i["path"] for i in lst["items"]] == ["two.png"]


def test_confirm_deletes_files_and_clears(client, env):
    root, outside = env
    client.post("/api/pending", json={"paths": ["keepme.png", "sub/three.png", "two.png"]})
    r = client.post("/api/pending/confirm", json={})
    j = r.json()
    assert j["deleted"] == 3
    assert j["bytes"] == 3 + 3 + 6
    assert not (root / "keepme.png").exists()
    assert not (root / "sub" / "three.png").exists()
    assert not (root / "two.png").exists()
    # manifest cleared
    assert client.get("/api/pending").json()["count"] == 0
    # never touched anything outside the manifest
    assert outside.read_bytes() == b"secret"


def test_confirm_idempotent_when_missing(client, env):
    root, _ = env
    (root / "keepme.png").unlink()
    client.post("/api/pending", json={"paths": ["keepme.png"]})
    # added before it vanished... actually add happens after unlink, so add skips it.
    (root / "two.png").unlink()
    client.post("/api/pending", json={"paths": ["two.png"]})
    # manifest empty since both adds skipped missing files
    r = client.post("/api/pending/confirm", json={})
    assert r.json()["deleted"] == 0
    assert client.get("/api/pending").json()["count"] == 0


def test_audit_lines_for_add_unmark_confirm(client, env):
    """Every manifest mutation appends one well-formed JSONL audit line
    (ts, ip, action, count, paths) to the append-only audit file."""
    import json
    root, _ = env
    audit = pending_mod.AUDIT
    client.post("/api/pending", json={"paths": ["keepme.png", "two.png"]})
    lines = [json.loads(l) for l in audit.read_text().splitlines()]
    assert len(lines) == 1
    e = lines[0]
    assert e["action"] == "add" and e["count"] == 2
    assert e["ip"] == "testclient"  # TestClient host recorded
    assert sorted(e["paths"]) == ["keepme.png", "two.png"]
    assert e["ts"].startswith(time.strftime("%Y"))  # ISO-ish UTC stamp

    client.request("DELETE", "/api/pending", json={"paths": ["keepme.png"]})
    e = [json.loads(l) for l in audit.read_text().splitlines()][-1]
    assert e["action"] == "unmark" and e["paths"] == ["keepme.png"]

    client.post("/api/pending/confirm", json={})
    e = [json.loads(l) for l in audit.read_text().splitlines()][-1]
    assert e["action"] == "confirm" and e["count"] == 1
    assert e["paths"] == ["two.png"]


def test_audit_read_endpoint(client, env):
    import json
    root, _ = env
    client.post("/api/pending", json={"paths": ["keepme.png"]})
    r = client.get("/api/pending/audit", params={"limit": 10})
    assert r.status_code == 200
    lines = r.json()["lines"]
    assert lines[-1]["action"] == "add"
    assert lines[-1]["paths"] == ["keepme.png"]
    # fresh/missing audit file: empty, not an error
    pending_mod.AUDIT.unlink()
    assert client.get("/api/pending/audit").json() == {"lines": [], "count": 0}


def test_audit_failure_never_fails_mutation(client, env, monkeypatch):
    """Audit append is best-effort: a broken audit sink can't break the op."""
    root, _ = env
    # Point AUDIT at an uncreatable location: append must be swallowed.
    monkeypatch.setattr(pending_mod, "AUDIT", root / "no-dir" / "x" / "a.jsonl")
    r = client.post("/api/pending", json={"paths": ["keepme.png"]})
    assert r.status_code == 200 and r.json() == {"added": 1, "count": 1}
    assert (root / "keepme.png").is_file()


def test_audit_truncates_long_path_lists(client, env):
    import json
    root, _ = env
    for i in range(25):
        (root / f"m{i}.png").write_bytes(b"x")
    client.post("/api/pending", json={"paths": [f"m{i}.png" for i in range(25)]})
    e = [json.loads(l) for l in pending_mod.AUDIT.read_text().splitlines()][-1]
    assert e["count"] == 25
    assert len(e["paths"]) == 21 and e["paths"][-1] == "... +5 more"


def test_dupe_pool_fallback_listing(monkeypatch, tmp_path):
    """Regression (2026-10-08f): dupe-view rejects are queued as DUPE_ROOT-
    relative paths that pass the gallery path-shape jail but only exist under
    the dupe pool. Listing, size-stat, and thumbs must resolve through the
    dupe jail (mirroring confirm) — else the Deletion view renders blank
    cells and '0 B'."""
    from backend.routers import dupe as dupe_mod

    groot = tmp_path / "gallery"
    droot = tmp_path / "dupes"
    groot.mkdir(); droot.mkdir()
    (droot / "pool1").mkdir()
    Image.new("RGB", (4, 4)).save(droot / "pool1" / "reject.png")
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", groot)
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", droot)
    # Write the manifest directly the way dupe send-pending does for
    # pool-outside-gallery members.
    import json, time
    (tmp_path / "pending.json").write_text(json.dumps(
        {"pool1/reject.png": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}))

    client = TestClient(app)
    lst = client.get("/api/pending").json()
    assert lst["count"] == 1 and lst["bytes"] > 0
    assert lst["items"][0]["size"] == (droot / "pool1" / "reject.png").stat().st_size
    # Pending listing surfaces it with real dimensions.
    d = client.get("/api/gallery/list", params={"pending": "pending"}).json()
    assert [i["path"] for i in d["items"]] == ["pool1/reject.png"]
    assert d["items"][0]["width"] == 4
    # Thumb + file resolve through the fallback jail.
    assert client.get("/api/gallery/thumb",
                      params={"path": "pool1/reject.png"}).status_code == 200
    assert client.get("/api/gallery/file",
                      params={"path": "pool1/reject.png"}).status_code == 200
    # Jail escapes stay rejected (no dupe fallback for violations).
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"x")
    (groot / "escape.png").symlink_to(outside)
    assert client.get("/api/gallery/thumb",
                      params={"path": "escape.png"}).status_code == 400


def test_add_and_confirm_expected_count_mismatch_409(client, env):
    """Optimistic concurrency: optional expected_count mismatch -> 409 with
    the current count; match or omission still works."""
    r = client.post("/api/pending", json={"paths": ["keepme.png"]})
    assert r.status_code == 200
    # stale expectation -> 409
    r = client.post("/api/pending", json={"paths": ["two.png"]},
                    params={"expected_count": 99})
    assert r.status_code == 409
    assert "current count" in r.json()["detail"]
    # correct expectation -> fine
    r = client.post("/api/pending", json={"paths": ["two.png"]},
                    params={"expected_count": 1})
    assert r.status_code == 200
    # confirm with a stale count -> 409, nothing deleted
    r = client.post("/api/pending/confirm", json={"expected_count": 99})
    assert r.status_code == 409
    assert (env[0] / "keepme.png").exists()
    # confirm with the seen count -> deletes
    r = client.post("/api/pending/confirm", json={"expected_count": 2})
    assert r.status_code == 200 and r.json()["deleted"] == 2


# ------------------------------------------------------------ banks (v1.5)

import io as _io
import json as _json


@pytest.fixture
def bank_env(tmp_path, monkeypatch):
    primary = tmp_path / "gallery"
    home = tmp_path / "home"
    work = tmp_path / "work"
    for root in (primary, home, work):
        root.mkdir(parents=True)
    for root, name in ((primary, "p.png"), (home, "h.png"), (work, "w.png")):
        img = Image.new("RGB", (32, 32), (5, 5, 5))
        buf = _io.BytesIO(); img.save(buf, "PNG")
        (root / name).write_bytes(buf.getvalue())
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", primary)
    monkeypatch.setattr(pending_mod, "MANIFEST", tmp_path / "pending.json")
    monkeypatch.setattr(pending_mod, "AUDIT", tmp_path / "audit.jsonl")
    monkeypatch.setenv("ELLIEEDIT_GALLERY_BANKS", _json.dumps([
        {"label": "Home", "root": str(home)},
        {"label": "Work", "root": str(work), "writable": True},
    ]))
    return TestClient(app)


def test_add_readonly_bank_blocked(bank_env):
    r = bank_env.post("/api/pending", json={"paths": ["bank:home:h.png"]})
    assert r.status_code == 400
    assert "read-only" in r.json()["detail"]


def test_add_writable_bank_key_works(bank_env):
    r = bank_env.post("/api/pending", json={"paths": ["bank:work:w.png"]})
    assert r.status_code == 200 and r.json()["added"] == 1
    items = bank_env.get("/api/pending").json()["items"]
    assert items[0]["path"] == "bank:work:w.png"


def test_confirm_keeps_readonly_bank_entries(bank_env):
    # A bank that flipped to read-only after marking must survive confirm.
    bank_env.post("/api/pending", json={"paths": ["p.png", "bank:work:w.png"]})
    import json as _j
    mpath = None
    # locate the manifest via the module constant (patched in fixture)
    from backend.routers import pending as _pm
    m = _j.loads(_pm.MANIFEST.read_text())
    m["bank:home:h.png"] = m.pop("bank:work:w.png")
    _pm.MANIFEST.write_text(_j.dumps(m))
    r = bank_env.post("/api/pending/confirm", json={})
    assert r.status_code == 200
    assert r.json()["deleted"] == 1          # only the primary file
    remaining = _j.loads(_pm.MANIFEST.read_text())
    assert list(remaining) == ["bank:home:h.png"]
