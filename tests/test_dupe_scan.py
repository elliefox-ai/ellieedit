"""Straggler scan tests (2026-10-09g) — import-front-door pass.

Seeded scratch roots (real Pillow images) prove: exclusion rules (.dupes,
ledger-referenced, already-family), hash resume (mtime change re-hashes),
clustering into provenance-marked families, library-match linkage that is
reference-only, and an untouched ledger.
"""

import json
import os
from pathlib import Path

import pytest
from PIL import Image

from backend import dupe_scan as ds


def _png(path: Path, kind="v", period=6):
    """Structured image — stripes/diagonals at a given period. Solid colors
    and pure gradients all hash identically, which would collapse every
    fixture into one cluster; distinct structures stay far apart."""
    path.parent.mkdir(parents=True, exist_ok=True)
    size = (48, 48)
    img = Image.new("L", size)
    px = img.load()
    for y in range(size[1]):
        for x in range(size[0]):
            if kind == "v":
                v = 255 * ((x // period) % 2)
            elif kind == "h":
                v = 255 * ((y // period) % 2)
            elif kind == "diag":
                v = 255 * (((x + y) // period) % 2)
            else:                                   # checker
                v = 255 * (((x // period) + (y // period)) % 2)
            px[x, y] = v
    img.convert("RGB").save(path)


def _mutate(path: Path, kind="checker"):
    """Rewrite a file's pixels AND bump its mtime — the re-hash test."""
    _png(path, kind)
    st = os.stat(path)
    os.utime(path, (st.st_atime, st.st_mtime + 100))


def _tweak(src: Path, dst: Path, seed=0):
    """Near-dupe of src: copy with one pixel's R/B nudged — a real-file
    difference (different bytes, mtime, and size) that stays inside the
    exact/T1 hash window."""
    from PIL import Image as _I
    img = _I.open(src).convert("RGB")
    px = img.load()
    r, g, b = px[1, 1]
    px[1, 1] = (max(0, r - 20), g, min(255, b + 20))
    img.save(dst)


@pytest.fixture
def world(tmp_path):
    dupe = tmp_path / "DupeReview"
    gather = tmp_path / "gather"
    lib = tmp_path / "Library"
    data = dupe / ".dupes"
    (data / "families").mkdir(parents=True)
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text("")
    # near-dupes inside the pool (should cluster): base + tweaked copy
    _png(dupe / "a1.png", "v", 6)
    _tweak(dupe / "a1.png", dupe / "a2.png")
    # a unique image (no cluster) — different structure + period
    _png(dupe / "solo.png", "h", 13)
    # cache dir + ledger-referenced file must be excluded
    _png(data / "cached-thumb.png", "v", 6)
    _png(dupe / "judged.png", "v", 6)
    ledger.write_text(json.dumps(
        {"family": "fam-aaaaaaaaaaaa", "members": {"judged.png": "kept"}}) + "\n")
    # an already-family file (existing canonical family)
    _png(dupe / "infamily.png", "v", 6)
    fam = {
        "format": "dupe-analyzer.family", "version": 1,
        "id": "fam-bbbbbbbbbbbb", "created": "x", "root": str(dupe),
        "authored": False,
        "members": [{"path": "infamily.png", "size": 1, "mtime": 1,
                     "dhash": "0" * 16, "phash": "0" * 16}],
    }
    (data / "families" / "fam-bbbbbbbbbbbb.json").write_text(json.dumps(fam))
    idx = {"version": 1, "generated": "old", "families": [
        {"id": "fam-bbbbbbbbbbbb", "size": 1, "tiers": ["exact"],
         "first_member": "infamily.png", "authored": False}], "stats": {}}
    (data / "index.json").write_text(json.dumps(idx))
    # second root: a near-dupe pair of its own (different structure)
    _png(gather / "g1.png", "diag", 5)
    _tweak(gather / "g1.png", gather / "g2.png")
    # library: an exact copy of a1 (reference match) + an unrelated file
    _png(lib / "copy-of-a1.png", "v", 6)
    _png(lib / "unrelated.png", "checker", 4)
    return {
        "dupe": dupe, "gather": gather, "lib": lib, "data": data,
        "ledger": ledger,
    }


def _run(world, **kw):
    return ds.scan_stragglers(
        [{"label": "dupe", "root": str(world["dupe"]),
          "exclude_dirs": {".dupes"}},
         {"label": "gather", "root": str(world["gather"])}],
        world["dupe"], world["data"], world["ledger"], world["lib"],
        library_limit=kw.pop("library_limit", 0), **kw)


def test_exclusions_and_families(world):
    s = _run(world)
    # exclusions: .dupes dir pruned before collection (cached-thumb never
    # counted); ledger-referenced + already-family files excluded after.
    assert s["per_root"]["dupe"]["files"] == 5      # a1 a2 solo judged infamily
    assert s["per_root"]["dupe"]["excluded"] == 2   # judged (ledger) + infamily (family)
    assert s["families"] == 2                       # {a1,a2} and {g1,g2}
    # solo.png clustered with nothing
    fams = list((world["data"] / "families").glob("fam-*.json"))
    strag = [json.loads(p.read_text()) for p in fams]
    strag = [f for f in strag if f.get("source") == ds.SOURCE]
    all_paths = {m["path"] for f in strag for m in f["members"]}
    assert "solo.png" not in all_paths
    assert {"a1.png", "a2.png"} <= all_paths
    # provenance marker + index surfacing
    for f in strag:
        assert f["source"] == "straggler-scan"
    idx = json.loads((world["data"] / "index.json").read_text())
    srcs = [f.get("source") for f in idx["families"]]
    assert srcs.count("straggler-scan") == 2
    assert any(f["id"] == "fam-bbbbbbbbbbbb" for f in idx["families"])
    # gather-root members surface with absolute paths (outside the jail)
    for f in strag:
        if any(m.get("root") == "gather" for m in f["members"]):
            assert all(os.path.isabs(m["path"])
                       for m in f["members"] if m["root"] == "gather")


def test_ledger_untouched(world):
    before = world["ledger"].read_text()
    _run(world)
    assert world["ledger"].read_text() == before


def test_library_match_reference_only(world):
    s = _run(world)
    assert s["library_matches"] >= 1
    strag = [json.loads(p.read_text())
             for p in (world["data"] / "families").glob("fam-*.json")]
    strag = [f for f in strag if f.get("source") == ds.SOURCE]
    matched = [m for f in strag for m in f["members"] if "library_match" in m]
    assert matched
    m = matched[0]
    assert m["library_match"]["library_path"] == "copy-of-a1.png"
    # library file untouched, and the library path is a REFERENCE — the
    # member stays a DupeReview path, never the library path
    assert (world["lib"] / "copy-of-a1.png").is_file()
    assert not m["path"].startswith(str(world["lib"]))


def test_resume_rehash_on_mtime_change(world):
    s1 = _run(world)
    first = s1["per_root"]["dupe"]
    # full rerun: everything resumes from the store
    s2 = _run(world)
    assert s2["per_root"]["dupe"]["resumed"] == first["hashed"]
    assert s2["per_root"]["dupe"]["hashed"] == first["hashed"]
    # mutate a file + bump mtime: it must RE-hash (resume key is path+mtime+size)
    _mutate(world["dupe"] / "a1.png")
    s3 = _run(world)
    assert s3["per_root"]["dupe"]["resumed"] == first["hashed"] - 1
    assert s3["per_root"]["dupe"]["hashed"] == first["hashed"]


def test_rescan_replaces_straggler_families(world):
    _run(world)
    # add another near-dupe pair, rescan: old straggler families replaced
    _png(world["dupe"] / "n1.png", "checker", 7)
    _tweak(world["dupe"] / "n1.png", world["dupe"] / "n2.png")
    s = _run(world)
    idx = json.loads((world["data"] / "index.json").read_text())
    srcs = [f.get("source") for f in idx["families"]]
    assert srcs.count("straggler-scan") == s["families"] == 3
    # the canonical family survives every rescan
    assert srcs.count(None) == 1


def test_thresholds_reject_far_pairs():
    # same scanner thresholds; bit patterns with known popcounts
    H9 = (1 << 9) - 1          # 9 bits set
    H21 = (1 << 21) - 1        # 21 bits set
    assert ds.pair_edge(0, 0, 0, 0) == "exact"
    assert ds.pair_edge(0, 0, 0xFF, (1 << 63)) == "near-identical"   # dh8/ph1
    assert ds.pair_edge(0, 0, H9, H21) is None          # dh9/ph21: no edge
    assert ds.pair_edge(0, 0, 0xFFF, 0xFFF) == "regional"            # dh12/ph12
    assert ds.pair_edge(0, 0, 0xFFFFF, 0xFFF) == "regional"          # ph-only arm
    assert ds.pair_edge(0, 0, 0x1FFFFF, 0xFFF) is None  # dh21: past the cap
    assert ds.pair_edge(0, 0, H21, H21) is None


# ------------------------------------------------------- endpoint surface

def test_endpoint_inline_and_filter(tmp_path, monkeypatch):
    """POST /api/dupe/scan-stragglers inline mode: creates provenance-marked
    families that /families?source=straggler surfaces and the plain listing
    marks; the ledger stays untouched."""
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend.routers import dupe as dupe_mod
    from backend.routers import library as lib_mod

    dupe = tmp_path / "DupeReview"
    lib = tmp_path / "Library"
    data = dupe / ".dupes"
    (data / "families").mkdir(parents=True)
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text("")
    _png(dupe / "a1.png", "v", 6)
    _tweak(dupe / "a1.png", dupe / "a2.png")
    _png(lib / "copy.png", "v", 6)
    (lib / ".library-index.jsonl").write_text("")
    idx = {"version": 1, "generated": "old", "families": [], "stats": {}}
    (data / "index.json").write_text(json.dumps(idx))

    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", dupe)
    monkeypatch.setattr(dupe_mod, "DUPE_DATA", data)
    monkeypatch.setattr(dupe_mod, "LEDGER", ledger)
    monkeypatch.setattr(lib_mod, "LIBRARY_ROOT", lib)
    c = TestClient(app)

    r = c.post("/api/dupe/scan-stragglers", json={"roots": [str(dupe)]})
    assert r.status_code == 200, r.text
    s = r.json()["summary"]
    assert s["families"] == 1
    assert ledger.read_text() == ""

    st = c.get("/api/dupe/scan-stragglers/status").json()
    assert st["running"] is False and st["last"]["families"] == 1

    # the straggler filter narrows to exactly the new family
    rows = c.get("/api/dupe/families",
                 params={"state": "all", "source": "straggler"}).json()
    assert rows["total"] == 1 and rows["items"][0]["source"] == "straggler-scan"
    card = rows["items"][0]
    assert card["library_matches"] >= 1
    # preview member carries the read-only library reference
    m = card["members"][0]
    assert m["member_state"] == "library" and m["library_path"] == "copy.png"
    # plain listing still surfaces it (with provenance fields present)
    plain = c.get("/api/dupe/families", params={"state": "all"}).json()
    assert plain["total"] == 1
    assert plain["items"][0]["source"] == "straggler-scan"


def test_endpoint_busy_guard(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend.routers import dupe as dupe_mod
    from backend.routers import library as lib_mod
    dupe = tmp_path / "DupeReview"
    (dupe / ".dupes" / "families").mkdir(parents=True)
    (dupe / "index.json").touch()
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text("")
    monkeypatch.setattr(dupe_mod, "DUPE_ROOT", dupe)
    monkeypatch.setattr(dupe_mod, "DUPE_DATA", dupe / ".dupes")
    monkeypatch.setattr(dupe_mod, "LEDGER", ledger)
    monkeypatch.setattr(lib_mod, "LIBRARY_ROOT", tmp_path / "lib")
    dupe_mod._straggler_state["running"] = True
    try:
        c = TestClient(app)
        r = c.post("/api/dupe/scan-stragglers", json={"roots": [str(dupe)]})
        assert r.status_code == 409
    finally:
        dupe_mod._straggler_state["running"] = False
