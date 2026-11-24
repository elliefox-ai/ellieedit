"""Cluster engine v2 tests (inc.3, DESIGN-inc3-cluster-engine.md §5).

T0 synthetic-folder smoke (cutover gate) · T1 hash parity + dialect guard ·
T2 pair exclusion · T3 membership proposals · T4 greedy 1:1 · T5 queue
invariant · T6 cache guard · T7 idempotence — plus merge-apply, rebuild
protection and the HTTP wiring.

Fixtures are seeded smooth random images (8x8 noise upsampled): distinct
seeds are structurally unrelated, near-twins are derived by JPEG
recompression / brightness / small crop, and the style-only pair is a
55/45 blend of two seeds (every hash channel fails, coarse r ~ 0.78).
"""

import io
import json
import shutil
import sqlite3
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from backend import cluster_engine as ce
from backend import dupe_scan as ds


# ----------------------------------------------------------------- fixtures

def _img(seed: int, size: int = 96) -> Image.Image:
    a = np.random.default_rng(seed).random((8, 8)) * 255
    return Image.fromarray(a.astype(np.uint8)).resize(
        (size, size), Image.BICUBIC).convert("RGB")


def _jpeg(img: Image.Image, q=60) -> Image.Image:
    b = io.BytesIO()
    img.save(b, "JPEG", quality=q)
    b.seek(0)
    return Image.open(b).convert("RGB")


def _bright(img, d=25):
    return Image.fromarray(np.clip(np.asarray(img, float) + d, 0, 255).astype(np.uint8))


def _crop(img, m=4):
    w, h = img.size
    return img.crop((m, m, w - m, h - m)).resize((w, h))


