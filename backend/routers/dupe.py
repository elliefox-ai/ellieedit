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
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .gallery import get_thumbnail
from fastapi.responses import FileResponse

log = __import__("logging").getLogger("ellieedit.dupe")

DUPE_ROOT = Path(os.environ.get(
    "ELLIEEDIT_DUPE_ROOT", "/mnt/shared/_Incoming/DupeReview"))
DUPE_DATA = Path(os.environ.get(
    "ELLIEEDIT_DUPE_DATA", str(DUPE_ROOT / ".dupes")))
# Ledger lives in the ellieedit repo dir (append-only JSONL, latest wins).
LEDGER = Path(os.environ.get(
    "ELLIEEDIT_DUPE_LEDGER",
    str(Path(__file__).resolve().parents[2] / ".dupe-verdicts.jsonl")))
# Canonical dupelib copy used for background scans.
DUPELIB_PATH = os.environ.get(
    "ELLIEEDIT_DUPELIB_PATH", str(Path.home() / "workspace/dupe-review-v2"))

VERDICTS = {"kept", "rejected", "melded", "deferred"}
FAMILY_ID_RE = re.compile(r"^fam-[0-9a-f]{12}$")
PAGE_SIZE = 40
SCAN_LOG = Path("/tmp/ellieedit-dupescan.log")

router = APIRouter(prefix="/api/dupe", tags=["dupe"])


def jailed(rel: str) -> Path:
    """DUPE_ROOT jail — mirrors gallery.jailed (no absolute, ~, .., symlink
    escapes, directories)."""
    rel = (rel or "").replace("\\", "/")  # family files store windows-ish paths
    if not rel or Path(rel).is_absolute() or rel.startswith("~"):
        raise HTTPException(400, "path escapes dupe root")
    root_real = DUPE_ROOT.resolve()
    candidate = (DUPE_ROOT / rel.lstrip("/")).resolve()
    if candidate == root_real or root_real not in candidate.parents:
        raise HTTPException(400, "path escapes dupe root")
    return candidate


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
                    out[e["family"]] = e
    except FileNotFoundError:
        pass
    except OSError as e:
        log.warning("dupe ledger unreadable: %s", e)
    return out


def _family_state(fid: str, verdicts: dict | None = None) -> str:
    v = (verdicts or _verdicts()).get(fid)
    if not v:
        return "unresolved"
    members = v.get("members") or {}
    if members and all(x == "deferred" for x in members.values()):
        return "unresolved"  # deferral is a note, not a decision
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
        "thumb": f"/api/dupe/thumb?path={rel}",
    }


# ----------------------------------------------------------------- endpoints

@router.get("/status")
def status():
    try:
        idx = _index()
    except HTTPException as e:
        return {"indexed": False, "root": str(DUPE_ROOT), "detail": e.detail}
    fams = idx["families"]
    verdicts = _verdicts()
    resolved = sum(1 for f in fams if _family_state(f["id"], verdicts) == "resolved")
    idx_mtime = (DUPE_DATA / "index.json").stat().st_mtime

    # Freshness: newest image mtime under the root, with a walk budget so a
    # slow network mount can't wedge the endpoint. Budget blown => honest
    # "unknown" rather than a stale claim.
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
        freshness = "no-images"
    elif not complete:
        freshness = "unknown (walk budget exceeded)"
    else:
        freshness = ("fresh" if newest <= idx_mtime
                     else f"stale — {int(newest - idx_mtime)}s of images newer than index")

    return {
        "indexed": True,
        "root": str(DUPE_ROOT),
        "families": len(fams),
        "members": sum(f.get("size", 0) for f in fams),
        "resolved": resolved,
        "unresolved": len(fams) - resolved,
        "index_generated": idx.get("generated"),
        "index_age_s": int(time.time() - idx_mtime),
        "freshness": freshness,
        "ledger": str(LEDGER),
        "scan_hint": (
            f"cd {DUPELIB_PATH} && PYTHONPATH=. python3 -m dupelib.cli analyze "
            f"\"{DUPE_ROOT}\"  # full scans are fastest from the Windows side"),
    }


