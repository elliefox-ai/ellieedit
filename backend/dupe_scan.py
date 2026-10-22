"""Straggler scan (2026-10-09g) — import-front-door for unscanned images.

The canonical dupelib scan indexed 1,998 files under the DupeReview root;
~6,300 files there (plus the old _DupeGatherer/staging iteration corpus)
were never scanned into families. This module scans those stragglers —
BOTH internally (near-dupe clustering) and against the Library (reference
matches) — and writes new family JSONs into the existing .dupes/families
dir with provenance marker ``source: "straggler-scan"`` so the operator
can judge them in the existing dupe UI.

PRINCIPLES (mirroring routers/dupe.py):
  - The ledger is NEVER touched. Library files are NEVER moved or
    modified — matches are references (``library_match`` on the member),
    not members.
  - Hashes persist to the existing dupelib cache.db fingerprints store
    (sqlite ``hashes`` table keyed path + size + mtime), so a rerun skips
    already-hashed files — a rerun of a 6k-file /mnt walk is the cheap case.
  - Clustering thresholds are the original scanner's (dupelib config v1.1):
    T1 = dhash<=8 AND phash<=20; T2 = (dh<=12 AND ph<=12) OR (ph<=12 AND
    dh<=20). Union-find over T1+T2; tiers use the established vocabulary.
  - Rescans are idempotent: previous ``straggler-scan`` families are
    replaced in the index and on disk; verdict-era families never are.

CLI: python -m backend.dupe_scan --roots /a /b [--library ROOT] [--limit N]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

log = __import__("logging").getLogger("ellieedit.dupe_scan")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}

# Original scanner thresholds (dupelib Config v1.1, see module docstring).
T1_DHASH = 8
T1_PHASH_MAX = 20
T2_MIN = 12
T2_DHASH_MAX = 20

SOURCE = "straggler-scan"
DEFAULT_GATHER_ROOT = "/mnt/shared/_DupeGatherer/staging"

# sqlite stores unsigned 64-bit hashes as signed ints (dupelib adapter).
def _to_s64(x: int) -> int:
    return x - (1 << 64) if x >= (1 << 63) else x


def _from_s64(x: int) -> int:
    return x + (1 << 64) if x < 0 else x


# ----------------------------------------------------------------- hashing

def dhash(img) -> int:
    """64-bit dhash-B — same recipe as dupelib.hashes.dhash."""
    g = img.convert("L").resize((9, 8), Image.BILINEAR)
    a = np.asarray(g, dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).flatten()
    return int(np.packbits(bits.astype(np.uint8)).tobytes().hex(), 16)


def dct_low(img) -> np.ndarray:
    """Top-left 8x8 block of the 32x32 grayscale DCT (DC included). Shared by
    the 64-bit phash here and the cluster engine's 63-bit DC-dropped variant
    so there is exactly ONE DCT recipe (inc.3: no forked hashing)."""
    k = np.arange(32)[:, None]
    x = np.arange(32)[None, :]
    m = np.cos(np.pi / 32 * (x + 0.5) * k)
    m[0] *= 1.0 / np.sqrt(2)
    g = img.convert("L").resize((32, 32), Image.BILINEAR)
    dct = m @ np.asarray(g, dtype=np.float64) @ m.T
    return dct[:8, :8]


def phash(img) -> int:
    """64-bit DCT phash (top-left 8x8 incl DC) — dupelib.hashes.phash."""
    low = dct_low(img)
    med = np.median(low)
    return int(np.packbits((low > med).astype(np.uint8)).tobytes().hex(), 16)


def hash_file(path: Path) -> tuple[int, int]:
    with Image.open(path) as _h:
        img = _h
        try:
            img.draft("L", (64, 64))
        except Exception:
            pass
        img = ImageOps.exif_transpose(img)
        return phash(img), dhash(img)


# ------------------------------------------------------------- hash store

class HashStore:
    """dupelib-compatible cache.db fingerprints store (path+size+mtime key).

    The DupeReview .dupes/cache.db already holds the canonical scan's
    hashes; this opens it (creating it only when absent) and keys straggler
    rows by ``<label>:<rel>`` so roots never collide. Resume: a row whose
    (size, mtime) still matches the file is reused verbatim; anything else
    re-hashes."""

    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.con = sqlite3.connect(str(db_path))
        self.con.execute(
            "CREATE TABLE IF NOT EXISTS hashes ("
            " path TEXT PRIMARY KEY, size INTEGER NOT NULL,"
            " mtime INTEGER NOT NULL, dhash INTEGER, phash INTEGER,"
            " state INTEGER DEFAULT 0)")
        self.con.commit()

    def get(self, key: str, size: int, mtime: int):
        row = self.con.execute(
            "SELECT size, mtime, dhash, phash FROM hashes WHERE path=?",
            (key,)).fetchone()
        if row and row[0] == size and row[1] == mtime and \
                row[2] is not None and row[3] is not None:
            return _from_s64(row[2]), _from_s64(row[3])
        return None

    def put(self, key: str, size: int, mtime: int, dh: int, ph: int):
        self.con.execute(
            "INSERT OR REPLACE INTO hashes(path,size,mtime,dhash,phash,state)"
            " VALUES(?,?,?,?,?,0)",
            (key, size, mtime, _to_s64(dh), _to_s64(ph)))

    def commit(self):
        self.con.commit()


def hex64(x: int) -> str:
    return f"{x:016x}"


# -------------------------------------------------------------- collection

def collect_images(root: Path, exclude_dirs: set[str] = frozenset()) -> list[Path]:
    """Image files under root, dot-dirs/files skipped, exclude_dirs pruned."""
    out: list[Path] = []
    stack = [root]
    while stack:
        d = stack.pop()
        try:
            for e in os.scandir(d):
                if e.name.startswith(".") or e.is_symlink():
                    continue
                try:
                    if e.is_dir():
                        if e.name not in exclude_dirs:
                            stack.append(Path(e.path))
                    elif Path(e.name).suffix.lower() in IMAGE_EXTS:
                        out.append(Path(e.path))
                except OSError:
                    continue
        except OSError:
            continue
    return sorted(out)


def ledger_paths(ledger: Path, dupe_root: Path) -> set[str]:
    """Absolute paths the ledger already references (never re-surface these)."""
    out: set[str] = set()
    try:
        text = ledger.read_text()
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        for rel in (e.get("members") or {}):
            rel = str(rel).replace("\\", "/").lstrip("/")
            try:
                out.add(str((dupe_root / rel).resolve()))
            except OSError:
                continue
    return out


def family_member_paths(families_dir: Path, dupe_root: Path,
                        skip_source: str | None = None) -> set[str]:
    """Absolute paths claimed by existing family files. Families carrying
    skip_source (our own previous runs) are skipped so rescans re-admit."""
    out: set[str] = set()
    if not families_dir.is_dir():
        return out
    for p in families_dir.glob("fam-*.json"):
        try:
            fam = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if skip_source and fam.get("source") == skip_source:
            continue
        for m in fam.get("members", []):
            rel = str(m.get("path", "")).replace("\\", "/")
            if not rel:
                continue
            if os.path.isabs(rel):
                out.add(str(Path(rel).resolve()))
            else:
                out.add(str((dupe_root / rel.lstrip("/")).resolve()))
    return out


# -------------------------------------------------------------- clustering

def pair_edge(dh1: int, ph1: int, dh2: int, ph2: int) -> str | None:
    """Edge tier for a hash pair under the original scanner thresholds:
    'near-identical' (T1) > 'regional' (T2) > None."""
    dd = bin(dh1 ^ dh2).count("1")
    pd = bin(ph1 ^ ph2).count("1")
    if dd == 0 and pd == 0:
        return "exact"
    if dd <= T1_DHASH and pd <= T1_PHASH_MAX:
        return "near-identical"
    if (pd <= T2_MIN and dd <= T2_DHASH_MAX) or (dd <= T2_MIN and pd <= T2_MIN):
        return "regional"
    return None


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def cluster(items: list[dict]) -> list[list[dict]]:
    """Union-find over T1/T2 edges (same thresholds as the original
    scanner). items: [{dhash, phash, ...}]. Deterministic: sorted input in,
    groups ordered by first member out."""
    n = len(items)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    dh = np.array([it["dhash"] for it in items], dtype=np.uint64)
    ph = np.array([it["phash"] for it in items], dtype=np.uint64)
    if hasattr(np, "bitwise_count"):
        xor_d = dh[:, None] ^ dh[None, :]
        xor_p = ph[:, None] ^ ph[None, :]
        dd = np.bitwise_count(xor_d).astype(np.int32)
        pd = np.bitwise_count(xor_p).astype(np.int32)
        exact = (dd == 0) & (pd == 0)
        t1 = (dd <= T1_DHASH) & (pd <= T1_PHASH_MAX) & ~exact
        cap = T2_DHASH_MAX
        t2 = ((pd <= T2_MIN) & (dd <= cap)) & ~t1 & ~exact
        for a, b in zip(*np.nonzero(exact | t1 | t2)):
            ra, rb = find(int(a)), find(int(b))
            if ra != rb:
                parent[ra] = rb
    else:                       # exact fallback (correct, slower)
        for i in range(n):
            for j in range(i + 1, n):
                if pair_edge(items[i]["dhash"], items[i]["phash"],
                             items[j]["dhash"], items[j]["phash"]):
                    ra, rb = find(i), find(j)
                    if ra != rb:
                        parent[ra] = rb
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    out = []
    for idxs in groups.values():
        if len(idxs) > 1:
            out.append([items[i] for i in sorted(idxs)])
    return out


# ------------------------------------------------------------- library refs

def best_library_match(dh: int, ph: int, lib_items: list[dict]) -> dict | None:
    """Nearest library image under the same edge thresholds. References
    only — the library file is never touched."""
    best = None
    for it in lib_items:
        tier = pair_edge(dh, ph, it["dhash"], it["phash"])
        if tier is None:
            continue
        d = hamming(dh, it["dhash"])
        if best is None or d < best["distance"]:
            best = {"library_path": it["path"], "tier": tier, "distance": d}
    return best


# ----------------------------------------------------------------- the scan

def scan_stragglers(roots: list[dict], dupe_root: Path, dupe_data: Path,
                    ledger: Path, library_root: Path,
                    exclude_dirs: set[str] = frozenset({".dupes"}),
                    library_limit: int = 0,
                    progress=None) -> dict:
    """Full straggler pass. roots: [{label, root, exclude_dirs?}]. Returns a
    summary dict; writes family JSONs + updates index.json. Read-only over
    the ledger, the library, and every image file."""
    t0 = time.time()
    families_dir = dupe_data / "families"
    families_dir.mkdir(parents=True, exist_ok=True)
    store = HashStore(dupe_data / "cache.db")
    skip_ledger = ledger_paths(ledger, dupe_root)
    skip_family = family_member_paths(families_dir, dupe_root, skip_source=SOURCE)

    def step(phase, done, total, label=""):
        if progress:
            progress({"phase": phase, "done": done, "total": total,
                      "label": label})

    # 1) collect + hash each root, respecting exclusions
    pool: list[dict] = []
    per_root: dict[str, dict] = {}
    for spec in roots:
        label = spec["label"]
        root = Path(spec["root"])
        excl = set(spec.get("exclude_dirs", set())) | set(exclude_dirs)
        files = collect_images(root, excl) if root.is_dir() else []
        hashed = skipped = excluded = 0
        for i, f in enumerate(files):
            step(f"hash:{label}", i, len(files), label)
            absr = str(f.resolve())
            if absr in skip_ledger or absr in skip_family:
                excluded += 1
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            key = f"{label}:{f.relative_to(root).as_posix() if f.is_relative_to(root) else str(f)}"
            hit = store.get(key, st.st_size, int(st.st_mtime))
            if hit:
                dh, ph = hit
                skipped += 1
            else:
                try:
                    ph, dh = hash_file(f)
                except Exception as e:      # unreadable/corrupt: skip honestly
                    log.warning("unhashable %s: %s", f, e)
                    continue
                store.put(key, st.st_size, int(st.st_mtime), dh, ph)
            hashed += 1
            pool.append({
                "dhash": dh, "phash": ph, "size": st.st_size,
                "mtime": int(st.st_mtime), "abs": absr, "root_label": label,
                "rel": (f.relative_to(root).as_posix()
                        if f.is_relative_to(root) else str(f)),
                "jailed": label == "dupe",
            })
        per_root[label] = {"files": len(files), "hashed": hashed,
                           "resumed": skipped, "excluded": excluded}
        store.commit()

    # 2) library fingerprints (resumable, same store) + reference matches
    lib_items: list[dict] = []
    if library_root.is_dir():
        lib_files = collect_images(library_root)
        if library_limit:
            lib_files = lib_files[:library_limit]
        for i, f in enumerate(lib_files):
            step("hash:library", i, len(lib_files), "library")
            try:
                st = f.stat()
            except OSError:
                continue
            rel = f.relative_to(library_root).as_posix()
            key = f"lib:{rel}"
            hit = store.get(key, st.st_size, int(st.st_mtime))
            if hit:
                dh, ph = hit
            else:
                try:
                    ph, dh = hash_file(f)
                except Exception:
                    continue
                store.put(key, st.st_size, int(st.st_mtime), dh, ph)
            lib_items.append({"dhash": dh, "phash": ph, "path": rel})
        store.commit()

    # 3) cluster the straggler pool internally
    groups = cluster(pool)
    new_fams = []
    for g in groups:
        g = sorted(g, key=lambda m: m["rel"])
        tiers = set()
        for i in range(len(g)):
            for j in range(i + 1, len(g)):
                t = pair_edge(g[i]["dhash"], g[i]["phash"],
                              g[j]["dhash"], g[j]["phash"])
                if t:
                    tiers.add(t)
        members = []
        n_lib = 0
        for m in g:
            match = best_library_match(m["dhash"], m["phash"], lib_items)
            if match:
                n_lib += 1
            members.append({
                "path": m["rel"] if m["jailed"] else m["abs"],
                "abs_path": m["abs"], "size": m["size"], "mtime": m["mtime"],
                "dhash": hex64(m["dhash"]), "phash": hex64(m["phash"]),
                "root": m["root_label"],
                **({"library_match": match} if match else {}),
            })
        anchor = "|".join(sorted(m["abs_path"] for m in members))
        fid = "fam-" + hashlib.sha256(anchor.encode()).hexdigest()[:12]
        fam = {
            "format": "dupe-analyzer.family", "version": 1, "id": fid,
            "created": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "root": str(dupe_root), "authored": False, "source": SOURCE,
            "library_matches": n_lib, "tiers": sorted(tiers),
            "members": members,
        }
        (families_dir / f"{fid}.json").write_text(json.dumps(fam, indent=1))
        new_fams.append({
            "id": fid, "size": len(members), "tiers": sorted(tiers),
            "first_member": members[0]["path"], "authored": False,
            "source": SOURCE, "library_matches": n_lib,
        })
    step("write", len(new_fams), len(new_fams))

    # 4) index update: replace previous straggler families, append new ones.
    #    Atomic write; the ledger is never touched.
    idx_path = dupe_data / "index.json"
    try:
        idx = json.loads(idx_path.read_text())
    except (OSError, json.JSONDecodeError):
        idx = {"version": 1, "generated": "", "families": [], "stats": {}}
    old = [f for f in idx.get("families", [])
           if f.get("source") != SOURCE]
    old_ids = {f["id"] for f in old}
    kept_ids = old_ids | {f["id"] for f in new_fams}
    for p in families_dir.glob("fam-*.json"):
        if p.stem not in kept_ids:
            try:
                fam = json.loads(p.read_text())
            except (OSError, json.JSONDecodeError):
                fam = None
            if fam and fam.get("source") == SOURCE:
                p.unlink()          # superseded by this rescan
    idx["families"] = old + new_fams
    idx["generated"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    tmp = idx_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(idx, indent=1))
    tmp.replace(idx_path)

    return {
        "per_root": per_root,
        "library_hashed": len(lib_items),
        "pool": len(pool),
        "families": len(new_fams),
        "members_in_families": sum(f["size"] for f in new_fams),
        "library_matches": sum(f["library_matches"] for f in new_fams),
        "seconds": round(time.time() - t0, 1),
    }


# --------------------------------------------------------------------- CLI

def main(argv=None):
    from .routers.dupe import DUPE_DATA, DUPE_ROOT, LEDGER
    from .routers.library import LIBRARY_ROOT
    ap = argparse.ArgumentParser(prog="backend.dupe_scan",
                                 description="Scan unscanned straggler roots into dupe families")
    ap.add_argument("--roots", nargs="*",
                    default=[str(DUPE_ROOT), DEFAULT_GATHER_ROOT])
    ap.add_argument("--library", default=str(LIBRARY_ROOT))
    ap.add_argument("--limit", type=int, default=0,
                    help="cap library files hashed (0 = all)")
    ap.add_argument("--engine", choices=["v1", "v2", "both"], default="v1",
                    help="v1 straggler scan (default) | v2 incremental "
                         "cluster engine | both")
    ap.add_argument("--rebuild", action="store_true",
                    help="v2 FULL rebuild (CLI-only, explicit opt-in): drops "
                         "this engine's own UNRESOLVED families and rescans; "
                         "resolved/committed families are protected")
    args = ap.parse_args(argv)
    roots = [{"label": f"root{i}", "root": r} for i, r in enumerate(args.roots)]
    if args.rebuild or args.engine in ("v2", "both"):
        from . import cluster_engine as ce
        from .routers import dupe as dr
        verdicts = dr._verdicts()
        protected = {f["id"] for f in dr._index().get("families", [])
                     if dr._family_state(f["id"], verdicts) == "resolved"}
        if args.engine == "both":
            v1 = scan_stragglers(roots, DUPE_ROOT, DUPE_DATA, LEDGER,
                                 Path(args.library), library_limit=args.limit)
            print(json.dumps(v1, indent=1))
        ce.apply_decisions(DUPE_ROOT, DUPE_DATA, dr._proposal_decisions(verdicts))
        v2 = ce.scan_incremental(
            roots, DUPE_ROOT, DUPE_DATA, skip_paths=ledger_paths(LEDGER, DUPE_ROOT),
            protected_ids=protected, rebuild=args.rebuild,
            progress=lambda p: print(f"\r{p['phase']} {p['done']}/{p['total']}",
                                     end="", flush=True))
        print()
        print(json.dumps(v2, indent=1))
        return
    summary = scan_stragglers(roots, DUPE_ROOT, DUPE_DATA, LEDGER,
                              Path(args.library), library_limit=args.limit,
                              progress=lambda p: print(
                                  f"\r{p['phase']} {p['done']}/{p['total']}",
                                  end="", flush=True))
    print()
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
