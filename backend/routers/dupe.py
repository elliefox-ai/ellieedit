"""Dupe view router — system-found near-duplicate families (plan §9.1).

Third curation action: dupelib (canonical copy: ~/workspace/dupe-review-v2)
pre-computes near-dupe families under <root>/.dupes/; this router surfaces
them per-family so a human can issue verdicts. PRINCIPLES:
  - verdicts-not-writes: nothing here touches image files except by posting
    rejected members onto the existing Pending Delete manifest (one
    destructive endpoint in the whole app: /api/pending/confirm).
  - path-jailed everything: DUPE_ROOT jail mirrors gallery.jailed, symlink
    and absolute-path escapes included.
  - verdicts live in an append-only JSONL ledger (latest entry per family
    wins); the ledger defaults to the ellieedit data dir, NOT next to the
    families, so the dupelib output tree stays pristine.

DUPE_ROOT is env-overridable (ELLIEEDIT_DUPE_ROOT). Canonical live tree:
  /mnt/shared/_Incoming/DupeReview  (627 families, index 2026-10-03).
"""

import json
import os
import re
import subprocess
import threading
import time
from urllib.parse import quote
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import gallery as _gallery_mod
from .gallery import get_thumbnail
from fastapi.responses import FileResponse

log = __import__("logging").getLogger("ellieedit.dupe")

DUPE_ROOT = Path(os.environ.get(
    "ELLIEEDIT_DUPE_ROOT", "/mnt/shared/_Incoming/DupeReview"))
# Member-root allowlist (2026-10-09h): straggler-scan families link members
# OUTSIDE the dupe root (e.g. /mnt/shared/_DupeGatherer/staging/...). The
# jail accepts absolute paths resolving under any of these realpaths only;
# env override ELLIEEDIT_DUPE_EXTRA_ROOTS (os.pathsep-separated) extends or
# replaces the two defaults. Strict allowlist — everything else is 400.
DUPE_MEMBER_ROOTS: list[Path] = [DUPE_ROOT] + [
    Path(p) for p in os.environ.get(
        "ELLIEEDIT_DUPE_EXTRA_ROOTS",
        os.pathsep.join(["/mnt/shared/_DupeGatherer",
                         "/mnt/shared/_Incoming"]),
    ).split(os.pathsep) if p.strip()]
DUPE_DATA = Path(os.environ.get(
    "ELLIEEDIT_DUPE_DATA", str(DUPE_ROOT / ".dupes")))
# Ledger lives in the ellieedit repo dir (append-only JSONL, latest wins).
LEDGER = Path(os.environ.get(
    "ELLIEEDIT_DUPE_LEDGER",
    str(Path(__file__).resolve().parents[2] / ".dupe-verdicts.jsonl")))
# Canonical dupelib copy used for background scans.
DUPELIB_PATH = os.environ.get(
    "ELLIEEDIT_DUPELIB_PATH", str(Path.home() / "workspace/dupe-review-v2"))

# Suggestion/conflict telemetry (2026-10-08d): append-only JSONL like the
# verdict ledger, gitignored. kind:override-style manual overrides included.
SIGNALS_LOG = Path(os.environ.get(
    "ELLIEEDIT_DUPE_SIGNALS_LOG",
    str(Path(__file__).resolve().parents[2] / ".dupe-signals.jsonl")))
SIGNAL_EVENTS = {"shown", "applied", "dismissed", "override"}

VERDICTS = {"kept", "rejected", "melded", "deferred"}
FAMILY_ID_RE = re.compile(r"^fam-[0-9a-f]{12}$")
PAGE_SIZE = 40
SCAN_LOG = Path("/tmp/ellieedit-dupescan.log")

# ------------------------------------------- death-row rehydration (2026-10-09b)
# The operator's pre-purge confidence sweep: RESOLVED families whose latest
# verdict is MAJORITY-REJECTED re-enter the normal unresolved queue as
# pre-marked UNCOMMITTED drafts (the client applies the historical verdict
# map as the current draft; only his own re-commits ever write the ledger).
# Read-only over the ledger: these endpoints consume history, never append.

DEATH_ROW_TTL = 300.0         # bytes summary cache (an ~11k-stat /mnt walk)
_death_row_cache: tuple[str, list[dict]] | None = None  # (idx:ledger key, rows)


def _death_row_rows(verdicts: dict | None = None,
                    idx: dict | None = None) -> list[dict]:
    """Majority-rejected resolved families, biggest-rejected-first.
    Majority = rejected >= kept and rejected > 0 over the LATEST ledger
    entry only (latest-verdict-wins). Pure ledger+index read — no file
    stats here; bytes are computed lazily by /death-row for the summary."""
    verdicts = verdicts if verdicts is not None else _verdicts()
    fams = (idx or _index())["families"]
    rows = []
    for f in fams:
        v = verdicts.get(f["id"])
        if not v or v.get("death_row_dismissed"):
            continue   # dismissed tombstone retires the row (Task 4)
        kept = rejected = 0
        for val in (v.get("members") or {}).values():
            if val == "kept":
                kept += 1
            elif val == "rejected":
                rejected += 1
        if rejected > 0 and rejected >= kept:
            rows.append({
                "id": f["id"], "size": f.get("size"),
                "tiers": f.get("tiers", []),
                "first_member": f.get("first_member", ""),
                "state": "unresolved", "rehydrated": True,
                "rejected": rejected, "kept": kept,
            })
    rows.sort(key=lambda r: (-r["rejected"], r["id"]))
    return rows


# ---- ghost states (2026-10-09f): members whose files left the dupe roots ----
# Kept files were promoted into the Library; rejected files were purged. A
# family whose members are ALL gone renders as blank thumbs. Resolution uses
# EXISTING signals only — the library index (promoted_from paths) plus
# os.path.exists-equivalent stats on the dupe roots — cached per server
# session; no hashing, no re-walks per render.

_GHOST_TTL = float(os.environ.get("ELLIEEDIT_GHOST_TTL", "60"))
                                   # seconds an exists lookup stays fresh
                                   # (probe env shortens it; /mnt stats are
                                   # the thing this router defends against)
_exists_cache: dict[str, tuple[float, bool]] = {}  # rel path -> (ts, on disk)
_library_cache: tuple[float, dict] | None = None   # (index mtime, promoted_from -> rec)
_ghost_cache: tuple[str, dict] | None = None       # (index:ledger key, per-family states)


def _il_key() -> str:
    """index:ledger mtime key — the cache key /status, /families and
    /death-row already agree on. Paths included so different roots (test
    tmp dirs) never share a cache entry on matching mtimes."""
    try:
        idx_mt = (DUPE_DATA / "index.json").stat().st_mtime
    except OSError:
        idx_mt = 0.0
    try:
        led_mt = float(LEDGER.stat().st_mtime)
    except OSError:
        led_mt = 0.0
    return f"{DUPE_DATA}:{LEDGER}:{idx_mt}:{led_mt}"


def _library_lookup() -> dict:
    """promoted_from path -> library record, cached on the index mtime.
    Unreadable/absent index -> empty map (everything resolves 'deleted')."""
    global _library_cache
    from .library import index_path, read_index
    ip = index_path()
    try:
        mt = ip.stat().st_mtime
    except OSError:
        mt = -1.0
    ck = f"{ip}:{mt}"          # path in the key: tmp roots must not collide
    if _library_cache and _library_cache[0] == ck:
        return _library_cache[1]
    out: dict[str, dict] = {}
    try:
        for rec in read_index():
            src = (rec.get("promoted_from") or "").replace("\\", "/")
            if src and not rec.get("deleted_soon"):
                out.setdefault(src, rec)
    except Exception as e:            # never let the listing die on the lookup
        log.warning("library index unreadable for ghost resolution: %s", e)
    _library_cache = (ck, out)
    return out


