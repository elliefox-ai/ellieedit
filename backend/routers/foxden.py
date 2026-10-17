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
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
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
_delivered: set[str] = set()            # prompt_ids already copied to delivery
_reconcile_lock = threading.Lock()
_last_reconcile = 0.0                   # time of last successful reconcile
RECONCILE_MIN_AGE = 30                  # non-forced calls inside this are no-ops
DELIVER_BACKFILL = 50                   # known recent renders re-checked on reconcile


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


def delivery_dir() -> Path:
    """Copy target so couch renders show up on the Windows/TV side."""
    return Path(os.environ.get("ELLIEEDIT_FOXDEN_DELIVERY_DIR",
                               "/mnt/shared/_FoxDen"))


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
    """Discover edit slots. Two graph families:
    - klein (CFGGuider/RandomNoise/SamplerCustomAdvanced): prompt 668, seed 730,
      guider 735, model source 743, size literals 729+731, steps on 731.
    - ksampler (classic KSampler graphs, e.g. krea2_gen_basic): seed may be a
      link to a Seed (rgthree) node; prompt walked the same way; size may be
      link-driven (ResolutionSelector) and then is left alone."""
    guiders = [k for k, n in wf.items() if n["class_type"] == "CFGGuider"]
    if len(guiders) == 1:
        return _find_slots_cfg(wf, guiders[0])
    samplers = [k for k, n in wf.items() if n["class_type"] == "KSampler"]
    if len(samplers) == 1:
        return _find_slots_ksampler(wf, samplers[0])
    raise HTTPException(
        400, "workflow has neither exactly one CFGGuider nor exactly one KSampler")


def _find_prompt_upstream(wf: dict, positive_link: list) -> tuple:
    """Walk upstream from a positive conditioning link to the literal prompt
    node. Empty-string literals are skipped (StringConcatenate string_b='')."""
    prompt = None
    seen, frontier = set(), [positive_link[0]]
    while frontier and prompt is None:
        nid = frontier.pop(0)
        if nid in seen or nid not in wf:
            continue
        seen.add(nid)
        for key in ("string", "text", "prompt"):
            v = wf[nid]["inputs"].get(key)
            if isinstance(v, str) and v.strip():
                prompt = (nid, key)
                break
        else:
            frontier += [v[0] for v in wf[nid]["inputs"].values() if is_link(v)]
    if prompt is None:
        raise HTTPException(400, "no literal prompt node upstream of sampler")
    return prompt


def _find_slots_cfg(wf: dict, guider: str) -> dict:
    ins = wf[guider]["inputs"]
    if not is_link(ins.get("model")) or not is_link(ins.get("positive")):
        raise HTTPException(400, "CFGGuider model/positive are not links")
    prompt = _find_prompt_upstream(wf, ins["positive"])
    seed = _only(wf, "RandomNoise")
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


def _find_slots_ksampler(wf: dict, sid: str) -> dict:
    ins = wf[sid]["inputs"]
    if not is_link(ins.get("model")) or not is_link(ins.get("positive")):
        raise HTTPException(400, "KSampler model/positive are not links")
    prompt = _find_prompt_upstream(wf, ins["positive"])
    # seed: literal on the KSampler, or a link to a node with a literal `seed`.
    if isinstance(ins.get("seed"), int):
        seed, seed_key = sid, "seed"
    elif is_link(ins.get("seed")) and isinstance(
            wf.get(ins["seed"][0], {}).get("inputs", {}).get("seed"), int):
        seed, seed_key = ins["seed"][0], "seed"
    else:
        raise HTTPException(400, "KSampler seed is neither literal nor linked "
                                 "to a node with a literal seed")
    size = [k for k, n in wf.items()
            if isinstance(n["inputs"].get("width"), int)
            and isinstance(n["inputs"].get("height"), int)
            and ("Latent" in n["class_type"] or "Scheduler" in n["class_type"])]
    steps = [sid] if isinstance(ins.get("steps"), int) else []
    return {"guider": sid, "seed": seed, "seed_key": seed_key,
            "prompt": prompt, "model_src": ins["model"][0],
            "model_slot": ins["model"][1], "size": size, "steps": steps}


def _next_id(wf: dict) -> int:
    return max([int(k) for k in wf if k.isdigit()] or [0]) + 1


def snap16(n: int) -> int:
    return max(64, min(4096, int(n / 16 + 0.5) * 16))


