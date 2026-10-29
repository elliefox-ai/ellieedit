"""Update module — workflow-runner tab backend.

Design (operator spec, 2026-10-09):
  - The tab RUNS prepared ComfyUI workflows; workflows are JSON template
    files in workflows/ (env: ELLIEEDIT_WORKFLOWS_DIR), each with metadata
    (name, description) and a params block declaring the placeholder
    injection points: source image node, seed node, prompt node.
  - Width/height follow the source at runtime: presets keep the
    GetImageSize (110) -> EmptyFlux2LatentImage/Flux2Scheduler chain from
    the real run artifact, so nothing is hardcoded server-side.
  - Renders never touch the Library. Only the explicit save-family action
    writes: promote the chosen stack entry via the existing promote
    machinery, copy the stack original alongside (originals travel with
    finals), and append a version-family record to the library index.
  - Saved prompts: sidecar JSON store (data/saved-prompts.json,
    env: ELLIEEDIT_SAVED_PROMPTS), entries {name, text}.
  - No delete endpoints: destruction lives in Gallery/Dupe, not here.
"""

import base64
import copy
import io
import json
import os
import random
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from PIL import Image, ImageOps
from pydantic import BaseModel

from .. import comfy as _comfy
from . import gallery as _gallery_mod
from . import library as _library_mod

log = __import__("logging").getLogger("ellieedit.update")

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS_DIR = Path(os.environ.get(
    "ELLIEEDIT_WORKFLOWS_DIR", str(REPO / "workflows")))
SAVED_PROMPTS_PATH = Path(os.environ.get(
    "ELLIEEDIT_SAVED_PROMPTS", str(REPO / "data" / "saved-prompts.json")))

COMFY_URL = _comfy.COMFY_URL
RUN_TIMEOUT_S = int(os.environ.get("ELLIEEDIT_UPDATE_TIMEOUT", "900"))

# Masked-inpaint denoise fence — deliberately the SAME 0.2–0.8 fence as
# Puppet's (puppet.py DENOISE_MIN/MAX, widened 2026-10-22 by Alexander):
# the inpaint recipe runs Puppet's Klein graph, so it inherits Puppet's
# fence. Kept as a local copy, not an import, so the two routers stay
# decoupled; if the fence ever moves, move both together.
INPAINT_DENOISE_MIN = 0.2
INPAINT_DENOISE_MAX = 0.8
INPAINT_DENOISE_DEFAULT = 0.45


def clamp_inpaint_denoise(v) -> float:
    try:
        d = float(v)
    except (TypeError, ValueError):
        return INPAINT_DENOISE_DEFAULT
    if d != d:  # NaN
        return INPAINT_DENOISE_DEFAULT
    return min(INPAINT_DENOISE_MAX, max(INPAINT_DENOISE_MIN, d))
# SaveImage prefix shared by the seeded presets: outputs land in the
# gallery-root tmp subfolder, addressable for the later promote, swept by
# the gallery tmp hygiene after 24h if never saved.
OUTPUT_PREFIX = "ellieedit_tmp/update"

router = APIRouter(prefix="/api/update", tags=["update"])


# ---------------------------------------------------------------------------
# Preset loading
# ---------------------------------------------------------------------------

def load_presets() -> list[dict]:
    """All valid preset templates: [{file, name, description}]."""
    out = []
    if not WORKFLOWS_DIR.is_dir():
        return out
    for p in sorted(WORKFLOWS_DIR.glob("*.json")):
        try:
            d = json.loads(p.read_text())
        except json.JSONDecodeError:
            continue
        if isinstance(d, dict) and d.get("name") and isinstance(d.get("graph"), dict):
            out.append({"file": p.name, "name": d["name"],
                        "description": d.get("description", "")})
    return out


def load_preset(file: str) -> dict:
    """One preset, strictly jailed to WORKFLOWS_DIR; validates shape."""
    if not file or Path(file).name != file or not file.endswith(".json"):
        raise HTTPException(400, "invalid preset file name")
    p = WORKFLOWS_DIR / file
    if not p.is_file():
        raise HTTPException(404, f"preset not found: {file}")
    try:
        d = json.loads(p.read_text())
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"preset {file} is not valid JSON: {e}")
    if not isinstance(d.get("graph"), dict) or not d.get("name"):
        raise HTTPException(500, f"preset {file} missing name/graph")
    params = d.get("params") or {}
    for key in ("image", "seed", "prompt"):
        if not isinstance(params.get(key), dict):
            raise HTTPException(500, f"preset {file} missing params.{key}")
    return d