@router.get("/families")
def families(state: str = "unresolved", cursor: str = ""):
    if state not in ("unresolved", "resolved", "all"):
        raise HTTPException(400, "state must be unresolved|resolved|all")
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
        })
    start = 0
    if cursor:
        try:
            start = next(i + 1 for i, r in enumerate(rows) if r["id"] == cursor)
        except StopIteration:
            raise HTTPException(400, "bad cursor")
    page = rows[start:start + PAGE_SIZE]
    # Thumbnails for the first few members of each card (strip view).
    for r in page:
        fam = _load_family(r["id"])
        members = [_member_view(m) for m in fam.get("members", [])[:6]]
        for m in members:
            try:
                jailed(m["path"])
            except HTTPException:
                m["thumb"] = None  # jailed member: no thumbnail, flag it
                m["jailed"] = True
        r["members"] = members
    next_cursor = page[-1]["id"] if page and start + PAGE_SIZE < len(rows) else None
    counts = {"unresolved": 0, "resolved": 0}
    for f in idx["families"]:
        counts[_family_state(f["id"], verdicts)] += 1
    return {"items": page, "next_cursor": next_cursor,
            "counts": counts, "total": len(idx["families"])}


@router.get("/families/{fid}")
def family_detail(fid: str):
    fam = _load_family(fid)
    verdicts = _verdicts()
    members = []
    for m in fam.get("members", []):
        v = _member_view(m)
        try:
            jailed(v["path"])
            st = v["_p"] = jailed(v["path"])
            v["exists"] = st.is_file()
        except HTTPException:
            v["thumb"] = None
            v["jailed"] = True
            v["exists"] = False
        members.append(v)
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
        "members": [{k: v for k, v in m.items() if k != "_p"} for m in members],
        "edges": fam.get("edges", []),
        "related": [
            {"family": r.get("related_family"), "tier": r.get("tier"),
             "distance": r.get("distance")}
            for r in fam.get("related", []) if r.get("related_family")
        ],
        "verdict": fam_verdict.get("members", {}),
        "note": note,
        "verdicts": {m["path"]: fam_verdict.get("members", {}).get(m["path"])
                     for m in members},
    }


class VerdictBody(BaseModel):
    members: dict[str, str]          # path -> kept|rejected|melded|deferred
    note: str = ""


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
    entry = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "family": fid,
        "members": clean,
        "note": body.note,
    }
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as fh:            # append-only by design
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"ok": True, "state": _family_state(fid), "entry": entry}


class SendBody(BaseModel):
    id: str


@router.post("/families/{fid}/send-pending")
def send_pending(fid: str):
    """Convenience: every 'rejected' member of the family's latest verdict ->
    the Pending Delete manifest. Dedupes against already-pending; silently
    skips missing/vanished files. Nothing is deleted here — the pending
    confirm endpoint remains the only destructive action."""
    from .pending import _load, _save
    from .gallery import GALLERY_ROOT
    fam_verdict = _verdicts().get(fid)
    if not fam_verdict:
        raise HTTPException(409, "family has no verdict yet")
    rejected = [p for p, v in (fam_verdict.get("members") or {}).items()
                if v == "rejected"]
    if not rejected:
        raise HTTPException(409, "no rejected members in the latest verdict")
    m = _load()
    now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    added = skipped = missing = 0
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
        else:
            skipped += 1
    _save(m)
    return {"added": added, "already_pending": skipped, "missing": missing,
            "count": len(m)}


@router.get("/thumb")
def thumb(path: str):
    EXTS = {".jpg", ".jpeg", ".png", ".webp"}
    src = jailed(path)
    if not src.is_file() or src.suffix.lower() not in EXTS:
        raise HTTPException(404, "not an image")
    try:
        tp = get_thumbnail(src)
    except Exception as e:
        raise HTTPException(500, f"thumbnail failed: {e}")
    return FileResponse(tp, media_type="image/webp",
                        headers={"Cache-Control": "public, max-age=86400"})


# ------------------------------------------------- background scan (optional)

_scan_proc: subprocess.Popen | None = None


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
