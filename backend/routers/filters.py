"""Filters module — the Filters tab backend.

Tier 1 (headline): the Colorhold Lineart transform, ported in
backend/colorhold.py from the adopted v5 pipeline. The endpoint runs
it in memory (no disk write) and returns a PNG data URL; the frontend
runs tier-2 tunes on canvas over that result, applies the universal
strength as a canvas composite, and only writes once, via /store,
when the operator commits at full res. Preview flow (workorder):
downscale via preview_max_side, then re-run at full res on commit.
Fill-field caching lives in backend/colorhold.py (keyed by image
hash + dark_t) so slider changes to sat/val/smoothing/strength only
recompute the cheap stage.

Tier 2 (client-side canvas, same tab): saturation, brightness /
contrast, and a value curve including lift-blacks. Those live in
frontend/js/modules/filters-tunes.js — same HSV convention as the
backend (hand-written, float [0, 1], hue 0-1) — so a tune means the
same thing on both sides. This router deliberately does NOT
re-implement them server-side.

Presets follow FoxDen's named-workspace-preset pattern (foxden.py
Task 5 addendum 2): server-backed at data/filters/presets.json, an
opaque-but-bounded slider-state dict, plus an auto-remembered last
state. Same caps: 200 presets, 60-char names, 64 KB state.

Ground rules (2026-10-13 work order, unchanged): code + tests only;
no server restarts, no BUILD/CACHE marker bumps (deploy-time only).
"""

import base64
import io
import json
import os
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel

from .. import colorhold as _ch
from . import gallery as _gallery_mod
from . import library as _library_mod

log = __import__("logging").getLogger("ellieedit.filters")

REPO = Path(__file__).resolve().parents[2]

router = APIRouter(prefix="/api/filters", tags=["filters"])

# ---------------------------------------------------------------------------
# Source resolution (local copy of update.resolve_source's jail order:
# gallery, then dupe, then library — kept local so this router stays
# decoupled from Update, the same reason Update keeps its own copy of
# Puppet's denoise fence).
# ---------------------------------------------------------------------------

def resolve_source(rel: str) -> Path:
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


def _decode_image_b64(s: str) -> bytes:
    s = (s or "").strip()
    if s.startswith("data:"):
        if "," not in s:
            raise HTTPException(400, "image data URL is malformed")
        s = s.split(",", 1)[1]
    try:
        raw = base64.b64decode(s, validate=True)
    except Exception:
        raise HTTPException(400, "image is not valid base64")
    if len(raw) > 64 * 1024 * 1024:
        raise HTTPException(413, "image too large")
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.load()
    except Exception:
        raise HTTPException(400, "image is not a valid image")
    return raw


def _load_source(path: str | None, image_b64: str | None) -> bytes:
    if image_b64:
        return _decode_image_b64(image_b64)
    if path:
        return resolve_source(path).read_bytes()
    raise HTTPException(400, "path or image_b64 required")


# ---------------------------------------------------------------------------
# Colorhold apply
# ---------------------------------------------------------------------------

class ApplyBody(BaseModel):
    path: str | None = None
    image_b64: str | None = None
    dark_t: float = _ch.DEFAULT_DARK_T
    sat_mul: float = _ch.DEFAULT_SAT_MUL
    val_mul: float = _ch.DEFAULT_VAL_MUL
    smooth: int = _ch.DEFAULT_SMOOTH
    line_sigma: float = _ch.DEFAULT_LINE_SIGMA
    strength: float = _ch.DEFAULT_STRENGTH
    # Black-mass gate (opt-in; off = exact v5). See colorhold.py.
    gate: bool = False
    gate_maxw: int = _ch.DEFAULT_GATE_MAXW
    gate_bh_full: float = _ch.DEFAULT_GATE_BH_FULL
    gate_strength: float = _ch.DEFAULT_GATE_STRENGTH
    preview_max_side: int | None = None


