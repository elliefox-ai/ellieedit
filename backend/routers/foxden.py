"""FoxDen router — simple ComfyUI generation shell (work order 2026-10-13).

No node graph in the UI: the server loads a workflow baseline (API/prompt
format: flat dict of node-id -> {class_type, inputs}) FRESH from disk on every
request, edits its `inputs` in place, submits it, and normalizes status.

Principles (from the work order):
  - no workflow caching (stale-JSON class of bugs);
  - silence is not success: a "done" job with zero output images is an ERROR
    with the ComfyUI log tail attached;
  - slots are DISCOVERED from the graph (guider -> positive -> prompt node,
    RandomNoise, latent/scheduler literals) and the tests assert discovery
    lands on the verified klein ids (668/730/729/731/735/743);
  - nothing here touches the ComfyUI install or the gallery/dupe state.
"""

import copy
import json
import logging
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import comfy

log = logging.getLogger("ellieedit.foxden")

router = APIRouter(prefix="/api/foxden", tags=["foxden"])

WORKFLOW_FILES = {"klein": "klein_gen_basic.json",
                  "krea2": "krea2_gen_basic.json"}
LORA_EXTS = {".safetensors", ".pt", ".ckpt", ".pth"}
UPLOAD_MAX = 25 * 1024 * 1024
RECENT_MAX = 200
_pending_meta: dict[str, dict] = {}     # prompt_id -> submission meta
_logged: set[str] = set()               # prompt_ids already in recent.jsonl


# ------------------------------------------------------------ env-resolved

def workflows_dir() -> Path:
    return Path(os.environ.get("ELLIEEDIT_COMFY_WORKFLOWS_DIR",
                               "/mnt/e/comfyui/user/default/workflows"))


def loras_dir() -> Path:
    return Path(os.environ.get(
        "ELLIEEDIT_COMFY_LORAS_DIR",
        "/mnt/e/Projects/git/ComfyUI-dev/models/loras"))


def comfy_log() -> Path:
    return Path(os.environ.get("ELLIEEDIT_COMFY_LOG",
                               "/mnt/e/comfyui/user/comfyui.log"))


def data_dir() -> Path:
    return Path(os.environ.get(
        "ELLIEEDIT_FOXDEN_DATA",
        str(Path(__file__).resolve().parents[2] / "data" / "foxden")))


# ------------------------------------------------------------------- HTTP

class ComfyDown(Exception):
    pass