def build_run_graph(preset: dict, image_name: str, prompt: str, seed: int) -> dict:
    """Deep-copy the preset graph and inject placeholders.

    Pure (no HTTP) so preset/injection behavior is unit-testable.
    """
    params = preset["params"]
    wf = copy.deepcopy(preset["graph"])

    def _patch(node_id, input_name, value):
        node = wf.get(str(node_id))
        if node is None or "inputs" not in node:
            raise HTTPException(500, f"preset graph missing node {node_id}")
        node["inputs"][input_name] = value

    _patch(params["image"]["node"], params["image"]["input"], image_name)
    _patch(params["seed"]["node"], params["seed"]["input"], int(seed))
    _patch(params["prompt"]["node"], params["prompt"]["input"], prompt)
    # Belt and braces: any SaveImage in the graph writes to the tmp prefix
    # so renders are gallery-addressable but never pollute the root listing.
    for node in wf.values():
        if node.get("class_type") == "SaveImage":
            node["inputs"]["filename_prefix"] = OUTPUT_PREFIX
    return wf


# ---------------------------------------------------------------------------
# Saved prompts (sidecar JSON store)
# ---------------------------------------------------------------------------

def list_prompts() -> list[dict]:
    if not SAVED_PROMPTS_PATH.is_file():
        return []
    try:
        data = json.loads(SAVED_PROMPTS_PATH.read_text())
    except json.JSONDecodeError:
        return []
    return [e for e in data if isinstance(e, dict) and e.get("name")]


def save_prompts(entries: list[dict]) -> None:
    SAVED_PROMPTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SAVED_PROMPTS_PATH.write_text(
        json.dumps(entries, indent=1, ensure_ascii=False))


def add_prompt(name: str, text: str) -> list[dict]:
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "prompt name required")
    entries = [e for e in list_prompts() if e["name"] != name]
    entries.append({"name": name, "text": text or ""})
    entries.sort(key=lambda e: e["name"].lower())
    save_prompts(entries)
    return entries


def delete_prompt(name: str) -> list[dict]:
    entries = [e for e in list_prompts() if e["name"] != name]
    save_prompts(entries)
    return entries


# ---------------------------------------------------------------------------
# Comfy submit + poll (generic pattern from backend/comfy.py)
# ---------------------------------------------------------------------------