@router.get("/defaults")
def defaults():
    """v5 validated defaults + the eye-tested rejections, so the
    frontend never hardcodes a second copy of them."""
    return {
        "dark_t": _ch.DEFAULT_DARK_T,
        "sat_mul": _ch.DEFAULT_SAT_MUL,
        "val_mul": _ch.DEFAULT_VAL_MUL,
        "smooth": _ch.DEFAULT_SMOOTH,
        "line_sigma": _ch.DEFAULT_LINE_SIGMA,
        "strength": _ch.DEFAULT_STRENGTH,
        "gate": False,
        "gate_maxw": _ch.DEFAULT_GATE_MAXW,
        "gate_bh_full": _ch.DEFAULT_GATE_BH_FULL,
        "gate_strength": _ch.DEFAULT_GATE_STRENGTH,
        "engine": _ch.fill_engine(),
        "rejected": [
            "line_sat beyond ~1.75 (indistinguishable, 2026-10-31)",
            "charcoal/parabolic black-value attenuation (crushed at full res)",
        ],
    }


@router.post("/apply")
def apply(body: ApplyBody):
    import logging
    try:
        raw = _load_source(body.path, body.image_b64)
        rgb = _ch.png_bytes_to_rgb(raw, max_side=body.preview_max_side)
        out, info = _ch.colorhold_lineart(
            rgb, dark_t=body.dark_t, sat_mul=body.sat_mul,
            val_mul=body.val_mul, smooth=body.smooth,
            line_sigma=body.line_sigma, strength=body.strength,
            gate=body.gate, gate_maxw=body.gate_maxw,
            gate_bh_full=body.gate_bh_full, gate_strength=body.gate_strength)
    except HTTPException:
        raise
    except ValueError as e:
        logging.getLogger("uvicorn.error").warning(
            "filters/apply 400: %r | body=%s",
            e, {k: (f"<{len(str(v))} chars>" if k == "image_b64" else v)
                for k, v in body.dict().items()})
        raise HTTPException(400, str(e))
    png = _ch.array_to_png_bytes(out)
    return {
        "ok": True,
        "image": "data:image/png;base64," + base64.b64encode(png).decode(),
        "width": int(out.shape[1]), "height": int(out.shape[0]),
        "engine": info["engine"], "cached_fill": info["cached_fill"],
        "gate": info["gate"], "gate_effective_maxw": info["gate_effective_maxw"],
        "cached_thin": info["cached_thin"],
    }


# ---------------------------------------------------------------------------
# Store a committed canvas result (exactly ONE bounded write, mirroring
# Update's render lifecycle: ellieedit_tmp/filters under the gallery
# root, gallery-addressable for the existing save-family machinery).
# ---------------------------------------------------------------------------

class StoreBody(BaseModel):
    image_b64: str = ""


@router.post("/store")
def store(body: StoreBody):
    raw = _decode_image_b64(body.image_b64)
    try:
        d = _gallery_mod.GALLERY_ROOT / "ellieedit_tmp" / "filters"
        d.mkdir(parents=True, exist_ok=True)
        name = f"filter-{uuid.uuid4().hex[:10]}.png"
        (d / name).write_bytes(raw)
    except OSError as e:
        log.warning("[filters] store failed: %s", e)
        raise HTTPException(502, f"could not store result: {e}")
    return {"ok": True, "render_path": f"ellieedit_tmp/filters/{name}"}


# ---------------------------------------------------------------------------
# Named presets + last state (FoxDen pattern, filters-scoped)
# ---------------------------------------------------------------------------

PRESETS_FILE = "presets.json"
PRESET_MAX = 200
PRESET_NAME_MAX = 60
PRESET_STATE_MAX_BYTES = 64 * 1024
_presets_lock = threading.Lock()


def _presets_path() -> Path:
    return Path(os.environ.get(
        "ELLIEEDIT_FILTERS_DATA",
        str(REPO / "data" / "filters"))) / PRESETS_FILE


def _load_presets() -> dict:
    p = _presets_path()
    empty = {"presets": {}, "last": None}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty
    except (OSError, ValueError):
        try:
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
    os.replace(tmp, p)


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
    """Auto-remember: the in-progress slider state (reload-safe)."""
    _check_state(body.state)
    with _presets_lock:
        d = _load_presets()
        d["last"] = body.state
        _save_presets(d)
    return {"saved": True}