def _member_on_disk(rel: str) -> bool:
    """TTL-cached existence probe (one stat per path per _GHOST_TTL, not per
    render — /mnt stats are the thing this whole router defends against)."""
    now = time.monotonic()
    hit = _exists_cache.get(rel)
    if hit and now - hit[0] < _GHOST_TTL:
        return hit[1]
    try:
        ok = jailed(rel).is_file()
    except HTTPException:
        ok = False
    _exists_cache[rel] = (now, ok)
    return ok


def _member_state(rel: str, verdict: str | None) -> str:
    """'disk' | 'library' | 'deleted' for one member path. Library wins over
    deleted ONLY on an index hit — absence alone never claims a promotion."""
    if _member_on_disk(rel):
        return "disk"
    if rel in _library_lookup():
        return "library"
    return "deleted"


def _death_ghosts(verdicts: dict, idx: dict) -> dict:
    """fid -> {on_disk: n, states: {rel: state}} for every majority-rejected
    family, cached on the index:ledger key (one family-file read + one cached
    stat per member per key — the same cost class /death-row already pays)."""
    global _ghost_cache
    key = _il_key()
    if _ghost_cache and _ghost_cache[0] == key:
        return _ghost_cache[1]
    out: dict[str, dict] = {}
    for r in _death_row_rows(verdicts, idx):
        fid = r["id"]
        try:
            fam = json.loads(_family_path(fid).read_text())
        except (OSError, json.JSONDecodeError, HTTPException):
            continue
        vmap = (verdicts.get(fid, {}).get("members") or {})
        states: dict[str, str] = {}
        on_disk = 0
        for m in fam.get("members", []):
            rel = m["path"].replace("\\", "/")
            st = _member_state(rel, vmap.get(rel))
            states[rel] = st
            if st == "disk":
                on_disk += 1
        out[fid] = {"on_disk": on_disk, "states": states}
    _ghost_cache = (key, out)
    return out

# Slow-storage defenses: the canonical tree lives on /mnt (10-100x slower
# than local disk), so every hot endpoint serves from mtime-keyed caches and
# never walks or stats the tree per request.
_STATUS_TTL = 60.0            # seconds a cached /status payload stays fresh
_FRESHNESS_TTL = 600.0        # seconds between /mnt freshness walks
_status_cache: tuple[float, str, str, dict] | None = None  # (key, ts, freshness, payload)
_freshness_cache: tuple[str, float, str] | None = None      # (idx_key, ts, freshness)
_preview_cache: dict[str, tuple[float, list[dict]]] = {}    # fid -> (fam mtime, members)
_jail_cache: dict[str, bool] = {}                           # rel path -> jailed?

router = APIRouter(prefix="/api/dupe", tags=["dupe"])


def jailed(rel: str) -> Path:
    """Allowlist jail (2026-10-09h): relative paths resolve under DUPE_ROOT
    (as before — no absolute, ~, .., symlink escapes, directories). Absolute
    paths are accepted ONLY if they resolve under one of the DUPE_MEMBER_ROOTS
    realpaths — straggler-scan families link members outside the dupe root.
    Symlinks are resolved before the containment check, so a link escaping an
    allowlisted root is rejected. """
    rel = (rel or "").replace("\\", "/")  # family files store windows-ish paths
    if not rel or rel.startswith("~") or ".." in rel.split("/"):
        raise HTTPException(400, "path escapes dupe root")
    if not Path(rel).is_absolute():
        # relative: old behavior — must physically resolve under DUPE_ROOT
        candidate = (DUPE_ROOT / rel.lstrip("/")).resolve()
        roots = [DUPE_ROOT]
    else:
        candidate = Path(rel).resolve()
        roots = [r for r in DUPE_MEMBER_ROOTS if r != DUPE_ROOT] + [DUPE_ROOT]
    for r in roots:
        root_real = r.resolve()
        if candidate != root_real and root_real in candidate.parents:
            return candidate
    raise HTTPException(400, "path escapes dupe root")


# ---------------------------------------------------------------- index load

