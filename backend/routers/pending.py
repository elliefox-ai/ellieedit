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
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .gallery import EXTS, GALLERY_ROOT, jailed, resolve_flex

log = __import__("logging").getLogger("ellieedit.pending")

MANIFEST = Path(os.environ.get(
    "ELLIEEDIT_PENDING_MANIFEST",
    str(Path(__file__).resolve().parents[2] / ".pending-delete.json")))

# Append-only audit trail: one JSON line per manifest mutation (see _audit).
AUDIT = Path(os.environ.get(
    "ELLIEEDIT_PENDING_AUDIT",
    str(Path(__file__).resolve().parents[2] / ".pending-audit.jsonl")))

router = APIRouter(prefix="/api/pending", tags=["pending"])

# One lock guarding every read-modify-write on the manifest. FastAPI runs
# sync endpoints in a threadpool, so unlocked _load/…/_save sequences can
# lose updates across pending, send-pending and meld-save writers.
manifest_lock = threading.Lock()


class PathsBody(BaseModel):
    paths: list[str]


class ConfirmBody(BaseModel):
    # Optimistic-concurrency guard: the count the client saw when listing.
    # Optional so existing callers and tests keep working.
    expected_count: int | None = None


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


def _audit(action: str, paths: list[str], request: Request | None = None) -> None:
    """Best-effort append to .pending-audit.jsonl (JSONL, same convention as
    the signals files). Diagnostic only: a failure here must never fail the
    mutation it records."""
    try:
        uniq = sorted(set(paths))
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "ip": (request.client.host if request is not None
                   and request.client else None),
            "action": action,
            "count": len(uniq),
            "paths": uniq if len(uniq) <= 20
                     else uniq[:20] + [f"... +{len(uniq) - 20} more"],
        }
        AUDIT.parent.mkdir(parents=True, exist_ok=True)
        with AUDIT.open("a") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        log.warning("pending audit append failed", exc_info=True)


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


@router.get("/count")
def count_pending():
    """Cheap badge source (2026-10-08n): manifest keys only — no per-entry
    /mnt stats. Bytes/sizes stay in GET /api/pending for the Deletion view."""
    with manifest_lock:
        m = _load()
    return {"count": len(m), "paths": sorted(m)}


@router.post("")
def add_pending(body: PathsBody, request: Request = None,
                expected_count: int | None = None):
    with manifest_lock:
        m = _load()
        if expected_count is not None and len(m) != expected_count:
            raise HTTPException(409, f"queue changed — current count is {len(m)}")
        added = 0
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        touched: list[str] = []
        for rel in body.paths:
            src = jailed(rel)  # raises 400 on any jail violation
            if not src.is_file() or src.suffix.lower() not in EXTS:
                continue  # missing (or not an image): ignore per spec
            if rel not in m:
                m[rel] = now
                added += 1
                touched.append(rel)
        _save(m)
    _audit("add", touched, request)
    return {"added": added, "count": len(m)}


@router.delete("")
def pardon_pending(body: PathsBody, request: Request = None,
                   expected_count: int | None = None):
    """Clemency: remove from the manifest; no disk change."""
    with manifest_lock:
        m = _load()
        if expected_count is not None and len(m) != expected_count:
            raise HTTPException(409, f"queue changed — current count is {len(m)}")
        removed = 0
        touched: list[str] = []
        for rel in body.paths:
            jailed(rel)  # jail applies on pardon too
            if rel in m:
                del m[rel]
                removed += 1
                touched.append(rel)
        _save(m)
    _audit("unmark", touched, request)
    return {"pardoned": removed, "count": len(m)}


@router.get("/audit")
def read_audit(limit: int = 100):
    """Newest audit lines (diagnostics from any client; read-only)."""
    limit = max(1, min(limit, 1000))
    lines: list[dict] = []
    try:
        with AUDIT.open() as fh:
            for line in fh:
                line = line.strip()
                if line:
                    lines.append(line)
    except FileNotFoundError:
        pass
    except Exception:
        log.warning("pending audit read failed", exc_info=True)
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            out.append({"raw": line})
    return {"lines": out, "count": len(out)}


@router.post("/confirm")
def confirm_pending(body: ConfirmBody | None = None, request: Request = None):
    """The ONLY destructive endpoint: delete every manifest file, then clear."""
    expected = body.expected_count if body is not None else None
    with manifest_lock:
        m = _load()
        if expected is not None and len(m) != expected:
            raise HTTPException(409, f"queue changed — current count is {len(m)}")
        deleted = 0
        bytes_freed = 0
        gone: list[str] = []
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
                gone.append(rel)
            except FileNotFoundError:
                # Passes the gallery jail but lives in the dupe pool instead.
                try:
                    from .dupe import jailed as dupe_jailed
                    dsrc = dupe_jailed(rel)
                    size = dsrc.stat().st_size
                    dsrc.unlink()
                    deleted += 1
                    bytes_freed += size
                    gone.append(rel)
                except Exception:
                    continue
            except OSError as e:
                log.warning("pending confirm: could not unlink %s: %s", rel, e)
        _save({})
    _audit("confirm", gone, request)
    return {"deleted": deleted, "bytes": bytes_freed}