def wire_denoise(wf: dict, denoise: float) -> str | None:
    """Per-workflow denoise wiring (work order add.5 revision 2026-10-16).
    The interface always SENDS denoise; whether the graph consumes it:
      'native' -> the graph already carries a literal `denoise` input
                  (KSampler-style, or a workflow that ships SplitSigmasDenoise):
                  set every one of them to the value.
      'split'  -> klein-style advanced pipeline (SamplerCustomAdvanced fed by a
                  sigmas link, no denoise input anywhere): ALWAYS splice a
                  SplitSigmasDenoise between the scheduler and the sampler —
                  unconditional, txt2img and img2img alike. Output slot 1 is the
                  tail (low-sigma) schedule that is actually sampled; at
                  denoise 1.0 it is the full schedule, i.e. identical to the
                  un-spliced graph.
      None     -> can't consume it: nothing wired, graph untouched."""
    d = float(denoise)
    native = [k for k, n in wf.items()
              if isinstance(n["inputs"].get("denoise"), (int, float))
              and not isinstance(n["inputs"].get("denoise"), bool)]
    if native:
        for k in native:
            wf[k]["inputs"]["denoise"] = d
        return "native"
    samplers = [k for k, n in wf.items()
                if n["class_type"] == "SamplerCustomAdvanced"
                and is_link(n["inputs"].get("sigmas"))]
    if len(samplers) == 1:
        sid = samplers[0]
        nid = str(_next_id(wf))
        wf[nid] = {"class_type": "SplitSigmasDenoise",
                   "inputs": {"sigmas": list(wf[sid]["inputs"]["sigmas"]),
                              "denoise": d}}
        wf[sid]["inputs"]["sigmas"] = [nid, 1]
        return "split"
    return None


def inject_input_image(wf: dict, name: str) -> None:
    """img2img on a graph with no upstream image chain (klein): LoadImage ->
    VAEEncode -> SamplerCustomAdvanced.latent_image, replacing the
    EmptyFlux2LatentImage link. The VAE is the one the graph already decodes
    with. The now-unreferenced empty-latent node is dropped."""
    adv = [k for k, n in wf.items() if n["class_type"] == "SamplerCustomAdvanced"]
    sid = _only(wf, "SamplerCustomAdvanced") if len(adv) == 1 else _only(wf, "KSampler")
    vae = wf[_only(wf, "VAEDecode")]["inputs"].get("vae")
    if not is_link(vae):
        raise HTTPException(400, "VAEDecode.vae is not a link; cannot encode input image")
    old = wf[sid]["inputs"].get("latent_image")
    lid = str(_next_id(wf))
    wf[lid] = {"class_type": "LoadImage", "inputs": {"image": name}}
    eid = str(_next_id(wf))
    wf[eid] = {"class_type": "VAEEncode",
               "inputs": {"pixels": [lid, 0], "vae": list(vae)}}
    wf[sid]["inputs"]["latent_image"] = [eid, 0]
    if is_link(old) and wf.get(old[0], {}).get("class_type", "").startswith("Empty"):
        still_used = any(v == old for n in wf.values()
                         for v in n["inputs"].values() if is_link(v))
        if not still_used:
            del wf[old[0]]


