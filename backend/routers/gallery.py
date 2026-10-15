"""Gallery module router — list + thumbnail + file streaming for the Gallery tab.

Root is one config constant, env-overridable (ELLIEEDIT_GALLERY_ROOT). Path
jail: every user-supplied path is resolved against the root and rejected if
the real path escapes it (symlinks included).
"""

import hashlib
import io
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Response as FResponse
from fastapi.responses import FileResponse, Response
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # local tool; images may be large

log = __import__("logging").getLogger("ellieedit.gallery")

GALLERY_ROOT = Path(os.environ.get("ELLIEEDIT_GALLERY_ROOT", "/mnt/e/comfyui/output"))
# Repaint intermediates land here (ComfyUI writes ellieedit_tmp/ inside its
# output root, which is shared with the gallery root). Env-overridable for
# the case where ComfyUI's output root differs from GALLERY_ROOT.
TMP_DIR = Path(os.environ.get(
    "ELLIEEDIT_TMP_DIR", str(GALLERY_ROOT / "ellieedit_tmp")))
TEMP_DIRS = {"ellieedit_tmp"}  # never shown in the gallery
TMP_MAX_AGE_S = 24 * 3600
MIGRATE_GLOBS = ("facecycle_repaint_*.png",)
THUMB_CACHE_DIR = Path(os.environ.get(
    "ELLIEEDIT_THUMB_CACHE",
    str(Path(__file__).resolve().parents[2] / ".thumbcache")))
THUMB_SIZE = 256
PAGE_SIZE = 100
EXTS = {".jpg", ".jpeg", ".png", ".webp"}

router = APIRouter(prefix="/api/gallery", tags=["gallery"])

# ---- listing caches (2026-10-15) -------------------------------------------
# /mnt/e is slow per syscall, and every page request used to re-list the whole
# folder, stat every image, and open 100 files for dimensions. Two in-memory
# caches make paging cheap; both are pure accelerators (a miss just does the
# old work) and are safe to lose on restart.
#   _DIR_INDEX: folder -> {filename: mtime}. Each request does ONE readdir and
#     stats only names it hasn't seen; vanished names drop out, new files
#     appear. The newest RECENT_RESTAT files are re-stat'ed on a fresh listing
#     (no cursor) so an in-place overwrite of recent work re-sorts. Older
#     in-place rewrites are picked up by ?refresh=true (or a restart).
#   _DIMS: (path, mtime) -> (w, h).
_DIR_INDEX: dict[str, dict[str, int]] = {}
DIR_INDEX_MAX = 64
RECENT_RESTAT = 200
_DIMS: dict[tuple[str, int], tuple[int, int]] = {}
DIMS_MAX = 100_000
_dims_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="gal-dims")

# ---- thumbnail warming (2026-10-15) ----------------------------------------
# Thumbnails are generated lazily, and the browser only asks for the ones near
# the viewport — so scrolling into never-viewed territory paid a cold full-size
# decode per image. After serving a listing page we now generate that page's
# thumbnails plus the NEXT page's in a small background pool, so scrolling
# finds them ready. Pure accelerator: a miss just falls back to on-demand.
THUMB_WARM = os.environ.get("ELLIEEDIT_THUMB_WARM", "1") != "0"
WARM_MAX_INFLIGHT = 400          # queued+running cap; the rest are skipped
_warm_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gal-thumb")
_warm_inflight: set[str] = set()
_thumb_locks: dict[str, threading.Lock] = {}
_state_guard = threading.Lock()


def jailed(rel: str) -> Path:
    """Resolve rel under GALLERY_ROOT; reject escapes (../, absolute, symlinks)."""
    if not rel or Path(rel).is_absolute() or rel.startswith("~"):
        raise HTTPException(400, "path escapes gallery root")
    root_real = GALLERY_ROOT.resolve()
    candidate = (GALLERY_ROOT / rel.lstrip("/")).resolve()
    if candidate == root_real or root_real not in candidate.parents:
        raise HTTPException(400, "path escapes gallery root")
    return candidate


