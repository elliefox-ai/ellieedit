"""ComfyUI integration layer for EllieEdit.

Ported near-verbatim from /home/zengonzo/workspace/facecycle/face_merge.py
(FaceCycle 2.0 relay). These encode hard-won fixes — most importantly the
BasicScheduler-not-Flux2Scheduler denoise lesson — so behavior is kept
identical. Do not "clean up" without re-testing against the real stack.
"""

import base64
import copy
import io
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from pathlib import Path

import numpy as np
from PIL import Image

COMFY_URL = os.environ.get('COMFY_URL', 'http://100.115.117.53:8188')


# Krea2 inpaint workflow — extracted verbatim from the operator's real ComfyUI
# history (sickOllieKrea2GGUF_v10 runs), converted to inpaint: LoadImage +
# LoadImageMask + VAEEncode + SetLatentNoiseMask replace EmptyFlux2LatentImage.
# LoRA stack preserved with the operator's tested strengths.
REPAINT_GRAPH = {
    "380": {"class_type": "UnetLoaderGGUF",
            "inputs": {"unet_name": "_Krea2\\sickOllieKrea2GGUF_v10.gguf"}},
    "381": {"class_type": "CLIPLoader",
            "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": "krea2", "device": "default"}},
    "382": {"class_type": "VAELoader",
            "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
    "397": {"class_type": "LoraLoader",
            "inputs": {"lora_name": "_Krea2\\Personal\\ZengoStyle\\zengosoft_faces-v1-r32-s500-step00000500.safetensors",
                       "strength_model": 1.0, "strength_clip": -0.1,
                       "model": ["380", 0], "clip": ["381", 0]}},
    "385": {"class_type": "LoraLoader",
            "inputs": {"lora_name": "_Krea2\\Personal\\ZengoStyle\\zengostyle-r32-s1500.safetensors",
                       "strength_model": 0.0, "strength_clip": -0.1,
                       "model": ["397", 0], "clip": ["397", 1]}},
    "386": {"class_type": "LoraLoader",
            "inputs": {"lora_name": "_Krea2\\Personal\\FlatDeep\\flatdeep-v4-r32.safetensors",
                       "strength_model": 0.8, "strength_clip": -0.1,
                       "model": ["385", 0], "clip": ["385", 1]}},
    "112": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["386", 1]}},
    "113": {"class_type": "CLIPTextEncode",
            "inputs": {"text": "muddy, incoherent, abstract, poor quality, bad quality, low quality, \n\nlens flare, light bleed, glare, halation", "clip": ["386", 1]}},
    "103": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    "106": {"class_type": "RandomNoise", "inputs": {"noise_seed": 0}},
    # BasicScheduler (not Flux2Scheduler — it has NO denoise input and silently ran
    # every repaint at full strength, regenerating the masked region from scratch).
    # BasicScheduler honors denoise for the SetLatentNoiseMask inpaint path.
    "115": {"class_type": "BasicScheduler", "inputs": {"model": ["386", 0], "scheduler": "simple", "steps": 4, "denoise": 0.5}},
    "114": {"class_type": "CFGGuider", "inputs": {"cfg": 1.0, "model": ["386", 0], "positive": ["112", 0], "negative": ["113", 0]}},
    "200": {"class_type": "LoadImage", "inputs": {"image": "input.png", "upload": "image"}},
    "201": {"class_type": "LoadImageMask", "inputs": {"image": "mask.png", "channel": "red"}},
    "202": {"class_type": "VAEEncode", "inputs": {"pixels": ["200", 0], "vae": ["382", 0]}},
    "203": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["202", 0], "mask": ["201", 0]}},
    "104": {"class_type": "SamplerCustomAdvanced",
            "inputs": {"noise": ["106", 0], "guider": ["114", 0], "sampler": ["103", 0],
                       "sigmas": ["115", 0], "latent_image": ["203", 0]}},
    "105": {"class_type": "VAEDecode", "inputs": {"samples": ["104", 0], "vae": ["382", 0]}},
    # SaveImage writes into an output subfolder so intermediates never land
    # in the gallery root; cleaned up by gallery.cleanup_tmp_dir().
    "19":  {"class_type": "SaveImage", "inputs": {"images": ["105", 0],
            "filename_prefix": "ellieedit_tmp/facecycle_repaint"}},
}


