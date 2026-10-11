"""Dupe-family cleanup — prune dead members, dissolve empty families.

Family records under <root>/.dupes/families/*.json reference member image
paths; many members are gone (deleted rejects / migrated keeps). This tool
checks existence, prunes dead members, dissolves families reduced to <=1
live member, and NEVER touches image files.

Member resolution mirrors the death-row ghost rules in routers/dupe.py:
  - member on disk          -> live
  - member in library index (promoted_from) -> 'in-library' (resolved,
    NOT live — a family whose only real members are library copies dissolves)
  - otherwise               -> missing

HARD CONSTRAINT (operator): the ONLY writable surfaces are family JSON
files, their .bak copies, and the audit journal. Every write goes through
_guarded_open/_guarded_replace, which asserts the target against a
whitelist (directory + extension). No os.remove/unlink/rename/shutil.move
exists anywhere in this module — "delete to .bak" is a byte copy to the
.bak followed by an open(path, 'w') truncate, both guarded.

Ledger (.dupe-verdicts.jsonl) is never read-modified — verdict history is
untouched; pruning family JSONs cannot erase it.

Usage:
  python -m backend.dupe_cleanup            # dry-run report (default)
  python -m backend.dupe_cleanup --live     # apply changes
  python -m backend.dupe_cleanup --live --limit 20   # live pilot
"""

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Env-overridable for tests, same convention as routers/dupe.py.
DUPE_ROOT = Path(os.environ.get(
    "ELLIEEDIT_DUPE_ROOT", "/mnt/shared/_Incoming/DupeReview"))
DUPE_DATA = Path(os.environ.get(
    "ELLIEEDIT_DUPE_DATA", str(DUPE_ROOT / ".dupes")))
FAMILIES_DIR = DUPE_DATA / "families"
JOURNAL = DUPE_DATA / "families-cleanup.jsonl"
LIBRARY_ROOT = Path(os.environ.get(
    "ELLIEEDIT_LIBRARY_ROOT", "/mnt/shared/_Library"))

# ---- write guard -----------------------------------------------------------

_ALLOWED_SUFFIXES = {".json", ".bak", ".jsonl", ".tmp"}
_ALLOWED_DIRS = (FAMILIES_DIR.resolve(), DUPE_DATA.resolve())


class WriteViolation(RuntimeError):
    """Attempted write outside the whitelisted surface."""


def _assert_writable(path: Path) -> Path:
    """Whitelist: only family JSONs, .bak copies, and the journal."""
    p = Path(path)
    if p.suffix not in _ALLOWED_SUFFIXES:
        raise WriteViolation(f"blocked write (suffix {p.suffix!r}): {p}")
    rp = p.resolve()
    if not any(rp == d or d in rp.parents for d in _ALLOWED_DIRS):
        raise WriteViolation(f"blocked write (outside dupe data): {p}")
    return p


