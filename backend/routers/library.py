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
import io
import json
import os
import shutil
import time
import uuid
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi import Response as FResponse
from fastapi.responses import FileResponse, StreamingResponse
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
    roots = [_gallery_mod.GALLERY_ROOT, _dupe_mod.DUPE_ROOT]
    roots += [b["root"] for b in _gallery_mod.get_banks()]
    for root in roots:
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
    """True if p is a file strictly under GALLERY_ROOT, DUPE_ROOT, or any
    gallery bank root (v1.5). Writability is NOT checked here — promote
    gates read-only banks in _resolve_source; a read-only file is a valid
    file, just not a movable one."""
    try:
        rp = p.resolve()
    except OSError:
        return False
    if not rp.is_file():
        return False
    roots = [_gallery_mod.GALLERY_ROOT, _dupe_mod.DUPE_ROOT]
    roots += [b["root"] for b in _gallery_mod.get_banks()]
    for root in roots:
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
    _roots = [_gallery_mod.GALLERY_ROOT, _dupe_mod.DUPE_ROOT]
    _roots += [b["root"] for b in _gallery_mod.get_banks()]
    for root in _roots:
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


def _index_maps(records: list[dict]) -> tuple[dict, set, dict]:
    """One-pass derivation from index records (Phase 0: the listing reads
    the index ONCE, where the old code read it twice — latest_tags plus
    deleted_soon_paths). Returns (tags_by_path, gone, family_by_path).
    family_by_path is the §2.7 reader fix: the latest record CARRYING
    family fields wins per path, so a retag record (tags only, no kind)
    never clobbers the original↔final linkage. No data is rewritten."""
    tags: dict[str, list[str]] = {}
    gone: set[str] = set()
    fam: dict[str, dict] = {}
    for rec in records:
        p = rec.get("path")
        if not p:
            continue
        if rec.get("tags") is not None:
            tags[p] = list(rec["tags"] or [])
        if rec.get("deleted_soon"):
            gone.add(p)
        else:
            gone.discard(p)  # latest entry wins, even un-flagging
        if rec.get("kind") or rec.get("family_id"):
            fam[p] = {"kind": rec.get("kind"),
                      "family_id": rec.get("family_id"),
                      "original": rec.get("original"),
                      "final": rec.get("final"),
                      "intermediates": rec.get("intermediates") or []}
    return tags, gone, fam


# ---------------------------------------------------------------------------
# Subject / shot metadata (2026-10-29, library sets)
# ---------------------------------------------------------------------------
# Why human metadata, not a vision model: a training set's useful
# labels are curation decisions — subject type, shot scale, figure
# count, a short detail ("woman", "horse", "car") — and a weak vision
# guess written into the index would pollute the set with wrong
# labels. So metadata is entered by a human (one image, or bulk over
# a selection), stored in its own sidecar, and never auto-generated.
# The sidecar follows the same append-only, latest-wins discipline
# as the index: a retag never clobbers metadata, and vice versa.
META_SUBJECTS = ["person", "animal", "vehicle", "building",
                 "landscape", "object", "other"]
META_SHOTS = ["close-up", "medium", "wide", "full", "other"]
META_FIGURES = ["none", "1", "2", "3+"]


def _meta_path() -> Path:
    return LIBRARY_ROOT / ".library-meta.jsonl"


def _sets_path() -> Path:
    return LIBRARY_ROOT / ".library-sets.jsonl"


def _read_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _append_jsonl(path: Path, record: dict) -> None:
    LIBRARY_ROOT.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(json.dumps(record, separators=(",", ":")) + "\n")


def latest_meta() -> dict[str, dict]:
    """path -> merged metadata dict; latest record wins per path."""
    meta: dict[str, dict] = {}
    for rec in _read_jsonl(_meta_path()):
        if rec.get("path"):
            meta[rec["path"]] = {k: rec.get(k, "") for k in
                                 ("subject", "shot", "figures", "detail")}
    return meta


