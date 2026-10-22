"""Cluster engine v2 (inc.3, 2026-10-22) — Meld's supplementary signal.

DESIGN-inc3-cluster-engine.md rev.2 is the authority. In short:

  * ``dupe_scan.py`` stays the PRIMARY engine (T1/T2 over the 64-bit dhash +
    64-bit-incl-DC phash). This module ADDS signal on top of it: a DC-dropped
    63-bit phash variant, a 16x16 coarse style signature (Pearson r), chunked
    Hamming, dual edge sets, greedy 1:1 pairing and union-find clustering.
  * Trap (a), d==0: ``pair_edges`` exclude d==0 per channel (merging identical
    images is a no-op) but ``cluster_edges`` INCLUDE it, so identical twins
    always share a family. Two sets, one distance computation.
  * Trap (b), queue invariant: this module only WRITES family JSONs + its own
    ``index.json`` rows. It never reads or writes the verdict ledger and never
    computes resolved/unresolved — ``routers.dupe._family_state`` stays the
    sole resolver. Everything that needs ledger knowledge (paths to skip,
    which proposals were ruled on, which families are protected during a
    rebuild) is handed IN by the caller as plain data.
  * Incremental (RULED): only files not already claimed by some family are
    scanned; existing families are never rewritten. A new file near-duplicating
    a member of EXACTLY ONE existing family becomes a *proposal* family
    (``proposed_merge`` annotation) — the committed family is untouched.
  * PIL/numpy only (G3: no OpenCV).

Hash dialects: the existing 64-bit phash (incl DC) and the 63-bit DC-dropped
phash are DIFFERENT hashes. The 63-bit one is a distinct type (``Phash63``)
and every comparison across dialects raises ``TypeError``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

from . import dupe_scan as ds

log = logging.getLogger("ellieedit.cluster_engine")

SOURCE_V2 = "cluster-engine-v2"
SCHEMA_VERSION = 2            # bump to retire every cached v2 row wholesale

# Meld defaults (SALVAGE §5 via design §2).
DHASH_TOL = 6                 # /64
PHASH63_TOL = 10              # /63
STYLE_MIN = 0.7               # ships conservative (Meld: 0.55) — RULED
STYLE_MAX = 0.999             # r above this = identical structure, hash job
CH = 512                      # chunk rows for the pairwise passes
COARSE = 16
COARSE_DIM = COARSE * COARSE

# tier vocabulary (existing: exact > near-identical > regional; "style" new)
TIER_EXACT, TIER_NEAR, TIER_REGIONAL, TIER_STYLE = (
    "exact", "near-identical", "regional", "style")
_TIER_BY_CODE = {0: TIER_EXACT, 1: TIER_NEAR, 2: TIER_REGIONAL, 3: TIER_STYLE}


# ---------------------------------------------------------------- dialects

class Phash63(int):
    """63-bit DC-dropped phash. Never comparable with the 64-bit phash."""


def hamming63(a: Phash63, b: Phash63) -> int:
    if not (isinstance(a, Phash63) and isinstance(b, Phash63)):
        raise TypeError("hamming63 compares Phash63 values only — the 63-bit "
                        "DC-dropped hash and the 64-bit phash are different "
                        "dialects and are never compared")
    return bin(int(a) ^ int(b)).count("1")


def hamming64(a: int, b: int) -> int:
    if isinstance(a, Phash63) or isinstance(b, Phash63):
        raise TypeError("hamming64 refuses Phash63 — mixed-dialect distance")
    return bin(int(a) ^ int(b)).count("1")


# ----------------------------------------------------------------- hashing

def phash63(img) -> Phash63:
    """Meld's phash: 32x32 DCT, 8x8 low block, DROP the DC term, threshold
    the remaining 63 coefficients at their median."""
    low = ds.dct_low(img).flatten()[1:]
    bits = (low > np.median(low)).astype(np.uint8)
    padded = np.concatenate([np.zeros(1, np.uint8), bits])      # 64 -> top bit 0
    return Phash63(int(np.packbits(padded).tobytes().hex(), 16))


def coarse_sig(img) -> np.ndarray:
    """16x16 blurred grayscale, mean-centred, L2-normalised float32 (256,).
    dot(a, b) == Pearson r. A flat image has no variance: zero vector, so it
    correlates with nothing (r=0) instead of producing NaN."""
    g = img.convert("L").resize((32, 32), Image.BOX)
    g = g.filter(ImageFilter.GaussianBlur(1.0)).resize((COARSE, COARSE), Image.BOX)
    a = np.asarray(g, dtype=np.float32).reshape(-1)
    a = a - a.mean()
    n = float(np.linalg.norm(a))
    return (a / n).astype(np.float32) if n > 1e-6 else np.zeros(COARSE_DIM, np.float32)


def hash_file_v2(path: Path) -> dict:
    """All four signals from ONE open/decode. dhash+phash are the primary
    engine's own functions, so parity with dupe_scan.hash_file is exact."""
    with Image.open(path) as _h:
        img = _h
        try:
            img.draft("L", (64, 64))
        except Exception:
            pass
        img = ImageOps.exif_transpose(img)
        return {"dhash": ds.dhash(img), "phash": ds.phash(img),
                "phash63": phash63(img), "coarse": coarse_sig(img)}


