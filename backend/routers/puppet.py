"""Puppet Theater module router — multi-subject compose stage (work order
2026-10-22, increment puppet-theater-v1).

Why this exists: two-reference Klein edits keep "correcting" subject poses —
the model's portrait prior beats the reference. Puppet Theater takes pose
authority away from the model. The human places rmbg cutouts manually as
baked pixels; the model's only job is a final harmonization pass
(light/shadow/seams), fenced to low denoise. Poses are pixels, not wishes.

Conventions followed (surveyed at ec8ce1d):
  - Router style / path jails: gallery.py (jailed(), atomic writes like
    foxden presets, env-overridable data dir like foxden.data_dir()).
  - Project storage: module data dir (ELLIEEDIT_PUPPET_DATA, default
    <repo>/data/puppet) with one folder per theater project —
    projects/<id>/project.json + projects/<id>/assets/*.png.
    (library.py's per-project layout is LIBRARY_ROOT/<tag>/ + a JSON sidecar;
    theater projects are working state, not promoted library items, so they
    live in module data like foxden's recent/presets, NOT in the library
    root, where the library listing would ingest the layer PNGs.)
  - Final pass: a masked repaint at the fenced denoise — engine Klein by
    default (backend.comfy.comfy_repaint_klein, v1.2; preserves placed
    pixels better), Krea2 (comfy_repaint) as the explicit alternative.
    The mask is the Fill Area rendermask when painted, else full-canvas
    white: the whole composite is context, nothing is a prompt-placed
    subject. FoxDen's generate/status plumbing is used by the frontend
    for BACKGROUND generation only (txt2img on the foxden tab's own path).
  - Denoise fence: the render denoise is clamped server-side to
    [DENOISE_MIN, DENOISE_MAX] = 0.2–0.8 (widened 2026-10-22 by Alexander's
    call: Fill Area regions intentionally have no existing pixels to
    protect, so high denoise is legitimate there; the 2026-09-08 d0.8
    face-reconception finding applies to whole-image passes, and the top
    of the fence still excludes the 0.9+ re-conceive-everything range).
"""

import base64
import io
import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageChops, ImageOps
from pydantic import BaseModel

from .. import comfy

Image.MAX_IMAGE_PIXELS = None  # local tool; images may be large

log = logging.getLogger("ellieedit.puppet")

router = APIRouter(prefix="/api/puppet", tags=["puppet"])

# ------------------------------------------------------------- the fence

DENOISE_MIN = 0.2
DENOISE_MAX = 0.8
DENOISE_DEFAULT = 0.45

CANVAS_PRESETS = {"1:1": (1024, 1024), "3:2": (1152, 768), "16:9": (1280, 720)}
MAX_CANVAS_DIM = 8192
MAX_LAYERS = 64
STATE_MAX_BYTES = 256 * 1024          # layer stack JSON; images are assets
ASSET_MAX_BYTES = 25 * 1024 * 1024    # same upload ceiling as foxden
ASSET_KINDS = {"source", "cutout", "mask", "background", "render",
               "rendermask"}
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
_lock = threading.Lock()


def clamp_denoise(v) -> float:
    """The fence, as a pure function: None/garbage -> default; anything
    outside [0.2, 0.8] is clamped INTO the fence, never rejected and never
    honored. d0.9+ in -> 0.8 out; d0.1 in -> 0.2 out."""
    try:
        d = float(v)
    except (TypeError, ValueError):
        return DENOISE_DEFAULT
    if d != d:  # NaN
        return DENOISE_DEFAULT
    return min(DENOISE_MAX, max(DENOISE_MIN, d))


# ------------------------------------------------------------------ paths

def data_dir() -> Path:
    return Path(os.environ.get(
        "ELLIEEDIT_PUPPET_DATA",
        str(Path(__file__).resolve().parents[2] / "data" / "puppet")))


def projects_dir() -> Path:
    return data_dir() / "projects"


def project_dir(pid: str) -> Path:
    """Jailed project folder: the id is a slug we minted, never a path."""
    if not _ID_RE.match(pid or ""):
        raise HTTPException(400, "bad project id")
    return projects_dir() / pid


def _project_file(pid: str) -> Path:
    return project_dir(pid) / "project.json"


def _asset_path(pid: str, name: str) -> Path:
    """Jailed asset path: basename only, image suffix only, inside assets/."""
    if not name or Path(name).name != name or Path(name).suffix.lower() not in IMG_EXTS:
        raise HTTPException(400, "bad asset name")
    return project_dir(pid) / "assets" / name


# ----------------------------------------------------------------- images