def _validate_meta(subject: str, shot: str, figures: str) -> None:
    if subject and subject not in META_SUBJECTS:
        raise HTTPException(400, f"unknown subject: {subject}")
    if shot and shot not in META_SHOTS:
        raise HTTPException(400, f"unknown shot: {shot}")
    if figures and figures not in META_FIGURES:
        raise HTTPException(400, f"unknown figures: {figures}")


def set_meta(path: str, subject: str = "", shot: str = "",
             figures: str = "", detail: str = "") -> dict:
    p = library_jailed(path)
    if not p.is_file():
        raise HTTPException(404, "not in library")
    _validate_meta(subject, shot, figures)
    rel = p.relative_to(LIBRARY_ROOT).as_posix()
    record = {"path": rel, "subject": subject, "shot": shot,
              "figures": figures, "detail": detail.strip(),
              "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")}
    _append_jsonl(_meta_path(), record)
    return record


def bulk_meta(paths: list[str], subject: str | None = None,
              shot: str | None = None, figures: str | None = None,
              detail: str | None = None) -> list[dict]:
    """Bulk metadata: None = keep the existing value, '' = clear it.
    This is what makes human tagging cheap — select twenty vehicle
    shots, set subject once, leave shot/detail untouched."""
    _validate_meta(subject or "", shot or "", figures or "")
    existing = latest_meta()
    out = []
    for path in paths:
        p = library_jailed(path)
        if not p.is_file():
            raise HTTPException(404, f"not in library: {path}")
        rel = p.relative_to(LIBRARY_ROOT).as_posix()
        cur = existing.get(rel, {"subject": "", "shot": "",
                                 "figures": "", "detail": ""})
        merged = {
            "subject": cur["subject"] if subject is None else subject,
            "shot": cur["shot"] if shot is None else shot,
            "figures": cur["figures"] if figures is None else figures,
            "detail": cur["detail"] if detail is None else detail.strip(),
        }
        out.append(set_meta(rel, **merged))
    return out


# ---------------------------------------------------------------------------
# Sets (2026-10-29)
# ---------------------------------------------------------------------------
# A set is a named, ordered collection of library references — not
# moves, not copies. Files stay in their tag folders; the set only
# records paths, in order, plus a caption template and per-member
# caption overrides. Locking freezes members + template, so later
# library edits cannot silently change a training set; export
# produces a reproducible zip (images + .txt captions + manifest).
def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def latest_sets() -> dict[str, dict]:
    """set id -> latest snapshot; deleted sets are dropped."""
    sets: dict[str, dict] = {}
    for rec in _read_jsonl(_sets_path()):
        if not rec.get("id"):
            continue
        if rec.get("deleted"):
            sets.pop(rec["id"], None)
        else:
            sets[rec["id"]] = rec
    return sets


def get_set_or_404(set_id: str) -> dict:
    s = latest_sets().get(set_id)
    if not s:
        raise HTTPException(404, "no such set")
    return s


def _save_set(s: dict) -> dict:
    s = dict(s)
    s["ts"] = _now()
    _append_jsonl(_sets_path(), s)
    return s


def create_set(name: str, purpose: str = "", caption_template: str = "",
               notes: str = "") -> dict:
    if not name.strip():
        raise HTTPException(400, "set name required")
    return _save_set({"id": uuid.uuid4().hex[:12], "name": name.strip(),
                      "purpose": purpose.strip(),
                      "caption_template": caption_template.strip(),
                      "notes": notes.strip(), "status": "draft",
                      "members": []})


def _require_unlocked(s: dict) -> None:
    if s.get("status") == "locked":
        raise HTTPException(409, "set is locked — unlock it to change it")


def add_set_members(set_id: str, paths: list[str]) -> dict:
    s = get_set_or_404(set_id)
    _require_unlocked(s)
    rows = {r["path"] for r in _all_rows()}
    have = [m["path"] for m in s.get("members", [])]
    for path in paths:
        rel = library_jailed(path).relative_to(LIBRARY_ROOT).as_posix()
        if rel not in rows:
            raise HTTPException(404, f"not in library: {path}")
        if rel not in have:
            s.setdefault("members", []).append({"path": rel, "caption": ""})
            have.append(rel)
    return _save_set(s)