def coarse_b64(c: np.ndarray) -> str:
    return base64.b64encode(np.asarray(c, np.float32).tobytes()).decode()


def coarse_from_b64(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=np.float32).copy()


# ------------------------------------------------------------- cache store

class StoreV2:
    """v2 signal cache. A SIBLING table in the same cache.db (``hashes_v2``),
    not new columns on dupelib's shared ``hashes`` table — dupelib's INSERT
    OR REPLACE would silently null added columns and the canonical db's
    contract stays untouched (deviation D2).

    A row is valid only if size+mtime match AND schema == SCHEMA_VERSION AND
    every v2 field is present and well-formed (SALVAGE §5.9 presence guard):
    anything else means *recompute*, never an error."""

    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.con = sqlite3.connect(str(db_path))
        self.con.execute("CREATE TABLE IF NOT EXISTS store_meta "
                         "(k TEXT PRIMARY KEY, v INTEGER NOT NULL)")
        self.con.execute(
            "CREATE TABLE IF NOT EXISTS hashes_v2 ("
            " path TEXT PRIMARY KEY, size INTEGER NOT NULL,"
            " mtime INTEGER NOT NULL, schema INTEGER,"
            " dhash INTEGER, phash INTEGER, phash63 INTEGER, coarse BLOB)")
        row = self.con.execute(
            "SELECT v FROM store_meta WHERE k='schema'").fetchone()
        if row is None or row[0] != SCHEMA_VERSION:
            # header mismatch retires old rows wholesale (no per-field probing)
            self.con.execute("DELETE FROM hashes_v2")
            self.con.execute("INSERT OR REPLACE INTO store_meta(k,v) "
                             "VALUES('schema',?)", (SCHEMA_VERSION,))
        self.con.commit()

    def get(self, key: str, size: int, mtime: int) -> dict | None:
        r = self.con.execute(
            "SELECT size, mtime, schema, dhash, phash, phash63, coarse "
            "FROM hashes_v2 WHERE path=?", (key,)).fetchone()
        if not r or r[0] != size or r[1] != mtime or r[2] != SCHEMA_VERSION:
            return None
        if any(v is None for v in r[3:]) or len(r[6]) != COARSE_DIM * 4:
            return None                                  # missing field -> recompute
        return {"dhash": ds._from_s64(r[3]), "phash": ds._from_s64(r[4]),
                "phash63": Phash63(r[5]),
                "coarse": np.frombuffer(r[6], dtype=np.float32).copy()}

    def put(self, key: str, size: int, mtime: int, h: dict):
        self.con.execute(
            "INSERT OR REPLACE INTO hashes_v2"
            "(path,size,mtime,schema,dhash,phash,phash63,coarse) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (key, size, mtime, SCHEMA_VERSION, ds._to_s64(h["dhash"]),
             ds._to_s64(h["phash"]), int(h["phash63"]),
             np.asarray(h["coarse"], np.float32).tobytes()))

    def commit(self):
        self.con.commit()

    def close(self):
        self.con.close()


# ------------------------------------------------------- distances & edges

_POP8 = np.array([bin(i).count("1") for i in range(256)], dtype=np.int32)


def _popcount(x: np.ndarray) -> np.ndarray:
    if hasattr(np, "bitwise_count"):
        return np.bitwise_count(x).astype(np.int32)
    b = np.ascontiguousarray(x).view(np.uint8).reshape(x.shape + (8,))
    return _POP8[b].sum(axis=-1).astype(np.int32)