def _decode_image(data_b64: str, what: str = "image") -> bytes:
    """base64 -> verified image bytes (PIL header check, format allowlist)."""
    try:
        raw = base64.b64decode(data_b64 or "", validate=True)
    except Exception:
        raise HTTPException(400, f"{what} is not valid base64")
    if not raw or len(raw) > ASSET_MAX_BYTES:
        raise HTTPException(400, f"{what} empty or oversized (25MB max)")
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.verify()
            fmt = im.format
    except Exception:
        raise HTTPException(400, f"{what} is not a readable image")
    if fmt not in ("PNG", "JPEG", "WEBP"):
        raise HTTPException(400, f"{what} must be PNG, JPEG, or WebP")
    return raw


def _png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


# ------------------------------------------------------------- state shape

def _asset_name(v):
    """An asset reference survives validation only as a bare image filename."""
    if not isinstance(v, str) or not v:
        return None
    if Path(v).name != v or Path(v).suffix.lower() not in IMG_EXTS:
        return None
    return v


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f else default


def validate_state(raw) -> dict:
    """Normalize a layer-stack state dict. Unknown layer keys are dropped;
    asset references must be bare filenames (the jail); canvas is bounded.
    The state this returns is the ONLY shape ever written to project.json
    or composited, so save and render can never disagree about a layer."""
    if not isinstance(raw, dict):
        raise HTTPException(400, "state must be an object")
    if len(json.dumps(raw, ensure_ascii=False).encode("utf-8")) > STATE_MAX_BYTES:
        raise HTTPException(413, "layer stack JSON too large")
    canvas_in = raw.get("canvas") if isinstance(raw.get("canvas"), dict) else {}
    # Clamped, not rejected — the exact mirror of puppet-core.js
    # normalizeState, so client and server can never disagree on the canvas.
    w = min(MAX_CANVAS_DIM, max(16, int(_num(canvas_in.get("width"), 1024))))
    h = min(MAX_CANVAS_DIM, max(16, int(_num(canvas_in.get("height"), 1024))))
    bg_in = canvas_in.get("background") if isinstance(canvas_in.get("background"), dict) else {}
    background = {"type": bg_in.get("type") if bg_in.get("type") in ("none", "image") else "none",
                  "asset": _asset_name(bg_in.get("asset"))}
    if background["type"] != "image":
        background["asset"] = None
    layers_in = raw.get("layers") if isinstance(raw.get("layers"), list) else []
    if len(layers_in) > MAX_LAYERS:
        raise HTTPException(400, f"at most {MAX_LAYERS} layers")
    layers = []
    seen_ids = set()
    for i, li in enumerate(layers_in):
        if not isinstance(li, dict):
            continue
        lid = str(li.get("id") or f"layer-{i + 1}")[:64]
        if lid in seen_ids:
            lid = f"{lid}-{i + 1}"
        seen_ids.add(lid)
        lw = max(1.0, _num(li.get("w"), 100.0))
        lh = max(1.0, _num(li.get("h"), 100.0))
        layers.append({
            "id": lid,
            "name": str(li.get("name") or f"Layer {i + 1}")[:80],
            "asset": _asset_name(li.get("asset")),
            "source": _asset_name(li.get("source")),
            "mask": _asset_name(li.get("mask")),
            "cutout": _asset_name(li.get("cutout")),
            "x": _num(li.get("x"), 0.0), "y": _num(li.get("y"), 0.0),
            "w": lw, "h": lh,
            "rotation": _num(li.get("rotation"), 0.0) % 360.0,
            "visible": bool(li.get("visible", True)),
            "natural_w": int(_num(li.get("natural_w"), 0)),
            "natural_h": int(_num(li.get("natural_h"), 0)),
        })
    name = str(raw.get("name") or "Untitled theater")[:120]
    return {"name": name,
            "canvas": {"width": w, "height": h, "background": background},
            "layers": layers,
            "rendermask": _asset_name(raw.get("rendermask"))}


def default_state(name: str = "") -> dict:
    return validate_state({"name": name or "Untitled theater",
                           "canvas": {"width": 1024, "height": 1024,
                                      "background": {"type": "none", "asset": None}},
                           "layers": []})


def save_project(pid: str, state: dict) -> dict:
    d = project_dir(pid)
    d.mkdir(parents=True, exist_ok=True)
    (d / "assets").mkdir(exist_ok=True)
    clean = validate_state(state)
    clean["updated"] = int(time.time())
    p = _project_file(pid)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(clean, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)                       # atomic: never a half-written file
    return clean