def remove_set_members(set_id: str, paths: list[str]) -> dict:
    s = get_set_or_404(set_id)
    _require_unlocked(s)
    drop = set()
    for path in paths:
        drop.add(library_jailed(path).relative_to(LIBRARY_ROOT).as_posix())
    s["members"] = [m for m in s.get("members", []) if m["path"] not in drop]
    return _save_set(s)


def set_distribution(members: list[dict]) -> dict:
    by_subject = Counter(m.get("meta", {}).get("subject") or "untagged"
                         for m in members)
    by_shot = Counter(m.get("meta", {}).get("shot") or "untagged"
                      for m in members)
    by_combo = Counter(
        f"{m.get('meta', {}).get('subject') or 'untagged'}/"
        f"{m.get('meta', {}).get('shot') or 'untagged'}"
        for m in members)
    return {"by_subject": dict(by_subject), "by_shot": dict(by_shot),
            "by_combo": dict(by_combo)}


def set_detail(set_id: str) -> dict:
    s = get_set_or_404(set_id)
    rows = {r["path"]: r for r in _all_rows()}
    members = []
    for m in s.get("members", []):
        row = rows.get(m["path"])
        members.append({"path": m["path"], "caption": m.get("caption", ""),
                        "missing": row is None,
                        "name": row["name"] if row else Path(m["path"]).name,
                        "tags": row["tags"] if row else [],
                        "meta": row["meta"] if row else {}})
    out = dict(s)
    out["members"] = members
    out["member_count"] = len(members)
    out["missing_count"] = sum(1 for m in members if m["missing"])
    present = [m for m in members if not m["missing"]]
    out["distribution"] = set_distribution(present)
    return out


def export_set_zip(set_id: str) -> tuple[str, bytes]:
    s = set_detail(set_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for m in s["members"]:
            if m["missing"]:
                continue
            p = library_jailed(m["path"])
            stem = Path(m["path"]).stem
            zf.write(p, f"{stem}{Path(m['path']).suffix}")
            caption = (m["caption"] or s.get("caption_template") or "").strip()
            zf.writestr(f"{stem}.txt", caption)
        manifest = {"set": s["name"], "purpose": s.get("purpose", ""),
                    "status": s.get("status"), "caption_template": s.get("caption_template", ""),
                    "member_count": s["member_count"],
                    "missing_count": s["missing_count"],
                    "distribution": s["distribution"],
                    "members": [{"path": m["path"], "caption": m["caption"],
                                 "tags": m["tags"], "meta": m["meta"],
                                 "missing": m["missing"]} for m in s["members"]]}
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in s["name"]) or "set"
    return f"{safe}.zip", buf.getvalue()


def _all_rows() -> list[dict]:
    """Every library row on disk, sorted newest-first, with tags,
    family fields, and subject/shot metadata joined. list_library
    filters and pages this; set detail resolves members against it."""
    tags_by_path, gone, fam = _index_maps(read_index())
    meta_by_path = latest_meta()
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
            info = fam.get(rel, {})
            rows.append({"path": rel, "name": fn, "mtime": full.stat().st_mtime,
                         "tags": file_tags, "meta": meta_by_path.get(rel, {}),
                         "kind": info.get("kind"),
                         "family_id": info.get("family_id"),
                         "original": info.get("original"),
                         "final": info.get("final")})
    rows.sort(key=lambda r: r["mtime"], reverse=True)
    return rows


