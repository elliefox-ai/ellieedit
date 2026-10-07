"""Tests for backend/comfy.py — graph builders with mocked ComfyUI HTTP."""

import base64
import io
import json

import pytest
from PIL import Image

from backend import comfy


def make_png_b64(size=(64, 48), color=(200, 100, 50)):
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def no_http(monkeypatch):
    """Mock _comfy_upload and the /prompt + /history HTTP calls."""
    calls = {"uploads": [], "prompt": None}

    def fake_upload(png_bytes, name, image_type="input", overwrite=True):
        calls["uploads"].append(name)
        return name

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        class R:
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass
            def read(self):
                if "/prompt" in url:
                    return json.dumps({"prompt_id": "test-pid-1"}).encode()
                if "/history/" in url:
                    return json.dumps({
                        "test-pid-1": {
                            "status": {"status_str": "success"},
                            "outputs": {"19": {"images": [
                                {"filename": "out.png", "subfolder": "", "type": "output"}]}},
                        },
                    }).encode()
                if "/view" in url:
                    return b"PNGDATA"
                raise AssertionError(f"unexpected url {url}")
        return R()

    monkeypatch.setattr(comfy, "_comfy_upload", fake_upload)
    monkeypatch.setattr(comfy.urllib.request, "urlopen", fake_urlopen)
    return calls


def test_graph_shape_matches_original():
    g = comfy.REPAINT_GRAPH
    assert g["115"]["class_type"] == "BasicScheduler"  # the denoise lesson
    assert g["115"]["inputs"]["denoise"] == 0.5
    assert g["115"]["inputs"]["scheduler"] == "simple"
    assert g["115"]["inputs"]["steps"] == 4
    assert g["200"]["class_type"] == "LoadImage"
    assert g["201"]["class_type"] == "LoadImageMask"
    assert g["201"]["inputs"]["channel"] == "red"
    assert g["203"]["class_type"] == "SetLatentNoiseMask"
    assert g["104"]["class_type"] == "SamplerCustomAdvanced"
    assert g["19"]["inputs"]["filename_prefix"] == "facecycle_repaint"
    # LoRA stack chain 380 -> 397 -> 385 -> 386
    assert g["397"]["inputs"]["model"] == ["380", 0]
    assert g["385"]["inputs"]["model"] == ["397", 0]
    assert g["386"]["inputs"]["model"] == ["385", 0]


def test_build_repaint_workflow_patches(no_http):
    img = make_png_b64()
    mask = make_png_b64(color=(0, 0, 0))
    wf = comfy.build_repaint_workflow(img, mask, "a red hat", denoise=0.65, seed=42)

    assert no_http["uploads"] == ["fc_img_42.png", "fc_mask_42.png"]
    assert wf["112"]["inputs"]["text"] == "a red hat"
    assert wf["106"]["inputs"]["noise_seed"] == 42
    assert wf["115"]["inputs"]["denoise"] == 0.65
    assert wf["200"]["inputs"]["image"] == "fc_img_42.png"
    assert wf["201"]["inputs"]["image"] == "fc_mask_42.png"
    # Rest of graph untouched (deep copy, not mutation of the template)
    assert comfy.REPAINT_GRAPH["115"]["inputs"]["denoise"] == 0.5
    assert comfy.REPAINT_GRAPH["112"]["inputs"]["text"] == ""


def test_build_repaint_workflow_empty_prompt_is_valid():
    """Promptless generate: CLIPTextEncode (node 112) accepts an empty string —
    conditioning comes from the surrounding context only. No neutral-prompt
    hack needed."""
    img = make_png_b64()
    mask = make_png_b64(color=(0, 0, 0))
    wf = comfy.build_repaint_workflow(img, mask, "", denoise=0.5, seed=1)
    assert wf["112"]["inputs"]["text"] == ""
    assert wf["112"]["class_type"] == "CLIPTextEncode"
    # Workflow still structurally intact for the backend sampler
    assert wf["114"]["inputs"]["positive"] == ["112", 0]


def test_comfy_repaint_roundtrip(no_http):
    img = make_png_b64()
    mask = make_png_b64(color=(0, 0, 0))
    data = comfy.comfy_repaint(img, mask, "prompt", denoise=0.5, seed=7)
    assert data == b"PNGDATA"


def test_comfy_repaint_rejects_bad_workflow(no_http, monkeypatch):
    import urllib.error

    def fake_urlopen_err(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 400, "Bad", {}, io.BytesIO(b"invalid graph"))

    monkeypatch.setattr(comfy.urllib.request, "urlopen", fake_urlopen_err)
    img = make_png_b64()
    mask = make_png_b64(color=(0, 0, 0))
    with pytest.raises(RuntimeError, match="rejected workflow"):
        comfy.comfy_repaint(img, mask, "p")