def load_project(pid: str) -> dict:
    p = _project_file(pid)
    if not p.is_file():
        raise HTTPException(404, "no such theater project")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise HTTPException(500, f"project unreadable: {e}")


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:32]
    return s or "theater"


# -------------------------------------------------------------- compositing

def _open_asset(pid: str, name: str) -> Image.Image:
    p = _asset_path(pid, name)
    if not p.is_file():
        raise HTTPException(404, f"asset missing: {name}")
    with Image.open(p) as im:
        return im.convert("RGBA")


def composite_image(pid: str, state: dict) -> Image.Image:
    """Flatten the stack exactly as the stage shows it (bottom layer first):
    background cover-fit, per-layer mask multiplied into alpha, resize to
    (w, h), rotate about the layer CENTER (CSS transform semantics: PIL
    rotates counter-clockwise, CSS clockwise — hence the negation), and
    alpha-composite at the layer's center. Pure layout: no model, no
    network. This is what Export and the final pass both consume."""
    cw = int(state["canvas"]["width"])
    ch = int(state["canvas"]["height"])
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    bg = state["canvas"].get("background") or {}
    if bg.get("type") == "image" and bg.get("asset"):
        bim = _open_asset(pid, bg["asset"])
        canvas.alpha_composite(ImageOps.fit(bim, (cw, ch), Image.LANCZOS))
    for layer in state.get("layers", []):
        if not layer.get("visible", True):
            continue
        fname = layer.get("asset") or layer.get("source")
        if not fname:
            continue
        im = _open_asset(pid, fname)
        # Two independent alpha masks, both nondestructive: the rmbg
        # "Cut Out" mask (v1.1, Amendment D — the original pixels are never
        # modified) and the hand-painted erase mask. Each multiplies in.
        for key in ("cutout", "mask"):
            if layer.get(key):
                mask = _open_asset(pid, layer[key]).convert("L")
                if mask.size != im.size:
                    mask = mask.resize(im.size, Image.BILINEAR)
                im.putalpha(_apply_mask(im.getchannel("A"), mask))
        tw = max(1, int(round(layer["w"])))
        th = max(1, int(round(layer["h"])))
        if im.size != (tw, th):
            im = im.resize((tw, th), Image.LANCZOS)
        rot = float(layer.get("rotation") or 0.0) % 360.0
        if rot:
            im = im.rotate(-rot, resample=Image.BICUBIC, expand=True)
        cx = float(layer["x"]) + float(layer["w"]) / 2.0
        cy = float(layer["y"]) + float(layer["h"]) / 2.0
        canvas.alpha_composite(im, (int(round(cx - im.width / 2.0)),
                                    int(round(cy - im.height / 2.0))))
    return canvas


def _apply_mask(alpha: Image.Image, mask: Image.Image) -> Image.Image:
    """alpha' = alpha * mask/255. Mask is grayscale: white keeps, black
    erases, gray is the soft edge. ImageChops.multiply IS that arithmetic."""
    return ImageChops.multiply(alpha, mask)


def white_mask_b64(w: int, h: int) -> str:
    """The final-pass fence in image form: an all-white mask means the whole
    canvas is repaint context — SetLatentNoiseMask repaints everything at
    the fenced denoise, so harmonization is uniform and no region is
    'the subject' the model may re-conceive at higher strength."""
    return base64.b64encode(_png_bytes(Image.new("L", (w, h), 255))).decode()


# -------------------------------------------------------------------- rmbg

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
JOB_MAX = 32


def rmbg_model_path() -> Path:
    home = Path(os.environ.get("U2NET_HOME", str(Path.home() / ".u2net")))
    return home / "u2net.onnx"


def rmbg_status() -> dict:
    """Availability WITHOUT triggering a download: rembg importable AND the
    u2net model already cached. The test suite skips on exactly this."""
    try:
        import rembg  # noqa: F401
        importable = True
    except Exception:
        importable = False
    cached = rmbg_model_path().is_file()
    return {"importable": importable, "model_cached": cached,
            "available": bool(importable and cached),
            "model_path": str(rmbg_model_path())}


_rmbg_session = None


def _rmbg_remove(raw: bytes) -> bytes:
    """remove() with a cached session — remove() alone rebuilds the onnx
    session (~10-30s) on EVERY call, which made every puppet drop crawl."""
    global _rmbg_session
    from rembg import remove, new_session
    if _rmbg_session is None:
        _rmbg_session = new_session("u2net")
    return remove(raw, session=_rmbg_session)