def compute_edges(dh, ph, p63, coarse, *, chunk: int = CH):
    """One chunked distance pass -> (cluster_edges, pair_candidates).

    cluster_edges: [(i, j, tier_code)] i<j — union-find input. INCLUDES d==0.
    pair_candidates: [(key, i, j, mode, distance, tier)] i<j — greedy-pair
    input. Per-channel ``d >= 1`` (trap a): identical images yield NONE.

    Channels (any one makes a cluster edge):
      primary  T1/T2/exact over 64-bit dhash + 64-bit phash (dupe_scan tiers)
      dhash    64-bit dhash distance <= 6
      phash63  63-bit DC-dropped phash distance <= 10
      style    0.7 <= Pearson r <= 0.999 on the 16x16 coarse signature
    """
    dh = np.asarray(dh, dtype=np.uint64)
    ph = np.asarray(ph, dtype=np.uint64)
    p63 = np.asarray(p63, dtype=np.uint64)
    coarse = np.asarray(coarse, dtype=np.float32).reshape(len(dh), COARSE_DIM)
    n = len(dh)
    cluster, cands = [], []
    cols = np.arange(n)[None, :]
    for i0 in range(0, n, chunk):
        i1 = min(n, i0 + chunk)
        dd = _popcount(dh[i0:i1, None] ^ dh[None, :])
        pd = _popcount(ph[i0:i1, None] ^ ph[None, :])
        p3 = _popcount(p63[i0:i1, None] ^ p63[None, :])
        r = coarse[i0:i1] @ coarse.T
        upper = cols > np.arange(i0, i1)[:, None]
        exact = (dd == 0) & (pd == 0)
        t1 = (dd <= ds.T1_DHASH) & (pd <= ds.T1_PHASH_MAX) & ~exact
        t2 = (pd <= ds.T2_MIN) & (dd <= ds.T2_DHASH_MAX) & ~t1 & ~exact
        dh_ok = dd <= DHASH_TOL
        p3_ok = p3 <= PHASH63_TOL
        st_ok = (r >= STYLE_MIN) & (r <= STYLE_MAX)
        any_edge = upper & (exact | t1 | t2 | dh_ok | p3_ok | st_ok)
        # tier code: exact 0 > near 1 > regional 2 (T2 or supplementary hash)
        # > style 3
        code = np.full(dd.shape, 3, dtype=np.int8)
        code[dh_ok | p3_ok | t2] = 2
        code[t1] = 1
        code[exact] = 0
        # pair candidates: d>=1 per channel
        dh_pair = (dd >= 1) & dh_ok
        p3_pair = (p3 >= 1) & p3_ok
        hash_pair = dh_pair | p3_pair
        st_pair = st_ok & ~hash_pair
        for a, b in zip(*np.nonzero(any_edge)):
            gi = int(a) + i0
            cluster.append((gi, int(b), int(code[a, b])))
        for a, b in zip(*np.nonzero(upper & (hash_pair | st_pair))):
            gi, gj = int(a) + i0, int(b)
            if hash_pair[a, b]:
                kd = dd[a, b] / 64.0 if dh_pair[a, b] else np.inf
                kp = p3[a, b] / 63.0 if p3_pair[a, b] else np.inf
                if kd <= kp:
                    mode, dist, key = "dhash", int(dd[a, b]), float(kd)
                else:
                    mode, dist, key = "phash", int(p3[a, b]), float(kp)
                tier = _TIER_BY_CODE[int(code[a, b])]
            else:
                mode, dist = "style", round(float(r[a, b]), 4)
                key, tier = 1.0 + (1.0 - float(r[a, b])), TIER_STYLE
            cands.append((key, gi, gj, mode, dist, tier))
    return cluster, cands


def greedy_pairs(cands) -> list[dict]:
    """Greedy 1:1: ascending key, take a pair only if BOTH endpoints are
    still free. Deterministic (ties by index)."""
    used: set[int] = set()
    out = []
    for key, i, j, mode, dist, tier in sorted(cands, key=lambda c: (c[0], c[1], c[2])):
        if i in used or j in used:
            continue
        used.update((i, j))
        out.append({"a": i, "b": j, "tier": tier, "mode": mode,
                    "distance": dist})
    return out


def union_find_groups(n: int, cluster_edges) -> list[list[int]]:
    """Connected components over cluster_edges; groups of >=2 only, each
    sorted, ordered by first member (deterministic)."""
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j, _ in cluster_edges:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return sorted((sorted(g) for g in groups.values() if len(g) > 1),
                  key=lambda g: g[0])


# ------------------------------------------------- existing-family matching