def apply_edits(wf: dict, prompt: str, seed: int, width=None, height=None,
                loras=(), steps=None, denoise: float = 1.0,
                input_image: str | None = None) -> dict:
    """Return an edited DEEP COPY. LoRAs chain loader -> l1 -> l2 -> guider.
    `denoise` is always supplied (default 1.0); wire_denoise decides whether
    the graph consumes it. `input_image` switches to img2img."""
    wf = copy.deepcopy(wf)
    s = find_slots(wf)
    pid, pkey = s["prompt"]
    wf[pid]["inputs"][pkey] = prompt
    wf[s["seed"]]["inputs"][s.get("seed_key", "noise_seed")] = int(seed)
    if (width is None) != (height is None):
        raise HTTPException(400, "give both width and height, or neither")
    if width is not None:
        for nid in s["size"]:                 # BOTH literal sites (729 + 731)
            # img2img: the image IS the latent source, so only the scheduler
            # (whose sigma shift depends on resolution) takes the size.
            if input_image and "Latent" in wf[nid]["class_type"]:
                continue
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
    if input_image:
        inject_input_image(wf, input_image)
    wire_denoise(wf, denoise)
    # Baselines exported from the UI carry PreviewImage (temp outputs), which
    # ComfyUI purges and our status filter rightly ignores. Inject a real
    # SaveImage so renders persist as type=output (2026-10-14 inaugural).
    if not any(n["class_type"] == "SaveImage" for n in wf.values()):
        vae = _only(wf, "VAEDecode")
        wf[str(_next_id(wf))] = {"class_type": "SaveImage",
                        "inputs": {"images": [vae, 0],
                                   "filename_prefix": "foxden"}}
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
    # Parked (suspended) pins: never reach the graph — recorded only so
    # "Reuse settings" can restore the tray faithfully.
    suspended_loras: list[LoraSpec] = []
    steps: int | None = None
    # First-class and ALWAYS sent (interface law, work order add.5 revision
    # 2026-10-16): whether the graph consumes it is wire_denoise's business.
    # Stored in recent/presets/Reuse either way.
    denoise: float = 1.0
    input_image: str | None = None          # name from /inputs or /upload (img2img)


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
    if not 0.0 <= body.denoise <= 1.0:
        raise HTTPException(400, "denoise must be 0.0..1.0")
    if body.input_image is not None:
        n = body.input_image.replace("\\", "/")
        if (not n.strip() or len(n) > 255 or n.startswith("/") or ".." in n.split("/")
                or ":" in n):
            raise HTTPException(400, "invalid input_image name")
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
                     body.width, body.height, body.loras, body.steps,
                     body.denoise, body.input_image)
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
        "suspended_loras": [lo.model_dump() for lo in body.suspended_loras],
        "denoise": body.denoise, "input_image": body.input_image,
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
def status(prompt_id: str, background: BackgroundTasks):
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
            # Comfy removes a finished prompt from /queue and writes its
            # history entry in two steps; a poll landing in that gap sees it
            # in neither (2026-10-17: "unknown prompt id" shown for a render
            # that was completing successfully). Re-check once before
            # declaring death — the second look finds the history entry.
            time.sleep(1.5)
            try:
                _s2, hist2 = _json(f"/history/{urllib.parse.quote(prompt_id)}")
                entry2 = (hist2 or {}).get(prompt_id) if isinstance(hist2, dict) else None
                queue2 = None if entry2 else _json("/queue")[1]
                out = normalize_status(prompt_id, entry2, queue2)
            except ComfyDown:
                pass
            if out["state"] == "unknown":
                out.update(state="error", error="unknown prompt id",
                           log_tail=log_tail())
    images = out.pop("_images", None)
    if out["state"] == "done" and images:
        _log_recent(prompt_id, images)
        if prompt_id not in _delivered:       # once per render, off the poll path
            if len(_delivered) > 1000:
                _delivered.clear()
            _delivered.add(prompt_id)
            background.add_task(deliver_images, images)
    return out


# ---------------------------------------------------------------- recent

def _log_recent(pid: str, images: list[dict]) -> None:
    meta = _pending_meta.get(pid)
    if pid in _logged or not meta:
        return
    _logged.add(pid)
    entry = {k: meta[k] for k in ("prompt", "workflow", "seed", "width",
                                  "height", "steps", "loras")}
    entry["suspended_loras"] = meta.get("suspended_loras", [])
    entry["denoise"] = meta.get("denoise", 1.0)
    entry["input_image"] = meta.get("input_image")
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


def _read_rows() -> list[dict]:
    rows = []
    try:
        for line in (data_dir() / "recent.jsonl").read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except FileNotFoundError:
        pass
    return rows


@router.get("/recent")
def recent(limit: int = 12):
    limit = max(1, min(limit, 100))
    rows = _read_rows()
    # newest first by completion time (reconciled rows are appended late but
    # carry their real ts); stable for rows without one
    rows.sort(key=lambda r: r.get("ts") or 0)
    items = list(reversed(rows))[:limit]
    for it in items:
        it["urls"] = [view_url(o) for o in it.get("outputs", [])]
    return {"items": items, "total": len(rows)}


# ------------------------------------------------------------- delivery

def deliver_images(images: list[dict]) -> int:
    """COPY output images (fetched via ComfyUI /view) into the delivery
    folder. Copy, never move — ComfyUI's output dir stays authoritative.
    Idempotent: an existing file of the same name is left alone. Only the
    `_FoxDen` leaf is created (its parent share must already exist, so a
    missing mount can't silently fill the local disk). Never raises: delivery
    is a convenience and must not break generation. Returns files written."""
    d = delivery_dir()
    try:
        d.mkdir(exist_ok=True)
    except OSError:
        log.warning("foxden delivery dir unavailable: %s", d, exc_info=True)
        return 0
    n = 0
    for im in images:
        fn = im.get("filename") or ""
        if (not fn or "/" in fn or "\\" in fn or fn.startswith(".")
                or im.get("type", "output") != "output"):
            continue
        dest = d / fn
        if dest.exists():
            continue
        q = urllib.parse.urlencode({"filename": fn,
                                    "subfolder": im.get("subfolder", ""),
                                    "type": "output"})
        try:
            st, body, _h = _comfy(f"/view?{q}", timeout=60)
            if st != 200 or not body:
                continue
            tmp = d / (fn + ".part")
            tmp.write_bytes(body)
            tmp.replace(dest)
            n += 1
        except Exception:               # convenience path: never break callers
            log.warning("foxden delivery failed for %s", fn, exc_info=True)
    return n


