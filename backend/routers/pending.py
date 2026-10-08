"""Pending Delete manifest router — the only path to destruction in EllieEdit.

A server-side JSON manifest (one entry per marked file: gallery-root-relative
path + added-at timestamp) so the delete queue survives browser death and
syncs across devices. Nothing here deletes except POST /api/pending/confirm,
which removes ALL manifest files from disk and clears the manifest.

Path jail mirrors gallery.jailed: every path must resolve to a real file
under GALLERY_ROOT (no escapes, absolute paths, ~, symlinks out of root,
directories).
"""

import json
import os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .gallery import EXTS, GALLERY_ROOT, jailed, resolve_flex

log = __import__("logging").getLogger("ellieedit.pending")

MANIFEST = Path(os.environ.get(
    "ELLIEEDIT_PENDING_MANIFEST",
    str(Path(__file__).resolve().parents[2] / ".pending-delete.json")))

router = APIRouter(prefix="/api/pending", tags=["pending"])


class PathsBody(BaseModel):
    paths: list[str]


def _load() -> dict:
    """manifest: {rel_path: added_at_iso}. Tolerates missing/corrupt file."""
    try:
        data = json.loads(MANIFEST.read_text())
        if isinstance(data, dict):
            return data
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {}


def load_manifest() -> dict:
    """Public accessor (gallery list filter reads this; keeps MANIFEST
    indirection so tests can monkeypatch pending_mod.MANIFEST)."""
    return _load()


def _save(m: dict) -> None:
    tmp = MANIFEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(m, indent=1))
    tmp.rename(MANIFEST)


def _entries(m: dict) -> list[dict]:
    items = []
    total = 0
    for rel, added_at in sorted(m.items()):
        try:
            # Gallery root first, dupe-pool fallback (same as confirm/listing).
            size = resolve_flex(rel).stat().st_size
        except Exception:
            size = None  # file vanished; keep it listed, size unknown
        if size:
            total += size
        items.append({"path": rel, "name": Path(rel).name,
                      "size": size, "added_at": added_at})
    return items


@router.get("")
def list_pending():
    m = _load()
    items = _entries(m)
    return {"items": items, "count": len(items), "bytes": sum(i["size"] or 0 for i in items)}


@router.post("")
def add_pending(body: PathsBody):
    m = _load()
    added = 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    for rel in body.paths:
        src = jailed(rel)  # raises 400 on any jail violation
        if not src.is_file() or src.suffix.lower() not in EXTS:
            continue  # missing (or not an image): ignore per spec
        if rel not in m:
            m[rel] = now
            added += 1
    _save(m)
    return {"added": added, "count": len(m)}


@router.delete("")
def pardon_pending(body: PathsBody):
    """Clemency: remove from the manifest; no disk change."""
    m = _load()
    removed = 0
    for rel in body.paths:
        jailed(rel)  # jail applies on pardon too
        if rel in m:
            del m[rel]
            removed += 1
    _save(m)
    return {"pardoned": removed, "count": len(m)}


@router.post("/confirm")
def confirm_pending():
    """The ONLY destructive endpoint: delete every manifest file, then clear."""
    m = _load()
    deleted = 0
    bytes_freed = 0
    for rel in list(m):
        try:
            src = jailed(rel)
        except HTTPException:
            # Entries can also come from the Dupe view, whose pool root is a
            # different tree than GALLERY_ROOT. Confirm remains the ONLY
            # destructive endpoint — it just resolves through the dupe jail
            # too, so those members are actually deletable.
            try:
                from .dupe import jailed as dupe_jailed
                src = dupe_jailed(rel)
            except Exception:
                continue  # resolves under neither root: skip
        try:
            size = src.stat().st_size
            src.unlink()
            deleted += 1
            bytes_freed += size
        except FileNotFoundError:
            # Passes the gallery jail but lives in the dupe pool instead.
            try:
                from .dupe import jailed as dupe_jailed
                dsrc = dupe_jailed(rel)
                size = dsrc.stat().st_size
                dsrc.unlink()
                deleted += 1
                bytes_freed += size
            except Exception:
                continue
        except OSError as e:
            log.warning("pending confirm: could not unlink %s: %s", rel, e)
    _save({})
    return {"deleted": deleted, "bytes": bytes_freed}