def _index() -> dict:
    idx = DUPE_DATA / "index.json"
    if not idx.is_file():
        raise HTTPException(404, "no dupe index — run a dupescan first")
    try:
        data = json.loads(idx.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(500, f"dupe index unreadable: {e}")
    if not isinstance(data, dict) or not isinstance(data.get("families"), list):
        raise HTTPException(500, "dupe index malformed")
    return data


def _family_path(fid: str) -> Path:
    if not FAMILY_ID_RE.match(fid):
        raise HTTPException(400, "bad family id")
    p = DUPE_DATA / "families" / f"{fid}.json"
    if not p.is_file():
        raise HTTPException(404, "no such family")
    return p


def _load_family(fid: str) -> dict:
    try:
        return json.loads(_family_path(fid).read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(500, f"family unreadable: {e}")


def _history() -> dict[str, list[dict]]:
    """family_id -> ALL ledger entries, oldest first (append-only history).
    Torn/invalid lines are skipped; last entry per family wins elsewhere."""
    out: dict[str, list[dict]] = {}
    try:
        with LEDGER.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(e, dict) and e.get("family"):
                    out.setdefault(e["family"], []).append(e)
    except FileNotFoundError:
        pass
    except OSError as e:
        log.warning("dupe ledger unreadable: %s", e)
    return out


def _verdicts() -> dict:
    """family_id -> latest ledger entry. Ledger is append-only; last wins."""
    out = {}
    try:
        with LEDGER.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue  # torn last line: ignore, keep going
                if isinstance(e, dict) and e.get("family"):
                    fam = e["family"]
                    if (e.get("death_row_dismissed") and not e.get("members")
                            and fam in out):
                        # Dismissal tombstone (Task 4): carries NO verdict
                        # map, so it must not replace the real latest
                        # verdict — it only flags it. The next real entry
                        # (commit / re-open) replaces the whole record and
                        # the flag with it.
                        out[fam] = {**out[fam], "death_row_dismissed": True}
                    else:
                        out[fam] = e
    except FileNotFoundError:
        pass
    except OSError as e:
        log.warning("dupe ledger unreadable: %s", e)
    return out


def _family_state(fid: str, verdicts: dict | None = None) -> str:
    """THE single source of truth for resolved-vs-unresolved (queue-hardening
    invariant, 2026-10-20): a family with a resolved record OR a dismiss
    tombstone is "resolved" and appears in NO actionable queue. Every listing,
    count and status number must go through here — never re-derive it."""
    v = (verdicts if verdicts is not None else _verdicts()).get(fid)
    if not v:
        return "unresolved"
    if v.get("death_row_dismissed"):
        return "resolved"      # tombstone = retired; only a real entry revives it
    members = v.get("members") or {}
    if not members or all(x == "deferred" for x in members.values()):
        # deferral is a note, not a decision; an empty map is a re-open
        # draft entry (Task 4) — the family is back in the review queue
        return "unresolved"
    return "resolved"


def _member_view(m: dict) -> dict:
    """Family member -> client shape (jailed path, thumb URL, verdict slot)."""
    rel = m["path"].replace("\\", "/")
    return {
        "path": rel,
        "name": Path(rel).name,
        "size": m.get("size"),
        "mtime": m.get("mtime"),
        "dhash": m.get("dhash"),
        "phash": m.get("phash"),
        "thumb": f"/api/dupe/thumb?path={quote(rel, safe='')}",
    }


def _fingerprint(v: dict, p: Path) -> dict:
    """Append an mtime-size fingerprint to a thumb URL (2026-10-08n) so the
    browser/SW can cache thumbs immutably — the URL itself proves content.
    The stat here piggybacks on the existence check the caller already paid
    for; no extra /mnt round-trip."""
    try:
        st = p.stat()
        v["thumb"] += f"&v={int(st.st_mtime)}-{st.st_size}"
    except OSError:
        v["thumb"] = None
        v["exists"] = False
    return v


def _preview_member(m: dict) -> dict:
    """ONE resolution pass per member (2026-10-08n): cheap jail string check,
    then a single jailed()+stat that doubles as the missing-file check AND
    the thumb fingerprint source. Replaces _missing_member's separate
    resolve for the listing path."""
    v = _member_view(m)
    if _jailed_cheap(v["path"]):
        v["thumb"] = None
        v["jailed"] = True
        v["exists"] = False
        return v
    try:
        p = jailed(v["path"])
        if not p.is_file():
            v["thumb"] = None
            v["exists"] = False
        else:
            _fingerprint(v, p)
    except HTTPException:
        v["thumb"] = None
        v["jailed"] = True
        v["exists"] = False
    return v


def _missing_member(v: dict) -> dict:
    """Null the thumb of a member whose file vanished (confirmed deletes
    leave stale family entries; a dead thumb URL logs a 404 console error
    on every render). Marks exists=False so the client skips it."""
    try:
        if not jailed(v["path"]).is_file():
            v["thumb"] = None
            v["exists"] = False
    except HTTPException:
        pass
    return v


def _jailed_cheap(rel: str) -> bool:
    """String-level jail check for LISTING paths — no /mnt stat per member.
    Full resolve-based jail stays in jailed() for anything actually opened."""
    hit = _jail_cache.get(rel)
    if hit is not None:
        return hit
    if not rel or rel.startswith("~") or ".." in rel.split("/"):
        bad = True
    elif rel.startswith("/"):
        # absolute: allowlisted member roots only (string-prefix fast path;
        # the full resolve-based jail stays in jailed())
        bad = not any(
            rel == str(r) or rel.startswith(str(r).rstrip("/") + "/")
            for r in DUPE_MEMBER_ROOTS)
    else:
        bad = False
    _jail_cache[rel] = bad
    return bad


# ----------------------------------------------------------------- endpoints

@router.get("/status")
def status():
    global _status_cache, _freshness_cache
    try:
        idx = _index()
    except HTTPException as e:
        return {"indexed": False, "root": str(DUPE_ROOT), "detail": e.detail}
    idx_path = DUPE_DATA / "index.json"
    idx_mtime = idx_path.stat().st_mtime
    try:
        ledger_mtime = LEDGER.stat().st_mtime
    except OSError:
        ledger_mtime = 0.0
    key = f"{idx_mtime}:{ledger_mtime}"
    now = time.monotonic()
    if _status_cache and _status_cache[0] == key and now - _status_cache[1] < _STATUS_TTL:
        return _status_cache[3]

    fams = idx["families"]
    verdicts = _verdicts()
    resolved = sum(1 for f in fams if _family_state(f["id"], verdicts) == "resolved")

    # Freshness: newest image mtime under the root — expensive on slow
    # storage, so it runs at most once per _FRESHNESS_TTL (or index change)
    # and the payload never waits on it after the first walk.
    if _freshness_cache and _freshness_cache[0] == key:
        _, ts, freshness = _freshness_cache
    else:
        ts, freshness = 0.0, None
    if freshness is None or now - ts >= _FRESHNESS_TTL:
        freshness = _freshness_walk(idx_mtime)
        _freshness_cache = (key, now, freshness)
    payload = {
        "indexed": True,
        "root": str(DUPE_ROOT),
        "families": len(fams),
        "members": sum(f.get("size", 0) for f in fams),
        "resolved": resolved,
        "unresolved": len(fams) - resolved,
        "index_generated": idx.get("generated"),
        "index_age_s": int(time.time() - idx_mtime),
        "key": key,
        "freshness": freshness,
        "ledger": str(LEDGER),
        "scan_hint": (
            f"cd {DUPELIB_PATH} && PYTHONPATH=. python3 -m dupelib.cli analyze "
            f"\"{DUPE_ROOT}\"  # full scans are fastest from the Windows side"),
    }
    _status_cache = (key, now, freshness, payload)
    return payload


def _freshness_walk(idx_mtime: float) -> str:
    """Walk the dupe root for the newest image mtime with a time budget, so a
    slow network mount can't wedge the endpoint. Budget blown => honest
    "unknown" rather than a stale claim. Called at most once per TTL."""
    newest = None
    complete = True
    budget = time.monotonic() + 4.0
    stack = [DUPE_ROOT]
    while stack:
        d = stack.pop()
        try:
            for e in os.scandir(d):
                if time.monotonic() > budget:
                    complete = False
                    stack = []
                    break
                if e.name.startswith(".") or e.is_symlink():
                    continue
                try:
                    if e.is_dir():
                        stack.append(e.path)
                    elif e.is_file():
                        m = e.stat().st_mtime
                        if newest is None or m > newest:
                            newest = m
                except OSError:
                    continue
        except OSError:
            continue
    if newest is None:
        return "no-images"
    if not complete:
        return "unknown (walk budget exceeded)"
    return ("fresh" if newest <= idx_mtime
            else f"stale — {int(newest - idx_mtime)}s of images newer than index")


def _family_preview(fid: str) -> list[dict]:
    """First members of a family in client shape, mtime-cached so repeat
    listings cost zero family-file reads and zero /mnt stats."""
    p = _family_path(fid)
    try:
        mt = p.stat().st_mtime
    except OSError:
        mt = -1.0
    hit = _preview_cache.get(fid)
    # TTL: a confirmed delete removes member files WITHOUT touching the
    # family file, so mtime alone would cache dead thumbs indefinitely.
    # 60s (2026-10-08n, was 10s): the per-refresh cost is one stat per
    # member on /mnt; the client-side list cache makes tab returns free
    # regardless, so this bounds stale-missing exposure without re-walking
    # 40 cards' members every few seconds.
    if hit and hit[0] == mt and time.time() - hit[1] < 60:
        return [dict(m) for m in hit[2]]
    try:
        fam = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(500, f"family unreadable: {e}")
    members = [_preview_member(m) for m in fam.get("members", [])[:6]]
    # Straggler families (2026-10-09g): members with a library match get the
    # ghost-chip shape (member_state='library' + the library rel path) so the
    # client renders the existing read-only '✓ in Library' reference. The
    # library file itself is never served or touched.
    if fam.get("source") == "straggler-scan":
        by_path = {m.get("path"): m for m in fam.get("members", [])}
        for v in members:
            ref = (by_path.get(v["path"]) or {}).get("library_match")
            if ref:
                v["member_state"] = "library"
                v["library_path"] = ref.get("library_path", "")
    _preview_cache[fid] = (mt, time.time(), members)
    return [dict(m) for m in members]


# ------------------------------------------------ straggler scan (2026-10-09g)
# Import front door: near-dupe families from files the canonical scan never
# indexed. Engine lives in backend/dupe_scan.py; this router owns the HTTP
# surface: a POST that runs inline (probe/tests, small roots) or in a
# background thread (the real 6k+ /mnt pool), a status endpoint, and the
# 'source' filter on /families. The ledger stays read-only from the scan.

_straggler_lock = threading.Lock()
_straggler_state: dict = {"running": False, "progress": None, "last": None}


class StragglerBody(BaseModel):
    background: bool = False
    roots: list[str] | None = None          # default: DupeReview + gather staging
    library_limit: int = 0                  # probe knob: cap library hashing
    # inc.3: "v1" (default, unchanged straggler scan) | "v2" (incremental
    # cluster engine only) | "both" (v1 then the v2 supplementary pass).
    engine: str = "v1"


def _proposal_decisions(verdicts: dict | None = None) -> dict[str, str]:
    """{proposal_family_id: merge|separate|rejected} for proposal families the
    operator has RULED on. Resolution goes through _family_state (the sole
    resolver); only the verb mapping lives here. melded = merge into the
    proposed family; kept = stays its own family (separate); rejected = the
    new file is a discard, not a merge."""
    verdicts = verdicts if verdicts is not None else _verdicts()
    out: dict[str, str] = {}
    try:
        rows = _index().get("families", [])
    except HTTPException:
        return out
    for f in rows:
        if not f.get("proposed_merge") or f.get("source") != "cluster-engine-v2":
            continue
        if _family_state(f["id"], verdicts) != "resolved":
            continue
        vals = set((verdicts.get(f["id"], {}).get("members") or {}).values())
        out[f["id"]] = ("merge" if "melded" in vals
                        else "separate" if "kept" in vals else "rejected")
    return out


def _run_cluster_v2(roots: list[dict]) -> dict:
    """v2 incremental pass. Ledger knowledge is read HERE and handed to the
    engine as plain data; the engine itself never touches the ledger."""
    from backend import cluster_engine as ce
    from backend import dupe_scan as engine
    merged = ce.apply_decisions(DUPE_ROOT, DUPE_DATA, _proposal_decisions())
    skip = engine.ledger_paths(LEDGER, DUPE_ROOT)
    out = ce.scan_incremental(
        roots, DUPE_ROOT, DUPE_DATA, skip_paths=skip,
        progress=lambda p: _straggler_state.update(progress=p))
    out["merged"] = merged["merged"]
    return out


@router.post("/scan-stragglers")
def scan_stragglers_ep(body: StragglerBody):
    from backend import dupe_scan as engine
    from .library import LIBRARY_ROOT
    if not _straggler_lock.acquire(blocking=False):
        raise HTTPException(409, "a straggler scan is already running")
    _straggler_lock.release()
    if _straggler_state["running"]:
        raise HTTPException(409, "a straggler scan is already running")
    roots = ([{"label": f"root{i}", "root": r} for i, r in enumerate(body.roots)]
             if body.roots else [
                 {"label": "dupe", "root": str(DUPE_ROOT),
                  "exclude_dirs": {".dupes"}},
                 {"label": "gather", "root": engine.DEFAULT_GATHER_ROOT}])

    def run():
        _straggler_state.update(running=True, progress=None, last=None)
        try:
            summary = {}
            if body.engine in ("v1", "both"):
                summary = engine.scan_stragglers(
                    roots, DUPE_ROOT, DUPE_DATA, LEDGER, Path(LIBRARY_ROOT),
                    library_limit=body.library_limit,
                    progress=lambda p: _straggler_state.update(progress=p))
            if body.engine in ("v2", "both"):
                summary["v2"] = _run_cluster_v2(roots)
            _straggler_state["last"] = summary
        except Exception as e:
            log.exception("straggler scan failed")
            _straggler_state["last"] = {"error": str(e)}
        finally:
            _straggler_state["running"] = False
            _straggler_state["progress"] = None

    if body.background:
        threading.Thread(target=run, daemon=True, name="straggler-scan").start()
        return {"started": True, "background": True,
                "status": "/api/dupe/scan-stragglers/status"}
    run()
    last = _straggler_state["last"] or {}
    if "error" in last:
        raise HTTPException(500, f"straggler scan failed: {last['error']}")
    return {"started": False, "summary": last}


@router.get("/scan-stragglers/status")
def scan_stragglers_status():
    return dict(_straggler_state)


@router.get("/families")
def families(state: str = "unresolved", cursor: str = "",
             offset: int = 0, limit: int = 0,
             include_archived: int = 0, source: str = ""):
    if state == "committed":
        state = "resolved"   # lifecycle-view name for the same ledger state
    if state not in ("unresolved", "resolved", "all"):
        raise HTTPException(
            400, "state must be unresolved|committed|resolved|all")
    idx = _index()
    verdicts = _verdicts()
    rows = []
    for f in idx["families"]:
        st = _family_state(f["id"], verdicts)
        if state != "all" and st != state:
            continue
        rows.append({
            "id": f["id"],
            "size": f.get("size"),
            "tiers": f.get("tiers", []),
            "first_member": f.get("first_member", ""),
            "state": st,
            # straggler provenance (2026-10-09g): import-batch families
            # carry source + a library-match count for the '✓ in Library'
            # reference chip (reference only — never a member).
            "source": f.get("source", ""),
            "library_matches": f.get("library_matches", 0),
            # inc.3: v2 membership proposal pointer (index row only, O(1))
            "proposed_merge": f.get("proposed_merge"),
            # Signal-conflict flag (2026-10-08d): the latest verdict SPLITS
            # members (kept AND rejected) while the index tier list claims a
            # strict near-identity tier exists in the family. O(1) per card
            # — verdicts dict + index rows only, no family-file reads, so the
            # listing stays as cheap as before. Precise per-pair conflicts
            # are computed lazily per-detail in /families/{id}/signals.
            "conflict": (
                bool((verdicts.get(f["id"], {}).get("members") or {}))
                and "kept" in (verdicts[f["id"]].get("members") or {}).values()
                and "rejected" in (verdicts[f["id"]].get("members") or {}).values()
                and bool(STRICT_TIERS & set(f.get("tiers", [])))),
        })
    # Death-row rehydration (2026-10-09b): majority-rejected resolved
    # families ride the normal unresolved queue, appended after the
    # genuinely unresolved ones, biggest-rejected-first. Each is a
    # pre-marked UNCOMMITTED draft client-side (rehydrated flag).
    rehydrated = 0
    archived_hidden = 0
    # Death-row rehydration RETIRED (2026-10-19): this was a one-time helper
    # for a specific review pattern (2026-10-09b) that kept re-lighting
    # committed families in the unresolved queue forever. Committed stays
    # committed; a family is only listed here if it is genuinely unresolved.
    if False and state == "unresolved":
        dh = _death_row_rows(verdicts, idx)
        have = {r["id"] for r in rows}
        dh = [r for r in dh if r["id"] not in have]
        # Ghost states (2026-10-09f): families with ZERO members still on
        # disk are hidden from the default list (include_archived=1 reveals
        # them). No ledger writes — resolution is read-only signals.
        ghosts = _death_ghosts(verdicts, idx)
        for r in dh:
            g = ghosts.get(r["id"], {})
            r["on_disk"] = g.get("on_disk", 0)
            r["archived"] = r["on_disk"] == 0
        archived_hidden = sum(1 for r in dh if r["archived"])
        if not include_archived:
            dh = [r for r in dh if not r["archived"]]
        rows = rows + dh
        rehydrated = len(dh)
    # QUEUE INVARIANT (2026-10-20): the unresolved queue holds ONLY families
    # whose state is "unresolved". This guard runs after every row source (the
    # retired rehydration block above included) so no future path can leave a
    # resolved/tombstoned family lingering here while counts say otherwise.
    if state == "unresolved":
        rows = [r for r in rows
                if _family_state(r["id"], verdicts) == "unresolved"]
    # Straggler import-batch filter (2026-10-09g): source=straggler narrows
    # to provenance-marked families before pagination/death-row handling.
    # 'straggler' is accepted as the client shorthand for the full marker.
    if source == "straggler":
        source = "straggler-scan"
    if source:
        rows = [r for r in rows if r.get("source") == source]
    start = 0
    if cursor:
        try:
            start = next(i + 1 for i, r in enumerate(rows) if r["id"] == cursor)
        except StopIteration:
            raise HTTPException(400, "bad cursor")
    # Cheap offset/limit params (2026-10-08m, twin loop step 4): lets a
    # client walk the listing without holding cursors. Non-negative ints;
    # limit=0 keeps the default page size.
    if offset < 0:
        raise HTTPException(400, "offset must be >= 0")
    start = max(start, offset)
    size = limit if limit > 0 else PAGE_SIZE
    page = rows[start:start + size]
    # states for the page loop — one shared cache read, no second walk
    ghosts_by_state = _death_ghosts(verdicts, idx) if state == "unresolved" else {}
    # Thumbnails for the first few members of each card (strip view), served
    # from the per-family preview cache — no family-file reads or /mnt stats
    # when nothing changed on disk.
    for r in page:
        r["members"] = _family_preview(r["id"])
        # Ghost chips (2026-10-09f): rehydrated cards annotate each preview
        # member with its resolved state + historical verdict so the client
        # can chip "✓ in Library" / "already deleted" without extra calls.
        if r.get("rehydrated"):
            vmap = (verdicts.get(r["id"], {}).get("members") or {})
            ghosts = ghosts_by_state.get(r["id"], {})
            states = ghosts.get("states", {})
            for m in r["members"]:
                m["verdict"] = vmap.get(m["path"])
                m["member_state"] = states.get(m["path"], "disk")
    total_all = len(idx["families"])
    if source:
        total_all = sum(1 for f in idx["families"]
                        if f.get("source", "") == source)
    next_cursor = page[-1]["id"] if page and start + size < len(rows) else None
    counts = {"unresolved": 0, "resolved": 0}
    for f in idx["families"]:
        if source and f.get("source", "") != source:
            continue
        counts[_family_state(f["id"], verdicts)] += 1
    # Cache key (2026-10-08n): index+ledger mtimes. Clients hold the listing
    # in memory keyed by this and skip the refetch on tab return when both
    # are unchanged (same key /status exposes).
    try:
        idx_mt = (DUPE_DATA / "index.json").stat().st_mtime
    except OSError:
        idx_mt = 0.0
    try:
        key = f"{idx_mt}:{float(LEDGER.stat().st_mtime)}"
    except OSError:
        key = f"{idx_mt}:0.0"
    return {"items": page, "next_cursor": next_cursor,
            "counts": counts, "total": total_all, "key": key,
            "rehydrated": rehydrated, "archived_hidden": archived_hidden}


def _death_row_stats(idx: dict) -> tuple[list[dict], dict, float, bool]:
    """(rows with rejected_files/bytes, ghosts, walk_ms, cached). The first
    call after an index/ledger change stats every rejected member on /mnt;
    walk_ms/stat count are logged and surfaced so that cost is visible."""
    global _death_row_cache
    try:
        idx_mt = (DUPE_DATA / "index.json").stat().st_mtime
    except OSError:
        idx_mt = 0.0
    try:
        key = f"{idx_mt}:{float(LEDGER.stat().st_mtime)}"
    except OSError:
        key = f"{idx_mt}:0.0"
    if _death_row_cache and _death_row_cache[0] == key:
        return (_death_row_cache[1], _death_ghosts(_verdicts(), idx),
                0.0, True)          # cache-hit read, no re-walk
    t0 = time.monotonic()
    stats = 0
    verdicts = _verdicts()
    rows = []
    for r in _death_row_rows(verdicts, idx):
        fam_verdict = (verdicts.get(r["id"], {}).get("members") or {})
        rejected = [p for p, v in fam_verdict.items() if v == "rejected"]
        files = 0
        nbytes = 0
        for rel in rejected:
            try:
                p = jailed(rel)
                stats += 1
                if not p.is_file():
                    continue
                files += 1
                nbytes += p.stat().st_size
            except HTTPException:
                continue
        rows.append({**r, "rejected_files": files, "rejected_bytes": nbytes})
    rows.sort(key=lambda r: (-r["rejected"], r["id"]))
    _death_row_cache = (key, rows)
    ghosts = _death_ghosts(verdicts, idx)
    walk_ms = (time.monotonic() - t0) * 1000.0
    log.info("death-row walk: %d rows, %d member stats, %.0f ms",
             len(rows), stats, walk_ms)
    return rows, ghosts, walk_ms, False


@router.get("/death-row")
def death_row(include_archived: int = 0):
    """Mass-commit summary: every majority-rejected resolved family with
    honest rejected-file counts AND bytes (stat of each rejected member
    still on disk — same size source the deletion view shows). Cached on
    the index:ledger key; the first walk after a change stats /mnt.
    Rows with ZERO rejected files left on disk are residue: hidden unless
    include_archived=1 (mirrors /families). Dismissed rows never list."""
    idx = _index()
    rows, ghosts, walk_ms, cached = _death_row_stats(idx)
    # Ghost annotation (2026-10-09f): honest on-disk counts per family (all
    # members, not just the still-rejected ones the byte walk stats).
    for r in rows:
        g = ghosts.get(r["id"], {})
        r["on_disk"] = g.get("on_disk", 0)
        r["archived"] = r["on_disk"] == 0
    shown = rows if include_archived else [
        r for r in rows if r["rejected_files"] > 0]
    return {
        "items": shown,
        "families": len(shown),
        "total_files": sum(r["rejected_files"] for r in shown),
        "total_bytes": sum(r["rejected_bytes"] for r in shown),
        "hidden_zero_file": len(rows) - len(shown),
        "walk_ms": round(walk_ms, 1),
        "cached": cached,
    }


class DismissBody(BaseModel):
    families: list[str] = []
    zero_file: bool = False     # also dismiss every row with no files left


@router.post("/death-row/dismiss")
def death_row_dismiss(body: DismissBody):
    """Retire death-row rows (bookkeeping only — nothing unlinks, no
    manifest writes). One append-only ledger tombstone per family; the
    latest-wins reader flags the real latest verdict (see _verdicts), so
    history survives and the next real verdict/re-open revives the family.
    Ids are validated against live death-row membership like commit."""
    live = {r["id"]: r for r in _death_row_stats(_index())[0]}
    targets = list(dict.fromkeys(body.families))
    if not targets and not body.zero_file:
        raise HTTPException(400, "no families")
    bad = [f for f in targets if not FAMILY_ID_RE.match(f) or f not in live]
    if bad:
        raise HTTPException(400, f"not death-row families: {bad[:3]}")
    if body.zero_file:
        targets += [fid for fid, r in live.items()
                    if r["rejected_files"] == 0 and fid not in targets]
    if not targets:
        return {"dismissed": 0}
    ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    lines = "".join(json.dumps(
        {"ts": ts, "family": fid, "death_row_dismissed": True,
         "signal": "dismissed"}, ensure_ascii=False) + "\n"
        for fid in targets)
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as fh:            # append-only by design
        fh.write(lines)
    return {"dismissed": len(targets)}


class DeathRowBody(BaseModel):
    families: list[str]
    expected_files: int | None = None


@router.post("/death-row/commit")
def death_row_commit(body: DeathRowBody, request: Request = None):
    """Mass enqueue: every still-rejected member of the given (validated
    majority-rejected) families -> the EXISTING Pending Delete manifest.
    Nothing unlinks here — /api/pending/confirm stays the only destructive
    endpoint. Missing files (already promoted/pardoned/vanished) are skipped
    and counted, never invented. expected_files is an optimistic guard so a
    stale button label cannot enqueue a different set than confirmed."""
    from .pending import _audit, _load, _save, manifest_lock
    if not body.families:
        raise HTTPException(400, "no families")
    dr = {r["id"]: r for r in _death_row_rows()}
    bad = [f for f in body.families if not FAMILY_ID_RE.match(f) or f not in dr]
    if bad:
        raise HTTPException(400, f"not majority-rejected families: {bad[:3]}")
    verdicts = _verdicts()
    batch: dict[str, str] = {}          # rel path -> family id (dedupe)
    for fid in dict.fromkeys(body.families):
        for p, v in (verdicts.get(fid, {}).get("members") or {}).items():
            if v == "rejected":
                batch.setdefault(p.replace("\\", "/"), fid)
    existing: list[str] = []
    missing = 0
    for rel in batch:
        try:
            p = jailed(rel)
            if not p.is_file():
                missing += 1
                continue
        except HTTPException:
            missing += 1
            continue
        existing.append(rel)
    if body.expected_files is not None and len(existing) != body.expected_files:
        raise HTTPException(
            409, f"death row changed — {len(existing)} files on disk, "
                 f"button showed {body.expected_files}")
    with manifest_lock:
        m = _load()
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        added = already = 0
        added_keys: list[str] = []
        for rel in existing:
            try:
                key = jailed(rel).resolve().relative_to(
                    _gallery_mod.GALLERY_ROOT.resolve()).as_posix()
            except (HTTPException, OSError, ValueError):
                key = rel  # dupe-pool-only member: keep dupe-relative key
            if key not in m:
                m[key] = now
                added += 1
                added_keys.append(key)
            else:
                already += 1
        _save(m)
    _audit("death_row_commit", added_keys, request)
    return {"added": added, "already_pending": already, "missing": missing,
            "count": len(m), "families": len(set(body.families)),
            "bytes": sum(jailed(rel).stat().st_size for rel in existing
                         if jailed(rel).is_file())}


@router.get("/families/{fid}")
def family_detail(fid: str):
    fam = _load_family(fid)
    verdicts = _verdicts()
    members = []
    # Single resolution pass (2026-10-08n): ONE jailed()+stat per member —
    # the old code resolved every member twice (explicit jail +
    # _missing_member's own resolve), doubling /mnt latency on this path.
    for m in fam.get("members", []):
        v = _member_view(m)
        try:
            p = jailed(v["path"])
        except HTTPException:
            v["thumb"] = None
            v["jailed"] = True
            v["exists"] = False
        else:
            if p.is_file():
                _fingerprint(v, p)
                if "exists" not in v:
                    v["exists"] = True
            else:
                v["thumb"] = None
                v["exists"] = False
        members.append(v)
    # Ghost states (2026-10-09f): detail members carry their resolved state
    # + historical verdict so chips render there too (read-only signals).
    vmap = (verdicts.get(fid, {}).get("members") or {})
    for v in members:
        v["verdict"] = vmap.get(v["path"])
        v["member_state"] = _member_state(v["path"], v["verdict"])
    fam_verdict = verdicts.get(fid, {})
    note = fam_verdict.get("note", "")
    if not note:
        # carry the last note any verdict left on this family
        try:
            for line in reversed(LEDGER.read_text().splitlines()):
                e = json.loads(line)
                if e.get("family") == fid and e.get("note"):
                    note = e["note"]
                    break
        except (OSError, json.JSONDecodeError, FileNotFoundError):
            pass
    return {
        "id": fam.get("id", fid),
        "created": fam.get("created"),
        "root": str(DUPE_ROOT),
        "state": _family_state(fid, verdicts),
        # Death-row rehydration (2026-10-09b): a majority-rejected resolved
        # family detail carries the flag so the client treats the historical
        # verdict map as the CURRENT UNCOMMITTED DRAFT (normal zoom/commit
        # flow) instead of the read-only committed view.
        "rehydrated": fid in {r["id"] for r in _death_row_rows(verdicts)},
        # Lifecycle (Task 4): tombstone flag + re-open draft marker; a
        # re-opened family hands back the last DECIDED verdict map so the
        # client can seed the new draft (history itself is never edited).
        "dismissed": bool(fam_verdict.get("death_row_dismissed")),
        "reopened": bool(fam_verdict.get("reopened")),
        "prior_verdicts": _prior_decided(fid) if fam_verdict.get("reopened") else {},
        "members": [{k: v for k, v in m.items() if k != "_p"} for m in members],
        "edges": fam.get("edges", []),
        "proposed_merge": _proposal_detail(fam),
        "related": [
            {"family": r.get("related_family"), "tier": r.get("tier"),
             "distance": r.get("distance")}
            for r in fam.get("related", []) if r.get("related_family")
        ],
        "verdict": fam_verdict.get("members", {}),
        "note": note,
        "meld": _latest_meld(fid),
        "verdicts": {m["path"]: fam_verdict.get("members", {}).get(m["path"])
                     for m in members},
    }


def _proposal_detail(fam: dict) -> dict | None:
    """Proposal annotation + a client-shaped matched-member view so the UI can
    render the side-by-side without a second lookup. None for plain families."""
    pm = fam.get("proposed_merge")
    if not pm:
        return None
    out = dict(pm)
    mp = str(pm.get("matched_member", "")).replace("\\", "/")
    if mp:
        out["matched"] = _member_view({"path": mp})
        try:
            jailed(mp)
        except HTTPException:
            out["matched"]["thumb"] = None
    return out


def _prior_decided(fid: str) -> dict:
    """members map of the newest ledger entry that actually decided
    something (kept/rejected) — what a re-opened family was committed as."""
    for e in reversed(_history().get(fid, [])):
        m = e.get("members") or {}
        if any(v in ("kept", "rejected") for v in m.values()):
            return m
    return {}


@router.post("/families/{fid}/reopen")
def reopen_family(fid: str):
    """Re-open a committed family for review: appends ONE new draft entry
    (empty verdict map, reopened flag). Ledger stays append-only — the old
    verdict entries are untouched and still readable; latest-wins puts the
    family back in the unresolved queue."""
    _load_family(fid)  # 400/404
    if _family_state(fid) != "resolved":
        raise HTTPException(409, "family is not committed")
    entry = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "family": fid, "members": {}, "reopened": True,
    }
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as fh:            # append-only by design
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"ok": True, "state": _family_state(fid)}