def _guarded_replace(path: Path, text: str) -> None:
    """The ONLY write primitive in this module."""
    p = _assert_writable(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    _assert_writable(tmp)
    tmp.write_text(text)
    # os.replace on the guarded path only (atomic within FAMILIES_DIR)
    os.replace(tmp, p)


def _delete_to_bak(path: Path) -> Path:
    """'Delete' = copy bytes to .bak, then truncate the JSON. No unlink."""
    p = _assert_writable(path)
    bak = p.with_suffix(".json.bak")
    _assert_writable(bak)
    if not bak.exists():
        shutil.copyfile(p, bak)   # read-only on source; write guarded on bak
    _guarded_replace(p, "")
    return bak


# ---- library index ---------------------------------------------------------

_lib_cache: tuple[float, dict] | None = None


def library_lookup() -> dict:
    """promoted_from path -> record, cached on index mtime (same rule as
    routers/dupe._library_lookup)."""
    global _lib_cache
    ip = LIBRARY_ROOT / ".library-index.jsonl"
    try:
        mt = ip.stat().st_mtime
    except OSError:
        mt = -1.0
    if _lib_cache and _lib_cache[0] == mt:
        return _lib_cache[1]
    out: dict[str, dict] = {}
    try:
        for line in ip.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            src = (rec.get("promoted_from") or "").replace("\\", "/")
            if src and not rec.get("deleted_soon"):
                out.setdefault(src, rec)
    except OSError:
        pass                      # absent/unreadable index -> everything missing
    _lib_cache = (mt, out)
    return out


# ---- member state ----------------------------------------------------------

def member_state(path: str) -> str:
    """'disk' | 'in-library' | 'missing' for one member path."""
    p = (path or "").replace("\\", "/")
    if p and os.path.isfile(p):
        return "disk"
    if p in library_lookup():
        return "in-library"
    return "missing"


# ---- core pass -------------------------------------------------------------

def _norm(p: str) -> str:
    return (p or "").replace("\\", "/")


def process_family(fpath: Path, live: bool, journal_fh) -> dict:
    """One family. Returns a stats dict; performs writes only when live."""
    fam = json.loads(fpath.read_text())
    fid = fam.get("id", fpath.stem)
    members = fam.get("members") or []

    kept, dead = [], []
    for m in members:
        st = member_state(m.get("path", ""))
        if st == "disk":
            kept.append(m)
        else:
            dead.append((m, st))

    n_live = len(kept)
    stats = {"fid": fid, "members": len(members), "live": n_live,
             "dead_missing": sum(1 for _, s in dead if s == "missing"),
             "dead_in_library": sum(1 for _, s in dead if s == "in-library"),
             "action": "none"}

    def j(action, path, reason):
        if journal_fh:
            journal_fh.write(json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(),
                "family": fid, "action": action,
                "path": _norm(path), "reason": reason}) + "\n")

    if not dead:
        return stats

    if n_live <= 1:
        # dissolve: every remaining real member is 0-or-1; family loses meaning
        stats["action"] = "dissolve"
        if live:
            _delete_to_bak(fpath)
            for m, st in dead:
                j("dissolve", m.get("path", ""), st)
        return stats

    # prune dead members, keep the family (>=2 live members remain)
    stats["action"] = "prune-member"
    if live:
        bak = fpath.with_suffix(".json.bak")
        _assert_writable(bak)
        if not bak.exists():
            shutil.copyfile(fpath, bak)
        fam["members"] = kept
        _guarded_replace(fpath, json.dumps(fam, indent=1) + "\n")
        for m, st in dead:
            j("prune-member", m.get("path", ""), st)
    return stats


def run(live: bool, limit: int | None = None) -> dict:
    paths = sorted(FAMILIES_DIR.glob("fam-*.json"))
    paths = [p for p in paths if p.suffix == ".json"]
    if limit:
        paths = paths[:limit]
    totals = {"families": 0, "with_dead": 0, "dead_missing": 0,
              "dead_in_library": 0, "prune": 0, "dissolve": 0,
              "json_bytes_touched": 0}
    journal_fh = None
    try:
        if live:
            journal_fh = JOURNAL.open("a")
        for p in paths:
            try:
                st = process_family(p, live, journal_fh)
            except (json.JSONDecodeError, OSError) as e:
                print(f"  ! skip {p.name}: {e}", file=sys.stderr)
                continue
            totals["families"] += 1
            if st["dead_missing"] or st["dead_in_library"]:
                totals["with_dead"] += 1
            totals["dead_missing"] += st["dead_missing"]
            totals["dead_in_library"] += st["dead_in_library"]
            if st["action"] == "prune-member":
                totals["prune"] += 1
                totals["json_bytes_touched"] += p.stat().st_size
            elif st["action"] == "dissolve":
                totals["dissolve"] += 1
                totals["json_bytes_touched"] += p.stat().st_size
    finally:
        if journal_fh:
            journal_fh.close()
    return totals


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", default=True,
                   help="report only, write nothing (default)")
    g.add_argument("--live", action="store_true",
                   help="apply prunes/dissolves (operator-approved only)")
    ap.add_argument("--limit", type=int, default=None,
                    help="process only the first N families (live pilot)")
    args = ap.parse_args(argv)
    mode = "LIVE" if args.live else "DRY-RUN"
    if args.live and args.limit is None:
        ans = input(f"{mode} run over ALL families in {FAMILIES_DIR}. "
                    "Type 'yes' to confirm: ")
        if ans.strip().lower() != "yes":
            print("aborted")
            return 1
    t0 = time.monotonic()
    totals = run(live=args.live, limit=args.limit)
    dt = time.monotonic() - t0
    print(f"dupe-family cleanup — {mode}")
    print(f"families scanned:        {totals['families']}")
    print(f"families with dead:      {totals['with_dead']}")
    print(f"dead members (missing):  {totals['dead_missing']}")
    print(f"dead members (in-lib):   {totals['dead_in_library']}")
    print(f"families to prune:       {totals['prune']}")
    print(f"families to dissolve:    {totals['dissolve']}")
    print(f"json bytes touched:      {totals['json_bytes_touched']}")
    print(f"elapsed: {dt:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
