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
    assert g["19"]["inputs"]["filename_prefix"] == "ellieedit_tmp/facecycle_repaint"
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


def test_repaint_deletes_intermediate(no_http, tmp_path, monkeypatch):
    """After reading the /view bytes, the saved intermediate is unlinked."""
    from backend.routers import gallery as gallery_mod
    tmpd = tmp_path / "ellieedit_tmp"
    tmpd.mkdir()
    saved = tmpd / "facecycle_repaint_00001_.png"
    saved.write_bytes(b"ondisk")
    monkeypatch.setattr(gallery_mod, "TMP_DIR", tmpd)

    # Fake history must report the real saved filename so unlink targets match.
    orig_urlopen = comfy.urllib.request.urlopen
    def patched(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        if "/history/" in url:
            import backend.routers.gallery as g2
            class R2:
                def __enter__(self): return self
                def __exit__(self, *a): pass
                def read(self):
                    return json.dumps({"test-pid-1": {
                        "status": {"status_str": "success"},
                        "outputs": {"19": {"images": [
                            {"filename": saved.name, "subfolder": "ellieedit_tmp", "type": "output"}]}}},
                    }).encode()
            return R2()
        return orig_urlopen(req, timeout=timeout)
    monkeypatch.setattr(comfy.urllib.request, "urlopen", patched)
    img = make_png_b64()
    mask = make_png_b64(color=(0, 0, 0))
    data = comfy.comfy_repaint(img, mask, "p", seed=3)
    assert data == b"PNGDATA"
    assert not saved.exists()


# ------------------------------------------------ Klein repaint (v1.2)

def test_klein_graph_shape():
    g = comfy.KLEIN_REPAINT_GRAPH
    # adapted from the verified basic gen graph
    assert "klein" in g["380"]["inputs"]["gguf_name"].lower()
    assert g["381"]["class_type"] == "ClipLoaderGGUF"
    assert g["382"]["inputs"]["vae_name"] == "flux2-vae.safetensors"
    # the denoise lesson applies here too: BasicScheduler, NOT Flux2Scheduler
    assert g["115"]["class_type"] == "BasicScheduler"
    assert "denoise" in g["115"]["inputs"]
    assert g["115"]["inputs"]["steps"] == 6            # basic gen runs 6
    assert g["114"]["inputs"]["cfg"] == 1.0
    # Klein's negative is a zeroed positive, as in the basic graph
    assert g["113"]["class_type"] == "ConditioningZeroOut"
    assert g["114"]["inputs"]["negative"] == ["113", 0]
    # the masked-repaint conversion, same as REPAINT_GRAPH
    assert g["203"]["class_type"] == "SetLatentNoiseMask"
    assert g["203"]["inputs"]["samples"] == ["202", 0]
    assert g["201"]["class_type"] == "LoadImageMask"
    assert g["201"]["inputs"]["channel"] == "red"


def test_build_klein_repaint_workflow_patches(no_http):
    wf = comfy.build_klein_repaint_workflow(
        make_png_b64(), make_png_b64(), "soft light", denoise=0.3, seed=42)
    assert wf["112"]["inputs"]["text"] == "soft light"
    assert wf["106"]["inputs"]["noise_seed"] == 42
    assert wf["115"]["inputs"]["denoise"] == 0.3
    assert wf["200"]["inputs"]["image"] == "pk_img_42.png"
    assert wf["201"]["inputs"]["image"] == "pk_mask_42.png"
    assert no_http["uploads"] == ["pk_img_42.png", "pk_mask_42.png"]
    # the module-level template is never mutated by a build
    assert comfy.KLEIN_REPAINT_GRAPH["112"]["inputs"]["text"] == ""


def test_comfy_repaint_klein_roundtrip(no_http):
    out = comfy.comfy_repaint_klein(make_png_b64(), make_png_b64(), "x",
                                    denoise=0.45, seed=1)
    assert out == b"PNGDATA"
    assert no_http["uploads"] == ["pk_img_1.png", "pk_mask_1.png"]
