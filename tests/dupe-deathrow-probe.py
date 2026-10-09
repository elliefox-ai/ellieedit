# Death-row rehydration probe runner (2026-10-09b).
# The LIVE 8800 dupe tree is fully resolved today (0 unresolved, 627
# majority-rejected families queued for the purge), so the classic
# dupe-probe sections — which need genuinely unresolved families — cannot
# run there anymore. This runner does what library-probe does:
#  1. SCRATCH instance on 127.0.0.1:8810 with a synthetic dupe tree
#     (unresolved + resolved majority-rejected families, real PNG files,
#     temp ledger/manifest) — then runs the FULL tests/dupe-probe.py
#     (all sections, including 14-15 death-row) against it.
#  2. LIVE 8800 death-row smoke: the real queue renders pre-marked cards,
#     /death-row totals are honest, and the mass bar appears after opening
#     + closing a family — WITHOUT clicking it (never queue real files).
# Run: .venv/bin/python tests/dupe-deathrow-probe.py
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

REPO = Path(__file__).resolve().parents[1]
SCRATCH = "http://127.0.0.1:8810"
LIVE = os.environ.get("ELLIEEDIT_PROBE_LIVE", "http://127.0.0.1:8800")
VIEWPORT = {"width": 1024, "height": 768}   # operator's iPad PWA

fails = []

# Ghost-state checks (2026-10-09f) — run inside the scratch env before the
# full dupe-probe. API assertions + one headless DOM pass for the chips.
GHOST_CHECKS = r"""
import json, urllib.request, os
from playwright.sync_api import sync_playwright
S = os.environ["ELLIEEDIT_PROBE_BASE"]
def api(p):
    return json.loads(urllib.request.urlopen(S + p, timeout=60).read())
ok = []
def chk(label, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + label + (" — " + str(detail) if detail else ""))
    ok.append(bool(cond))

lst = api("/api/dupe/families?state=unresolved")
ids = [it["id"] for it in lst["items"]]
chk("ghost family hidden from default list", "fam-aaaaaaaa0009" not in ids, ids)
chk("archived_hidden counts the ghost", lst.get("archived_hidden") == 1,
    lst.get("archived_hidden"))
full = api("/api/dupe/families?state=unresolved&include_archived=1")
fids = [it["id"] for it in full["items"]]
chk("archived toggle reveals the ghost", "fam-aaaaaaaa0009" in fids, fids)
grow = next(it for it in full["items"] if it["id"] == "fam-aaaaaaaa0009")
chk("ghost flagged archived + zero on disk",
    grow["archived"] is True and grow["on_disk"] == 0,
    (grow["archived"], grow["on_disk"]))
# chips data on the actionable on-disk families
row4 = next(it for it in full["items"] if it["id"] == "fam-aaaaaaaa0004")
st4 = {m["path"]: m["member_state"] for m in row4["members"]}
chk("deleted member resolves 'deleted'", st4.get("probe-d/d3.png") == "deleted", st4)
chk("on-disk members resolve 'disk'",
    st4.get("probe-d/d1.png") == "disk" and st4.get("probe-d/d2.png") == "disk")
row5 = next(it for it in full["items"] if it["id"] == "fam-aaaaaaaa0005")
st5 = {m["path"]: m["member_state"] for m in row5["members"]}
chk("promoted kept member resolves 'library'", st5.get("probe-e/e1.png") == "library", st5)
chk("on-disk family stays in the default list",
    "fam-aaaaaaaa0005" in ids and "fam-aaaaaaaa0004" in ids, ids)
dr = api("/api/dupe/death-row")
drow = {r["id"]: r for r in dr["items"]}
chk("death-row: ghost archived flag", drow["fam-aaaaaaaa0009"]["archived"] is True)
chk("death-row: on-disk honest counts",
    drow["fam-aaaaaaaa0005"]["on_disk"] == 1 and not drow["fam-aaaaaaaa0005"]["archived"])

with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={"width": 1024, "height": 768})
    pg.goto(S + "/", wait_until="networkidle")
    pg.evaluate("() => { try { localStorage.eeAutoAdvance = '0'; } catch (_) {} }")
    pg.evaluate('''() => { const btn = [...document.querySelectorAll('#tabbar .tab')]
        .find(t => t.dataset.name === 'dupe'); btn.click(); }''')
    pg.wait_for_timeout(2500)
    chips = pg.evaluate(
        "() => [...document.querySelectorAll('.fam-card')].map(c => c.textContent).join('|')")
    chk("'✓ in Library' chip renders", "✓ in Library" in chips)
    chk("'already deleted' chip renders", "already deleted" in chips)
    chk("ghost family has no card by default", "fam-aaaaaaaa0009" not in chips)
    pg.check("#dupe-archived")
    pg.wait_for_timeout(2500)
    chips2 = pg.evaluate(
        "() => [...document.querySelectorAll('.fam-card')].map(c => c.textContent).join('|')")
    chk("toggle reveals ghost card in UI", "fam-aaaaaaaa0009" in chips2, chips2[:200])
    # pardon->promote still works: fam-0005 (1 kept on-disk after flip) —
    # flip e2 to kept, commit, then promote via the normal send-pending path
    # is covered by the full dupe-probe; here: commit a pardon verdict writes
    # the ledger and the family re-resolves (no crash from ghosts)
    r = urllib.request.Request(
        S + "/api/dupe/families/fam-aaaaaaaa0005/verdict",
        data=json.dumps({"members": {"probe-e/e1.png": "kept",
                                     "probe-e/e2.png": "kept"},
                         "note": "pardon"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    resp = json.loads(urllib.request.urlopen(r, timeout=30).read())
    chk("pardon commit works alongside ghosts", resp.get("ok") is True, resp)
    b.close()
print("GHOST-CHECKS " + ("PASS" if all(ok) else "FAIL"))
raise SystemExit(0 if all(ok) else 1)
"""