def comfy_submit(wf: dict) -> str:
    req = urllib.request.Request(
        COMFY_URL + "/prompt", data=json.dumps({"prompt": wf}).encode(),
        method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise HTTPException(502, f"ComfyUI rejected workflow: {detail[:2000]}")
    if "prompt_id" not in resp:
        raise HTTPException(502, f"ComfyUI did not queue: {json.dumps(resp)[:2000]}")
    return resp["prompt_id"]


def comfy_poll(pid: str, timeout: int = RUN_TIMEOUT_S) -> dict:
    """Poll history until outputs exist. Returns the image entry
    {filename, subfolder, type} of the first output-type image."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(2)
        with urllib.request.urlopen(COMFY_URL + f"/history/{pid}",
                                    timeout=30) as r:
            hist = json.loads(r.read())
        if pid not in hist:
            continue
        entry = hist[pid]
        status = entry.get("status", {})
        if status.get("status_str") == "error":
            raise HTTPException(502, f"ComfyUI run errored: {json.dumps(status)[:2000]}")
        for node_out in entry.get("outputs", {}).values():
            for im in node_out.get("images", []):
                if im.get("type") == "output":
                    return im
        # outputs present but no output-type image: silent prune guard
        if entry.get("outputs"):
            raise HTTPException(502, "run finished without an output image")
    raise HTTPException(504, f"update run timed out after {timeout}s (pid {pid})")


def comfy_fetch_image(im: dict) -> bytes:
    url = (f"{COMFY_URL}/view?filename={urllib.parse.quote(im['filename'])}"
           f"&subfolder={urllib.parse.quote(im.get('subfolder', ''))}&type=output")
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


# ---------------------------------------------------------------------------
# Source resolution + save-family
# ---------------------------------------------------------------------------

def resolve_source(rel: str) -> Path:
    """Jail a client path against gallery, then dupe, then library roots."""
    p = _gallery_mod.jailed(rel)
    if p.is_file():
        return p
    from .dupe import jailed as _dupe_jailed
    p = _dupe_jailed(rel)
    if p.is_file():
        return p
    try:
        p = _library_mod.library_jailed(rel)
        if p.is_file():
            return p
    except HTTPException:
        pass
    raise HTTPException(404, "source not found under gallery/dupe/library roots")


def _unique_dest(dest_dir: Path, name: str) -> Path:
    dest = dest_dir / name
    if not dest.exists():
        return dest
    stem, suffix = Path(name).stem, Path(name).suffix
    for i in range(1, 1000):
        cand = dest_dir / f"{stem}-{i}{suffix}"
        if not cand.exists():
            return cand
    raise HTTPException(409, "could not find unique destination name")


def save_family(render_rel: str, original_path: str, tag: str | None,
                intermediates: list[str] | None = None,
                recipe: str | None = None, masked: bool = False) -> dict:
    """Promote the chosen render via the existing promote machinery, copy
    the stack original into the library alongside it, and append a
    version-family record so originals travel with finals. recipe/masked
    (2026-10-24) note how the final was made — a masked-inpaint final
    records recipe='masked-inpaint', masked=True — additive fields only,
    so old records stay valid."""
    render_src = resolve_source(render_rel)
    record = _library_mod.promote_move(render_src,
                                       (tag or "").strip().lower() or None)
    final_rel = record["path"]
    family_id = uuid.uuid4().hex[:12]
    tag_dir = _library_mod.LIBRARY_ROOT / Path(final_rel).parent.name
    tag_dir.mkdir(parents=True, exist_ok=True)
    orig_src = resolve_source(original_path)
    orig_dest = _unique_dest(tag_dir, f"{Path(final_rel).stem}-original{orig_src.suffix}")
    shutil.copyfile(orig_src, orig_dest)
    orig_rel = orig_dest.relative_to(_library_mod.LIBRARY_ROOT).as_posix()
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    _library_mod.append_index({
        "path": orig_rel, "tags": record["tags"],
        "promoted_from": orig_src.name, "ts": now,
        "sha256": _library_mod.sha256_of(orig_dest),
        "kind": "version-original", "family_id": family_id,
    })
    final_rec = {
        "path": final_rel, "tags": record["tags"],
        "promoted_from": record.get("promoted_from", ""), "ts": now,
        "sha256": record.get("sha256", ""),
        "kind": "version-family", "family_id": family_id,
        "original": orig_rel, "final": final_rel,
        "intermediates": list(intermediates or []),
    }
    if recipe is not None:   # additive: old callers omit it, records stay valid
        final_rec["recipe"] = recipe
        final_rec["masked"] = bool(masked)
    _library_mod.append_index(final_rec)
    log.info("save-family %s: original=%s final=%s tag=%s",
             family_id, orig_rel, final_rel, record["tags"])
    return {"ok": True, "family_id": family_id, "final": final_rel,
            "original": orig_rel, "tags": record["tags"]}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

class RunBody(BaseModel):
    preset: str
    path: str
    prompt: str = ""
    seed: int | None = None
    random: bool = True


@router.get("/presets")
def presets_endpoint():
    return {"presets": load_presets()}


# ---------------------------------------------------------------------------
# Async jobs (FoxDen-style submit/poll, 2026-10-24)
#
# /run used to block the request up to 900 s (Claude flagged it). The
# async endpoints below are the new path: submit returns a job_id at
# once, the client polls /jobs/{id}. The synchronous /run stays as a
# thin wrapper over the same _execute_run so old callers and tests keep
# working until the async variant is proven, then it can go away.
# Jobs are in-memory only (a restart drops them — same tradeoff as
# FoxDen's pending meta); no temp files are written per poll or per
# attempt, and a job's only disk write is its single result file.
# ---------------------------------------------------------------------------

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _job_new() -> str:
    jid = uuid.uuid4().hex[:16]
    with _jobs_lock:
        _jobs[jid] = {"status": "queued"}
    return jid


def _job_run(jid: str, fn) -> None:
    with _jobs_lock:
        _jobs[jid]["status"] = "running"
    try:
        result = fn()
    except HTTPException as e:
        with _jobs_lock:
            _jobs[jid] = {"status": "error",
                          "error": str(e.detail)[:2000]}
    except Exception as e:
        with _jobs_lock:
            _jobs[jid] = {"status": "error", "error": str(e)[:2000]}
    else:
        with _jobs_lock:
            _jobs[jid] = {"status": "done", "result": result}


def _start_job(fn) -> str:
    jid = _job_new()
    threading.Thread(target=_job_run, args=(jid, fn), daemon=True).start()
    return jid


@router.get("/jobs/{job_id}")
def job_status(job_id: str):
    if not job_id.replace("-", "").isalnum():
        raise HTTPException(400, "bad job id")
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, f"unknown job: {job_id}")
    return {"job_id": job_id, **job}


def _execute_run(body: RunBody) -> dict:
    """One preset run, factored out of /run so the async job runs the
    identical code path (same return shape, same upload/poll/fetch)."""
    preset = load_preset(body.preset)
    src = resolve_source(body.path)
    seed = random.getrandbits(48) if (body.random or body.seed is None) else int(body.seed)
    try:
        image_name = _comfy._comfy_upload(
            src.read_bytes(), f"update_{uuid.uuid4().hex[:8]}{src.suffix or '.png'}")
    except RuntimeError as e:
        # Upload failures (incl. the full-drive 500) surface as a 502
        # with the named cause, not a bare 500.
        raise HTTPException(502, str(e))
    wf = build_run_graph(preset, image_name, body.prompt, seed)
    pid = comfy_submit(wf)
    log.info("update run queued %s preset=%s seed=%d src=%s", pid, body.preset, seed, body.path)
    im = comfy_poll(pid)
    data = comfy_fetch_image(im)
    render_rel = None
    # Outputs land in the shared comfy output root (= gallery root); expose
    # the gallery-relative path so the render can be promoted later.
    sub = im.get("subfolder", "")
    cand = (_gallery_mod.GALLERY_ROOT / sub / im["filename"])
    if cand.is_file():
        render_rel = (Path(sub) / im["filename"]).as_posix()
    return {"ok": True, "prompt_id": pid, "seed": seed,
            "image": "data:image/png;base64," + base64.b64encode(data).decode(),
            "render_path": render_rel, "recipe": body.preset, "masked": False}


@router.post("/run")
def run(body: RunBody):
    return _execute_run(body)


@router.post("/run-async")
def run_async(body: RunBody):
    """Submit a preset run; poll /jobs/{job_id} for the result."""
    return {"job_id": _start_job(lambda: _execute_run(body))}


# ---------------------------------------------------------------------------
# Masked inpaint (2026-10-24) — the FIRST brick of the shared ComfyUI
# engine layer, and deliberately NOT a fourth inpaint graph.
#
# The recipe runs Puppet Theater's existing, test-pinned machinery in
# backend/comfy.py — comfy_inpaint_klein: the Klein mask-fenced INPAINT
# graph (BasicScheduler denoise + SetLatentNoiseMask, prompt in charge
# inside the mask, no ReferenceLatent/ColorMatchV2) plus host-side
# composite_back, which keeps every unmasked pixel pixel-exact. This
# endpoint is only the Update-side recipe and mask plumbing around it:
# mask decode/normalize, denoise fence, async job, result file.
#
# Temp-write discipline (2026-10-24 disk-full lesson): the whole path is
# in-memory bytes — source read, mask decoded, uploads to Comfy, result
# fetched — plus exactly ONE bounded write: the result PNG under
# ellieedit_tmp/update, the same lifecycle class as /run renders, so the
# render can be saved to the Library later. No per-poll, per-attempt,
# or per-chunk files anywhere.
# ---------------------------------------------------------------------------

class InpaintBody(BaseModel):
    path: str
    prompt: str = ""
    mask_b64: str = ""     # data URL or bare base64 PNG; WHITE = regenerate
    denoise: float | None = None
    seed: int | None = None
    random: bool = True


def _decode_mask(mask_b64: str) -> bytes:
    s = (mask_b64 or "").strip()
    if s.startswith("data:"):
        if "," not in s:
            raise HTTPException(400, "mask data URL is malformed")
        s = s.split(",", 1)[1]
    try:
        raw = base64.b64decode(s, validate=True)
    except Exception:
        raise HTTPException(400, "mask is not valid base64")
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.load()
    except Exception:
        raise HTTPException(400, "mask is not a valid image")
    return raw


def _oriented_png(src_png: bytes) -> bytes:
    """Source bytes with EXIF orientation applied, re-encoded as PNG.

    Browsers auto-rotate displayed JPEGs by EXIF; PIL does not. The
    mask canvas is sized from the displayed (rotated) image, so an
    unrotated source made _normalize_mask measure the wrong size and
    the painted region land rotated/offset. Transposing here — before
    mask sizing, the Comfy upload, and composite_back — keeps all three
    in the displayed orientation. No-op for images without EXIF.
    """
    with Image.open(io.BytesIO(src_png)) as im:
        oriented = ImageOps.exif_transpose(im)
        buf = io.BytesIO()
        oriented.save(buf, "PNG")
        return buf.getvalue()


def _normalize_mask(mask_raw: bytes, src_png: bytes) -> str:
    """Mask to source size (BILINEAR), grayscale, base64. Raises 400 when
    the mask is all black — nothing painted means nothing to regenerate,
    and a no-op Comfy run would burn a generation for nothing."""
    with Image.open(io.BytesIO(src_png)) as im:
        size = ImageOps.exif_transpose(im).size
    with Image.open(io.BytesIO(mask_raw)) as im:
        mask = im.convert("L")
    if mask.size != size:
        mask = mask.resize(size, Image.BILINEAR)
    if mask.getextrema()[1] == 0:
        raise HTTPException(400, "mask is empty — paint a region to regenerate first")
    buf = io.BytesIO()
    mask.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _store_update_render(png: bytes) -> str | None:
    """Single bounded result write, mirroring /run's render lifecycle:
    ellieedit_tmp/update under the gallery root (gallery-addressable for
    save-family). Returns the gallery-relative path, or None on failure
    (the base64 result still returns — the stack entry just can't save
    until it has a path)."""
    try:
        d = _gallery_mod.GALLERY_ROOT / "ellieedit_tmp" / "update"
        d.mkdir(parents=True, exist_ok=True)
        name = f"inpaint-{uuid.uuid4().hex[:10]}.png"
        (d / name).write_bytes(png)
        return f"ellieedit_tmp/update/{name}"
    except OSError as e:
        log.warning("[update inpaint] render store failed: %s", e)
        return None


def _execute_inpaint(body: InpaintBody) -> dict:
    src = resolve_source(body.path)
    # EXIF orientation applied once, upstream of mask sizing (which
    # also transposes) and the Comfy upload, so all three agree.
    src_png = _oriented_png(src.read_bytes())
    mask_b64 = _normalize_mask(_decode_mask(body.mask_b64), src_png)
    seed = random.getrandbits(48) if (body.random or body.seed is None) else int(body.seed)
    denoise = clamp_inpaint_denoise(body.denoise)
    try:
        png = _comfy.comfy_inpaint_klein(
            base64.b64encode(src_png).decode(), mask_b64,
            body.prompt or "", denoise=denoise, seed=seed)
    except Exception as e:
        log.error("[update inpaint] ERROR: %s", e)
        raise HTTPException(502, f"masked inpaint failed: {e}")
    return {"ok": True, "seed": seed, "denoise": denoise,
            "image": "data:image/png;base64," + base64.b64encode(png).decode(),
            "render_path": _store_update_render(png),
            "recipe": "masked-inpaint", "masked": True}


@router.post("/inpaint-async")
def inpaint_async(body: InpaintBody):
    """Submit a masked inpaint; poll /jobs/{job_id} for the result."""
    return {"job_id": _start_job(lambda: _execute_inpaint(body))}


@router.get("/prompts")
def prompts_get():
    return {"prompts": list_prompts()}


class PromptBody(BaseModel):
    name: str
    text: str = ""


@router.post("/prompts")
def prompts_post(body: PromptBody):
    return {"prompts": add_prompt(body.name, body.text)}


@router.delete("/prompts")
def prompts_delete(name: str = Query(...)):
    return {"prompts": delete_prompt(name)}


class SaveFamilyBody(BaseModel):
    render_path: str
    original_path: str
    tag: str | None = None
    intermediates: list[str] = []
    recipe: str | None = None
    masked: bool = False


@router.post("/save-family")
def save_family_endpoint(body: SaveFamilyBody):
    return save_family(body.render_path, body.original_path, body.tag,
                       body.intermediates, body.recipe, body.masked)
