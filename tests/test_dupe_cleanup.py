"""Tests for backend/dupe_cleanup.py — fabricated families in tmp dirs only.
No test ever touches live dupe data with writes."""

import json
import os
from pathlib import Path

import pytest

from backend import dupe_cleanup as dc


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Fabricated dupe tree + library index; all module constants patched."""
    root = tmp_path / "DupeReview"
    fams = root / ".dupes" / "families"
    fams.mkdir(parents=True)
    lib = tmp_path / "Library"
    lib.mkdir()
    lib_index = lib / ".library-index.jsonl"

    def fam(fid, members, **kw):
        d = {"format": "dupe-analyzer.family", "version": 1, "id": fid,
             "created": "2026-10-09T00:00:00-07:00", "root": str(root),
             "authored": False, "tiers": ["near-identical"],
             "members": members, **kw}
        (fams / f"{fid}.json").write_text(json.dumps(d, indent=1) + "\n")
        return d

    def on_disk_member(p):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
        return {"path": str(p), "size": 1, "root": "gather"}

    def gone_member(p):
        return {"path": str(p), "size": 1, "root": "gather"}

    monkeypatch.setattr(dc, "DUPE_ROOT", root)
    monkeypatch.setattr(dc, "DUPE_DATA", root / ".dupes")
    monkeypatch.setattr(dc, "FAMILIES_DIR", fams)
    monkeypatch.setattr(dc, "JOURNAL", root / ".dupes" / "families-cleanup.jsonl")
    monkeypatch.setattr(dc, "LIBRARY_ROOT", lib)
    monkeypatch.setattr(dc, "_lib_cache", None)
    # keep the write guard in sync with the patched dirs
    monkeypatch.setattr(dc, "_ALLOWED_DIRS",
                        (fams.resolve(), (root / ".dupes").resolve()))
    return {"root": root, "fams": fams, "lib_index": lib_index,
            "fam": fam, "disk": on_disk_member, "gone": gone_member}


def _lib(env, promoted_from):
    with env["lib_index"].open("a") as fh:
        fh.write(json.dumps({"path": "lib/x.png",
                             "promoted_from": promoted_from}) + "\n")
    dc._lib_cache = None


# ---- member state ----------------------------------------------------------

def test_member_states(env, tmp_path):
    live = env["disk"](tmp_path / "a.png")["path"]
    _lib(env, "/gone/promoted.png")
    assert dc.member_state(live) == "disk"
    assert dc.member_state("/gone/promoted.png") == "in-library"
    assert dc.member_state("/gone/never-existed.png") == "missing"


def test_library_resolved_not_live(env, tmp_path):
    """An in-library member does NOT count as live for retention."""
    _lib(env, "/gone/promoted.png")
    env["fam"]("fam-" + "a" * 12, [
        env["gone"]("/gone/promoted.png"),
        env["gone"]("/gone/rejected.png"),
    ])
    st = dc.process_family(next(env["fams"].glob("*.json")), live=False, journal_fh=None)
    assert st["action"] == "dissolve"


# ---- prune / dissolve rules ------------------------------------------------

def test_prune_keeps_family_with_two_live(env, tmp_path):
    live1 = env["disk"](tmp_path / "a.png")
    live2 = env["disk"](tmp_path / "b.png")
    env["fam"]("fam-" + "b" * 12, [live1, live2, env["gone"]("/gone/x.png")])
    fpath = next(env["fams"].glob("*.json"))
    st = dc.process_family(fpath, live=False, journal_fh=None)
    assert st["action"] == "prune-member"
    assert st["live"] == 2
    # dry-run: file unchanged
    before = fpath.read_text()
    assert json.loads(before)["members"] and len(json.loads(before)["members"]) == 3


def test_dissolve_two_dead_one_live(env, tmp_path):
    live1 = env["disk"](tmp_path / "a.png")
    env["fam"]("fam-" + "c" * 12, [live1, env["gone"]("/gone/x.png"),
                                   env["gone"]("/gone/y.png")])
    st = dc.process_family(next(env["fams"].glob("*.json")), live=False, journal_fh=None)
    assert st["action"] == "dissolve"


def test_dissolve_zero_live(env):
    env["fam"]("fam-" + "d" * 12, [env["gone"]("/gone/x.png")])
    st = dc.process_family(next(env["fams"].glob("*.json")), live=False, journal_fh=None)
    assert st["action"] == "dissolve"


def test_no_dead_no_action(env, tmp_path):
    live1 = env["disk"](tmp_path / "a.png")
    live2 = env["disk"](tmp_path / "b.png")
    env["fam"]("fam-" + "e" * 12, [live1, live2])
    st = dc.process_family(next(env["fams"].glob("*.json")), live=False, journal_fh=None)
    assert st["action"] == "none"


# ---- live writes -----------------------------------------------------------

def test_live_prune_writes_bak_and_journal(env, tmp_path):
    live1 = env["disk"](tmp_path / "a.png")
    live2 = env["disk"](tmp_path / "b.png")
    gone = env["gone"]("/gone/x.png")
    env["fam"]("fam-" + "f" * 12, [live1, live2, gone])
    fpath = next(env["fams"].glob("*.json"))
    original = fpath.read_text()
    with dc.JOURNAL.open("a") as jh:
        dc.process_family(fpath, live=True, journal_fh=jh)
    bak = fpath.with_suffix(".json.bak")
    assert bak.exists() and bak.read_text() == original
    fam = json.loads(fpath.read_text())
    assert [m["path"] for m in fam["members"]] == [live1["path"], live2["path"]]
    lines = dc.JOURNAL.read_text().strip().splitlines()
    rec = json.loads(lines[0])
    assert rec["action"] == "prune-member" and rec["reason"] == "missing"
    assert rec["path"] == gone["path"]


def test_live_dissolve_truncates_json_keeps_bak(env, tmp_path):
    _lib(env, "/gone/promoted.png")
    env["fam"]("fam-" + "1" * 12, [env["gone"]("/gone/promoted.png"),
                                   env["gone"]("/gone/rejected.png")])
    fpath = next(env["fams"].glob("*.json"))
    original = fpath.read_text()
    with dc.JOURNAL.open("a") as jh:
        dc.process_family(fpath, live=True, journal_fh=jh)
    assert fpath.read_text() == ""
    bak = fpath.with_suffix(".json.bak")
    assert json.loads(bak.read_text())["id"] == "fam-" + "1" * 12
    recs = [json.loads(l) for l in dc.JOURNAL.read_text().strip().splitlines()]
    assert all(r["action"] == "dissolve" for r in recs)
    reasons = {r["reason"] for r in recs}
    assert reasons == {"in-library", "missing"}


def test_run_totals(env, tmp_path):
    env["disk"](tmp_path / "a.png")
    env["disk"](tmp_path / "b.png")
    env["fam"]("fam-" + "2" * 12, [
        {"path": str(tmp_path / "a.png")}, {"path": str(tmp_path / "b.png")},
        env["gone"]("/gone/x.png")])
    env["fam"]("fam-" + "3" * 12, [env["gone"]("/gone/y.png")])
    totals = dc.run(live=False)
    assert totals["families"] == 2
    assert totals["with_dead"] == 2
    assert totals["dead_missing"] == 2
    assert totals["prune"] == 1 and totals["dissolve"] == 1


# ---- dry-run writes nothing ------------------------------------------------

def test_dry_run_writes_nothing(env, tmp_path):
    env["disk"](tmp_path / "a.png")
    env["disk"](tmp_path / "b.png")
    env["fam"]("fam-" + "4" * 12, [
        {"path": str(tmp_path / "a.png")}, {"path": str(tmp_path / "b.png")},
        env["gone"]("/gone/x.png")])
    env["fam"]("fam-" + "5" * 12, [env["gone"]("/gone/y.png")])

    def snapshot():
        out = {}
        for base, _, files in os.walk(env["root"]):
            for f in files:
                p = Path(base) / f
                out[p] = (p.stat().st_mtime_ns, p.stat().st_size)
        return out

    before = snapshot()
    dc.run(live=False)
    assert snapshot() == before          # no mtime or content change anywhere
    assert not dc.JOURNAL.exists()


# ---- write guard -----------------------------------------------------------

def test_guard_blocks_non_whitelisted_writes(env, tmp_path):
    with pytest.raises(dc.WriteViolation):
        dc._guarded_replace(tmp_path / "image.png", "x")     # wrong dir
    with pytest.raises(dc.WriteViolation):
        dc._guarded_replace(env["root"] / "outside.json", "x")  # right suffix, wrong dir
    with pytest.raises(dc.WriteViolation):
        dc._delete_to_bak(tmp_path / "picture.jpg")          # image path
    with pytest.raises(dc.WriteViolation):
        dc._assert_writable(env["fams"] / "member.dat")      # wrong suffix in dir
    # allowed: family json inside families dir
    ok = env["fams"] / "fam-000000000000.json"
    ok.write_text("{}")
    dc._guarded_replace(ok, "{}")


def test_ledger_never_touched(env, tmp_path):
    """Live run over families must not create/modify anything outside the
    whitelisted surface — the verdict ledger path is asserted untouched."""
    ledger = env["root"] / ".dupe-verdicts.jsonl"
    ledger.write_text('{"family": "fam-x"}\n')
    env["fam"]("fam-" + "6" * 12, [env["gone"]("/gone/x.png")])
    fpath = next(env["fams"].glob("*.json"))
    with dc.JOURNAL.open("a") as jh:
        dc.process_family(fpath, live=True, journal_fh=jh)
    assert ledger.read_text() == '{"family": "fam-x"}\n'