def _abs_of(m: dict, dupe_root: Path) -> str:
    rel = str(m.get("abs_path") or m.get("path", "")).replace("\\", "/")
    if not rel:
        return ""
    p = Path(rel)
    return str(p.resolve()) if p.is_absolute() else str((dupe_root / rel.lstrip("/")).resolve())


def _hex_int(v) -> int | None:
    try:
        return int(str(v), 16)
    except (TypeError, ValueError):
        return None


def load_existing_members(families_dir: Path, dupe_root: Path) -> list[dict]:
    """Hashes of every existing family member, for new-file matching. Proposal
    families (``proposed_merge``) are excluded: a pending proposal is not an
    established family to propose merging into. Members without parseable
    64-bit hashes are skipped (cannot be compared)."""
    out = []
    if not families_dir.is_dir():
        return out
    for p in sorted(families_dir.glob("fam-*.json")):
        try:
            fam = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if fam.get("proposed_merge"):
            continue
        for m in fam.get("members", []):
            dh, ph = _hex_int(m.get("dhash")), _hex_int(m.get("phash"))
            if dh is None or ph is None:
                continue
            out.append({"fid": fam.get("id", p.stem), "dhash": dh, "phash": ph,
                        "path": m.get("path", ""), "abs": _abs_of(m, dupe_root)})
    return out


def match_existing(pool: list[dict], existing: list[dict],
                   *, chunk: int = CH) -> list[dict[str, dict]]:
    """Per pool item: {family_id: {distance, member}} of its best match in
    each existing family under the primary T1/T2/exact predicate or dhash<=6
    (the supplementary channels that exist for existing members — style
    needs a coarse signature the family JSONs don't carry; deviation D4)."""
    res: list[dict[str, dict]] = [dict() for _ in pool]
    if not pool or not existing:
        return res
    ed = np.array([e["dhash"] for e in existing], dtype=np.uint64)
    ep = np.array([e["phash"] for e in existing], dtype=np.uint64)
    pdh = np.array([it["dhash"] for it in pool], dtype=np.uint64)
    pph = np.array([it["phash"] for it in pool], dtype=np.uint64)
    for i0 in range(0, len(pool), chunk):
        i1 = min(len(pool), i0 + chunk)
        dd = _popcount(pdh[i0:i1, None] ^ ed[None, :])
        pd = _popcount(pph[i0:i1, None] ^ ep[None, :])
        exact = (dd == 0) & (pd == 0)
        t1 = (dd <= ds.T1_DHASH) & (pd <= ds.T1_PHASH_MAX)
        t2 = (pd <= ds.T2_MIN) & (dd <= ds.T2_DHASH_MAX)
        hit = exact | t1 | t2 | (dd <= DHASH_TOL)
        for a, b in zip(*np.nonzero(hit)):
            e = existing[int(b)]
            d = int(dd[a, b])
            cur = res[i0 + int(a)].get(e["fid"])
            if cur is None or d < cur["distance"]:
                res[i0 + int(a)][e["fid"]] = {
                    "distance": d, "member": e["path"], "abs": e["abs"]}
    return res


# ------------------------------------------------------------- index I/O

def _read_index(dupe_data: Path) -> dict:
    try:
        return json.loads((dupe_data / "index.json").read_text())
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "generated": "", "families": [], "stats": {}}


def _write_index(dupe_data: Path, idx: dict):
    idx["generated"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    p = dupe_data / "index.json"
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(idx, indent=1))
    tmp.replace(p)                                    # atomic


def _family_id(abs_paths) -> str:
    return "fam-" + hashlib.sha256("|".join(sorted(abs_paths)).encode()).hexdigest()[:12]


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ------------------------------------------------------------- the scan