def resolve_flex(rel: str) -> Path:
    """Resolve a manifest-style rel under GALLERY_ROOT; on miss, fall back to
    the dupe-pool jail (mirrors pending.confirm). The dupe view queues
    pool-relative paths that pass the gallery path-shape jail but only exist
    under DUPE_ROOT — without this fallback every pending listing, size-stat,
    and thumb resolves to nothing (blank grid, '0 B'). Raises 404 on a
    double miss. Jail escapes stay 400 (strict gallery jail); only a passing
    jail with a missing file falls through to the dupe pool."""
    p = jailed(rel)  # raises 400 on any gallery-jail violation
    if p.is_file():
        return p
    from .dupe import jailed as dupe_jailed
    p = dupe_jailed(rel)  # raises 400 on dupe-jail violations
    if not p.is_file():
        raise HTTPException(404, "not found under gallery or dupe root")
    return p


def _thumb_path(src: Path) -> Path:
    key = hashlib.sha1(f"{src}|{src.stat().st_mtime_ns}".encode()).hexdigest()
    return THUMB_CACHE_DIR / f"{key}.webp"


def get_thumbnail(src: Path) -> Path:
    """Cached thumbnail path, generating it if needed. One generation per
    thumbnail at a time (concurrent requests and the warm pool wait for it
    instead of racing on the same temp file), written atomically."""
    tp = _thumb_path(src)
    if tp.exists():
        return tp
    with _state_guard:
        lock = _thumb_locks.setdefault(tp.name, threading.Lock())
    try:
        with lock:
            if tp.exists():          # someone else finished while we waited
                return tp
            THUMB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = tp.with_name(f"{tp.stem}.{os.getpid()}-{threading.get_ident()}.tmp")
            try:
                with Image.open(src) as im:
                    if im.format == "JPEG":
                        im.draft("RGB", (THUMB_SIZE * 2, THUMB_SIZE * 2))  # decode at reduced scale
                    im.thumbnail((THUMB_SIZE, THUMB_SIZE))
                    im.save(tmp, "WEBP", quality=80)
                tmp.replace(tp)
            finally:
                tmp.unlink(missing_ok=True)
    finally:
        with _state_guard:
            _thumb_locks.pop(tp.name, None)
    return tp


def _warm_one(path: str) -> None:
    try:
        get_thumbnail(Path(path))
    except Exception:
        log.debug("thumb warm failed for %s", path, exc_info=True)
    finally:
        with _state_guard:
            _warm_inflight.discard(path)


def warm_thumbs(paths: list[str]) -> list:
    """Queue background thumbnail generation, in the given order (current page
    first, then the next). Never blocks, never raises; already-queued paths
    are skipped. Returns the futures (tests wait on them)."""
    if not THUMB_WARM:
        return []
    futs = []
    with _state_guard:
        for p in paths:
            if p in _warm_inflight:
                continue
            if len(_warm_inflight) >= WARM_MAX_INFLIGHT:
                break
            _warm_inflight.add(p)
            futs.append(_warm_pool.submit(_warm_one, p))
    return futs


def _entry_mtime(entry) -> int:
    return int(entry.stat().st_mtime)


def _path_mtime(path: str) -> int:
    return int(os.stat(path).st_mtime)


def _scan_dir(base: Path, root_real: Path, fresh: bool, refresh: bool):
    """One readdir + stats for unseen names only.
    -> (files [(mtime, name)] newest-first, subdirs [name], cold: bool)"""
    key = str(base)
    prev = {} if refresh else _DIR_INDEX.get(key, {})
    cur: dict[str, int] = {}
    subdirs: list[str] = []
    cold = False
    with os.scandir(base) as it:
        for entry in it:
            name = entry.name
            if name.startswith(".") or entry.is_symlink():
                continue
            if entry.is_dir():
                if name in TEMP_DIRS and base == root_real:
                    continue  # intermediates, not gallery content
                subdirs.append(name)
            elif os.path.splitext(name)[1].lower() in EXTS:
                m = prev.get(name)
                if m is None:
                    try:
                        m = _entry_mtime(entry)
                    except OSError:
                        continue
                    cold = True
                cur[name] = m
    if fresh and prev and not refresh:
        # Fresh listing: re-check the newest files so an in-place overwrite of
        # recent work re-sorts. Paging requests (cursor) skip this.
        newest = sorted(cur, key=lambda n: (cur[n], n), reverse=True)[:RECENT_RESTAT]
        for n in newest:
            try:
                cur[n] = _path_mtime(os.path.join(key, n))
            except OSError:
                cur.pop(n, None)
    if len(_DIR_INDEX) >= DIR_INDEX_MAX and key not in _DIR_INDEX:
        _DIR_INDEX.pop(next(iter(_DIR_INDEX)))
    _DIR_INDEX[key] = cur
    subdirs.sort()
    files = sorted(((m, n) for n, m in cur.items()), reverse=True)  # newest first
    return files, subdirs, cold


