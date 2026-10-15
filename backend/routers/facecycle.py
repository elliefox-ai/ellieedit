"""FaceCycle module router — ported from face_merge.py's /repaint relay.

Contract kept 1:1 with the original: JSON in {image_b64, mask_b64, prompt,
denoise, seed} → JSON out {image_b64}. Multiple variants are requested as
parallel calls from the client, exactly like the original UI does.
"""

import base64
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import comfy

log = logging.getLogger("ellieedit.facecycle")

router = APIRouter(prefix="/api/facecycle", tags=["facecycle"])


class RepaintRequest(BaseModel):
    image_b64: str
    mask_b64: str
    prompt: str = ""
    denoise: float = Field(0.5, ge=0.0, le=1.0)
    seed: int = 0


@router.post("/repaint")
def repaint(req: RepaintRequest):
    """Run one Krea2 inpaint via ComfyUI. Blocking (long); runs in a worker thread."""
    try:
        png = comfy.comfy_repaint(
            req.image_b64, req.mask_b64, req.prompt,
            denoise=req.denoise, seed=req.seed)
    except Exception as e:
        log.error("[repaint] ERROR: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    return {"image_b64": base64.b64encode(png).decode()}


# ---------------------------------------------------------------------------
# Replace sources (work order 2026-10-13, Task 8/9 revision)
#
# FaceCycle's finishing move: write the final image NEXT TO the selected base
# image, then send every source image to the EXISTING deletion queue (the
# pending-delete manifest — the only path to destruction is still
# /api/pending/confirm). No confirm step by design: the queue is the safety
# net. Provenance decides how the sources are retired:
#   gallery -> manifest entries, gallery-root-relative keys
#   dupe    -> same manifest + the family's ledger entry (ACCEPTED, exactly
#              what meld-save writes) so the family collapses on the spot
# ---------------------------------------------------------------------------

import json
import re
import struct
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

from . import gallery as _gallery_mod

REPLACE_MAX = 8
_PNG_SIG = b"\x89PNG\r\n\x1a\n"


class ReplaceSourcesBody(BaseModel):
    image_b64: str                  # final PNG, base64 (no data: prefix)
    kind: str                       # 'gallery' | 'dupe'
    base: str                       # the selected base image's path
    sources: list[str]              # every source path (base included)
    family: str | None = None       # required for kind='dupe'


def _png_with_text(data: bytes, key: str, text: str) -> bytes:
    """Insert one tEXt chunk right after IHDR. Best-effort: any trouble
    returns the original bytes untouched."""
    try:
        payload = key.encode("latin-1") + b"\x00" + text.encode("latin-1", "replace")
        chunk = (struct.pack(">I", len(payload)) + b"tEXt" + payload
                 + struct.pack(">I", zlib.crc32(b"tEXt" + payload) & 0xFFFFFFFF))
        ihdr_end = 8 + 8 + struct.unpack(">I", data[8:12])[0] + 4  # sig+len/type+data+crc
        return data[:ihdr_end] + chunk + data[ihdr_end:]
    except Exception:
        return data


def _unique_next_to(base: Path, stem: str, suffix: str = ".png") -> Path:
    """Never overwrite (library._unique_dest convention: stem, stem-2, ...)."""
    cand = base.parent / f"{stem}{suffix}"
    i = 2
    while cand.exists():
        cand = base.parent / f"{stem}-{i}{suffix}"
        i += 1
    return cand


@router.post("/replace-sources")
def replace_sources(body: ReplaceSourcesBody, request: Request = None):
    import base64 as _b64
    from .pending import _audit, _load, _save, manifest_lock
    from . import dupe as _dupe

    if body.kind not in ("gallery", "dupe"):
        raise HTTPException(400, "kind must be 'gallery' or 'dupe'")
    srcs = list(dict.fromkeys(p.replace("\\", "/") for p in body.sources))
    base_rel = body.base.replace("\\", "/")
    if not srcs:
        raise HTTPException(400, "no sources")
    if len(srcs) > REPLACE_MAX:
        raise HTTPException(400, f"at most {REPLACE_MAX} sources")
    if base_rel not in srcs:
        raise HTTPException(400, "base must be one of the sources")
    try:
        data = _b64.b64decode(body.image_b64, validate=True)
    except Exception:
        raise HTTPException(400, "image_b64 is not valid base64")
    if not data.startswith(_PNG_SIG) or len(data) < 33:
        raise HTTPException(400, "result must be a PNG")

    jail = _gallery_mod.jailed if body.kind == "gallery" else _dupe.jailed
    if body.kind == "dupe":
        if not body.family:
            raise HTTPException(400, "family is required for dupe provenance")
        fam = _dupe._load_family(body.family)   # 404 on unknown family
        known = {m["path"].replace("\\", "/") for m in fam.get("members", [])}
        bad = [p for p in srcs if p not in known]
        if bad:
            raise HTTPException(400, f"path not a family member: {bad[0]}")
    resolved: dict[str, Path] = {}
    for p in srcs:
        fp = jail(p)                            # 400 on any jail escape
        if not fp.is_file():
            raise HTTPException(404, f"source missing: {p}")
        resolved[p] = fp
    base_file = resolved[base_rel]

    meta = {"tool": "ellieedit-facecycle", "action": "replace-sources",
            "base": base_file.name, "sources": [resolved[p].name for p in srcs],
            "family": body.family,
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    data = _png_with_text(data, "ellieedit", json.dumps(meta, ensure_ascii=False))

    dest = _unique_next_to(base_file, f"{base_file.stem}-fc")
    dest.write_bytes(data)

    # Queue sources on the existing manifest (same key rule as meld-save /
    # send-pending: gallery-root-relative when possible, else dupe-relative).
    groot = _gallery_mod.GALLERY_ROOT.resolve()
    with manifest_lock:
        m = _load()
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        added_keys: list[str] = []
        for p in srcs:
            try:
                key = resolved[p].resolve().relative_to(groot).as_posix()
            except (OSError, ValueError):
                key = p
            if key not in m:
                m[key] = now
                added_keys.append(key)
        _save(m)
    _audit("replace_sources", added_keys, request)

    try:
        saved_rel = dest.resolve().relative_to(groot).as_posix()
    except (OSError, ValueError):
        saved_rel = dest.name
    if body.kind == "dupe":
        entry = {"ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
                 "family": body.family,
                 "members": {p: "kept" for p in srcs},
                 "note": f"replace-sources → {saved_rel}",
                 "meld_result": saved_rel}
        _dupe.LEDGER.parent.mkdir(parents=True, exist_ok=True)
        with _dupe.LEDGER.open("a") as fh:      # append-only by design
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"saved_as": saved_rel, "saved_dir": str(dest.parent),
            "pending_added": len(added_keys), "pending_count": len(m),
            "sources": srcs}