def scan_incremental(roots: list[dict], dupe_root: Path, dupe_data: Path,
                     skip_paths=frozenset(), *,
                     exclude_dirs: set[str] = frozenset({".dupes"}),
                     protected_ids=frozenset(), rebuild: bool = False,
                     progress=None) -> dict:
    """Incremental v2 pass. roots: [{label, root, exclude_dirs?}].

    Only files NOT claimed by any existing family (any source) and not in
    ``skip_paths`` (caller-supplied, e.g. ledger-referenced paths) are
    scanned. Existing family files and index rows are never modified; new
    rows are appended under source ``cluster-engine-v2``. Idempotent.

    rebuild=True (CLI only) first discards this engine's OWN families except
    ``protected_ids`` (the caller's resolved/committed ids), then scans.
    """
    t0 = time.time()
    families_dir = dupe_data / "families"
    families_dir.mkdir(parents=True, exist_ok=True)
    idx = _read_index(dupe_data)
    dropped = 0
    if rebuild:
        keep, drop_ids = [], set()
        for f in idx.get("families", []):
            if f.get("source") == SOURCE_V2 and f["id"] not in protected_ids:
                drop_ids.add(f["id"])
            else:
                keep.append(f)
        for fid in drop_ids:
            try:
                (families_dir / f"{fid}.json").unlink()
            except OSError:
                pass
        idx["families"] = keep
        dropped = len(drop_ids)

    def step(phase, done, total, label=""):
        if progress:
            progress({"phase": phase, "done": done, "total": total, "label": label})

    claimed = ds.family_member_paths(families_dir, dupe_root) | set(skip_paths)
    store = StoreV2(dupe_data / "cache.db")
    pool: list[dict] = []
    per_root: dict[str, dict] = {}
    try:
        for spec in roots:
            label, root = spec["label"], Path(spec["root"])
            excl = set(spec.get("exclude_dirs", set())) | set(exclude_dirs)
            files = ds.collect_images(root, excl) if root.is_dir() else []
            hashed = resumed = excluded = 0
            for i, f in enumerate(files):
                step(f"hash:{label}", i, len(files), label)
                absr = str(f.resolve())
                if absr in claimed:
                    excluded += 1
                    continue
                try:
                    st = f.stat()
                except OSError:
                    continue
                rel = f.relative_to(root).as_posix() if f.is_relative_to(root) else str(f)
                key = f"{label}:{rel}"
                h = store.get(key, st.st_size, int(st.st_mtime))
                if h:
                    resumed += 1
                else:
                    try:
                        h = hash_file_v2(f)
                    except Exception as e:
                        log.warning("unhashable %s: %s", f, e)
                        continue
                    store.put(key, st.st_size, int(st.st_mtime), h)
                    hashed += 1
                pool.append({**h, "size": st.st_size, "mtime": int(st.st_mtime),
                             "abs": absr, "rel": rel, "root_label": label,
                             "jailed": label == "dupe"})
            per_root[label] = {"files": len(files), "hashed": hashed,
                               "resumed": resumed, "excluded": excluded}
            store.commit()
    finally:
        store.close()

    pool.sort(key=lambda it: it["abs"])               # deterministic order
    n = len(pool)
    cluster_edges, cands = compute_edges(
        [it["dhash"] for it in pool], [it["phash"] for it in pool],
        [int(it["phash63"]) for it in pool],
        np.array([it["coarse"] for it in pool], dtype=np.float32)
        if n else np.zeros((0, COARSE_DIM), np.float32))
    groups = union_find_groups(n, cluster_edges)
    pairs = greedy_pairs(cands)
    grouped = {i for g in groups for i in g}
    matches = match_existing(pool, load_existing_members(families_dir, dupe_root))

    # proposals for singletons that match exactly one existing family
    units = [g for g in groups] + [[i] for i in range(n) if i not in grouped]
    existing_ids = {f["id"] for f in idx.get("families", [])}
    new_rows, n_fam, n_prop = [], 0, 0
    for g in units:
        fams: dict[str, dict] = {}
        for i in g:
            for fid, m in matches[i].items():
                if fid not in fams or m["distance"] < fams[fid]["distance"]:
                    fams[fid] = {**m, "new": pool[i]}
        proposal = None
        if len(fams) == 1:                            # ambiguity rule: >1 => none
            fid, m = next(iter(fams.items()))
            proposal = {"family_id": fid, "matched_member": m["member"],
                        "distance": m["distance"],
                        "new_member": (m["new"]["rel"] if m["new"]["jailed"]
                                       else m["new"]["abs"])}
        if len(g) == 1 and proposal is None:
            continue                                   # lone, unmatched: no family
        members_it = [pool[i] for i in g]
        pos = {i: k for k, i in enumerate(g)}
        edges = [{**e, "a": pos[e["a"]], "b": pos[e["b"]]}
                 for e in pairs if e["a"] in pos and e["b"] in pos]
        tiers = sorted({_TIER_BY_CODE[c] for a, b, c in cluster_edges
                        if a in pos and b in pos})
        if proposal and not tiers:
            tiers = [TIER_REGIONAL]
        fid_new = _family_id(m["abs"] for m in members_it)
        if fid_new in existing_ids or (families_dir / f"{fid_new}.json").exists():
            continue                                   # never rewrite
        members = [{
            "path": m["rel"] if m["jailed"] else m["abs"], "abs_path": m["abs"],
            "size": m["size"], "mtime": m["mtime"],
            "dhash": ds.hex64(m["dhash"]), "phash": ds.hex64(m["phash"]),
            "phash63": ds.hex64(int(m["phash63"])), "root": m["root_label"],
        } for m in members_it]
        fam = {"format": "dupe-analyzer.family", "version": 1, "id": fid_new,
               "created": _now(), "root": str(dupe_root), "authored": False,
               "source": SOURCE_V2, "engine_schema": SCHEMA_VERSION,
               "library_matches": 0, "tiers": tiers, "members": members,
               "edges": edges}
        row = {"id": fid_new, "size": len(members), "tiers": tiers,
               "first_member": members[0]["path"], "authored": False,
               "source": SOURCE_V2, "library_matches": 0}
        if proposal:
            fam["proposed_merge"] = proposal
            row["proposed_merge"] = {"family_id": proposal["family_id"],
                                     "distance": proposal["distance"]}
            n_prop += 1
        (families_dir / f"{fid_new}.json").write_text(json.dumps(fam, indent=1))
        new_rows.append(row)
        existing_ids.add(fid_new)
        n_fam += 1
    step("write", n_fam, n_fam)
    if new_rows or dropped:
        idx["families"] = idx.get("families", []) + new_rows
        _write_index(dupe_data, idx)
    return {"per_root": per_root, "pool": n, "families": n_fam,
            "proposals": n_prop, "pairs": len(pairs), "rebuild_dropped": dropped,
            "seconds": round(time.time() - t0, 1)}


