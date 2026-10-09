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
import json
import os
import random
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
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
                intermediates: list[str] | None = None) -> dict:
    """Promote the chosen render via the existing promote machinery, copy
    the stack original into the library alongside it, and append a
    version-family record so originals travel with finals."""
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
    _library_mod.append_index({
        "path": final_rel, "tags": record["tags"],
        "promoted_from": record.get("promoted_from", ""), "ts": now,
        "sha256": record.get("sha256", ""),
        "kind": "version-family", "family_id": family_id,
        "original": orig_rel, "final": final_rel,
        "intermediates": list(intermediates or []),
    })
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


@router.post("/run")
def run(body: RunBody):
    preset = load_preset(body.preset)
    src = resolve_source(body.path)
    seed = random.getrandbits(48) if (body.random or body.seed is None) else int(body.seed)
    image_name = _comfy._comfy_upload(src.read_bytes(), f"update_{uuid.uuid4().hex[:8]}{src.suffix or '.png'}")
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
            "render_path": render_rel}


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


@router.post("/save-family")
def save_family_endpoint(body: SaveFamilyBody):
    return save_family(body.render_path, body.original_path, body.tag,
                       body.intermediates)
