"""Review module router — save blended results from the Review tab.

Blend happens client-side (canvas); the server only writes the resulting PNG
into the gallery root under a configurable output subdir ("reviewed/").
Path jail mirrors gallery.jailed: destination is resolved under GALLERY_ROOT
and rejected if the real path escapes it (../, absolute, ~, symlinks).

Overwrite policy: reject saving over an existing file unless overwrite=true.
"""

import base64
import binascii
import io
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from PIL import Image

from .gallery import GALLERY_ROOT, EXTS, jailed

Image.MAX_IMAGE_PIXELS = None

REVIEW_SUBDIR = os.environ.get("ELLIEEDIT_REVIEW_SUBDIR", "reviewed")

router = APIRouter(prefix="/api/review", tags=["review"])


def jailed_output(filename: str) -> "object":
    """Resolve filename under GALLERY_ROOT/REVIEW_SUBDIR; same jail rules."""
    if not filename or "/" in filename or "\\" in filename or filename in (".", ".."):
        raise HTTPException(400, "bad filename")
    return jailed(f"{REVIEW_SUBDIR}/{filename}")


class SaveBody(BaseModel):
    filename: str
    data: str            # data URL or bare base64 PNG
    overwrite: bool = False


@router.get("/outdir")
def outdir():
    return {"subdir": REVIEW_SUBDIR, "path": f"{REVIEW_SUBDIR}/<name>.png"}


@router.post("/save")
def save(body: SaveBody):
    dest = jailed_output(body.filename)
    if dest.suffix.lower() not in EXTS:
        raise HTTPException(400, "filename must end in an image extension")
    if dest.exists() and not body.overwrite:
        raise HTTPException(409, f"already exists: {REVIEW_SUBDIR}/{dest.name}")

    raw = body.data
    if raw.startswith("data:"):
        raw = raw.partition(",")[2]
    try:
        png = base64.b64decode(raw, validate=True)
        with Image.open(io.BytesIO(png)) as im:
            im.verify()  # reject non-image payloads
        with Image.open(io.BytesIO(png)) as im:
            fmt = (im.format or "").upper()
    except Exception:
        raise HTTPException(400, "invalid image data")

    dest.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "PNG":
        payload = png
    else:
        with Image.open(io.BytesIO(png)) as im:
            buf = io.BytesIO()
            im.save(buf, "PNG")
            payload = buf.getvalue()
    dest.write_bytes(payload)
    return {"saved": f"{REVIEW_SUBDIR}/{dest.name}", "bytes": len(payload),
            "overwritten": bool(body.overwrite)}