def _run_rmbg(job_id: str, raw: bytes) -> None:
    try:
        st = rmbg_status()
        if not st["importable"]:
            raise RuntimeError("rembg is not installed on the server")
        if not st["model_cached"] and \
                os.environ.get("PUPPET_RMBG_ALLOW_DOWNLOAD") != "1":
            raise RuntimeError(
                "u2net model not cached and downloads are off "
                "(set PUPPET_RMBG_ALLOW_DOWNLOAD=1 to allow a first-run download)")
        out = _rmbg_remove(raw)              # bytes in -> PNG bytes out
        if isinstance(out, Image.Image):
            out = _png_bytes(out)
        with Image.open(io.BytesIO(out)) as im:
            w, h = im.size
            has_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
        with _jobs_lock:
            _jobs[job_id].update(state="done", image_b64=base64.b64encode(out).decode(),
                                 width=w, height=h)
    except Exception as e:
        log.warning("puppet rmbg job %s failed: %s", job_id, e)
        with _jobs_lock:
            if job_id in _jobs:
                _jobs[job_id].update(state="error", error=str(e))


class RmbgBody(BaseModel):
    image_b64: str


@router.post("/rmbg", status_code=202)
def rmbg_submit(body: RmbgBody):
    """Image in -> job id out. Background removal runs in a thread (it can
    exceed a few seconds); poll GET /rmbg/{job_id} for the alpha PNG."""
    raw = _decode_image(body.image_b64, "rmbg input")
    job_id = uuid.uuid4().hex[:16]
    with _jobs_lock:
        if len(_jobs) >= JOB_MAX:
            _jobs.pop(next(iter(_jobs)))
        _jobs[job_id] = {"state": "running"}
    threading.Thread(target=_run_rmbg, args=(job_id, raw), daemon=True,
                     name=f"puppet-rmbg-{job_id}").start()
    return {"job_id": job_id, "state": "running"}


@router.get("/rmbg/{job_id}")
def rmbg_poll(job_id: str):
    with _jobs_lock:
        job = dict(_jobs.get(job_id) or {})
    if not job:
        raise HTTPException(404, "no such rmbg job")
    return job


# ------------------------------------------------------------------- config

@router.get("/config")
def config():
    return {"denoise": {"min": DENOISE_MIN, "max": DENOISE_MAX,
                        "default": DENOISE_DEFAULT},
            "canvas_presets": {k: list(v) for k, v in CANVAS_PRESETS.items()},
            "max_layers": MAX_LAYERS,
            "engines": list(ENGINES), "default_engine": DEFAULT_ENGINE,
            "rmbg": rmbg_status()}


# ----------------------------------------------------------------- projects

class ProjectCreate(BaseModel):
    name: str = ""
    state: dict | None = None


class ProjectSave(BaseModel):
    state: dict


@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate):
    pid = f"{_slug(body.name)}-{uuid.uuid4().hex[:8]}"
    state = validate_state(body.state) if body.state is not None else default_state(body.name)
    if body.name:
        state["name"] = body.name[:120]
    saved = save_project(pid, state)
    return {"id": pid, "state": saved}


@router.get("/projects")
def list_projects():
    out = []
    try:
        dirs = sorted(projects_dir().iterdir(),
                      key=lambda p: p.stat().st_mtime, reverse=True)
    except FileNotFoundError:
        dirs = []
    for d in dirs:
        pf = d / "project.json"
        if not pf.is_file():
            continue
        try:
            st = json.loads(pf.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({"id": d.name, "name": st.get("name", d.name),
                    "updated": st.get("updated"),
                    "canvas": st.get("canvas"),
                    "layers": len(st.get("layers", []))})
    return {"items": out}


@router.get("/projects/{pid}")
def get_project(pid: str):
    return {"id": pid, "state": load_project(pid)}


@router.put("/projects/{pid}")
def put_project(pid: str, body: ProjectSave):
    project_dir(pid)                          # jail/id check
    return {"id": pid, "state": save_project(pid, body.state)}


# ------------------------------------------------------------------- assets

class AssetBody(BaseModel):
    kind: str
    image_b64: str


@router.post("/projects/{pid}/assets", status_code=201)
def add_asset(pid: str, body: AssetBody):
    if body.kind not in ASSET_KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(ASSET_KINDS)}")
    raw = _decode_image(body.image_b64, "asset")
    d = project_dir(pid) / "assets"
    d.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(raw)) as im:
        w, h = im.size
        rgba = im.convert("RGBA")
    fname = f"{body.kind}-{uuid.uuid4().hex[:10]}.png"
    (d / fname).write_bytes(_png_bytes(rgba))
    return {"file": fname, "kind": body.kind, "width": w, "height": h,
            "url": f"/api/puppet/projects/{pid}/assets/{fname}"}


