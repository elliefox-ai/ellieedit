"""Library module — promote (move) gallery/dupe images into the Library root.

Design decisions (operator, 2026-10-09):
  - LIBRARY_ROOT default /mnt/shared/_Library (Windows-side share),
    env-overridable via ELLIEEDIT_LIBRARY_ROOT.
  - Promotion is a MOVE, never a copy: shutil.move (same-volume rename when
    possible, cross-device copy+unlink otherwise) — never leaves a copy.
  - Sources are jailed to GALLERY_ROOT or DUPE_ROOT; anything else is 400.
  - Delete (2026-10-09e): a library delete is never an unlink. POST
    /pending-delete MOVES the file into LIBRARY_ROOT/.pending-delete/ and
    appends an index record with deleted_soon: true. The listing skips both
    (the dot-dir is invisible and deleted-soon paths are filtered). The
    only destructive step is POST /pending/confirm, which unlinks the
    pending area — the library-side twin of the gallery pending queue.
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


def pending_dir() -> Path:
    """Deletion-queue pending area (2026-10-09e): files move HERE on delete,
    never unlinked until the confirmed purge. Dot-prefixed so os.walk and
    every listing skip it. Function (not a constant) so it always follows
    the current LIBRARY_ROOT (tests monkeypatch it)."""
    return LIBRARY_ROOT / ".pending-delete"


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
    """Default tag from the source path: the DEEPEST folder component under
    the source root (2026-10-09e — subfolder navigation means the deepest
    folder is the one the operator browsed into); bare files at the root
    fall back to the filename stem's leading token, then to BARE_FILE_TAG."""
    for root in (_gallery_mod.GALLERY_ROOT, _dupe_mod.DUPE_ROOT):
        try:
            rel = src.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        parts = rel.parts
        if len(parts) >= 2:
            return normalize_tag(parts[-2])
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
            try:
                shutil.move(str(src), str(dest))
            except PermissionError:
                # DrvFS sources (/mnt/*): shutil.move's copy2 copystat dies
                # on utime ("Operation not permitted") AFTER copying bytes.
                # Fall back to a plain content copy + best-effort metadata,
                # then unlink — still a move; the source never survives.
                shutil.copyfile(src, dest)
                try:
                    shutil.copystat(src, dest)
                except PermissionError:
                    pass
                src.unlink()
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


def deleted_soon_paths() -> set[str]:
    """Paths whose latest index record is flagged deleted_soon (2026-10-09e):
    the file already sits in the pending area, but a stale duplicate on
    disk must never reappear in the listing."""
    gone: set[str] = set()
    for rec in read_index():
        if rec.get("path"):
            if rec.get("deleted_soon"):
                gone.add(rec["path"])
            else:
                gone.discard(rec["path"])  # latest entry wins, even un-flagging
    return gone


def list_library(tag: str = "", cursor: int = 0) -> dict:
    """Paged listing of library images with tags. Latest-wins tags joined
    with what's actually on disk (index entries for vanished files are
    skipped)."""
    tags_by_path = latest_tags()
    gone = deleted_soon_paths()
    rows: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(LIBRARY_ROOT):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if Path(fn).suffix.lower() not in EXTS or fn.startswith("."):
                continue
            full = Path(dirpath) / fn
            rel = full.relative_to(LIBRARY_ROOT).as_posix()
            if rel in gone:
                continue  # deleted-soon: queued, never listed again
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


class DeleteBody(BaseModel):
    path: str


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


@router.post("/pending-delete")
def pending_delete(body: DeleteBody):
    """Library delete (2026-10-09e): enqueue into the deletion queue's
    pending area. The file is MOVED to LIBRARY_ROOT/.pending-delete/ (never
    unlinked), dropped from the listing, and the index is marked
    deleted_soon. Actual destruction lives only in /pending/confirm."""
    p = library_jailed(body.path)
    if not p.is_file():
        raise HTTPException(404, "not in library")
    rel = p.relative_to(LIBRARY_ROOT).as_posix()
    tags = latest_tags().get(rel, [])
    pdir = pending_dir()
    pdir.mkdir(parents=True, exist_ok=True)
    dest = _unique_dest(pdir, p.name)
    try:
        os.replace(p, dest)
    except OSError as e:
        raise HTTPException(500, f"queue move failed: {e}")
    append_index({
        "path": rel, "tags": tags, "promoted_from": "",
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "sha256": "", "deleted_soon": True,
    })
    log.info("library pending-delete: %s -> %s", rel, dest.name)
    return {"ok": True, "path": rel, "queued": dest.name}


@router.get("/pending")
def pending_list():
    items = []
    total = 0
    try:
        entries = sorted(pending_dir().iterdir())
    except FileNotFoundError:
        entries = []
    for f in entries:
        try:
            size = f.stat().st_size
        except OSError:
            continue
        if f.is_file():
            items.append({"name": f.name, "size": size})
            total += size
    return {"items": items, "count": len(items), "bytes": total}


@router.post("/pending/confirm")
def pending_confirm():
    """The ONLY library destructive step: unlink everything in the pending
    area. Mirrors /api/pending/confirm semantics (explicit, count-free for
    the small library queue)."""
    deleted = 0
    bytes_freed = 0
    try:
        entries = list(pending_dir().iterdir())
    except FileNotFoundError:
        entries = []
    for f in entries:
        try:
            size = f.stat().st_size
            f.unlink()
            deleted += 1
            bytes_freed += size
        except OSError as e:
            log.warning("library pending confirm: could not unlink %s: %s", f, e)
    return {"deleted": deleted, "bytes": bytes_freed}


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
