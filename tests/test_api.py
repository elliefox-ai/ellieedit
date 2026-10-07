"""Endpoint smoke tests with mocked ComfyUI."""

import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app


def make_png_bytes(size=(32, 32)):
    img = Image.new("RGB", size, (10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def client(monkeypatch):
    def fake_repaint(image_b64, mask_b64, prompt, denoise=0.5, seed=0, timeout=600):
        return make_png_bytes()
    monkeypatch.setattr("backend.comfy.comfy_repaint", fake_repaint)
    return TestClient(app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_shell_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "EllieEdit" in r.text


def test_manifest_and_sw(client):
    assert client.get("/manifest.webmanifest").status_code == 200
    assert client.get("/sw.js").status_code == 200


def test_repaint_endpoint(client):
    payload = {
        "image_b64": base64.b64encode(make_png_bytes()).decode(),
        "mask_b64": base64.b64encode(make_png_bytes()).decode(),
        "prompt": "test",
        "denoise": 0.5,
        "seed": 1,
    }
    r = client.post("/api/facecycle/repaint", json=payload)
    assert r.status_code == 200
    out = base64.b64decode(r.json()["image_b64"])
    assert out.startswith(b"\x89PNG")


def test_repaint_promptless(client):
    """Generate with empty prompt is accepted (conditioning from context only)."""
    payload = {
        "image_b64": base64.b64encode(make_png_bytes()).decode(),
        "mask_b64": base64.b64encode(make_png_bytes()).decode(),
        "prompt": "",
        "denoise": 0.5,
        "seed": 2,
    }
    r = client.post("/api/facecycle/repaint", json=payload)
    assert r.status_code == 200
    assert base64.b64decode(r.json()["image_b64"]).startswith(b"\x89PNG")


def test_repaint_error_propagates(client, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("ComfyUI down")
    monkeypatch.setattr("backend.comfy.comfy_repaint", boom)
    payload = {
        "image_b64": base64.b64encode(make_png_bytes()).decode(),
        "mask_b64": base64.b64encode(make_png_bytes()).decode(),
        "prompt": "test",
    }
    r = client.post("/api/facecycle/repaint", json=payload)
    assert r.status_code == 500
    assert "ComfyUI down" in r.json()["detail"]