@router.get("/projects/{pid}/assets/{fname}")
def get_asset(pid: str, fname: str):
    p = _asset_path(pid, fname)
    if not p.is_file():
        raise HTTPException(404, "no such asset")
    return FileResponse(p, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=3600"})


# ------------------------------------------------------------------- export

@router.get("/projects/{pid}/export.png")
def export_png(pid: str):
    state = load_project(pid)
    data = _png_bytes(composite_image(pid, validate_state(state)))
    return Response(data, media_type="image/png", headers={
        "Content-Disposition": f'attachment; filename="puppet-{pid}.png"'})


@router.get("/projects/{pid}/export.json")
def export_json(pid: str):
    state = load_project(pid)
    return Response(json.dumps(state, ensure_ascii=False, indent=2),
                    media_type="application/json", headers={
                        "Content-Disposition":
                            f'attachment; filename="puppet-{pid}.json"'})


# --------------------------------------------------------------- final pass

def choose_render_mask(pid: str, state: dict, mode) -> tuple[str, str]:
    """Resolve the final-pass mask. Returns (mask_b64, used) where used is
    'fill' or 'full'.

    - mode 'all' (the UI's "Render all") → the v1 full-canvas white mask.
    - mode 'fill' with a painted Fill Area rendermask asset → that mask
      (white = regenerate, black = locked), resized to the canvas.
    - a rendermask that exists but is entirely black is EMPTY: painting
      nothing must behave exactly like v1, so fall back to white.
    - no rendermask at all → white."""
    w = int(state["canvas"]["width"])
    h = int(state["canvas"]["height"])
    if mode == "fill" and state.get("rendermask"):
        try:
            mask = _open_asset(pid, state["rendermask"]).convert("L")
        except HTTPException:
            mask = None                       # dangling ref: treat as none
        if mask is not None:
            if mask.size != (w, h):
                mask = mask.resize((w, h), Image.BILINEAR)
            if mask.getextrema()[1] > 0:      # something is painted
                return base64.b64encode(_png_bytes(mask)).decode(), "fill"
    return white_mask_b64(w, h), "full"


class RenderBody(BaseModel):
    prompt: str = ""
    denoise: float | None = None
    seed: int = 0
    mode: str = "fill"
    engine: str = "klein"


# Final-pass engines (v1.2 item 4). Klein is the DEFAULT — including when
# the client omits the field or sends garbage: it preserves the placed
# pixels (the design) better. Krea2 repaints more aggressively and stays
# available as the explicit option. Both run at the same fenced denoise.
ENGINES = ("klein", "krea2")
DEFAULT_ENGINE = "klein"


def resolve_engine(v) -> str:
    return v if v in ENGINES else DEFAULT_ENGINE


@router.post("/projects/{pid}/render")
def render(pid: str, body: RenderBody):
    """The harmonization pass. Composites the SAVED stack server-side (so
    what renders is exactly what export.png shows), then runs the existing
    low-denoise inpaint path at the FENCED denoise. The mask comes from the
    Fill Area step when one is painted (mode 'fill'); otherwise — or when
    the user picks "Render all" — it is the v1 full-canvas white mask.
    The result is also stored as a 'render' asset; the client shows it as
    an accept/discard preview — accepting never deletes the stack."""
    state = validate_state(load_project(pid))
    flat = composite_image(pid, state)
    w, h = flat.size
    denoise = clamp_denoise(body.denoise)
    mask_b64, mask_used = choose_render_mask(pid, state, body.mode)
    engine = resolve_engine(body.engine)
    repaint = (comfy.comfy_repaint_klein if engine == "klein"
               else comfy.comfy_repaint)
    try:
        png = repaint(
            base64.b64encode(_png_bytes(flat)).decode(),
            mask_b64,
            body.prompt or "",
            denoise=denoise, seed=int(body.seed or 0))
    except Exception as e:
        log.error("[puppet render] ERROR: %s", e)
        raise HTTPException(status_code=502, detail=f"final pass failed: {e}")
    render_asset = None
    try:
        d = project_dir(pid) / "assets"
        d.mkdir(parents=True, exist_ok=True)
        render_asset = f"render-{uuid.uuid4().hex[:10]}.png"
        (d / render_asset).write_bytes(png)
    except OSError:
        render_asset = None                   # preview still returns
    return {"image_b64": base64.b64encode(png).decode(),
            "denoise": denoise, "width": w, "height": h,
            "mask_used": mask_used, "engine": engine,
            "render_asset": render_asset}