def list_library(tag: str = "", cursor: int = 0, kind: str = "",
                 subject: str = "", shot: str = "", q: str = "") -> dict:
    """Paged listing of library images with tags. Latest-wins tags joined
    with what's actually on disk (index entries for vanished files are
    skipped). Phase 0:
      - `tags` and `total_all` come from the UNFILTERED set (the old code
        computed them after the tag filter, so the tag bar collapsed and
        'all (N)' showed the filtered count);
      - rows carry family fields (kind, family_id, original, final);
      - kind filter: '' (default) hides version-original rows (finals +
        loose images; originals are reached through their family),
        'originals' shows only originals, 'all' shows everything;
      - subject / shot / q filters (2026-10-29) apply after kind and
        before paging, so the counts stay honest the same way.
    """
    t0 = time.perf_counter()
    rows = _all_rows()
    t_walk = time.perf_counter()
    # Unfiltered set first: the tag bar and the 'all' count must survive
    # filtering (Phase 0 bug fix).
    all_tags = sorted({t for r in rows for t in r["tags"]})
    total_all = len(rows)
    if kind == "originals":
        rows = [r for r in rows if r["kind"] == "version-original"]
    elif kind == "all":
        pass
    else:  # default: finals + loose; originals via their family
        rows = [r for r in rows if r["kind"] != "version-original"]
    if tag:
        t = tag.strip().lower()
        rows = [r for r in rows if t in r["tags"]]
    if subject:
        rows = [r for r in rows if (r["meta"].get("subject") or "") == subject]
    if shot:
        rows = [r for r in rows if (r["meta"].get("shot") or "") == shot]
    if q:
        needle = q.strip().lower()
        rows = [r for r in rows if needle in r["name"].lower()
                or needle in (r["meta"].get("detail") or "").lower()
                or needle in " ".join(r["tags"]).lower()
                or needle in r["path"].lower()]
    total = len(rows)
    page = rows[cursor:cursor + PAGE_SIZE]
    next_cursor = cursor + PAGE_SIZE if cursor + PAGE_SIZE < total else None
    t_total = time.perf_counter()
    return {"items": page, "total": total, "total_all": total_all,
            "shown": len(page), "tag": tag or None, "tags": all_tags,
            "next_cursor": next_cursor, "kind": kind or "finals",
            "meta_vocab": {"subjects": META_SUBJECTS, "shots": META_SHOTS,
                           "figures": META_FIGURES},
            "timing_ms": {"index": 0.0, "walk": (t_walk - t0) * 1000,
                          "total": (t_total - t0) * 1000}}


router = APIRouter(prefix="/api/library", tags=["library"])


class PromoteBody(BaseModel):
    path: str
    tag: str | None = None
    bank: str | None = None   # v1.5: bank the path lives in (primary default)


class RetagBody(BaseModel):
    path: str
    tags: list[str]


class DeleteBody(BaseModel):
    path: str


class MetaBody(BaseModel):
    path: str
    subject: str = ""
    shot: str = ""
    figures: str = ""
    detail: str = ""


class MetaBulkBody(BaseModel):
    paths: list[str]
    subject: str | None = None
    shot: str | None = None
    figures: str | None = None
    detail: str | None = None


class SetCreateBody(BaseModel):
    name: str
    purpose: str = ""
    caption_template: str = ""
    notes: str = ""


class SetUpdateBody(BaseModel):
    name: str | None = None
    purpose: str | None = None
    caption_template: str | None = None
    notes: str | None = None


class SetMembersBody(BaseModel):
    paths: list[str]


@router.get("/list")
def list_endpoint(tag: str = "", cursor: int = 0, kind: str = "",
                  subject: str = "", shot: str = "", q: str = "",
                  response: FResponse = None):
    if kind not in ("", "originals", "all"):
        raise HTTPException(400, "kind must be '' | originals | all")
    if subject and subject not in META_SUBJECTS:
        raise HTTPException(400, f"unknown subject: {subject}")
    if shot and shot not in META_SHOTS:
        raise HTTPException(400, f"unknown shot: {shot}")
    d = list_library(tag=tag, cursor=cursor, kind=kind,
                     subject=subject, shot=shot, q=q)
    if response is not None:   # Server-Timing mirrors Gallery (Phase 0)
        tm = d.get("timing_ms", {})
        response.headers["Server-Timing"] = (
            f"walk;dur={tm.get('walk', 0):.1f}, "
            f"index;dur={tm.get('index', 0):.1f}, "
            f"total;dur={tm.get('total', 0):.1f}")
    return d