def _comfy(path, data=None, headers=None, method=None, timeout=30):
    """-> (status, body bytes, headers). HTTP errors RETURN their status/body
    (ComfyUI puts node_errors in a 400 body); transport failures raise
    ComfyDown. Tests monkeypatch this one function — no live ComfyUI."""
    req = urllib.request.Request(comfy.COMFY_URL + path, data=data,
                                 headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise ComfyDown(str(e))


def _json(path, **kw):
    status, body, _h = _comfy(path, **kw)
    try:
        return status, json.loads(body or b"null")
    except json.JSONDecodeError:
        return status, None


def _http_down(e: Exception) -> HTTPException:
    return HTTPException(502, f"ComfyUI unreachable: {e}")


# -------------------------------------------------- workflow editing (pure)

def is_link(v) -> bool:
    return (isinstance(v, list) and len(v) == 2
            and isinstance(v[0], str) and isinstance(v[1], int))


def load_workflow(name: str) -> dict:
    """Fresh read every call — never cached."""
    fn = WORKFLOW_FILES.get(name)
    if not fn:
        raise HTTPException(400, f"unknown workflow {name!r}; "
                                 f"choices: {sorted(WORKFLOW_FILES)}")
    p = workflows_dir() / fn
    try:
        wf = json.loads(p.read_text())
    except FileNotFoundError:
        raise HTTPException(404, f"workflow file missing: {p}")
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(500, f"workflow unreadable: {e}")
    if (not isinstance(wf, dict) or "nodes" in wf
            or not all(isinstance(v, dict) and "class_type" in v
                       for v in wf.values())):
        raise HTTPException(500, f"{fn} is not API/prompt format")
    return wf


def validate_graph(wf: dict) -> None:
    """Every edge [node_id, slot] must reference an existing node."""
    for nid, node in wf.items():
        for k, v in node.get("inputs", {}).items():
            if is_link(v) and v[0] not in wf:
                raise ValueError(f"node {nid}.{k} links to missing node {v[0]}")


def _only(wf, class_type):
    hits = [k for k, n in wf.items() if n["class_type"] == class_type]
    if len(hits) != 1:
        raise HTTPException(
            400, f"workflow needs exactly one {class_type} (found {len(hits)})")
    return hits[0]


def find_slots(wf: dict) -> dict:
    """Discover edit slots. klein verified: prompt 668, seed 730, guider 735,
    model source 743, size literals 729+731, steps on 731."""
    guider = _only(wf, "CFGGuider")
    seed = _only(wf, "RandomNoise")
    ins = wf[guider]["inputs"]
    if not is_link(ins.get("model")) or not is_link(ins.get("positive")):
        raise HTTPException(400, "CFGGuider model/positive are not links")
    prompt = None
    seen, frontier = set(), [ins["positive"][0]]
    while frontier and prompt is None:
        nid = frontier.pop(0)
        if nid in seen or nid not in wf:
            continue
        seen.add(nid)
        for key in ("string", "text", "prompt"):
            if isinstance(wf[nid]["inputs"].get(key), str):
                prompt = (nid, key)
                break
        else:
            frontier += [v[0] for v in wf[nid]["inputs"].values() if is_link(v)]
    if prompt is None:
        raise HTTPException(400, "no literal prompt node upstream of guider")
    size = [k for k, n in wf.items()
            if isinstance(n["inputs"].get("width"), int)
            and isinstance(n["inputs"].get("height"), int)
            and ("Latent" in n["class_type"] or "Scheduler" in n["class_type"])]
    steps = [k for k, n in wf.items()
             if "Scheduler" in n["class_type"]
             and isinstance(n["inputs"].get("steps"), int)]
    return {"guider": guider, "seed": seed, "prompt": prompt,
            "model_src": ins["model"][0], "model_slot": ins["model"][1],
            "size": size, "steps": steps}


def _next_id(wf: dict) -> int:
    return max([int(k) for k in wf if k.isdigit()] or [0]) + 1


def snap16(n: int) -> int:
    return max(64, min(4096, int(n / 16 + 0.5) * 16))


def apply_edits(wf: dict, prompt: str, seed: int, width=None, height=None,
                loras=(), steps=None) -> dict:
    """Return an edited DEEP COPY. LoRAs chain loader -> l1 -> l2 -> guider."""
    wf = copy.deepcopy(wf)
    s = find_slots(wf)
    pid, pkey = s["prompt"]
    wf[pid]["inputs"][pkey] = prompt
    wf[s["seed"]]["inputs"]["noise_seed"] = int(seed)
    if (width is None) != (height is None):
        raise HTTPException(400, "give both width and height, or neither")
    if width is not None:
        for nid in s["size"]:                 # BOTH literal sites (729 + 731)
            wf[nid]["inputs"]["width"] = snap16(width)
            wf[nid]["inputs"]["height"] = snap16(height)
    if steps is not None:
        for nid in s["steps"]:
            wf[nid]["inputs"]["steps"] = int(steps)
    prev = [s["model_src"], s["model_slot"]]
    nxt = _next_id(wf)
    for lo in loras:
        nid = str(nxt)
        nxt += 1
        wf[nid] = {"class_type": "LoraLoaderModelOnly",
                   "inputs": {"model": prev, "lora_name": lo.name,
                              "strength_model": float(lo.strength_model)}}
        prev = [nid, 0]
    wf[s["guider"]]["inputs"]["model"] = prev
    validate_graph(wf)
    return wf


# ---------------------------------------------------------------- config

def scan_loras() -> list[str]:
    """ComfyUI-style names: subfolders joined with a BACKSLASH (the Windows
    server validates lora_name against os.sep, same as comfy.py's graph)."""
    root = loras_dir()
    if not root.is_dir():
        return []
    out = []
    for p in root.rglob("*"):
        if p.is_file() and p.suffix.lower() in LORA_EXTS:
            out.append("\\".join(p.relative_to(root).parts))
    return sorted(out, key=str.lower)


def reachable() -> bool:
    try:
        return _comfy("/system_stats", timeout=3)[0] == 200
    except ComfyDown:
        return False


@router.get("/config")
def config():
    return {
        "workflows": [{"id": k, "file": v,
                       "available": (workflows_dir() / v).is_file()}
                      for k, v in WORKFLOW_FILES.items()],
        "default_workflow": "klein",
        "loras": scan_loras(),
        "loras_dir": str(loras_dir()),
        "comfy_url": comfy.COMFY_URL,
        "comfy_reachable": reachable(),
    }


# -------------------------------------------------------------- generate

class LoraSpec(BaseModel):
    name: str
    strength_model: float = 1.0


class GenerateBody(BaseModel):
    workflow: str = "klein"
    prompt: str = ""
    seed: int | None = None
    width: int | None = None
    height: int | None = None
    loras: list[LoraSpec] = []
    steps: int | None = None


def _node_errors_text(resp: dict) -> str:
    bits = []
    err = resp.get("error")
    if isinstance(err, dict):
        bits.append(err.get("message") or str(err))
    for nid, ne in (resp.get("node_errors") or {}).items():
        for e in ne.get("errors", []):
            bits.append(f"node {nid} ({ne.get('class_type')}): "
                        f"{e.get('message')} {e.get('details', '')}".strip())
    return "; ".join(bits) or "rejected"


@router.post("/generate")
def generate(body: GenerateBody):
    if not body.prompt.strip():
        raise HTTPException(400, "prompt is empty")
    if body.steps is not None and not (1 <= body.steps <= 150):
        raise HTTPException(400, "steps must be 1..150")
    if len(body.loras) > 8:
        raise HTTPException(400, "at most 8 LoRAs")
    avail = set(scan_loras())
    for lo in body.loras:
        if not -4.0 <= lo.strength_model <= 4.0:
            raise HTTPException(400, f"strength out of range: {lo.name}")
        if avail and lo.name not in avail:     # only enforceable if dir readable
            raise HTTPException(400, f"unknown LoRA: {lo.name}")
    seed = body.seed if body.seed is not None else random.randrange(2 ** 31)
    wf = apply_edits(load_workflow(body.workflow), body.prompt, seed,
                     body.width, body.height, body.loras, body.steps)
    try:
        status, resp = _json(
            "/prompt", data=json.dumps({"prompt": wf}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
            timeout=60)
    except ComfyDown as e:
        raise _http_down(e)
    if (status != 200 or not isinstance(resp, dict)
            or resp.get("node_errors") or "prompt_id" not in resp):
        raise HTTPException(
            400, "ComfyUI rejected the workflow: "
                 + (_node_errors_text(resp) if isinstance(resp, dict)
                    else f"HTTP {status}"))
    pid = resp["prompt_id"]
    if len(_pending_meta) > RECENT_MAX:
        _pending_meta.pop(next(iter(_pending_meta)))
    _pending_meta[pid] = {
        "prompt": body.prompt, "workflow": body.workflow, "seed": seed,
        "width": body.width, "height": body.height, "steps": body.steps,
        "loras": [lo.model_dump() for lo in body.loras],
        "submitted": time.time(),
    }
    return {"prompt_id": pid, "seed": seed, "workflow": body.workflow}


# ---------------------------------------------------------------- status

def view_url(im: dict) -> str:
    q = urllib.parse.urlencode({"filename": im["filename"],
                                "subfolder": im.get("subfolder", ""),
                                "type": im.get("type", "output")})
    return f"/api/foxden/view?{q}"


def log_tail(n: int = 30) -> list[str]:
    try:
        with comfy_log().open("rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 24_000))
            return fh.read().decode(errors="replace").splitlines()[-n:]
    except OSError:
        return []


def normalize_status(pid: str, hist: dict | None, queue: dict | None) -> dict:
    """Pure: ComfyUI history entry (or None) + /queue payload -> our shape."""
    if hist:
        st = hist.get("status") or {}
        if st.get("status_str") == "error":
            msgs = [m for m in st.get("messages", [])
                    if isinstance(m, list) and m and m[0] == "execution_error"]
            why = (msgs[-1][1].get("exception_message") if msgs
                   and isinstance(msgs[-1][1], dict) else None)
            return {"state": "error", "outputs": [],
                    "error": why or "ComfyUI reported an execution error",
                    "log_tail": log_tail()}
        images = [im for node in (hist.get("outputs") or {}).values()
                  for im in node.get("images", [])
                  if im.get("type") == "output"]
        if images:
            return {"state": "done", "outputs": [view_url(i) for i in images],
                    "_images": images}
        if st.get("completed") or st.get("status_str") == "success":
            # silence is not success
            return {"state": "error", "outputs": [],
                    "error": "ComfyUI finished with NO output images",
                    "log_tail": log_tail()}
        return {"state": "running", "outputs": []}
    for row in (queue or {}).get("queue_running", []):
        if len(row) > 1 and row[1] == pid:
            return {"state": "running", "outputs": []}
    for row in (queue or {}).get("queue_pending", []):
        if len(row) > 1 and row[1] == pid:
            return {"state": "queued", "outputs": []}
    return {"state": "unknown", "outputs": []}


@router.get("/status/{prompt_id}")
def status(prompt_id: str):
    if not prompt_id.replace("-", "").isalnum():
        raise HTTPException(400, "bad prompt id")
    try:
        _s, hist = _json(f"/history/{urllib.parse.quote(prompt_id)}")
        entry = (hist or {}).get(prompt_id) if isinstance(hist, dict) else None
        queue = None if entry else _json("/queue")[1]
    except ComfyDown as e:
        raise _http_down(e)
    out = normalize_status(prompt_id, entry, queue)
    if out["state"] == "unknown":
        young = time.time() - _pending_meta.get(prompt_id, {}).get(
            "submitted", 0) < 15
        if young:
            out["state"] = "queued"     # submit/queue race window
        else:
            out.update(state="error", error="unknown prompt id",
                       log_tail=log_tail())
    images = out.pop("_images", None)
    if out["state"] == "done" and images:
        _log_recent(prompt_id, images)
    return out


# ---------------------------------------------------------------- recent

def _log_recent(pid: str, images: list[dict]) -> None:
    meta = _pending_meta.get(pid)
    if pid in _logged or not meta:
        return
    _logged.add(pid)
    entry = {k: meta[k] for k in ("prompt", "workflow", "seed", "width",
                                  "height", "steps", "loras")}
    entry.update(prompt_id=pid, ts=int(time.time()),
                 outputs=[{"filename": i["filename"],
                           "subfolder": i.get("subfolder", ""),
                           "type": i.get("type", "output")} for i in images])
    try:
        d = data_dir()
        d.mkdir(parents=True, exist_ok=True)
        with (d / "recent.jsonl").open("a") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        log.warning("foxden recent log write failed", exc_info=True)


@router.get("/recent")
def recent(limit: int = 12):
    limit = max(1, min(limit, 100))
    rows = []
    try:
        for line in (data_dir() / "recent.jsonl").read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except FileNotFoundError:
        pass
    items = list(reversed(rows))[:limit]
    for it in items:
        it["urls"] = [view_url(o) for o in it.get("outputs", [])]
    return {"items": items}


# ------------------------------------------------------- view / upload

@router.get("/view")
def view(filename: str, subfolder: str = "", type: str = "output"):
    """Proxy a ComfyUI image (the browser may not reach :8188 directly)."""
    if (type not in ("output", "input", "temp") or not filename
            or "/" in filename or "\\" in filename or ".." in subfolder
            or subfolder.startswith(("/", "\\"))):
        raise HTTPException(400, "bad view parameters")
    q = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder,
                                "type": type})
    try:
        status_, body, hdr = _comfy(f"/view?{q}", timeout=60)
    except ComfyDown as e:
        raise _http_down(e)
    if status_ != 200:
        raise HTTPException(404, "image not found in ComfyUI")
    ctype = next((v for k, v in hdr.items() if k.lower() == "content-type"),
                 "image/png")
    return Response(body, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=3600"})


@router.post("/upload")
async def upload(request: Request):
    """Raw multipart passthrough to ComfyUI /upload/image (field `image`).
    Nothing is stored here; no multipart parser dependency needed."""
    ctype = request.headers.get("content-type", "")
    if not ctype.startswith("multipart/form-data"):
        raise HTTPException(400, "multipart/form-data with an `image` field")
    body = await request.body()
    if not body or len(body) > UPLOAD_MAX:
        raise HTTPException(400, "empty or oversized upload (25MB max)")
    try:
        status_, resp = await run_in_threadpool(
            lambda: _json("/upload/image", data=body,
                          headers={"Content-Type": ctype}, method="POST",
                          timeout=60))
    except ComfyDown as e:
        raise _http_down(e)
    if status_ != 200 or not isinstance(resp, dict) or "name" not in resp:
        raise HTTPException(400, f"ComfyUI upload failed (HTTP {status_})")
    return {"name": resp["name"], "subfolder": resp.get("subfolder", ""),
            "type": resp.get("type", "input")}


@router.get("/inputs")
def inputs():
    """Images ComfyUI currently lists as LoadImage choices (upload listing)."""
    try:
        _s, info = _json("/object_info/LoadImage")
    except ComfyDown as e:
        raise _http_down(e)
    try:
        names = info["LoadImage"]["input"]["required"]["image"][0]
    except (TypeError, KeyError, IndexError):
        names = []
    return {"items": [n for n in names if isinstance(n, str)]}