def _cursor_start(keys: list, cursor: str) -> int:
    """Index of the first key strictly AFTER the cursor in a newest-first list
    of (mtime, name, ...). Tolerant: the cursor item itself may be gone (it was
    marked pending, deleted, or returned since the last page) — we still resume
    at the right spot instead of failing with 400."""
    try:
        cm, cn = cursor.split(":", 1)
        target = (int(cm), cn)
    except ValueError:
        raise HTTPException(400, "bad cursor")
    lo, hi = 0, len(keys)
    while lo < hi:                       # newest-first: predicate is monotone
        mid = (lo + hi) // 2
        if tuple(keys[mid][:2]) < target:
            hi = mid
        else:
            lo = mid + 1
    return lo


def _read_dims(path: str):
    try:
        with Image.open(path) as im:
            return im.size  # cheap header read
    except Exception:
        return None


def _dims_many(files: list[tuple[str, int]]) -> list:
    """[(abs_path, mtime)] -> [(w,h) | None], cached; misses read in parallel
    (the header reads are IO-bound on /mnt)."""
    out = [None] * len(files)
    todo = []
    for i, key in enumerate(files):
        hit = _DIMS.get(key)
        if hit:
            out[i] = hit
        else:
            todo.append(i)
    if todo:
        res = list(_dims_pool.map(_read_dims, [files[i][0] for i in todo]))
        for i, r in zip(todo, res):
            out[i] = r
            if r:
                if len(_DIMS) >= DIMS_MAX:
                    _DIMS.clear()
                _DIMS[files[i]] = r
    return out


@router.get("/list")
def list_images(response: FResponse, dir: str = "", cursor: str = "",
                pending: str = "all", refresh: bool = False):
    """pending filter (default 'all' = everything, backward compatible):
      active  — exclude every path in the pending-delete manifest
      pending — only manifest paths
    Every item is tagged `pending: bool` so an 'All' client view can badge
    manifest images without a second fetch. Filtering happens BEFORE cursor
    resolution, so pagination is correct within each filtered view.
    `refresh=true` drops this folder's cached index (re-stats everything).
    Server-Timing reports where the time went (walk / dims / total)."""
    t0 = time.perf_counter()
    if pending not in ("all", "active", "pending"):
        raise HTTPException(400, "pending must be all|active|pending")
    from .pending import load_manifest  # lazy: pending.py imports this module
    pending_set = set(load_manifest().keys())

    root_real = GALLERY_ROOT.resolve()
    if dir and (Path(dir).is_absolute() or dir.startswith("~")):
        raise HTTPException(400, "dir escapes gallery root")
    base = (GALLERY_ROOT / dir.lstrip("/")).resolve() if dir else GALLERY_ROOT.resolve()
    if base != root_real and root_real not in base.parents:
        raise HTTPException(400, "dir escapes gallery root")
    if not base.is_dir():
        raise HTTPException(404, "not a directory")

    if pending == "pending":
        # Pending is a GLOBAL inbox: it must not depend on the folder walk at
        # all (the walk is per-folder and non-recursive, so manifest images in
        # other folders would be invisible). List manifest paths directly.
        out = _pending_listing(pending_set, cursor, root_real)
        response.headers["Server-Timing"] = \
            f"total;dur={(time.perf_counter() - t0) * 1000:.1f}"
        return out

    files, subdirs, cold = _scan_dir(base, root_real, fresh=not cursor,
                                     refresh=refresh)
    t_walk = time.perf_counter()

    def rel_of(name: str) -> str:
        return (base / name).relative_to(root_real).as_posix()

    # Pending filter applies before cursoring so cursors stay per-view correct.
    if pending != "all":
        files = [(m, n) for (m, n) in files
                 if (rel_of(n) in pending_set) == (pending == "pending")]

    start = _cursor_start(files, cursor) if cursor else 0
    page = files[start:start + PAGE_SIZE]
    dims = _dims_many([(str(base / n), m) for m, n in page])
    t_dims = time.perf_counter()
    items = []
    for (mtime, name), wh in zip(page, dims):
        if not wh:
            continue
        w, h = wh
        rel = rel_of(name)
        items.append({
            "name": name,
            "path": rel,
            "mtime": int(mtime),
            "width": w, "height": h,
            "thumb": True,  # generated lazily by /thumb
            "pending": rel in pending_set,
        })
    next_cursor = f"{page[-1][0]}:{page[-1][1]}" if page and start + PAGE_SIZE < len(files) else None
    ahead = files[start + PAGE_SIZE:start + 2 * PAGE_SIZE]
    warm_thumbs([str(base / n) for _m, n in page] + [str(base / n) for _m, n in ahead])
    response.headers["Server-Timing"] = (
        f'walk;dur={(t_walk - t0) * 1000:.1f};desc="{"cold" if cold else "warm"}", '
        f"dims;dur={(t_dims - t_walk) * 1000:.1f}, "
        f"total;dur={(time.perf_counter() - t0) * 1000:.1f}")
    return {"items": items, "subdirs": subdirs, "next_cursor": next_cursor,
            "root": str(root_real)}