STRICT_TIERS = {"exact", "pixel-identical", "near-identical"}


def _edge_members(ed: dict, members: list[str]) -> tuple[str, str] | None:
    """Edge -> (path_a, path_b) against a normalized member list. Real family
    files index members by position; the test fixtures (and possibly older
    trees) use paths. Accept both; anything unresolvable -> None."""
    out = []
    for k in ("a", "b"):
        v = ed.get(k)
        if isinstance(v, bool):
            return None
        if isinstance(v, int) and 0 <= v < len(members):
            out.append(members[v])
        elif isinstance(v, str):
            n = v.replace("\\", "/")
            if n not in members:
                return None
            out.append(n)
        else:
            return None
    return (out[0], out[1]) if len(out) == 2 and out[0] != out[1] else None


def _signals(fam: dict, history: list[dict]) -> dict:
    """Verdict-history signals for one family. READ-ONLY: nothing here
    touches files or the ledger. Duel history is NOT part of this — the
    duel-curator's .duel-curator/state.json does not exist on this host and
    its per-ROOT rel paths are not path-addressable to dupe members, so the
    second curation signal here is the operator's prior verdict history."""
    members = [m["path"].replace("\\", "/") for m in fam.get("members", [])]
    # Per-member aggregate over the whole append-only history.
    per = {p: {"kept": 0, "rejected": 0, "last": None, "entries": 0}
           for p in members}
    for e in history:
        touched = set()
        for p, v in (e.get("members") or {}).items():
            p = p.replace("\\", "/")
            if p in per and v in ("kept", "rejected"):
                per[p][v] += 1
                per[p]["last"] = v
                touched.add(p)
        for p in touched:
            per[p]["entries"] += 1
    latest = history[-1] if history else None

    # Pair conflicts: a strict hash edge (pixel-identical/exact/near-identical)
    # whose endpoints carry DISAGREEING last verdicts — the human split what
    # the hashes call the same picture.
    conflicts = []
    conflict_members: set[str] = set()
    for ed in fam.get("edges", []):
        if ed.get("tier") not in STRICT_TIERS:
            continue
        pair = _edge_members(ed, members)
        if not pair:
            continue
        a, b = pair
        la, lb = per[a]["last"], per[b]["last"]
        if la and lb and la != lb:
            conflicts.append({
                "a": a, "b": b, "tier": ed.get("tier"),
                "detail": f"verdict history favors {a} ({la}) over {b} ({lb}) "
                          f"but hashes call them {ed.get('tier')}",
            })
            conflict_members.update(pair)

    # Suggestion — ONLY on strong agreement, never applied automatically:
    # the last DECIDED entry kept exactly one member and rejected the rest,
    # every kept↔rejected pair the family has an edge for is a strict tier,
    # AND the family is back in review (latest entry missing or all-deferred).
    # A decided latest entry means the family is resolved/committed, where
    # Apply has no draft to fill — the suggestion belongs to the re-review.
    suggestion = None
    latest_decided = None
    for e in reversed(history):
        if any(v in ("kept", "rejected")
               for v in (e.get("members") or {}).values()):
            latest_decided = e
            break
    latest_all_deferred = (
        latest is not None and bool(latest.get("members"))
        and all(v == "deferred" for v in latest["members"].values()))
    in_review = history and (latest is None or latest_all_deferred)
    if latest_decided and in_review and not conflicts:
        lm = {p.replace("\\", "/"): v
              for p, v in (latest_decided.get("members") or {}).items()
              if v in ("kept", "rejected")}
        keeps = [p for p in members if lm.get(p) == "kept"]
        rejects = [p for p in members if lm.get(p) == "rejected"]
        if len(keeps) == 1 and rejects:
            k = keeps[0]
            # Suppressed above when any strict kept↔rejected edge contradicts
            # the split — strong disagreement shows the disagreement instead
            # of a suggestion (design rule: never fuse, never auto-apply).
            # Apply only fills the DRAFT; nothing persists until Commit.
            suggestion = {
                "keep": k,
                "reject": rejects,
                "label": f"keep {Path(k).name}, reject rest",
                "history_entries": len(history),
            }

    return {
        "members": per,
        "conflicts": conflicts,
        "conflict": bool(conflicts),
        "conflict_members": sorted(conflict_members),
        "suggestion": suggestion,
        "history_entries": len(history),
        "duel_history": "unavailable — no path-addressable duel record exists",
    }