def _save(img, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


@pytest.fixture
def world(tmp_path):
    dupe = tmp_path / "DupeReview"
    data = dupe / ".dupes"
    (data / "families").mkdir(parents=True)
    (data / "index.json").write_text(json.dumps(
        {"version": 1, "generated": "old", "families": [], "stats": {}}))
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text("")
    return {"dupe": dupe, "data": data, "ledger": ledger, "tmp": tmp_path}


def _roots(w):
    return [{"label": "dupe", "root": str(w["dupe"]), "exclude_dirs": {".dupes"}}]


def _run(w, **kw):
    return ce.scan_incremental(_roots(w), w["dupe"], w["data"], **kw)


def _fams(w) -> dict[str, dict]:
    out = {}
    for p in sorted((w["data"] / "families").glob("fam-*.json")):
        f = json.loads(p.read_text())
        out[f["id"]] = f
    return out


def _names(fam) -> set[str]:
    return {Path(m["path"]).name for m in fam["members"]}


def _by_names(w) -> dict[frozenset, dict]:
    return {frozenset(_names(f)): f for f in _fams(w).values()}


def _index(w) -> dict:
    return json.loads((w["data"] / "index.json").read_text())


def _existing_family(w, fid: str, rels: list[str], source="dupelib"):
    """An established (e.g. committed) family: members hashed via the primary
    engine's own hash_file, exactly the shape the canonical scan writes."""
    members = []
    for rel in rels:
        p = w["dupe"] / rel
        ph, dh = ds.hash_file(p)
        st = p.stat()
        members.append({"path": rel, "size": st.st_size, "mtime": int(st.st_mtime),
                        "dhash": ds.hex64(dh), "phash": ds.hex64(ph)})
    fam = {"format": "dupe-analyzer.family", "version": 1, "id": fid,
           "created": "x", "root": str(w["dupe"]), "authored": False,
           "source": source, "tiers": ["near-identical"], "members": members,
           "edges": [{"a": 0, "b": 1, "tier": "near-identical"}]}
    (w["data"] / "families" / f"{fid}.json").write_text(json.dumps(fam, indent=1))
    idx = _index(w)
    idx["families"].append({"id": fid, "size": len(members), "tiers": fam["tiers"],
                            "first_member": rels[0], "authored": False,
                            "source": source})
    (w["data"] / "index.json").write_text(json.dumps(idx))
    return fam


# ------------------------------------------------------------ T0 smoke

def test_t0_smoke_synthetic_folder(world):
    d = world["dupe"]
    base = _img(100)
    _save(base, d / "twin_orig.png")
    _save(_jpeg(base), d / "twin_jpeg.png")
    _save(_bright(base), d / "twin_bright.png")
    _save(_crop(base), d / "twin_crop.png")
    trip = _img(200)
    for i, sub in enumerate(("x", "y", "z")):                 # exact triplet
        _save(trip, d / sub / f"trip{i}.png")
    sa, sb = _img(1), _img(2)
    _save(sa, d / "style_a.png")
    _save(Image.blend(sa, sb, 0.45), d / "style_b.png")       # 55/45 restyle
    for s in (300, 301, 302):
        _save(_img(s), d / f"unrelated{s}.png")

    summary = _run(world)
    groups = {frozenset(k) for k in _by_names(world)}
    assert frozenset({"twin_orig.png", "twin_jpeg.png",
                      "twin_bright.png", "twin_crop.png"}) in groups
    # trap (a): d==0 triplet is ONE family, not three
    assert frozenset({"trip0.png", "trip1.png", "trip2.png"}) in groups
    assert frozenset({"style_a.png", "style_b.png"}) in groups
    in_fams = {n for g in groups for n in g}
    assert not any(n.startswith("unrelated") for n in in_fams)    # singletons
    assert summary["families"] == 3 and summary["proposals"] == 0

    # the style pair clusters ONLY via the style channel: every hash channel
    # fails for it, and the family records exactly that tier
    style = _by_names(world)[frozenset({"style_a.png", "style_b.png"})]
    assert style["tiers"] == ["style"]
    assert [e["mode"] for e in style["edges"]] == ["style"]
    for f in _fams(world).values():
        assert f["source"] == ce.SOURCE_V2


# ------------------------------------------------- T1 parity + dialects

def _vector_image():
    a = (np.add.outer(np.arange(64) ** 1.3, np.arange(64) * 3.0)
         + 40 * np.sin(np.add.outer(np.arange(64) / 5.0, np.arange(64) / 3.0)))
    a = ((a - a.min()) / (a.max() - a.min()) * 255).astype(np.uint8)
    return Image.fromarray(a).convert("RGB")


def test_t1_hash_vectors_and_primary_parity(tmp_path):
    img = _vector_image()
    # hardcoded vectors (recorded from the reference implementation)
    assert ds.hex64(ds.dhash(img)) == "6bdab6ad6bdab6ad"
    assert ds.hex64(ds.phash(img)) == "aa2bae2bfe548154"
    assert ds.hex64(int(ce.phash63(img))) == "2a2bae2bfe548154"
    c = ce.coarse_sig(img)
    assert c.dtype == np.float32 and c.shape == (256,)
    assert abs(float(np.linalg.norm(c)) - 1.0) < 1e-4 and abs(float(c.sum())) < 1e-3
    # v2 hashing is the primary engine's own dhash/phash — exact parity
    p = tmp_path / "v.png"
    img.save(p)
    ph, dh = ds.hash_file(p)
    h = ce.hash_file_v2(p)
    assert (h["phash"], h["dhash"]) == (ph, dh)
    # tolerance vectors for the PIL-not-cv2 deviation (G3): near-twins stay
    # well inside Meld's tolerances
    base = _img(100)
    sb = ce.coarse_sig(base)
    for twin, dmax in ((_jpeg(base), 3), (_bright(base), 3), (_crop(base), 6)):
        a, b = ce.phash63(base), ce.phash63(twin)
        assert ce.hamming63(a, b) <= dmax
        assert float(sb @ ce.coarse_sig(twin)) > 0.9
    # unrelated seeds are far in every channel
    other = _img(5)
    assert ce.hamming63(ce.phash63(base), ce.phash63(other)) > ce.PHASH63_TOL
    assert float(sb @ ce.coarse_sig(other)) < ce.STYLE_MIN


def test_t1_dialects_never_mix():
    a63 = ce.phash63(_img(1))
    plain = ds.phash(_img(1))
    with pytest.raises(TypeError):
        ce.hamming63(a63, plain)           # 63-bit vs 64-bit
    with pytest.raises(TypeError):
        ce.hamming64(a63, plain)
    with pytest.raises(TypeError):
        ce.hamming64(plain, a63)
    assert ce.hamming63(a63, a63) == 0 and ce.hamming64(plain, plain) == 0


# ------------------------------------------------ T2 pair exclusion

def test_t2_identical_images_no_pair_but_one_family(world):
    d = world["dupe"]
    im = _img(7)
    _save(im, d / "a.png")
    _save(im, d / "b.png")
    ph, dh = ds.hash_file(d / "a.png")
    cl, cands = ce.compute_edges([dh, dh], [ph, ph], [0, 0],
                                 np.zeros((2, 256), np.float32))
    assert cands == [] and ce.greedy_pairs(cands) == []        # no greedy pair
    assert len(cl) == 1 and cl[0][2] == 0                      # exact cluster edge
    s = _run(world)
    fam, = _fams(world).values()                               # one family
    assert _names(fam) == {"a.png", "b.png"}
    # Bugs 1+2 (2026-11-24): the exact pair now gets a STORED edge (tier
    # exact) instead of an empty edge list — the family is fully edged.
    assert fam["edges"] == [{"a": 0, "b": 1, "tier": "exact",
                             "mode": "exact", "distance": 0}]
    assert "exact" in fam["tiers"]
    assert s["pairs"] == 0 and s["exact_edges"] == 1


def _fully_edged(fam) -> bool:
    """Every member appears in >=1 stored edge (Bugs 1+2 invariant)."""
    seen = {x for e in fam.get("edges", []) for x in (e["a"], e["b"])}
    return seen == set(range(len(fam["members"])))


def test_stored_edges_define_membership_chain_loser_forms_no_family():
    # T4 chain at the formation rule: a-b d=2, b-c d=1 — greedy takes
    # (b,c); a has a cluster edge to b but no stored edge, so it is in NO
    # component and forms no family (the old union-find grouping admitted
    # it unedged). The cluster still spans all three — only the STORED
    # edges decide membership now.
    dh = [0b0, 0b11, 0b111]
    ph = [0, 0, 0]
    p63 = [(1 << 40) * 0, (1 << 50) - 1, (1 << 20) - 1]       # far in phash63
    cl, cands = ce.compute_edges(dh, ph, p63, np.zeros((3, 256), np.float32))
    assert ce.union_find_groups(3, cl) == [[0, 1, 2]]          # cluster: all 3
    stored, comps = ce.stored_family_units(cl, cands, 3)
    assert [(e["a"], e["b"]) for e in stored] == [(1, 2)]
    assert comps == [[1, 2]]                                   # member 0: no family


def test_three_way_exact_set_is_one_fully_edged_family(world):
    d = world["dupe"]
    trip = _img(200)
    for i, sub in enumerate(("x", "y", "z")):
        _save(trip, d / sub / f"trip{i}.png")
    s = _run(world)
    assert s["families"] == 1 and s["exact_edges"] == 3
    fam, = _fams(world).values()
    assert len(fam["members"]) == 3
    assert sorted(e["tier"] for e in fam["edges"]) == ["exact"] * 3
    assert _fully_edged(fam)


def test_reported_shape_668_pairs_plus_379_strays(world):
    # fam-ef12d5c7fca1's shape, synthetic: 668 disjoint near-twin pairs +
    # 379 unrelated pool members. Expected: 668 pair-families, every one
    # fully edged, no mega-family, and no stray in any family.
    d = world["dupe"]
    for k in range(668):
        base = _img(1000 + k, size=64)
        _save(base, d / f"pair{k}_a.png")
        _save(_jpeg(base), d / f"pair{k}_b.png")
    for k in range(379):
        _save(_img(5000 + k, size=64), d / f"stray{k}.png")
    s = _run(world)
    # every pair forms exactly one stored edge — greedy or exact (most
    # JPEG recompressions of these smooth synthetics are hash-identical,
    # so they land as exact edges, not greedy pairs)
    assert s["families"] == 668
    assert s["pairs"] + s["exact_edges"] == 668
    fams = _fams(world)
    assert len(fams) == 668
    assert all(len(f["members"]) == 2 for f in fams.values())
    assert all(_fully_edged(f) for f in fams.values())
    in_fams = {Path(m["path"]).name for f in fams.values() for m in f["members"]}
    assert not any(n.startswith("stray") for n in in_fams)
    assert len(in_fams) == 668 * 2


def test_rebuild_decomposes_overmerged_mega_family(world):
    # The acceptance recluster on a fixture: a hand-written over-merged
    # v2 family (4 members, 1 pair edge — the old shape) is dropped by
    # --rebuild and the pool re-forms as decomposed pair-families.
    d = world["dupe"]
    for k, seed in ((1, 100), (2, 110)):
        _save(_img(seed), d / f"m{k}a.png")
        _save(_jpeg(_img(seed)), d / f"m{k}b.png")
    members = []
    for name in ("m1a.png", "m1b.png", "m2a.png", "m2b.png"):
        p = d / name
        ph, dh = ds.hash_file(p)
        st = p.stat()
        members.append({"path": name, "size": st.st_size, "mtime": int(st.st_mtime),
                        "dhash": ds.hex64(dh), "phash": ds.hex64(ph)})
    mega_id = "fam-" + "ab" * 6
    mega = {"format": "dupe-analyzer.family", "version": 1, "id": mega_id,
            "created": "x", "root": str(d), "authored": False,
            "source": ce.SOURCE_V2, "tiers": ["near-identical"],
            "members": members,
            "edges": [{"a": 0, "b": 1, "tier": "near-identical",
                       "mode": "dhash", "distance": 1}]}
    (world["data"] / "families" / f"{mega_id}.json").write_text(json.dumps(mega))
    idx = _index(world)
    idx["families"].append({"id": mega_id, "size": 4,
                            "tiers": ["near-identical"], "first_member": "m1a.png",
                            "authored": False, "source": ce.SOURCE_V2})
    (world["data"] / "index.json").write_text(json.dumps(idx))
    r = _run(world, rebuild=True)
    assert r["rebuild_dropped"] == 1
    fams = _fams(world)
    assert mega_id not in fams
    assert len(fams) == 2
    assert all(len(f["members"]) == 2 for f in fams.values())
    assert all(_fully_edged(f) for f in fams.values())
    assert {frozenset(_names(f)) for f in fams.values()} == \
        {frozenset({"m1a.png", "m1b.png"}), frozenset({"m2a.png", "m2b.png"})}


def test_merged_family_stays_fully_edged(world):
    # apply_decisions: the merged family is the union of both families'
    # stored edges + the proposal edge — every member in >=1 edge.
    base, _ = _proposal_world(world)
    _save(_jpeg(base), world["dupe"] / "new_near_F.png")
    _run(world)
    prop, = [f for f in _fams(world).values() if f.get("proposed_merge")]
    r = ce.apply_decisions(world["dupe"], world["data"], {prop["id"]: "merge"})
    merged = _fams(world)[r["merged"][0]]
    assert len(merged["members"]) == 3
    assert _fully_edged(merged)
    assert any(e.get("mode") == "proposal" for e in merged["edges"])


# --------------------------------------------------- T4 greedy 1:1

def test_t4_greedy_one_to_one_chain():
    # a-b d=2, b-c d=1 (dhash channel); everything else far apart
    dh = [0b0, 0b11, 0b111]
    ph = [0, 0, 0]
    p63 = [(1 << 40) * 0, (1 << 50) - 1, (1 << 20) - 1]       # far in phash63
    cl, cands = ce.compute_edges(dh, ph, p63, np.zeros((3, 256), np.float32))
    pairs = ce.greedy_pairs(cands)
    assert [(p["a"], p["b"]) for p in pairs] == [(1, 2)]       # (b,c) not (a,b)
    used = [x for p in pairs for x in (p["a"], p["b"])]
    assert len(used) == len(set(used))                         # 1:1
    assert pairs[0]["mode"] == "dhash" and pairs[0]["distance"] == 1
    # all three are still ONE cluster via cluster_edges
    assert ce.union_find_groups(3, cl) == [[0, 1, 2]]


# --------------------------------------------- T3 membership proposal

def _proposal_world(w):
    d = w["dupe"]
    base = _img(400)
    _save(base, d / "F1.png")
    _save(_bright(base, 10), d / "F2.png")
    _existing_family(w, "fam-111111111111", ["F1.png", "F2.png"])
    other = _img(500)
    _save(other, d / "G1.png")
    _save(_bright(other, 10), d / "G2.png")
    _existing_family(w, "fam-222222222222", ["G1.png", "G2.png"])
    return base, other


def test_t3_membership_proposal(world):
    base, other = _proposal_world(world)
    f_path = world["data"] / "families" / "fam-111111111111.json"
    f_before = f_path.read_bytes()
    idx_row_before = next(r for r in _index(world)["families"]
                          if r["id"] == "fam-111111111111")
    _save(_jpeg(base), world["dupe"] / "new_near_F.png")        # matches F only
    s = _run(world)
    assert s["proposals"] == 1 and s["families"] == 1
    prop, = [f for f in _fams(world).values() if f.get("proposed_merge")]
    pm = prop["proposed_merge"]
    assert pm["family_id"] == "fam-111111111111"
    assert pm["matched_member"] in ("F1.png", "F2.png") and pm["distance"] >= 0
    assert _names(prop) == {"new_near_F.png"} and prop["source"] == ce.SOURCE_V2
    # the committed family is byte-identical and its index row unchanged
    assert f_path.read_bytes() == f_before
    assert next(r for r in _index(world)["families"]
                if r["id"] == "fam-111111111111") == idx_row_before
    row = next(r for r in _index(world)["families"] if r["id"] == prop["id"])
    assert row["proposed_merge"]["family_id"] == "fam-111111111111"

    # re-scan: a ruled (or pending) proposal never re-fires
    s2 = _run(world)
    assert s2["families"] == 0 and s2["proposals"] == 0
    assert sum(1 for f in _fams(world).values() if f.get("proposed_merge")) == 1


def test_t3_multi_family_match_is_not_a_proposal(world):
    base, other = _proposal_world(world)
    # a file halfway between: hash-near BOTH families
    mix_src = _img(600)
    # craft by making F and G members near-identical to one picture: add a
    # member to each family that is a near-twin of the new file
    shared = _img(700)
    _save(shared, world["dupe"] / "S_in_F.png")
    _save(_jpeg(shared), world["dupe"] / "S_in_G.png")
    _existing_family(world, "fam-333333333333", ["F1.png", "S_in_F.png"])
    _existing_family(world, "fam-444444444444", ["G1.png", "S_in_G.png"])
    _save(_bright(shared, 12), world["dupe"] / "new_ambiguous.png")
    _run(world)
    plain = [f for f in _fams(world).values()
             if "new_ambiguous.png" in _names(f)]
    assert len(plain) == 1
    assert "proposed_merge" not in plain[0]                    # plain new family
    row = next(r for r in _index(world)["families"] if r["id"] == plain[0]["id"])
    assert "proposed_merge" not in row


# ------------------------------------------ merge apply (§3c.3)

def test_merge_apply_new_id_old_family_untouched(world):
    base, _ = _proposal_world(world)
    _save(_jpeg(base), world["dupe"] / "new_near_F.png")
    _run(world)
    prop, = [f for f in _fams(world).values() if f.get("proposed_merge")]
    f_path = world["data"] / "families" / "fam-111111111111.json"
    f_before = f_path.read_bytes()
    r = ce.apply_decisions(world["dupe"], world["data"], {prop["id"]: "merge"})
    assert len(r["merged"]) == 1
    merged = _fams(world)[r["merged"][0]]
    assert _names(merged) == {"F1.png", "F2.png", "new_near_F.png"}
    assert merged["merged_from"] == {"proposal": prop["id"],
                                     "family": "fam-111111111111"}
    assert merged["id"] != "fam-111111111111" and f_path.read_bytes() == f_before
    # positional edges of the target stay valid; the proposal edge is appended
    assert merged["edges"][0] == {"a": 0, "b": 1, "tier": "near-identical"}
    assert any(e.get("mode") == "proposal" for e in merged["edges"])
    # idempotent; non-merge verdicts do nothing
    assert ce.apply_decisions(world["dupe"], world["data"],
                              {prop["id"]: "merge"})["merged"] == []
    assert ce.apply_decisions(world["dupe"], world["data"],
                              {prop["id"]: "separate"})["merged"] == []


# --------------------------------------------------- T6 cache guard

def test_t6_cache_presence_guard_and_schema_bump(world, tmp_path, monkeypatch):
    p = tmp_path / "i.png"
    _img(9).save(p)
    h = ce.hash_file_v2(p)
    st = p.stat()
    db = tmp_path / "cache.db"
    s = ce.StoreV2(db)
    s.put("k", st.st_size, int(st.st_mtime), h)
    s.commit()
    got = s.get("k", st.st_size, int(st.st_mtime))
    assert got and int(got["phash63"]) == int(h["phash63"])
    assert np.allclose(got["coarse"], h["coarse"])
    assert s.get("k", st.st_size + 1, int(st.st_mtime)) is None   # key mismatch
    # matching key but a missing v2 field => recompute, never fatal
    for col in ("phash63", "coarse"):
        s.con.execute(f"UPDATE hashes_v2 SET {col}=NULL WHERE path='k'")
        s.commit()
        assert s.get("k", st.st_size, int(st.st_mtime)) is None
        s.put("k", st.st_size, int(st.st_mtime), h)
        s.commit()
    s.con.execute("UPDATE hashes_v2 SET coarse=x'00' WHERE path='k'")
    s.commit()
    assert s.get("k", st.st_size, int(st.st_mtime)) is None       # malformed blob
    s.put("k", st.st_size, int(st.st_mtime), h)
    s.commit()
    s.close()
    # an end-to-end scan recovers from a damaged row by re-hashing
    _save(_img(11), world["dupe"] / "a.png")
    _save(_jpeg(_img(11)), world["dupe"] / "b.png")
    _run(world)
    con = sqlite3.connect(str(world["data"] / "cache.db"))
    con.execute("UPDATE hashes_v2 SET phash63=NULL")
    con.commit()
    con.close()
    shutil.rmtree(world["data"] / "families")
    (world["data"] / "families").mkdir()
    (world["data"] / "index.json").write_text(json.dumps(
        {"version": 1, "generated": "", "families": [], "stats": {}}))
    s3 = _run(world)
    assert s3["per_root"]["dupe"]["hashed"] == 2 and s3["families"] == 1
    # schema bump retires every old row wholesale
    monkeypatch.setattr(ce, "SCHEMA_VERSION", ce.SCHEMA_VERSION + 1)
    s4 = ce.StoreV2(world["data"] / "cache.db")
    assert s4.con.execute("SELECT COUNT(*) FROM hashes_v2").fetchone()[0] == 0
    s4.close()


# ---------------------------------------------------- T7 idempotence

def test_t7_idempotent_and_ledger_untouched(world):
    d = world["dupe"]
    base = _img(100)
    _save(base, d / "a.png")
    _save(_jpeg(base), d / "b.png")
    _save(_img(1), d / "s1.png")
    _save(Image.blend(_img(1), _img(2), 0.45), d / "s2.png")
    world["ledger"].write_text(
        json.dumps({"family": "fam-aaaaaaaaaaaa", "members": {"z.png": "kept"}}) + "\n")
    led = world["ledger"].read_bytes()
    _run(world)
    idx1, fams1 = _index(world)["families"], _fams(world)
    mt = {p.name: p.stat().st_mtime_ns
          for p in (world["data"] / "families").glob("fam-*.json")}
    s2 = _run(world)
    assert _index(world)["families"] == idx1 and _fams(world) == fams1
    assert s2["families"] == 0 and s2["pool"] == 0            # incremental: nothing new
    assert {p.name: p.stat().st_mtime_ns
            for p in (world["data"] / "families").glob("fam-*.json")} == mt
    assert world["ledger"].read_bytes() == led                # ledger untouched


def test_incremental_never_rewrites_existing_and_skips_given_paths(world):
    d = world["dupe"]
    base = _img(100)
    _save(base, d / "a.png")
    _save(_jpeg(base), d / "b.png")
    _run(world)
    before = _fams(world)
    _save(_img(77), d / "judged.png")
    _save(_jpeg(_img(77)), d / "judged2.png")
    # caller-supplied skip (ledger-referenced paths): never surfaced
    _run(world, skip_paths={str((d / "judged.png").resolve()),
                            str((d / "judged2.png").resolve())})
    assert _fams(world) == before


def _rect(seed: int, w: int, h: int) -> Image.Image:
    """A smooth-seed image at a non-square size (aspect-gate fixtures)."""
    return _img(seed).resize((w, h), Image.BICUBIC)


def _hand_family(w, fid: str, files, edges, source="dupelib", related=None,
                 extra_members=None):
    """Hand-write a family JSON over real files — the shape another engine
    (dupelib) writes: dense edges, any tiers, no width/height on members.
    files: [(rel, Image)]; edges/related: lists of dicts, written verbatim.
    extra_members: raw member dicts appended as-is (e.g. a dead path)."""
    d = w["dupe"]
    members = []
    for rel, img in files:
        _save(img, d / rel)
        p = d / rel
        ph, dh = ds.hash_file(p)
        st = p.stat()
        members.append({"path": rel, "size": st.st_size, "mtime": int(st.st_mtime),
                        "dhash": ds.hex64(dh), "phash": ds.hex64(ph)})
    members += list(extra_members or [])
    fam = {"format": "dupe-analyzer.family", "version": 1, "id": fid,
           "created": "x", "root": str(d), "authored": False,
           "source": source,
           "tiers": sorted({e.get("tier") for e in edges}),
           "members": members, "edges": edges}
    if related:
        fam["related"] = related
    (w["data"] / "families" / f"{fid}.json").write_text(json.dumps(fam, indent=1))
    idx = _index(w)
    idx["families"].append({"id": fid, "size": len(members), "tiers": fam["tiers"],
                            "first_member": members[0]["path"], "authored": False,
                            "source": source})
    (w["data"] / "index.json").write_text(json.dumps(idx))
    return fam


def _all_member_abs_paths(w) -> list[str]:
    return [ce._abs_of(m, w["dupe"]) for f in _fams(w).values()
            for m in f["members"]]


def _related_families(fam) -> dict[str, dict]:
    return {r["related_family"]: r for r in fam.get("related", [])}


# ------------------------------------------- Change 1: decompose in rebuild

def test_reform_decomposes_dupelib_mega_family(world):
    # fam-a2b8a69a999e's shape, synthetic and small: 10 members, dense
    # "related" edges chaining three allowed-tier components plus three
    # related-only strays into one mega-family.
    d = world["dupe"]
    # a second, ordinary family for the pre-existing related entry to point at
    _save(_img(900), d / "o1.png")
    _save(_jpeg(_img(900)), d / "o2.png")
    _existing_family(world, "fam-999999999999", ["o1.png", "o2.png"])
    files = [("m0.png", _img(100)), ("m1.png", _jpeg(_img(100))),
             ("m2.png", _bright(_img(100))),
             ("m3.png", _img(110)), ("m4.png", _jpeg(_img(110))),
             ("m5.png", _img(1)),
             ("m6.png", Image.blend(_img(1), _img(2), 0.45)),
             ("m7.png", _img(700)), ("m8.png", _img(701)), ("m9.png", _img(702))]
    edges = [
        {"a": 0, "b": 1, "tier": "near-identical", "mode": "dhash", "distance": 1},
        {"a": 1, "b": 2, "tier": "near-identical", "mode": "dhash", "distance": 2},
        {"a": 0, "b": 2, "tier": "near-identical", "mode": "dhash", "distance": 2},
        {"a": 3, "b": 4, "tier": "regional", "mode": "dhash", "distance": 8},
        {"a": 5, "b": 6, "tier": "style", "mode": "style", "distance": 0.78},
        # the weak tier, chaining everything into one mega-family
        {"a": 0, "b": 3, "tier": "related", "distance": 12},
        {"a": 1, "b": 4, "tier": "related", "distance": 13},
        {"a": 2, "b": 6, "tier": "related", "distance": 14},
        {"a": 3, "b": 5, "tier": "related", "distance": 11},
        {"a": 5, "b": 7, "tier": "related", "distance": 15},
        {"a": 7, "b": 8, "tier": "related", "distance": 16},
        {"a": 8, "b": 9, "tier": "related", "distance": 17},
        {"a": 0, "b": 9, "tier": "related", "distance": 18},
    ]
    mega = "fam-a2b8a69a999e"
    _hand_family(world, mega, files, edges,
                 related=[{"related_family": "fam-999999999999",
                           "tier": "regional", "distance": 5}])
    r = _run(world, rebuild=True)
    assert r["reformed"] == 1 and r["reformed_created"] == 3
    assert r["reformed_unclaimed"] == 3 and r["reformed_dead"] == 0
    fams = _fams(world)
    assert mega not in fams
    by_names = _by_names(world)
    comp_a = by_names[frozenset({"m0.png", "m1.png", "m2.png"})]
    comp_b = by_names[frozenset({"m3.png", "m4.png"})]
    comp_c = by_names[frozenset({"m5.png", "m6.png"})]
    # the related-only strays are in NO family (unclaimed, re-pooled as
    # singletons — their images are unrelated to everything)
    in_fams = {Path(m["path"]).name for f in fams.values() for m in f["members"]}
    assert not ({"m7.png", "m8.png", "m9.png"} & in_fams)
    # no family file anywhere contains a "related" edge
    for f in fams.values():
        assert all(e.get("tier") != "related" for e in f.get("edges", []))
        assert f["source"] == "dupelib" or f["id"] == "fam-999999999999"
        assert _fully_edged(f)
    # sources preserved (NOT cluster-engine-v2) + reformed_from marker
    for f in (comp_a, comp_b, comp_c):
        assert f["source"] == "dupelib"
        assert f["reformed_from"] == {"family": mega}
        assert f["tiers"] == sorted({e["tier"] for e in f["edges"]})
    # cross-family related links, from the disallowed edges
    assert set(_related_families(comp_a)) >= {comp_b["id"], comp_c["id"],
                                              "fam-999999999999"}
    assert set(_related_families(comp_b)) >= {comp_a["id"], comp_c["id"],
                                              "fam-999999999999"}
    assert set(_related_families(comp_c)) >= {comp_a["id"], comp_b["id"],
                                              "fam-999999999999"}
    assert _related_families(comp_a)[comp_b["id"]]["tier"] == "related"
    # the pre-existing related entry is preserved, deduped by family
    assert len([r for r in comp_a["related"]
                if r["related_family"] == "fam-999999999999"]) == 1
    # index rows: the mega row is replaced in place by the three new rows
    ids = [x["id"] for x in _index(world)["families"]]
    assert mega not in ids
    assert len(ids) == len(set(ids)) == 4      # 3 re-formed + the other family
    assert all(next(x for x in _index(world)["families"] if x["id"] == f["id"])
               ["source"] == "dupelib" for f in (comp_a, comp_b, comp_c))
    # the "other" family is byte-identical: re-form never touched it
    other = _fams(world)["fam-999999999999"]
    assert _names(other) == {"o1.png", "o2.png"}

    # second rebuild is a no-op on the re-formed families (idempotent):
    # all their edges are allowed tiers now, and their (non-v2) source
    # means the drop step never touches them either
    before = {fid: (world["data"] / "families" / f"{fid}.json").read_bytes()
              for fid in fams}
    r2 = _run(world, rebuild=True)
    assert r2["reformed"] == 0 and r2["reformed_created"] == 0
    assert r2["families"] == 0
    assert {fid: (world["data"] / "families" / f"{fid}.json").read_bytes()
            for fid in fams} == before


def test_reform_near_identical_only_family_survives_intact(world):
    # the acceptance's allowance: a large family formed SOLELY by
    # near-identical/exact edges stays whole, byte-identical.
    files = []
    base = _img(100)
    files.append(("n00.png", base))
    files.append(("n01.png", base))                    # exact twin of n00
    files.append(("n02.png", base))                    # exact twin of n00
    for k in range(3, 20):
        files.append((f"n{k:02d}.png",
                      _jpeg(base) if k % 2 else _bright(base, 8)))
    edges = ([{"a": 0, "b": 1, "tier": "exact", "mode": "exact", "distance": 0},
              {"a": 0, "b": 2, "tier": "exact", "mode": "exact", "distance": 0}]
             + [{"a": k, "b": k + 1, "tier": "near-identical",
                 "mode": "dhash", "distance": 1} for k in range(19)])
    fid = "fam-202020202020"
    _hand_family(world, fid, files, edges)
    before = (world["data"] / "families" / f"{fid}.json").read_bytes()
    r = _run(world, rebuild=True)
    assert r["reformed"] == 0 and r["families"] == 0
    assert (world["data"] / "families" / f"{fid}.json").read_bytes() == before
    assert len(_fams(world)[fid]["members"]) == 20


def test_reform_skips_protected_resolved_families(world):
    # past reviews are never rewritten: a resolved mega-family is left
    # alone by the re-form step, even with "related" edges.
    files = [("p0.png", _img(100)), ("p1.png", _jpeg(_img(100))),
             ("p2.png", _img(700))]
    edges = [{"a": 0, "b": 1, "tier": "near-identical", "mode": "dhash",
              "distance": 1},
             {"a": 1, "b": 2, "tier": "related", "distance": 12}]
    fid = "fam-303030303030"
    _hand_family(world, fid, files, edges)
    before = (world["data"] / "families" / f"{fid}.json").read_bytes()
    r = _run(world, rebuild=True, protected_ids={fid})
    assert r["reformed"] == 0 and r["reformed_skipped_protected"] == 1
    assert (world["data"] / "families" / f"{fid}.json").read_bytes() == before


# ------------------------------------------- Change 2: aspect gate

def test_aspect_gate_blocks_cross_orientation_edges():
    # a hash-identical pair (dhash 0 / phash 0) in different orientation
    # classes forms NO edge at all; same-orientation pairs form edges
    # exactly as before; dims=None keeps the old ungated callers working.
    dh = [0, 0b11]
    ph = [0, 0]
    p63 = [0, (1 << 50) - 1]                          # far in phash63
    coarse = np.zeros((2, 256), np.float32)
    cl, cands = ce.compute_edges(dh, ph, p63, coarse,
                                 dims=[(96, 128), (128, 96)])
    assert cl == [] and cands == []                   # portrait vs landscape
    cl, cands = ce.compute_edges(dh, ph, p63, coarse,
                                 dims=[(96, 128), (90, 120)])
    assert cl == [(0, 1, 1)]                         # both portrait: near edge
    assert len(cands) == 1 and cands[0][3] == "dhash"
    assert cands[0][4] == 2
    cl, cands = ce.compute_edges(dh, ph, p63, coarse,
                                 dims=[(100, 250), (89, 100)])
    assert cl == [] and cands == []                   # portrait, 2.2x divergence
    cl, cands = ce.compute_edges(dh, ph, p63, coarse,
                                 dims=[(120, 100), (240, 100)])
    assert cl == [(0, 1, 1)]                         # landscape, exactly 2x: allowed
    cl, cands = ce.compute_edges(dh, ph, p63, coarse,
                                 dims=[(120, 100), (241, 100)])
    assert cl == []                                  # landscape, just over 2x
    cl, cands = ce.compute_edges(dh, ph, p63, coarse,
                                 dims=[(100, 100), (100, 200)])
    assert cl == []                                  # square vs portrait
    cl, cands = ce.compute_edges(dh, ph, p63, coarse,
                                 dims=[(96, 128), None])
    assert cl == [(0, 1, 1)]                         # unmeasurable fails open
    cl, cands = ce.compute_edges(dh, ph, p63, coarse)
    assert cl == [(0, 1, 1)]                         # dims=None: ungated


def test_aspect_gate_end_to_end_members_carry_dimensions(world):
    # the same smooth seed at portrait and landscape sizes is
    # hash-IDENTICAL (dhash 0 / phash 0) — without the gate it would be
    # an exact family; with it, no edge forms between the orientations.
    # The portrait pair still families normally, and its member records
    # carry width/height. The landscape twin is not silently dropped:
    # it stays unclaimed this scan, and on the NEXT scan it surfaces as
    # a single-member proposal against the now-existing portrait family,
    # for a human to rule on.
    d = world["dupe"]
    _save(_rect(100, 96, 128), d / "port_a.png")
    _save(_rect(100, 96, 128), d / "port_b.png")       # same bytes, portrait
    _save(_rect(100, 128, 96), d / "land_a.png")       # same content, landscape
    s = _run(world)
    assert s["families"] == 1 and s["proposals"] == 0
    fam, = _fams(world).values()
    assert _names(fam) == {"port_a.png", "port_b.png"}
    assert all(m["width"] == 96 and m["height"] == 128 for m in fam["members"])
    assert "land_a.png" not in {Path(m["path"]).name
                                for f in _fams(world).values()
                                for m in f["members"]}
    s2 = _run(world)
    assert s2["families"] == 1 and s2["proposals"] == 1
    prop, = [f for f in _fams(world).values() if f.get("proposed_merge")]
    assert _names(prop) == {"land_a.png"}
    assert prop["proposed_merge"]["family_id"] == fam["id"]


def test_aspect_gate_drops_cross_orientation_edge_on_reform(world):
    # a re-formed family: A(portrait)—C(portrait) near-identical survives,
    # A—B(portrait—landscape) near-identical is dropped, so B is unclaimed.
    # The family needs a disallowed edge to be re-formed at all.
    files = [("a.png", _rect(100, 96, 128)),
             ("b.png", _rect(800, 128, 96)),
             ("c.png", _rect(100, 96, 128))]
    edges = [{"a": 0, "b": 1, "tier": "near-identical", "mode": "dhash",
              "distance": 0},
             {"a": 0, "b": 2, "tier": "near-identical", "mode": "dhash",
              "distance": 0},
             {"a": 1, "b": 2, "tier": "related", "distance": 12}]
    _hand_family(world, "fam-404040404040", files, edges)
    r = _run(world, rebuild=True)
    assert r["reformed"] == 1 and r["reformed_created"] == 1
    fam, = [f for f in _fams(world).values()
            if f["id"] != "fam-404040404040"]
    assert _names(fam) == {"a.png", "c.png"}
    assert fam["edges"] == [{"a": 0, "b": 1, "tier": "near-identical",
                             "mode": "dhash", "distance": 0}]
    assert "b.png" not in {Path(m["path"]).name
                           for f in _fams(world).values()
                           for m in f["members"]}


# ------------------------------------------- Change 4: dead member paths

def test_dead_paths_dropped_on_reform(world):
    # a dupelib family with a dead member: the re-formed family excludes
    # it, edges remap, and NO written family file contains a nonexistent
    # member path.
    files = [("d0.png", _img(100)), ("d1.png", _jpeg(_img(100)))]
    ghost = {"path": "gone/ghost.png", "size": 123, "mtime": 0,
             "dhash": "0" * 16, "phash": "0" * 16}
    edges = [{"a": 0, "b": 1, "tier": "near-identical", "mode": "dhash",
              "distance": 1},
             {"a": 0, "b": 2, "tier": "near-identical", "mode": "dhash",
              "distance": 2},
             {"a": 1, "b": 2, "tier": "related", "distance": 12}]
    _hand_family(world, "fam-505050505050", files, edges,
                 extra_members=[ghost])
    r = _run(world, rebuild=True)
    assert r["reformed"] == 1 and r["dead_members"] == 1
    assert r["reformed_dead"] == 1
    fam, = _fams(world).values()
    assert _names(fam) == {"d0.png", "d1.png"}
    assert fam["edges"] == [{"a": 0, "b": 1, "tier": "near-identical",
                             "mode": "dhash", "distance": 1}]
    for ap in _all_member_abs_paths(world):
        assert Path(ap).is_file()


def test_dead_paths_dropped_on_merge(world):
    # apply_decisions: a dead member in the TARGET family never reaches
    # the merged family file; edges remap, and the proposal edge is
    # found by path among the survivors.
    d = world["dupe"]
    files = [("t1.png", _img(100)), ("t2.png", _jpeg(_img(100))),
             ("t3.png", _bright(_img(100), 10))]
    edges = [{"a": 0, "b": 1, "tier": "near-identical", "mode": "dhash",
              "distance": 1},
             {"a": 0, "b": 2, "tier": "near-identical", "mode": "dhash",
              "distance": 2}]
    _hand_family(world, "fam-606060606060", files, edges)
    _save(_jpeg(_img(100), 40), d / "n.png")
    p = d / "n.png"
    ph, dh = ds.hash_file(p)
    st = p.stat()
    prop_id = "fam-616161616161"
    prop = {"format": "dupe-analyzer.family", "version": 1, "id": prop_id,
            "created": "x", "root": str(d), "authored": False,
            "source": ce.SOURCE_V2, "tiers": ["regional"],
            "members": [{"path": "n.png", "size": st.st_size,
                         "mtime": int(st.st_mtime), "dhash": ds.hex64(dh),
                         "phash": ds.hex64(ph)}],
            "edges": [],
            "proposed_merge": {"family_id": "fam-606060606060",
                               "matched_member": "t1.png", "distance": 0,
                               "new_member": "n.png"}}
    (world["data"] / "families" / f"{prop_id}.json").write_text(json.dumps(prop))
    (world["dupe"] / "t2.png").unlink()                # target member dies
    r = ce.apply_decisions(world["dupe"], world["data"], {prop_id: "merge"})
    assert r["dead_dropped"] == 1
    merged = _fams(world)[r["merged"][0]]
    assert _names(merged) == {"t1.png", "t3.png", "n.png"}
    assert merged["edges"] == [
        {"a": 0, "b": 1, "tier": "near-identical", "mode": "dhash",
         "distance": 2},
        {"a": 0, "b": 2, "tier": "regional", "mode": "proposal",
         "distance": 0}]
    assert _fully_edged(merged)
    # the dead-path rule bites at WRITE time: the merged file is clean.
    # The old target file is deliberately untouched by apply_decisions
    # (its resolved ledger entry stays), so it still lists the dead
    # member — that staleness is the re-form step's job on the next
    # rebuild, not the merge's.
    for m in merged["members"]:
        assert Path(ce._abs_of(m, world["dupe"])).is_file()


# -------------------------------------------------- rebuild (CLI-only)

def test_rebuild_protects_resolved_and_regenerates_rest(world):
    d = world["dupe"]
    for seed, nm in ((100, "p"), (110, "q")):
        _save(_img(seed), d / f"{nm}1.png")
        _save(_jpeg(_img(seed)), d / f"{nm}2.png")
    _run(world)
    fams = _by_names(world)
    keep = fams[frozenset({"p1.png", "p2.png"})]["id"]
    drop = fams[frozenset({"q1.png", "q2.png"})]["id"]
    keep_bytes = (world["data"] / "families" / f"{keep}.json").read_bytes()
    r = _run(world, rebuild=True, protected_ids={keep})
    assert r["rebuild_dropped"] == 1
    after = _fams(world)
    assert set(after) == {keep, drop}                  # same ids regenerated
    assert (world["data"] / "families" / f"{keep}.json").read_bytes() == keep_bytes
    ids = [x["id"] for x in _index(world)["families"]]
    assert sorted(ids) == sorted(set(ids)) == sorted({keep, drop})


def test_rebuild_is_not_reachable_over_http():
    from backend.main import app
    assert not any("rebuild" in getattr(r, "path", "") for r in app.routes)
    from backend.routers import dupe as dm
    assert "rebuild" not in dm.StragglerBody.model_fields


# --------------------------------- T5 queue invariant + HTTP wiring

@pytest.fixture
def api(world, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend.routers import dupe as dm
    from backend.routers import library as lib_mod
    monkeypatch.setattr(dm, "DUPE_ROOT", world["dupe"])
    monkeypatch.setattr(dm, "DUPE_MEMBER_ROOTS", [world["dupe"]])
    monkeypatch.setattr(dm, "DUPE_DATA", world["data"])
    monkeypatch.setattr(dm, "LEDGER", world["ledger"])
    monkeypatch.setattr(lib_mod, "LIBRARY_ROOT", world["tmp"] / "lib")
    # The endpoint's DEFAULT roots include the gather staging dir
    # (dupe_scan.DEFAULT_GATHER_ROOT = /mnt/shared/_DupeGatherer/staging).
    # On a real tree that directory exists and holds thousands of images, so
    # a default-roots scan would pull them into this test's temp family tree
    # (T5 failed operator-side with a surplus family). Pin it to a path that
    # cannot exist so the scan sees ONLY the fixture's DupeReview root.
    monkeypatch.setattr(ds, "DEFAULT_GATHER_ROOT",
                        str(world["tmp"] / "no-gather-staging"))
    return TestClient(app)


def _scan_v2(api, world):
    # default roots: the jailed "dupe" label => members carry DupeReview-
    # relative paths, which is what the verdict endpoint validates against
    r = api.post("/api/dupe/scan-stragglers", json={"engine": "v2"})
    assert r.status_code == 200, r.text
    return r.json()["summary"]["v2"]


def test_t5_queue_invariant_through_rescan_and_merge(api, world):
    d = world["dupe"]
    base = _img(100)
    _save(base, d / "a.png")
    _save(_jpeg(base), d / "b.png")
    _save(_img(120), d / "c.png")
    _save(_jpeg(_img(120)), d / "d.png")
    s = _scan_v2(api, world)
    assert s["families"] == 2
    fams = _by_names(world)
    X = fams[frozenset({"a.png", "b.png"})]["id"]
    Y = fams[frozenset({"c.png", "d.png"})]["id"]
    # commit X: ledger entry resolves it
    assert api.post(f"/api/dupe/families/{X}/verdict",
                    json={"members": {"a.png": "kept", "b.png": "rejected"}}
                    ).status_code == 200
    ledger_after_commit = world["ledger"].read_bytes()
    _scan_v2(api, world)                                 # rescan: nothing replaced
    q = api.get("/api/dupe/families", params={"state": "unresolved"}).json()
    ids = {i["id"] for i in q["items"]}
    assert X not in ids and Y in ids
    assert all(i["state"] == "unresolved" for i in q["items"])
    assert api.get("/api/dupe/families", params={"state": "resolved"}
                   ).json()["items"][0]["id"] == X
    assert world["ledger"].read_bytes() == ledger_after_commit

    # a new file near X => proposal (X stays committed, same id)
    _save(_jpeg(base, 40), d / "e.png")
    _scan_v2(api, world)
    q = api.get("/api/dupe/families", params={"state": "unresolved"}).json()
    prop = next(i for i in q["items"] if i["proposed_merge"])
    assert prop["proposed_merge"]["family_id"] == X
    det = api.get(f"/api/dupe/families/{prop['id']}").json()
    assert det["proposed_merge"]["matched"]["thumb"]
    assert api.get(f"/api/dupe/families/{X}").json()["state"] == "resolved"

    # rule it "melded" (= merge): the family that gained a member is a NEW
    # unresolved id; X's ledger entry is untouched (append-only prefix)
    assert api.post(f"/api/dupe/families/{prop['id']}/verdict",
                    json={"members": {"e.png": "melded"}}).status_code == 200
    assert world["ledger"].read_bytes().startswith(ledger_after_commit)
    q = api.get("/api/dupe/families", params={"state": "unresolved"}).json()
    ids = {i["id"] for i in q["items"]}
    merged = next(f for f in _fams(world).values() if f.get("merged_from"))
    assert merged["id"] in ids and merged["id"] != X and X not in ids
    assert api.get(f"/api/dupe/families/{X}").json()["state"] == "resolved"
    assert all(i["state"] == "unresolved" for i in q["items"])


def test_separate_verdict_keeps_its_own_family(api, world):
    d = world["dupe"]
    base = _img(100)
    _save(base, d / "a.png")
    _save(_jpeg(base), d / "b.png")
    _scan_v2(api, world)
    _save(_jpeg(base, 40), d / "e.png")
    _scan_v2(api, world)
    prop = next(f for f in _fams(world).values() if f.get("proposed_merge"))
    assert api.post(f"/api/dupe/families/{prop['id']}/verdict",
                    json={"members": {"e.png": "kept"}}).status_code == 200  # separate
    n = len(_fams(world))
    _scan_v2(api, world)
    assert len(_fams(world)) == n                           # never re-fires
    assert not any(f.get("merged_from") for f in _fams(world).values())


def test_http_fixture_isolated_from_real_gather_staging(api, world):
    """Regression guard for the operator-side T5 failure: default-roots scans
    must never reach the real /mnt/shared staging tree."""
    assert not str(ds.DEFAULT_GATHER_ROOT).startswith("/mnt/shared")
    assert not Path(ds.DEFAULT_GATHER_ROOT).exists()
    # even with a populated *real-looking* sibling dir elsewhere, only the
    # fixture root is scanned
    stray = world["tmp"] / "stray"
    _save(_img(901), stray / "x1.png")
    _save(_img(901), stray / "x2.png")
    _save(_img(902), world["dupe"] / "only.png")
    s = _scan_v2(api, world)
    assert s["pool"] == 1 and s["families"] == 0