def build_repaint_workflow(image_b64, mask_b64, prompt, denoise=0.5, seed=0):
    """Deep-copy REPAINT_GRAPH and patch in one job's parameters.

    Split out from comfy_repaint so graph construction is unit-testable
    without any HTTP. Patch behavior is identical to the original.
    """
    img_png = base64.b64decode(image_b64)
    mask_png = base64.b64decode(mask_b64)
    img = Image.open(io.BytesIO(img_png))
    w, h = img.size

    img_name = _comfy_upload(img_png, f"fc_img_{seed}.png")
    mask_name = _comfy_upload(mask_png, f"fc_mask_{seed}.png")

    wf = copy.deepcopy(REPAINT_GRAPH)
    wf["112"]["inputs"]["text"] = prompt
    wf["106"]["inputs"]["noise_seed"] = int(seed)
    wf["115"]["inputs"]["denoise"] = float(denoise)
    wf["200"]["inputs"]["image"] = img_name
    wf["201"]["inputs"]["image"] = mask_name
    return wf


def _comfy_upload(png_bytes, name, image_type="input", overwrite=True):
    """Upload a PNG to ComfyUI's /upload/image endpoint. Returns server filename."""
    boundary = uuid.uuid4().hex
    parts = []
    for field, val in (("image", (name, png_bytes, "image/png")),):
        filename, data, ctype = val
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n")
    for field, val in (("type", image_type), ("overwrite", "true" if overwrite else "false")):
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"\r\n\r\n{val}\r\n".encode())
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        COMFY_URL + "/upload/image", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["name"]


def _delete_saved_file(im):
    """Unlink the repaint intermediate once its bytes are in hand.

    ComfyUI writes to the shared output root mounted at GALLERY_ROOT, so the
    saved file is addressable locally. Best-effort: never fail the repaint.
    """
    try:
        from .routers.gallery import TMP_DIR
        p = TMP_DIR / Path(im["filename"]).name
        if p.is_file():
            p.unlink()
            print(f"[repaint] cleaned intermediate {p.name}", flush=True)
    except Exception as e:
        print(f"[repaint] intermediate cleanup skipped: {e}", flush=True)


def comfy_repaint(image_b64, mask_b64, prompt, denoise=0.5, seed=0, timeout=600):
    """Run one Krea2 inpaint. Returns PNG bytes of the repainted full image."""
    wf = build_repaint_workflow(image_b64, mask_b64, prompt, denoise, seed)

    req = urllib.request.Request(
        COMFY_URL + "/prompt", data=json.dumps({"prompt": wf}).encode(),
        method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError(f"ComfyUI rejected workflow: {detail[:2000]}")
    if "prompt_id" not in resp:
        raise RuntimeError(f"ComfyUI did not queue: {json.dumps(resp)[:2000]}")
    pid = resp["prompt_id"]
    print(f"[repaint] queued {pid} seed={seed} denoise={denoise}", flush=True)

    # Poll history — a success with empty outputs is a silent prune; read log.
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(2)
        with urllib.request.urlopen(COMFY_URL + f"/history/{pid}", timeout=30) as r:
            hist = json.loads(r.read())
        if pid not in hist:
            continue
        entry = hist[pid]
        status = entry.get("status", {})
        if status.get("status_str") == "error":
            raise RuntimeError(f"ComfyUI run errored: {json.dumps(status)[:2000]}")
        outputs = entry.get("outputs", {})
        if outputs:
            for node_out in outputs.values():
                for im in node_out.get("images", []):
                    if im.get("type") == "output":
                        url = (f"{COMFY_URL}/view?filename={urllib.parse.quote(im['filename'])}"
                               f"&subfolder={urllib.parse.quote(im.get('subfolder',''))}&type=output")
                        with urllib.request.urlopen(url, timeout=120) as r2:
                            data = r2.read()
                        print(f"[repaint] done {pid} in {time.time()-t0:.0f}s", flush=True)
                        _delete_saved_file(im)
                        return data
            raise RuntimeError(f"Output had no output-type image: {json.dumps(outputs)[:1000]}")
    raise RuntimeError(f"Repaint timed out after {timeout}s (pid {pid})")