@router.get("/families/{fid}/signals")
def family_signals(fid: str):
    """Lazy per-detail signal computation — never on the listing path."""
    fam = _load_family(fid)
    return _signals(fam, _history().get(fid, []))


class SignalEventBody(BaseModel):
    family: str
    event: str
    detail: str = ""


@router.post("/signals/event")
def signal_event(body: SignalEventBody):
    """Suggestion/conflict telemetry: shown / applied / dismissed / override.
    Append-only JSONL, gitignored — manual overrides are calibration data
    (spec: 'every manual override of a signal's suggestion is data')."""
    if not FAMILY_ID_RE.match(body.family):
        raise HTTPException(400, "bad family id")
    if body.event not in SIGNAL_EVENTS:
        raise HTTPException(400, f"event must be one of {sorted(SIGNAL_EVENTS)}")
    entry = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "family": body.family,
        "event": body.event,
        "detail": body.detail[:500],
    }
    SIGNALS_LOG.parent.mkdir(parents=True, exist_ok=True)
    with SIGNALS_LOG.open("a") as fh:      # append-only by design
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"ok": True}


class VerdictBody(BaseModel):
    members: dict[str, str]          # path -> kept|rejected|melded|deferred
    note: str = ""
    # ADDITIVE (2026-10-08c, Sift): optional path -> 1-based pick rank. The
    # members verdict stays a plain string; readers must tolerate ranks being
    # absent on any entry (older ledger lines never carry it).
    ranks: dict[str, int] = {}