@router.post("/promote")
def promote(body: PromoteBody):
    src = _resolve_source(body.path, bank=body.bank)
    record = promote_move(src, (body.tag or "").strip().lower() or None)
    return {"ok": True, **record}


@router.get("/derive")
def derive(path: str = Query(...), bank: str | None = None):
    return {"tag": derive_tag(_resolve_source(path, bank=bank))}


@router.post("/retag")
def retag_endpoint(body: RetagBody):
    return retag(body.path, body.tags)


# ---- subject/shot metadata + sets (2026-10-29) ----------------------------

@router.post("/meta")
def meta_endpoint(body: MetaBody):
    return set_meta(body.path, body.subject, body.shot,
                    body.figures, body.detail)


@router.post("/meta/bulk")
def meta_bulk_endpoint(body: MetaBulkBody):
    return {"updated": bulk_meta(body.paths, body.subject, body.shot,
                                 body.figures, body.detail)}


@router.get("/sets")
def sets_list():
    sets = sorted(latest_sets().values(), key=lambda s: s.get("ts", ""))
    return {"sets": [{**s, "member_count": len(s.get("members", []))}
                     for s in sets]}


@router.post("/sets")
def sets_create(body: SetCreateBody):
    return create_set(body.name, body.purpose, body.caption_template,
                      body.notes)


@router.get("/sets/{set_id}")
def sets_get(set_id: str):
    return set_detail(set_id)


@router.post("/sets/{set_id}")
def sets_update(set_id: str, body: SetUpdateBody):
    s = get_set_or_404(set_id)
    if body.caption_template is not None and s.get("status") == "locked":
        raise HTTPException(409, "set is locked — unlock it to change the template")
    if body.name is not None:
        s["name"] = body.name.strip() or s["name"]
    if body.purpose is not None:
        s["purpose"] = body.purpose.strip()
    if body.caption_template is not None:
        s["caption_template"] = body.caption_template.strip()
    if body.notes is not None:
        s["notes"] = body.notes.strip()
    return _save_set(s)


@router.post("/sets/{set_id}/members")
def sets_add_members(set_id: str, body: SetMembersBody):
    return add_set_members(set_id, body.paths)


@router.post("/sets/{set_id}/members/remove")
def sets_remove_members(set_id: str, body: SetMembersBody):
    return remove_set_members(set_id, body.paths)


@router.post("/sets/{set_id}/lock")
def sets_lock(set_id: str):
    s = get_set_or_404(set_id)
    s["status"] = "locked"
    return _save_set(s)


@router.post("/sets/{set_id}/unlock")
def sets_unlock(set_id: str):
    s = get_set_or_404(set_id)
    s["status"] = "draft"
    return _save_set(s)


@router.get("/sets/{set_id}/export")
def sets_export(set_id: str):
    filename, data = export_set_zip(set_id)
    return StreamingResponse(io.BytesIO(data), media_type="application/zip",
                             headers={"Content-Disposition":
                                      f'attachment; filename="{filename}"'})


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


def _resolve_source(rel: str, bank: str | None = None) -> Path:
    """Jail a client path against GALLERY_ROOT, falling back to DUPE_ROOT
    (mirrors gallery.resolve_flex). With an explicit non-primary bank, the
    path resolves under that bank — and a read-only bank is a 400, since
    promote is a MOVE."""
    if bank and bank != "primary":
        bank_obj = _gallery_mod.bank_by_id(bank)
        if bank_obj is None:
            raise HTTPException(400, f"unknown gallery bank: {bank}")
        if not bank_obj["writable"]:
            raise HTTPException(
                400, f"gallery bank '{bank_obj['label']}' is read-only — "
                     "promote is a move")
        p = _gallery_mod.bank_jailed(bank, rel)
        if p.is_file():
            return p
        raise HTTPException(404, "not found under gallery bank")
    p = _gallery_mod.jailed(rel)
    if p.is_file():
        return p
    p2 = _dupe_mod.jailed(rel)
    if p2.is_file():
        return p2
    raise HTTPException(404, "not found under gallery or dupe root")
