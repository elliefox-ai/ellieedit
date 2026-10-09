"""One-time bulk migration: kept dupe-review verdicts -> Library.

Reads the append-only verdict ledger (.dupe-verdicts.jsonl, latest entry
per family wins), collects every member whose final verdict is "kept",
and MOVES each file from DUPE_ROOT into LIBRARY_ROOT/<tag>/<name> via
backend.routers.library.promote_move (move never copy; index records
appended with sha256 + promoted_from).

  python -m backend.library_migrate --dry-run   # numbers only, no changes
  python -m backend.library_migrate --apply     # operator-approved only

Dry-run prints per-project (tag) counts, total bytes, and verifies every
kept path still exists under DUPE_ROOT.
"""

import argparse
import collections
import json
import os
import sys

from backend.routers import dupe as dupe_mod
from backend.routers import library as lib_mod


def kept_paths(ledger_path) -> list[str]:
    """DUPE_ROOT-relative paths whose latest verdict per family is 'kept'."""
    latest: dict[str, dict[str, str]] = {}
    with open(ledger_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            v = json.loads(line)
            fam = v.get("family")
            if fam and v.get("members"):
                latest.setdefault(fam, {}).update(v["members"])
    return sorted(p for m in latest.values()
                  for p, verdict in m.items() if verdict == "kept")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--ledger", default=str(dupe_mod.LEDGER))
    args = ap.parse_args(argv)
    if args.apply == args.dry_run:
        print("pass exactly one of --dry-run / --apply", file=sys.stderr)
        return 2

    root = dupe_mod.DUPE_ROOT
    paths = kept_paths(args.ledger)
    per_tag = collections.Counter()
    total_bytes = 0
    missing = []
    for rel in paths:
        src = root / rel
        if not src.is_file():
            missing.append(rel)
            continue
        tag = lib_mod.derive_tag(src)
        per_tag[tag] += 1
        total_bytes += src.stat().st_size

    print(f"ledger: {args.ledger}")
    print(f"kept members (latest verdict wins): {len(paths)}")
    print(f"missing under {root}: {len(missing)}")
    for rel in missing:
        print(f"  MISSING: {rel}")
    print(f"per-project (tag) counts:")
    for tag, n in sorted(per_tag.items(), key=lambda kv: -kv[1]):
        print(f"  {tag:20s} {n}")
    print(f"total bytes WOULD move: {total_bytes:,} "
          f"({total_bytes / (1 << 30):.2f} GiB)")
    if args.dry_run:
        print("DRY RUN — nothing moved, no index records written.")
        print("APPROVAL GATE: operator must explicitly run --apply.")
        return 0 if not missing else 1

    moved = 0
    errors = []
    for rel in paths:
        src = root / rel
        if not src.is_file():
            continue
        try:
            lib_mod.promote_move(src)
            moved += 1
        except Exception as e:  # noqa: BLE001 — batch job, collect all
            errors.append(f"{rel}: {e}")
    print(f"moved: {moved}, errors: {len(errors)}")
    for e in errors:
        print(f"  ERROR: {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