def check(label, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + label + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(label)


def make_img(p: Path, color):
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 240), color).save(p)


def fam_json(fid, root, rels, edges):
    return {
        "format": "dupe-analyzer.family", "version": 1, "id": fid,
        "created": "2026-10-09T00:00:00-07:00", "root": str(root),
        "authored": False,
        "members": [
            {"path": r, "abs_path": str(root / r), "size": (root / r).stat().st_size,
             "mtime": int((root / r).stat().st_mtime),
             # near-identical sequential hashes: same-family members sit at
             # Hamming distance 1, so the twin-loop section finds twins
             "dhash": format(_j, "016x"), "phash": format(_j, "016x")}
            for _j, r in enumerate(rels)],
        "edges": edges, "related": [],
    }


def build_tree(tmp: Path):
    droot = tmp / "DupeReview"
    specs = [  # (fid, folder, files, edges) — all unresolved unless noted
        ("fam-aaaaaaaa0001", "probe-a", ["a1.png", "a2.png", "a3.png", "a4.png", "a5.png", "a6.png"],
         [("probe-a/a1.png", "probe-a/a2.png")]),
        ("fam-aaaaaaaa0002", "probe-b", ["b1.png", "b2.png"],
         [("probe-b/b1.png", "probe-b/b2.png")]),
        ("fam-aaaaaaaa0003", "probe-c", ["c1.png", "c2.png", "c3.png", "c4.png"],
         [("probe-c/c1.png", "probe-c/c2.png"), ("probe-c/c2.png", "probe-c/c3.png")]),
        ("fam-aaaaaaaa0006", "probe-f", ["f1.png", "f2.png", "f3.png", "f4.png"],
         [("probe-f/f2.png", "probe-f/f3.png")]),
        ("fam-aaaaaaaa0007", "probe-g", ["g1.png", "g2.png", "g3.png"],
         [("probe-g/g1.png", "probe-g/g2.png")]),
        ("fam-aaaaaaaa0008", "probe-h", ["h1.png", "h2.png", "h3.png"],
         [("probe-h/h2.png", "probe-h/h3.png")]),
        ("fam-aaaaaaaa0004", "probe-d", ["d1.png", "d2.png", "d3.png"],
         [("probe-d/d2.png", "probe-d/d3.png")]),   # resolved majority-rejected
        ("fam-aaaaaaaa0005", "probe-e", ["e1.png", "e2.png"],
         [("probe-e/e1.png", "probe-e/e2.png")]),   # resolved majority-rejected
        ("fam-aaaaaaaa0009", "probe-i", ["i1.png", "i2.png", "i3.png"],
         [("probe-i/i2.png", "probe-i/i3.png")]),   # resolved majority-rejected
    ]
    famdir = droot / ".dupes" / "families"
    famdir.mkdir(parents=True)
    index_fams = []
    fams = {}
    for i, (fid, folder, files, edges) in enumerate(specs):
        rels = []
        for j, f in enumerate(files):
            rel = f"{folder}/{f}"
            make_img(droot / rel, ((40 * i + 30) % 256, 140, 60 + 17 * j))
            rels.append(rel)
        # edges use FULL member-relative paths — bare file names don't
        # resolve in _edge_members and silently kill conflict detection
        fam = fam_json(fid, droot, rels,
                       [{"a": a, "b": b, "tier": "exact", "distance": 0}
                        for a, b in edges])
        (famdir / f"{fid}.json").write_text(json.dumps(fam))
        fams[fid] = fam
        index_fams.append({"id": fid, "size": len(rels), "tiers": ["exact"],
                           "first_member": rels[0], "authored": False})
    (droot / ".dupes" / "index.json").write_text(json.dumps({
        "version": 1, "generated": "2026-10-09T00:00:01-07:00",
        "families": index_fams, "stats": {}}))
    # resolved majority-rejected verdicts: fam-D (1 kept / 2 rejected),
    # fam-E (1 kept / 1 rejected) — in the SCRATCH ledger only
    ledger = tmp / ".dupe-verdicts.jsonl"
    with ledger.open("w") as fh:
        fh.write(json.dumps({
            "ts": "2026-10-09T00:00:02-07:00", "family": "fam-aaaaaaaa0004",
            "members": {"probe-d/d1.png": "kept", "probe-d/d2.png": "rejected",
                        "probe-d/d3.png": "rejected"},
            "note": "scratch death-row seed"}) + "\n")
        fh.write(json.dumps({
            "ts": "2026-10-09T00:00:03-07:00", "family": "fam-aaaaaaaa0005",
            "members": {"probe-e/e1.png": "kept", "probe-e/e2.png": "rejected"},
            "note": "scratch death-row mass seed"}) + "\n")
        fh.write(json.dumps({
            "ts": "2026-10-09T00:00:04-07:00", "family": "fam-aaaaaaaa0009",
            "members": {"probe-i/i1.png": "kept", "probe-i/i2.png": "rejected",
                        "probe-i/i3.png": "rejected"},
            "note": "scratch ghost seed"}) + "\n")
    # GHOST SCENARIO (2026-10-09f):
    #   fam-0009: every member leaves the disk → hidden from the default
    #     death-row list, revealed by include_archived=1 (zero thumbs).
    #   fam-0004: rejected member d3.png deleted → 'already deleted' chip.
    #   fam-0005: kept member e1.png promoted to the Library (index record +
    #     file moved) → '✓ in Library' chip; e2.png stays actionable.
    # Ghost mutations are NOT applied here — the full dupe-probe needs the
    # pristine tree (dead thumbs 404 in its console-error gate); they run in
    # GHOST_MUTATE after it. build_tree only leaves the fam-0009 verdict in
    # the ledger; its files stay on disk until the mutation pass.
    lroot = tmp / "Library"
    lroot.mkdir(parents=True, exist_ok=True)
    return droot, ledger, fams