@router.post("/families/{fid}/verdict")
def post_verdict(fid: str, body: VerdictBody):
    fam = _load_family(fid)  # 404 on unknown family
    known = {m["path"].replace("\\", "/") for m in fam.get("members", [])}
    clean = {}
    for path, verdict in body.members.items():
        rel = path.replace("\\", "/")
        if rel not in known:
            raise HTTPException(400, f"path not a family member: {path}")
        if verdict not in VERDICTS:
            raise HTTPException(400, f"verdict must be one of {sorted(VERDICTS)}")
        clean[rel] = verdict
    if not clean:
        raise HTTPException(400, "empty verdict set")
    clean_ranks: dict[str, int] = {}
    for path, rank in (body.ranks or {}).items():
        rel = path.replace("\\", "/")
        if rel not in clean:
            raise HTTPException(400, f"rank path not in verdict members: {path}")
        if not isinstance(rank, int) or rank < 1:
            raise HTTPException(400, "ranks must be 1-based positive ints")
        clean_ranks[rel] = rank
    entry = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "family": fid,
        "members": clean,
        "note": body.note,
    }
    if clean_ranks:
        entry["ranks"] = clean_ranks   # additive; absent on non-sift verdicts
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as fh:            # append-only by design
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    if fam.get("proposed_merge"):
        # inc.3: a ruled proposal materialises immediately (melded = merge).
        # Best effort — the verdict is already durably in the ledger.
        try:
            from backend import cluster_engine as _ce
            _ce.apply_decisions(DUPE_ROOT, DUPE_DATA, _proposal_decisions())
        except Exception:
            log.exception("proposal merge apply failed (verdict is recorded)")
    return {"ok": True, "state": _family_state(fid), "entry": entry}