def _pending_listing(pending_set: set, cursor: str, root_real: Path) -> dict:
    """Global pending view: every manifest path, any folder, newest first.
    Same item shape, tagging, and cursoring as the folder walk — one data
    source so the status count and grid count cannot diverge."""
    files = []
    for rel in pending_set:
        try:
            f = resolve_flex(rel)
            st = f.stat()
            if f.suffix.lower() not in EXTS:
                continue
            files.append((int(st.st_mtime), f.name, rel, f))
        except (HTTPException, OSError):
            continue  # vanished or jailed under both roots: skip in the grid
    files.sort(reverse=True)
    start = _cursor_start(files, cursor) if cursor else 0
    page = files[start:start + PAGE_SIZE]
    dims = _dims_many([(str(f), m) for m, _n, _r, f in page])
    items = []
    for (mtime, name, rel, _f), wh in zip(page, dims):
        if not wh:
            continue
        w, h = wh
        # path stays the manifest key (gallery- or dupe-relative); the media
        # endpoints resolve through the same flexible jail.
        items.append({"name": name, "path": rel, "mtime": int(mtime),
                      "width": w, "height": h, "thumb": True, "pending": True})
    next_cursor = f"{page[-1][0]}:{page[-1][1]}" if page and start + PAGE_SIZE < len(files) else None
    warm_thumbs([str(f) for _m, _n, _r, f in page]
                + [str(f) for _m, _n, _r, f in files[start + PAGE_SIZE:start + 2 * PAGE_SIZE]])
    return {"items": items, "subdirs": [], "next_cursor": next_cursor,
            "root": str(root_real)}


def cleanup_tmp_dir():
    """Startup hygiene for repaint intermediates.

    1. Migrate legacy mess: any facecycle_repaint_*.png the old prefix wrote
       straight into the output root is deleted (pure intermediates).
    2. Delete files in TMP_DIR older than TMP_MAX_AGE_S (belt-and-braces for
       files whose post-repaint unlink was missed).
    Safe to call repeatedly; tolerates a missing TMP_DIR.
    """
    removed = 0
    root_real = GALLERY_ROOT.resolve()
    try:
        for pattern in MIGRATE_GLOBS:
            for old in root_real.glob(pattern):
                if old.is_file():
                    old.unlink()
                    removed += 1
        if removed:
            log.info("tmp sweep: removed %d legacy repaint file(s) from output root", removed)
    except OSError as e:
        log.warning("tmp sweep: legacy migration skipped: %s", e)
    try:
        now = time.time()
        for f in TMP_DIR.iterdir():
            try:
                if f.is_file() and now - f.stat().st_mtime > TMP_MAX_AGE_S:
                    f.unlink()
                    removed += 1
            except OSError as e:
                log.warning("tmp sweep: could not remove %s: %s", f, e)
    except FileNotFoundError:
        pass  # nothing painted yet
    except OSError as e:
        log.warning("tmp sweep: TMP_DIR scan skipped: %s", e)
    return removed


@router.get("/thumb")
def thumbnail(path: str = Query(...)):
    src = resolve_flex(path)
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
    src = resolve_flex(path)
    if not src.is_file() or src.suffix.lower() not in EXTS:
        raise HTTPException(404, "not an image")
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
             "png": "image/png", "webp": "image/webp"}[src.suffix.lower()[1:]]
    return FileResponse(src, media_type=media,
                        headers={"Cache-Control": "public, max-age=3600"})