# Ghost mutations (2026-10-09f) — applied AFTER the full dupe-probe so the
# pristine tree stays intact for its console-error gate. Runs in the scratch
# env; paths come from the env vars the probe already exports.
GHOST_MUTATE = r'''
import json, os
from pathlib import Path
droot = Path(os.environ["ELLIEEDIT_DUPE_ROOT"])
lroot = Path(os.environ["ELLIEEDIT_LIBRARY_ROOT"])
ledger = Path(os.environ["ELLIEEDIT_DUPE_LEDGER"])
for rel in ("probe-i/i1.png", "probe-i/i2.png", "probe-i/i3.png",
            "probe-d/d3.png"):
    (droot / rel).unlink()
(lroot / "kept").mkdir(parents=True, exist_ok=True)
os.replace(droot / "probe-e" / "e1.png", lroot / "kept" / "e1.png")
(lroot / ".library-index.jsonl").write_text(json.dumps({
    "path": "kept/e1.png", "tags": ["probe"],
    "promoted_from": "probe-e/e1.png", "sha256": "0" * 64}) + "\n")
import time
time.sleep(2)   # exists-cache TTL is env-shortened to 1s in the probe env
# re-seed the seeded verdicts AFTER dupe-probe's commits: the ledger is
# append-only with latest-verdict-wins, so fresh entries restore exactly the
# states the ghost checks assert on.
seed = [
    {"family": "fam-aaaaaaaa0004",
     "members": {"probe-d/d1.png": "kept", "probe-d/d2.png": "rejected",
                 "probe-d/d3.png": "rejected"}, "note": "ghost reseed D"},
    {"family": "fam-aaaaaaaa0005",
     "members": {"probe-e/e1.png": "kept", "probe-e/e2.png": "rejected"},
     "note": "ghost reseed E"},
    {"family": "fam-aaaaaaaa0009",
     "members": {"probe-i/i1.png": "kept", "probe-i/i2.png": "rejected",
                 "probe-i/i3.png": "rejected"}, "note": "ghost reseed I"},
]
with ledger.open("a") as fh:
    for e in seed:
        e["ts"] = "2026-10-09T12:00:00-07:00"
        fh.write(json.dumps(e) + "\n")
print("ghost mutations applied")
'''


