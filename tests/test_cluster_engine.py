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
    assert cands == [] and ce.greedy_pairs(cands) == []        # no pair
    assert len(cl) == 1 and cl[0][2] == 0                      # exact cluster edge
    s = _run(world)
    fam, = _fams(world).values()                               # one family
    assert _names(fam) == {"a.png", "b.png"}
    assert fam["edges"] == [] and "exact" in fam["tiers"]
    assert s["pairs"] == 0


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