# ------------------------------------------------------------- reconcile

def _foxden_images(entry: dict) -> list[dict]:
    return [{"filename": im["filename"], "subfolder": im.get("subfolder", ""),
             "type": "output"}
            for node in (entry.get("outputs") or {}).values()
            for im in node.get("images", [])
            if im.get("type") == "output"
            and str(im.get("filename", "")).startswith("foxden_")]


def _meta_from_graph(graph) -> dict:
    """Best-effort recovery of what was rendered from the graph ComfyUI kept
    in history, so reconciled renders still support Reuse settings. Anything
    unrecoverable stays None / '(reconciled)'."""
    meta = {"prompt": "(reconciled)", "workflow": None, "seed": None,
            "width": None, "height": None, "steps": None, "loras": []}
    if not isinstance(graph, dict):
        return meta
    try:
        sl = find_slots(graph)
        pid, pkey = sl["prompt"]
        text = graph[pid]["inputs"].get(pkey)
        if isinstance(text, str) and text.strip():
            meta["prompt"] = text
        seed = graph[sl["seed"]]["inputs"].get("noise_seed")
        if isinstance(seed, int):
            meta["seed"] = seed
        if sl["size"]:
            ins = graph[sl["size"][0]]["inputs"]
            meta["width"], meta["height"] = ins.get("width"), ins.get("height")
        if sl["steps"]:
            meta["steps"] = graph[sl["steps"][0]]["inputs"].get("steps")
        for n in graph.values():
            dn = n.get("inputs", {}).get("denoise")
            if isinstance(dn, (int, float)) and not isinstance(dn, bool):
                meta["denoise"] = float(dn)
            if n.get("class_type") == "LoadImage" and isinstance(n["inputs"].get("image"), str):
                meta["input_image"] = n["inputs"]["image"]
        for nid in sorted((k for k, n in graph.items() if k.isdigit()
                           and n.get("class_type") == "LoraLoaderModelOnly"),
                          key=int):
            ins = graph[nid]["inputs"]
            if isinstance(ins.get("lora_name"), str):
                meta["loras"].append({"name": ins["lora_name"],
                                      "strength_model": ins.get("strength_model", 1.0)})
    except Exception:                       # unusual graph: keep what we have
        log.debug("foxden meta recovery partial", exc_info=True)
    return meta


def _entry_ts(entry: dict) -> int:
    best = None
    for m in (entry.get("status") or {}).get("messages", []):
        if (isinstance(m, list) and len(m) > 1 and isinstance(m[1], dict)
                and m[0] in ("execution_start", "execution_success")
                and isinstance(m[1].get("timestamp"), (int, float))):
            best = int(m[1]["timestamp"] / 1000)
            if m[0] == "execution_success":
                break
    return best or int(time.time())


@router.post("/recent/reconcile")
def reconcile(force: bool = False):
    """Adopt renders ComfyUI finished that no client observed (tab left, device
    asleep). Scans ComfyUI /history for foxden_* outputs not yet in
    recent.jsonl, appends them, and copies them (plus the latest known renders)
    to the delivery folder. History can be 50MB+, so this is NOT run per
    /recent call: the frontend calls it on tab activation (throttled unless
    force) and from the refresh button (force)."""
    global _last_reconcile
    if not _reconcile_lock.acquire(blocking=False):
        return {"skipped": "busy", "added": 0, "delivered": 0}
    try:
        if not force and time.time() - _last_reconcile < RECONCILE_MIN_AGE:
            return {"skipped": "recent", "added": 0, "delivered": 0}
        cap = int(os.environ.get("ELLIEEDIT_FOXDEN_HISTORY_MAX", "500"))
        try:
            st, hist = _json(f"/history?max_items={cap}", timeout=180)
        except ComfyDown as e:
            raise _http_down(e)
        if st != 200 or not isinstance(hist, dict):
            raise HTTPException(502, f"ComfyUI history unavailable (HTTP {st})")
        rows = _read_rows()
        known_pids = {r.get("prompt_id") for r in rows} | _logged
        known_files = {o.get("filename") for r in rows
                       for o in r.get("outputs", [])}
        fresh = []
        for pid, entry in hist.items():
            if not isinstance(entry, dict) or pid in known_pids:
                continue
            imgs = _foxden_images(entry)
            if not imgs or any(i["filename"] in known_files for i in imgs):
                continue
            graph = (entry.get("prompt") or [None, None, None])[2:3]
            row = _meta_from_graph(graph[0] if graph else None)
            row.update(prompt_id=pid, ts=_entry_ts(entry), outputs=imgs,
                       reconciled=True)
            fresh.append(row)
        fresh.sort(key=lambda r: r["ts"])
        if fresh:
            try:
                d = data_dir()
                d.mkdir(parents=True, exist_ok=True)
                with (d / "recent.jsonl").open("a") as fh:
                    for r in fresh:
                        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            except OSError as e:
                raise HTTPException(500, f"could not write recent log: {e}")
            _logged.update(r["prompt_id"] for r in fresh)
        deliver = [o for r in fresh for o in r["outputs"]]
        deliver += [o for r in rows[-DELIVER_BACKFILL:]
                    for o in r.get("outputs", [])]
        delivered = deliver_images(deliver)
        _last_reconcile = time.time()
        return {"scanned": len(hist), "added": len(fresh),
                "delivered": delivered, "delivery_dir": str(delivery_dir())}
    finally:
        _reconcile_lock.release()


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