# ------------------------------------------------ proposal merge (§3c.3)

def apply_decisions(dupe_root: Path, dupe_data: Path, decisions: dict[str, str]) -> dict:
    """Materialise ruled proposals. decisions: {proposal_family_id: action}
    supplied by the caller from the ledger (this module never reads it).
    Only action "merge" does work: a NEW family = the target family's members
    (verbatim, same order so its positional edges stay valid) + the proposal's
    members, under its content-derived id. The old target family file and id
    are untouched (its resolved ledger entry stays); the merged id is
    unresolved, i.e. membership change = re-review (accepted cost, §3b).
    Idempotent: an existing merged id is left alone."""
    families_dir = dupe_data / "families"
    done, skipped = [], []
    idx = None
    for pid, action in decisions.items():
        if action != "merge":
            continue
        try:
            prop = json.loads((families_dir / f"{pid}.json").read_text())
            pm = prop["proposed_merge"]
            target = json.loads((families_dir / f"{pm['family_id']}.json").read_text())
        except (OSError, json.JSONDecodeError, KeyError):
            skipped.append(pid)
            continue
        tm, pmem = target.get("members", []), prop.get("members", [])
        merged = tm + pmem
        abs_paths = [_abs_of(m, dupe_root) for m in merged]
        fid = _family_id(abs_paths)
        path = families_dir / f"{fid}.json"
        if path.exists():
            skipped.append(pid)
            continue
        edges = list(target.get("edges", []))
        off = len(tm)
        edges += [{**e, "a": e["a"] + off, "b": e["b"] + off}
                  for e in prop.get("edges", [])
                  if isinstance(e.get("a"), int) and isinstance(e.get("b"), int)]
        mi = next((k for k, m in enumerate(tm)
                   if m.get("path") == pm.get("matched_member")), None)
        if mi is not None and pmem:
            edges.append({"a": mi, "b": off, "tier": TIER_REGIONAL,
                          "mode": "proposal", "distance": pm.get("distance")})
        tiers = sorted(set(target.get("tiers", [])) | set(prop.get("tiers", [])))
        fam = {"format": "dupe-analyzer.family", "version": 1, "id": fid,
               "created": _now(), "root": str(dupe_root), "authored": False,
               "source": SOURCE_V2, "engine_schema": SCHEMA_VERSION,
               "library_matches": sum(1 for m in merged if m.get("library_match")),
               "tiers": tiers, "members": merged, "edges": edges,
               "merged_from": {"proposal": pid, "family": pm["family_id"]}}
        path.write_text(json.dumps(fam, indent=1))
        if idx is None:
            idx = _read_index(dupe_data)
        idx["families"].append({
            "id": fid, "size": len(merged), "tiers": tiers,
            "first_member": merged[0].get("path", ""), "authored": False,
            "source": SOURCE_V2, "library_matches": fam["library_matches"]})
        done.append(fid)
    if idx is not None:
        _write_index(dupe_data, idx)
    return {"merged": done, "skipped": skipped}