class SendBody(BaseModel):
    id: str


@router.post("/families/{fid}/send-pending")
def send_pending(fid: str, request: Request = None):
    """Convenience: every 'rejected' member of the family's latest verdict ->
    the Pending Delete manifest. Dedupes against already-pending; silently
    skips missing/vanished files. Nothing is deleted here — the pending
    confirm endpoint remains the only destructive action."""
    from .pending import _audit, _load, _save, manifest_lock
    from .gallery import GALLERY_ROOT
    fam_verdict = _verdicts().get(fid)
    if not fam_verdict:
        raise HTTPException(409, "family has no verdict yet")
    rejected = [p for p, v in (fam_verdict.get("members") or {}).items()
                if v == "rejected"]
    if not rejected:
        raise HTTPException(409, "no rejected members in the latest verdict")
    with manifest_lock:
        m = _load()
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        added = skipped = missing = 0
        added_keys: list[str] = []
        for rel in rejected:
            try:
                src = jailed(rel)
                if not src.is_file():
                    missing += 1
                    continue
            except HTTPException:
                missing += 1
                continue
            # The manifest is gallery-root-relative by contract. When the member
            # also lives under GALLERY_ROOT (dupe pool inside the gallery tree),
            # store that form so Gallery badges/confirm work unchanged; members
            # only reachable via the dupe pool keep dupe-relative paths, which
            # pending.confirm resolves through the dupe jail as a fallback.
            key = rel
            try:
                key = src.resolve().relative_to(
                    GALLERY_ROOT.resolve()).as_posix()
            except (OSError, ValueError):
                pass  # dupe pool outside the gallery tree: keep dupe-relative
            if key not in m:
                m[key] = now
                added += 1
                added_keys.append(key)
            else:
                skipped += 1
        _save(m)
    _audit("family_commit_write", added_keys, request)
    return {"added": added, "already_pending": skipped, "missing": missing,
            "count": len(m)}