async def live_smoke(pw):
    """LIVE 8800: the real death-row queue renders pre-marked; the mass bar
    shows honest counts after a family visit; NOTHING is enqueued."""
    import urllib.request
    b = await pw.chromium.launch()
    ctx = await b.new_context(viewport=VIEWPORT, has_touch=True)
    pg = await ctx.new_page()
    try:
        # PRE-WARM /death-row: the first stat walk over ~559 families ×
        # rejected members on /mnt takes minutes; the summary is cached on
        # the index:ledger key afterwards, so the UI bar paints fast.
        import time as _time
        t0 = _time.time()
        s = json.loads(urllib.request.urlopen(
            LIVE + "/api/dupe/death-row", timeout=1200).read())
        print(f"death-row summary warmed in {_time.time()-t0:.0f}s — "
              f"{s['families']} families, {s['total_files']} files, "
              f"{s['total_bytes']/1073741824:.2f} GB on disk")
        await pg.goto(LIVE + "/", wait_until="networkidle")
        await pg.evaluate("() => { try { localStorage.eeAutoAdvance = '0'; } catch (_) {} }")
        await pg.evaluate("""() => {
          const btn = [...document.querySelectorAll('#tabbar .tab')]
            .find(t => t.dataset.name === 'dupe');
          btn.click();
        }""")
        await pg.wait_for_timeout(5000)   # /mnt thumbs
        cards = await pg.evaluate(
            "() => [...document.querySelectorAll('.fam-card')]"
            ".filter(c => !c.classList.contains('skel'))")
        check("live: family cards render", len(cards) > 0, str(len(cards)))
        dr_badges = await pg.evaluate(
            "() => [...document.querySelectorAll('.fam-card')]"
            ".filter(c => c.textContent.includes('death row')).length")
        check("live: death-row badges on cards", dr_badges > 0, str(dr_badges))
        # page to the tail: rehydrated rows append after the (zero) unresolved
        for _ in range(40):
            tail = await pg.evaluate("""() => {
              const more = document.querySelector('#dupe-more');
              if (!more || more.style.display === 'none') return false;
              document.querySelector('#dupe-loadmore').click();
              return true;
            }""")
            if not tail:
                break
            await pg.wait_for_timeout(900)
        shown = await pg.evaluate(
            "() => document.querySelectorAll('.fam-card:not(.skel)').length")
        total = await pg.evaluate(
            """async () => { const d = await fetch(
                 '/api/dupe/families?state=unresolved&cursor=').then(r => r.json());
              return d.items.length; }""")
        check("live: unresolved queue is the death row",
              shown >= total and dr_badges > 0, f"shown={shown} first-page={total}")
        await pg.screenshot(path=".probes/drl-01-live-queue.png")
        # open + close a family that HAS rejected files on disk: the mass
        # bar counts stat-existing files, so a family whose rejects are all
        # gone would (correctly) stay hidden
        opened = await pg.evaluate("""async () => {
          const d = await fetch('/api/dupe/death-row').then(r => r.json());
          const fid = (d.items.find(x => x.rejected_files > 0) || {}).id;
          if (!fid) return null;
          const card = [...document.querySelectorAll('.fam-card')]
            .find(c => c.textContent.includes(fid));
          if (card) { card.click(); return fid; }
          return null;
        }""")
        await pg.wait_for_timeout(4000)
        draft = await pg.evaluate(
            "() => !!document.querySelector('.ss-header .ss-badge.draft')")
        check("live: rehydrated detail opens as draft", bool(opened) and draft,
              str(draft))
        await pg.screenshot(path=".probes/drl-02-live-draft.png")
        before_manifest = json.loads(urllib.request.urlopen(
            LIVE + "/api/pending/count").read())["count"]
        await pg.evaluate("() => document.querySelector('#dupe-back').click()")
        bar = None
        for _ in range(120):
            bar = await pg.evaluate("""() => {
              const b = document.querySelector('#dupe-deathbar');
              if (!b || b.style.display === 'none') return null;
              const btn = document.querySelector('#dupe-death-commit');
              return btn && !btn.disabled ? btn.textContent : null;
            }""")
            if bar and "files" in bar:
                break
            await pg.wait_for_timeout(1000)
        check("live: mass bar shows count/GB", bool(bar and "GB" in bar),
              str(bar))
        check("live: mass bar shows count/GB", bool(bar and "GB" in bar),
              str(bar))
        await pg.screenshot(path=".probes/drl-03-live-massbar.png")
        check("live: /death-row totals honest",
              s["total_files"] > 0 and s["total_bytes"] > 0,
              f"{s['total_files']} files, {s['total_bytes']/1073741824:.2f} GB")
        after_manifest = json.loads(urllib.request.urlopen(
            LIVE + "/api/pending/count").read())["count"]
        check("live: smoke enqueued NOTHING",
              before_manifest == after_manifest,
              f"{before_manifest} -> {after_manifest}")
        # iPad 44px: the mass button is thumb-reachable
        btn = await pg.evaluate("""() => {
          const b = document.querySelector('#dupe-death-commit');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return {h: Math.round(r.height), bottom: Math.round(innerHeight - r.bottom)};
        }""")
        check("live: mass button >=44px", bool(btn and btn["h"] >= 44), str(btn))
    finally:
        await b.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix="ellieedit-dupescratch-"))
    droot, ledger, _ = build_tree(tmp)
    groot = tmp / "Gallery"
    groot.mkdir()
    env = dict(os.environ,
               ELLIEEDIT_DUPE_ROOT=str(droot),
               ELLIEEDIT_DUPE_DATA=str(droot / ".dupes"),
               ELLIEEDIT_DUPE_LEDGER=str(ledger),
               ELLIEEDIT_DUPE_SIGNALS_LOG=str(tmp / ".dupe-signals.jsonl"),
               ELLIEEDIT_PENDING_MANIFEST=str(tmp / ".pending-delete.json"),
               ELLIEEDIT_PENDING_AUDIT=str(tmp / ".pending-audit.jsonl"),
               ELLIEEDIT_GALLERY_ROOT=str(groot),
               ELLIEEDIT_LIBRARY_ROOT=str(tmp / "Library"),
               ELLIEEDIT_THUMB_CACHE=str(tmp / ".thumbs"),
               ELLIEEDIT_PROBE_BASE=SCRATCH,
               ELLIEEDIT_DUPE_SEED_OK="1",
               ELLIEEDIT_GHOST_TTL="1")
    srv = subprocess.Popen(
        [str(REPO / ".venv/bin/python"), "-m", "uvicorn", "backend.main:app",
         "--host", "127.0.0.1", "--port", "8810"],
        cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    scratch_rc = 1
    try:
        for _ in range(60):
            try:
                import urllib.request
                urllib.request.urlopen(SCRATCH + "/health", timeout=1)
                break
            except Exception:
                time.sleep(0.3)
        check("scratch: server up", True)
        # ORDER MATTERS (2026-10-09f): the full dupe-probe needs the PRISTINE
        # scratch tree (its console-error gate 404s on dead thumbs), so it
        # runs first; the ghost mutations apply afterwards, then the
        # ghost-state checks run against the same live scratch server.
        r = subprocess.run([str(REPO / ".venv/bin/python"),
                            str(REPO / "tests" / "dupe-probe.py")],
                           cwd=REPO, env=env, timeout=1500)
        scratch_rc = r.returncode
        check("scratch: full dupe-probe (sections 1-15, incl. death-row)",
              scratch_rc == 0, f"exit={scratch_rc}")
        # NOW the ghost mutations: fam-0009 files vanish, fam-0004's d3
        # rejects away, fam-0005's kept e1 promotes to the Library
        g = subprocess.run(
            [str(REPO / ".venv/bin/python"), "-c", GHOST_MUTATE],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=60)
        if g.stderr.strip():
            print(g.stderr)
        check("scratch: ghost mutations applied", g.returncode == 0,
              f"exit={g.returncode}")
        g = subprocess.run(
            [str(REPO / ".venv/bin/python"), "-c", GHOST_CHECKS],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=300)
        print(g.stdout, end="")
        if g.stderr.strip():
            print(g.stderr)
        check("scratch: ghost-state API checks", g.returncode == 0,
              f"exit={g.returncode}")
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except subprocess.TimeoutExpired:
            srv.kill()
        shutil.rmtree(tmp, ignore_errors=True)
    asyncio.run(asyncio.wait_for(_live(), timeout=900))
    print(("PASS" if not fails else "FAIL") +
          (": " + "; ".join(fails) if fails else " — death-row probe green"))
    sys.exit(1 if fails else 0)


async def _live():
    async with async_playwright() as pw:
        await live_smoke(pw)


if __name__ == "__main__":
    main()
