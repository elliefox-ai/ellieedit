"""Library module — promote (move) gallery/dupe images into the Library root.

Design decisions (operator, 2026-10-09):
  - LIBRARY_ROOT default /mnt/shared/_Library (Windows-side share),
    env-overridable via ELLIEEDIT_LIBRARY_ROOT.
  - Promotion is a MOVE, never a copy: shutil.move (same-volume rename when
    possible, cross-device copy+unlink otherwise) — never leaves a copy.
  - Sources are jailed to GALLERY_ROOT or DUPE_ROOT; anything else is 400.
  - Tags/projects: the operator thinks in project names ("ZengoSoft",
    "FlatDeep"). Default tag derived from the source subfolder via
    normalize_tag (lowercase, strip folder noise, alias map); an explicit
    tag param always overrides.
  - Sidecar index .library-index.jsonl — append-only JSONL, same discipline
    as the dupe ledger, latest entry per path wins. Each record:
      {path: <rel to LIBRARY_ROOT>, tags: [...], promoted_from: <rel>,
       ts: <ISO8601>, sha256: <hex at promotion time>}
    The sha256 is taken at promotion so the index survives later moves or
    renames within the library.
"""

import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import dupe as _dupe_mod
from . import gallery as _gallery_mod
from .gallery import EXTS, get_thumbnail

log = __import__("logging").getLogger("ellieedit.library")

LIBRARY_ROOT = Path(os.environ.get(
    "ELLIEEDIT_LIBRARY_ROOT", "/mnt/shared/_Library"))

PAGE_SIZE = 40


def index_path() -> Path:
    return LIBRARY_ROOT / ".library-index.jsonl"


# ---------------------------------------------------------------------------
# Tag normalization
# ---------------------------------------------------------------------------

# Folder-noise tokens dropped during normalization: version/pass markers,
# pipeline stage words, and generator namespacing that isn't part of the
# project name the operator thinks in.
NOISE_TOKENS = {
    "face", "faces", "composite", "v5", "v4", "v3", "kreagen",
    "sd15pass", "sd15", "top", "gen", "base", "regen", "pass", "out",
}
# Numeric-mush prefixes on generator folders (e.g. f2k4b_zengodraw).
NOISE_RE = None  # compiled lazily below
import re
NOISE_RE = re.compile(r"^[a-z]\d[a-z0-9]{1,6}$")
# Operator-vocabulary aliases: normalized folder -> project name.
ALIAS_MAP = {
    "zengodraw": "zengosoft",
    "zengo": "zengosoft",
    "facecycle": "zengosoft",
}
BARE_FILE_TAG = "misc"


def normalize_tag(folder: str) -> str:
    """'ZengoSoft Face' -> 'zengosoft'; 'flatdeep_v5_kreagen' -> 'flatdeep'.

    Rules: lowercase; split on [_/\\ -]; drop noise tokens and short
    numeric-mush prefixes; alias-map to operator project vocabulary; if
    nothing survives the strip, keep the longest original token.
    """
    raw = (folder or "").strip().lower()
    if not raw:
        return BARE_FILE_TAG
    tokens = [t for t in re.split(r"[_\-/\\\s]+", raw) if t]
    kept = [t for t in tokens
            if t not in NOISE_TOKENS and not NOISE_RE.match(t)]
    stem = " ".join(kept) if kept else (tokens[0] if tokens else raw)
    return ALIAS_MAP.get(stem, stem)


def derive_tag(src: Path) -> str:
    """Default tag from the source path: first path component under the
    source root; bare files at the root fall back to the filename stem's
    leading token, then to BARE_FILE_TAG."""
    for root in (_gallery_mod.GALLERY_ROOT, _dupe_mod.DUPE_ROOT):
        try:
            rel = src.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        parts = rel.parts
        if len(parts) >= 2:
            return normalize_tag(parts[0])
        # Bare file at root: a separator-bearing stem carries a project
        # prefix ("facecycle_composite(9).png" -> "facecycle"); a single
        # loose token is meaningless -> BARE_FILE_TAG unless aliased.
        stem = re.split(r"[(\d]", src.stem)[0].strip("_- ")
        if not stem or ("_" not in stem and stem not in ALIAS_MAP):
            return BARE_FILE_TAG
        return normalize_tag(stem)
    return BARE_FILE_TAG


# ---------------------------------------------------------------------------
# Index discipline (append-only JSONL, latest wins per path)
# ---------------------------------------------------------------------------

def append_index(record: dict) -> None:
    LIBRARY_ROOT.mkdir(parents=True, exist_ok=True)
    with index_path().open("a") as fh:  # append-only by design
        fh.write(json.dumps(record, separators=(",", ":")) + "\n")


def read_index() -> list[dict]:
    p = index_path()
    if not p.is_file():
        return []
    out = []
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def latest_tags() -> dict[str, list[str]]:
    """path(rel) -> tags, latest entry wins."""
    tags: dict[str, list[str]] = {}
    for rec in read_index():
        if rec.get("path"):
            tags[rec["path"]] = list(rec.get("tags") or [])
    return tags


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Path validation
# ---------------------------------------------------------------------------

def valid_source(p: Path) -> bool:
    """True if p is a file strictly under GALLERY_ROOT or DUPE_ROOT."""
    try:
        rp = p.resolve()
    except OSError:
        return False
    if not rp.is_file():
        return False
    for root in (_gallery_mod.GALLERY_ROOT, _dupe_mod.DUPE_ROOT):
        try:
            rr = root.resolve()
        except OSError:
            continue
        if rr != rp and rr in rp.parents:
            return True
    return False


