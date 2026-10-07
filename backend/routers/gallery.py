"""Gallery module router — list + thumbnail + file streaming for the Gallery tab.

Root is one config constant, env-overridable (ELLIEEDIT_GALLERY_ROOT). Path
jail: every user-supplied path is resolved against the root and rejected if
the real path escapes it (symlinks included).
"""

import hashlib
import io
import os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # local tool; images may be large

log = __import__("logging").getLogger("ellieedit.gallery")

GALLERY_ROOT = Path(os.environ.get("ELLIEEDIT_GALLERY_ROOT", "/mnt/e/comfyui/output"))
THUMB_CACHE_DIR = Path(os.environ.get(
    "ELLIEEDIT_THUMB_CACHE",
    str(Path(__file__).resolve().parents[2] / ".thumbcache")))
THUMB_SIZE = 256
PAGE_SIZE = 100
EXTS = {".jpg", ".jpeg", ".png", ".webp"}

router = APIRouter(prefix="/api/gallery", tags=["gallery"])


def jailed(rel: str) -> Path:
    """Resolve rel under GALLERY_ROOT; reject escapes (../, absolute, symlinks)."""
    if not rel or Path(rel).is_absolute() or rel.startswith("~"):
        raise HTTPException(400, "path escapes gallery root")
    root_real = GALLERY_ROOT.resolve()
    candidate = (GALLERY_ROOT / rel.lstrip("/")).resolve()
    if candidate == root_real or root_real not in candidate.parents:
        raise HTTPException(400, "path escapes gallery root")
    return candidate


def _thumb_path(src: Path) -> Path:
    key = hashlib.sha1(f"{src}|{src.stat().st_mtime_ns}".encode()).hexdigest()
    return THUMB_CACHE_DIR / f"{key}.webp"


def get_thumbnail(src: Path) -> Path:
    tp = _thumb_path(src)
    if tp.exists():
        return tp
    THUMB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = tp.with_suffix(".tmp")
    with Image.open(src) as im:
        im.thumbnail((THUMB_SIZE, THUMB_SIZE))
        im.save(tmp, "WEBP", quality=80)
    tmp.rename(tp)
    return tp


@router.get("/list")
def list_images(dir: str = "", cursor: str = ""):
    root_real = GALLERY_ROOT.resolve()
    if dir and (Path(dir).is_absolute() or dir.startswith("~")):
        raise HTTPException(400, "dir escapes gallery root")
    base = (GALLERY_ROOT / dir.lstrip("/")).resolve() if dir else GALLERY_ROOT.resolve()
    if base != root_real and root_real not in base.parents:
        raise HTTPException(400, "dir escapes gallery root")
    if not base.is_dir():
        raise HTTPException(404, "not a directory")

    files = []
    subdirs = []
    for entry in sorted(base.iterdir()):
        if entry.name.startswith(".") or entry.is_symlink():
            continue
            continue
        if entry.is_dir():
            subdirs.append(entry.name)
        elif entry.suffix.lower() in EXTS:
            try:
                st = entry.stat()
                files.append((int(st.st_mtime), entry))
            except OSError:
                continue
    files.sort(reverse=True)  # newest first

    start = 0
    if cursor:
        # Opaque cursor: "mtime:name" of the last item on the previous page.
        try:
            cm, cn = cursor.split(":", 1)
            cm = int(cm)
            start = next((i + 1 for i, (m, e) in enumerate(files)
                          if m == cm and e.name == cn), None)
            if start is None:
                raise ValueError
        except ValueError:
            raise HTTPException(400, "bad cursor")

    page = files[start:start + PAGE_SIZE]
    items = []
    for mtime, f in page:
        try:
            with Image.open(f) as im:
                w, h = im.size  # cheap header read
        except Exception:
            continue
        items.append({
            "name": f.name,
            "path": f"{f.relative_to(root_real).as_posix()}",
            "mtime": int(mtime),
            "width": w, "height": h,
            "thumb": True,  # generated lazily by /thumb
        })
    next_cursor = f"{page[-1][0]}:{page[-1][1].name}" if page and start + PAGE_SIZE < len(files) else None
    return {"items": items, "subdirs": subdirs, "next_cursor": next_cursor,
            "root": str(root_real)}


@router.get("/thumb")
def thumbnail(path: str = Query(...)):
    src = jailed(path)
    if not src.is_file() or src.suffix.lower() not in EXTS:
        raise HTTPException(404, "not an image")
    try:
        tp = get_thumbnail(src)
    except Exception as e:
        raise HTTPException(500, f"thumbnail failed: {e}")
    return FileResponse(tp, media_type="image/webp",
                        headers={"Cache-Control": "public, max-age=86400"})


@router.get("/file")
def file(path: str = Query(...)):
    src = jailed(path)
    if not src.is_file() or src.suffix.lower() not in EXTS:
        raise HTTPException(404, "not an image")
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
             "png": "image/png", "webp": "image/webp"}[src.suffix.lower()[1:]]
    return FileResponse(src, media_type=media,
                        headers={"Cache-Control": "public, max-age=3600"})