@router.get("/file")
def file(path: str):
    """FULL-SIZE image, same jail rules as thumb. Stack-spread thumbnails and
    the focus deck must serve real pixels, never the thumbnail file
    (thumb-click-to-thumbnail bug dies here)."""
    EXTS = {".jpg", ".jpeg", ".png", ".webp"}
    src = jailed(path)
    if not src.is_file() or src.suffix.lower() not in EXTS:
        raise HTTPException(404, "not an image")
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
             "png": "image/png", "webp": "image/webp"}[src.suffix.lower()[1:]]
    return FileResponse(src, media_type=media,
                        headers={"Cache-Control": "public, max-age=3600"})


@router.get("/thumb")
def thumb(path: str, v: str = ""):
    EXTS = {".jpg", ".jpeg", ".png", ".webp"}
    src = jailed(path)
    if not src.is_file() or src.suffix.lower() not in EXTS:
        raise HTTPException(404, "not an image")
    try:
        tp = get_thumbnail(src)
    except Exception as e:
        raise HTTPException(500, f"thumbnail failed: {e}")
    # Fingerprinted URLs are content-addressed: immutable caching (2026-10-08n).
    # Unfingerprinted callers keep the old 24h policy.
    cc = ("public, max-age=31536000, immutable" if v
          else "public, max-age=86400")
    return FileResponse(tp, media_type="image/webp",
                        headers={"Cache-Control": cc})


# ------------------------------------------------- background scan (optional)

_scan_proc: subprocess.Popen | None = None


class MeldSaveBody(BaseModel):
    image_b64: str                      # PNG blend, base64 (no data: prefix)
    members: list[str]                  # melded component paths


MELD_MAX = 8


def _latest_meld(fid: str) -> dict | None:
    """Latest ledger meld for this family: {result, members} — or None."""
    for e in reversed(_history().get(fid, [])):
        if e.get("meld_result"):
            return {"result": e["meld_result"],
                    "members": sorted((e.get("members") or {}).keys())}
    return None


@router.post("/families/{fid}/meld-save")
def meld_save(fid: str, body: MeldSaveBody, request: Request = None):
    """FaceCycle 'Save back': write the blend as a NEW auto-named file in the
    gallery root (never overwrites — provenance), record the family ACCEPTED
    (every melded component 'kept') in the ledger, and queue ALL components
    onto the pending-delete manifest immediately (on-the-spot collapse).
    The result file does not re-enter hash scanning. Cancel never calls this,
    so 'nothing persists without Save back' holds by construction."""
    fam = _load_family(fid)  # 404 on unknown family
    known = {m["path"].replace("\\", "/") for m in fam.get("members", [])}
    comps = [p.replace("\\", "/") for p in body.members]
    if not comps:
        raise HTTPException(400, "no meld members")
    if len(comps) > MELD_MAX:
        raise HTTPException(400, f"meld accepts at most {MELD_MAX} members")
    bad = [p for p in comps if p not in known]
    if bad:
        raise HTTPException(400, f"path not a family member: {bad[0]}")
    import base64 as _b64
    # Mask contract C5 (Meld salvage §2): no painted mask crosses this boundary
    # — only the finished blend PNG. Decode is deliberately STRICTER than Meld's
    # tolerant decode_mask: validate=True base64 + PNG IHDR magic, 400 on any
    # mismatch (a corrupt save must fail loudly, not half-write).
    try:
        data = _b64.b64decode(body.image_b64, validate=True)
    except Exception:
        raise HTTPException(400, "image_b64 is not valid base64")
    # hash sanity: must actually be a PNG with a plausible IHDR header
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 33:
        raise HTTPException(400, "meld result must be a PNG")
    groot = _gallery_mod.GALLERY_ROOT  # module attr: test monkeypatch-safe
    groot.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    name = f"meld-{fid}-{ts}.png"
    dest = groot / name
    n = 0
    while dest.exists():  # auto-name, NEVER overwrite
        n += 1
        name = f"meld-{fid}-{ts}-{n}.png"
        dest = groot / name
    dest.write_bytes(data)

    # Ledger: ACCEPTED by default — 'why work on it only to throw it away'.
    entry = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "family": fid,
        "members": {p: "kept" for p in comps},
        "note": f"meld saved → {name}",
        "meld_result": name,
    }
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as fh:            # append-only by design
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # On-the-spot collapse: every component goes to the deletion queue NOW.
    from .pending import _audit, _load, _save, manifest_lock
    with manifest_lock:
        m = _load()
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        added = 0
        added_keys: list[str] = []
        for p in comps:
            key = p
            try:
                key = jailed(p).resolve().relative_to(
                    _gallery_mod.GALLERY_ROOT.resolve()).as_posix()
            except (HTTPException, OSError, ValueError):
                pass  # dupe-pool-only member: keep dupe-relative manifest key
            if key not in m:
                m[key] = now
                added += 1
                added_keys.append(key)
        _save(m)
    _audit("family_commit_write", added_keys, request)
    return {"saved_as": name, "pending_added": added, "pending_count": len(m),
            "members": comps}


@router.post("/scan")
def start_scan():
    """Background dupelib analyze via subprocess; log to /tmp. A long scan is
    a legitimate background job — poll GET /api/dupe/scan/status."""
    global _scan_proc
    if _scan_proc is not None and _scan_proc.poll() is None:
        raise HTTPException(409, "scan already running")
    lib = Path(DUPELIB_PATH)
    if not (lib / "dupelib").is_dir():
        raise HTTPException(500, f"dupelib not found at {lib}")
    with SCAN_LOG.open("w") as lf:
        _scan_proc = subprocess.Popen(
            ["python3", "-m", "dupelib.cli", "analyze", str(DUPE_ROOT)],
            cwd=str(lib), stdout=lf, stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONPATH": str(lib)})
    return {"started": True, "pid": _scan_proc.pid, "log": str(SCAN_LOG)}


@router.get("/scan/status")
def scan_status():
    if _scan_proc is None:
        return {"running": False, "ever_started": False}
    return {"running": _scan_proc.poll() is None,
            "returncode": _scan_proc.poll(), "log": str(SCAN_LOG)}
