"""Review save endpoint tests — path jail, dir creation, overwrite policy."""

import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.routers import gallery as gallery_mod
from backend.routers import review as review_mod


def png_b64(color=(10, 20, 30)):
    buf = io.BytesIO()
    Image.new("RGB", (32, 24), color).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def client(tmp_path, monkeypatch):
    root = tmp_path / "gallery"
    root.mkdir(parents=True)
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"secret")
    (root / "escape.png").symlink_to(outside)
    monkeypatch.setattr(gallery_mod, "GALLERY_ROOT", root)
    monkeypatch.setattr(review_mod, "REVIEW_SUBDIR", "reviewed")
    return TestClient(app)


def _save(client, name, data=None, **kw):
    body = {"filename": name, "data": data if data is not None else png_b64()}
    body.update(kw)
    return client.post("/api/review/save", json=body)


def test_save_creates_dirs_and_file(client, tmp_path):
    r = _save(client, "out1.png")
    assert r.status_code == 200
    assert r.json()["saved"] == "reviewed/out1.png"
    dest = tmp_path / "gallery" / "reviewed" / "out1.png"
    assert dest.is_file()
    with Image.open(dest) as im:
        assert im.size == (32, 24)


def test_save_rejects_existing_without_overwrite(client):
    assert _save(client, "dup.png").status_code == 200
    r = _save(client, "dup.png")
    assert r.status_code == 409
    r = _save(client, "dup.png", overwrite=True)
    assert r.status_code == 200


def test_save_jail_dotdot(client):
    assert _save(client, "../escape.png").status_code == 400
    assert _save(client, "sub/../escape.png").status_code == 400


def test_save_jail_absolute_and_tilde(client):
    assert _save(client, "/etc/passwd").status_code == 400
    assert _save(client, "~root/x.png").status_code == 400


def test_save_jail_symlink(client, tmp_path):
    # Symlink at the destination that resolves outside the root must be rejected.
    reviewed = tmp_path / "gallery" / "reviewed"
    reviewed.mkdir()
    (reviewed / "link.png").symlink_to(tmp_path / "secret.png")
    assert _save(client, "link.png").status_code == 400
    assert not (tmp_path / "secret.png").exists() or \
        (tmp_path / "secret.png").read_bytes() == b"secret"


def test_save_bad_filename(client):
    assert _save(client, "").status_code == 400
    assert _save(client, "a/b.png").status_code == 400
    assert _save(client, "x.txt").status_code == 400


def test_save_bad_data(client):
    r = _save(client, "bad.png", data=base64.b64encode(b"not an image").decode())
    assert r.status_code == 400


def test_outdir(client):
    r = client.get("/api/review/outdir")
    assert r.status_code == 200
    assert r.json()["subdir"] == "reviewed"