# ---------------------------------------------------------------- presets
# Task 5 addendum 2 (2026-10-14): named workspace presets + auto-remembered
# last state, server-backed at data/foxden/presets.json (same dir as
# recent.jsonl) so they follow the operator across devices. The form state is
# an opaque-but-bounded dict (the frontend owns its shape: prompt, workflow,
# aspect/input image, seed, steps, denoise, LoRA pins + suspended tray).

PRESETS_FILE = "presets.json"
PRESET_MAX = 200
PRESET_NAME_MAX = 60
PRESET_STATE_MAX_BYTES = 64 * 1024
_presets_lock = threading.Lock()


def _presets_path() -> Path:
    return data_dir() / PRESETS_FILE


def _load_presets() -> dict:
    p = _presets_path()
    empty = {"presets": {}, "last": None}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty
    except (OSError, ValueError):
        try:                                   # keep the damaged file for rescue
            p.replace(p.with_suffix(".json.corrupt"))
        except OSError:
            pass
        return empty
    if not isinstance(raw, dict) or not isinstance(raw.get("presets"), dict):
        return empty
    return {"presets": raw["presets"],
            "last": raw.get("last") if isinstance(raw.get("last"), dict) else None}


def _save_presets(d: dict) -> None:
    p = _presets_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)                         # atomic: never a half-written file


def _check_state(state: dict) -> None:
    if len(json.dumps(state, ensure_ascii=False).encode("utf-8")) > PRESET_STATE_MAX_BYTES:
        raise HTTPException(413, "preset state too large")


class PresetBody(BaseModel):
    name: str
    state: dict


class LastBody(BaseModel):
    state: dict


@router.get("/presets")
def presets_list():
    d = _load_presets()
    return {"presets": [{"name": n, "ts": v.get("ts"), "state": v.get("state", {})}
                        for n, v in sorted(d["presets"].items(), key=lambda kv: kv[0].lower())],
            "last": d["last"]}


@router.post("/presets")
def presets_save(body: PresetBody):
    name = " ".join(body.name.split())
    if not name or len(name) > PRESET_NAME_MAX or name.startswith("_"):
        raise HTTPException(400, f"name must be 1-{PRESET_NAME_MAX} chars and not start with '_'")
    _check_state(body.state)
    with _presets_lock:
        d = _load_presets()
        if name not in d["presets"] and len(d["presets"]) >= PRESET_MAX:
            raise HTTPException(400, "too many presets")
        existed = name in d["presets"]
        d["presets"][name] = {"ts": int(time.time()), "state": body.state}
        _save_presets(d)
    return {"saved": name, "overwrote": existed, "count": len(d["presets"])}


@router.delete("/presets/{name}")
def presets_delete(name: str):
    with _presets_lock:
        d = _load_presets()
        if name not in d["presets"]:
            raise HTTPException(404, "no such preset")
        del d["presets"][name]
        _save_presets(d)
    return {"deleted": name, "count": len(d["presets"])}


@router.put("/last")
def last_save(body: LastBody):
    """Auto-remember: the in-progress composition (reload/sleep/crash safe)."""
    _check_state(body.state)
    with _presets_lock:
        d = _load_presets()
        d["last"] = body.state
        _save_presets(d)
    return {"ok": True}