def library_jailed(rel: str) -> Path:
    """Resolve rel under LIBRARY_ROOT; reject escapes (gallery.jailed style)."""
    if not rel or Path(rel).is_absolute() or rel.startswith("~"):
        raise HTTPException(400, "path escapes library root")
    root_real = LIBRARY_ROOT.resolve()
    candidate = (LIBRARY_ROOT / rel.lstrip("/")).resolve()
    if candidate == root_real or root_real not in candidate.parents:
        raise HTTPException(400, "path escapes library root")
    return candidate


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


def promote_move(src: Path, tag: str | None = None) -> dict:
    """Move src into LIBRARY_ROOT/<tag>/<name>; append the index record.
    Returns the record. Raises HTTPException on invalid source."""
    try:
        src.resolve()
    except OSError:
        raise HTTPException(404, "source not found")
    if not valid_source(src):
        if src.exists():
            raise HTTPException(400, "source is outside gallery/dupe roots")
        raise HTTPException(404, "source not found (already promoted?)")
    dest_dir = LIBRARY_ROOT / (tag or derive_tag(src))
    LIBRARY_ROOT.mkdir(parents=True, exist_ok=True)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = _unique_dest(dest_dir, src.name)
    digest = sha256_of(src)
    try:
        # os.replace within the same volume is a pure rename; cross-device
        # (EXDEV) falls back to shutil.move's copy+unlink. Either way this
        # is a MOVE: the source never survives.
        try:
            os.replace(src, dest)
        except OSError as e:
            if getattr(e, "errno", None) != 18:  # EXDEV
                raise
            shutil.move(str(src), str(dest))
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(404, "source vanished mid-promote")
    # Relative provenance: best-effort rel path under its source root.
    promoted_from = src.name
    for root in (_gallery_mod.GALLERY_ROOT, _dupe_mod.DUPE_ROOT):
        try:
            promoted_from = src.resolve().relative_to(root.resolve()).as_posix()
            break
        except ValueError:
            continue
    record = {
        "path": dest.relative_to(LIBRARY_ROOT).as_posix(),
        "tags": [tag or derive_tag(src)],
        "promoted_from": promoted_from,
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "sha256": digest,
    }
    append_index(record)
    log.info("promoted %s -> %s (tag=%s)", promoted_from, record["path"], record["tags"][0])
    return record


def retag(path: str, tags: list[str]) -> dict:
    p = library_jailed(path)
    if not p.is_file():
        raise HTTPException(404, "not in library")
    clean = sorted({t.strip().lower() for t in tags if t.strip()})
    if not clean:
        raise HTTPException(400, "empty tag set")
    rel = p.relative_to(LIBRARY_ROOT).as_posix()
    record = {"path": rel, "tags": clean, "promoted_from": "", "ts":
              datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
              "sha256": ""}
    append_index(record)
    return {"path": rel, "tags": clean}


def list_library(tag: str = "", cursor: int = 0) -> dict:
    """Paged listing of library images with tags. Latest-wins tags joined
    with what's actually on disk (index entries for vanished files are
    skipped)."""
    tags_by_path = latest_tags()
    rows: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(LIBRARY_ROOT):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if Path(fn).suffix.lower() not in EXTS or fn.startswith("."):
                continue
            full = Path(dirpath) / fn
            rel = full.relative_to(LIBRARY_ROOT).as_posix()
            file_tags = tags_by_path.get(rel, [normalize_tag(full.parent.name)]
                                         if full.parent != LIBRARY_ROOT else [])
            rows.append({"path": rel, "name": fn, "mtime": full.stat().st_mtime,
                         "tags": file_tags})
    rows.sort(key=lambda r: r["mtime"], reverse=True)
    if tag:
        t = tag.strip().lower()
        rows = [r for r in rows if t in r["tags"]]
    all_tags = sorted({t for r in rows for t in r["tags"]})
    total = len(rows)
    page = rows[cursor:cursor + PAGE_SIZE]
    next_cursor = cursor + PAGE_SIZE if cursor + PAGE_SIZE < total else None
    return {"items": page, "total": total, "shown": len(page),
            "tag": tag or None, "tags": all_tags, "next_cursor": next_cursor}


router = APIRouter(prefix="/api/library", tags=["library"])


class PromoteBody(BaseModel):
    path: str
    tag: str | None = None


class RetagBody(BaseModel):
    path: str
    tags: list[str]


@router.get("/list")
def list_endpoint(tag: str = "", cursor: int = 0):
    return list_library(tag=tag, cursor=cursor)


@router.post("/promote")
def promote(body: PromoteBody):
    src = _resolve_source(body.path)
    record = promote_move(src, (body.tag or "").strip().lower() or None)
    return {"ok": True, **record}


@router.get("/derive")
def derive(path: str = Query(...)):
    return {"tag": derive_tag(_resolve_source(path))}


@router.post("/retag")
def retag_endpoint(body: RetagBody):
    return retag(body.path, body.tags)


@router.get("/thumb")
def thumb(path: str = Query(...)):
    p = library_jailed(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    tp = get_thumbnail(p)
    return FileResponse(tp, media_type="image/webp")


@router.get("/file")
def file(path: str = Query(...)):
    p = library_jailed(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(p)


def _resolve_source(rel: str) -> Path:
    """Jail a client path against GALLERY_ROOT, falling back to DUPE_ROOT
    (mirrors gallery.resolve_flex)."""
    p = _gallery_mod.jailed(rel)
    if p.is_file():
        return p
    p2 = _dupe_mod.jailed(rel)
    if p2.is_file():
        return p2
    raise HTTPException(404, "not found under gallery or dupe root")
