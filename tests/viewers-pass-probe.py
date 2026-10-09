# Viewers-pass browser probe (2026-10-09e).
# Gallery subfolder navigation + delete-in-viewer + Library lightbox, against
# a SCRATCH instance on 127.0.0.1:8811 with TEMP roots — no real operator
# file is ever touched. Run: .venv/bin/python tests/viewers-pass-probe.py
import asyncio
import subprocess
import time
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

REPO = Path(__file__).resolve().parents[1]
SCRATCH = "http://127.0.0.1:8811"

fails = []


def check(label, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + label + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(label)


def make_img(p: Path, color):
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 240), color).save(p)


async def descend(pg, folder_name):
    """Click the folder card for folder_name — if it's already visible take
    it directly; otherwise breadcrumb back to root and look there."""
    found = await pg.evaluate(
        """(name) => { const c = [...document.querySelectorAll('.gal-cell.folder')]
          .find(c => c.dataset.folder === name); if (c) { c.click(); return true; } return false; }""",
        folder_name)
    if found:
        await pg.wait_for_timeout(1000)
        return
    await pg.evaluate("() => { const c = document.querySelector('.gal-crumbs .crumb'); if (c) c.click(); }")
    await pg.wait_for_timeout(600)
    await pg.wait_for_function(
        """(name) => [...document.querySelectorAll('.gal-cell.folder')]
          .some(c => c.dataset.folder === name)""", arg=folder_name, timeout=30000)
    await pg.evaluate(
        """(name) => { [...document.querySelectorAll('.gal-cell.folder')]
          .find(c => c.dataset.folder === name).click(); }""", folder_name)
    await pg.wait_for_timeout(1000)


async def main():
    import shutil, tempfile
    tmp = Path(tempfile.mkdtemp(prefix="ellieedit-vp-probe-"))
    groot, lroot = tmp / "gallery", tmp / "library"
    # Nested depth: gallery/zengostyle/passes/ — deepest folder = 'passes'.
    make_img(groot / "zengostyle" / "passes" / "deep-a.png", (180, 40, 40))
    make_img(groot / "zengostyle" / "passes" / "deep-b.png", (40, 140, 200))
    make_img(groot / "zengostyle" / "top.png", (60, 170, 90))

    env = dict(
        __import__("os").environ,
        ELLIEEDIT_GALLERY_ROOT=str(groot),
        ELLIEEDIT_DUPE_ROOT=str(tmp / "dupes"),
        ELLIEEDIT_LIBRARY_ROOT=str(lroot),
        ELLIEEDIT_THUMB_CACHE_DIR=str(tmp / ".thumbs"),
        ELLIEEDIT_PENDING_MANIFEST=str(tmp / ".pending-delete.json"),
        ELLIEEDIT_PENDING_AUDIT=str(tmp / ".pending-audit.jsonl"),
    )
    srv = subprocess.Popen(
        [str(REPO / ".venv/bin/python"), "-m", "uvicorn", "backend.main:app",
         "--host", "127.0.0.1", "--port", "8811"],
        cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                import urllib.request
                urllib.request.urlopen(SCRATCH + "/health", timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page(viewport={"width": 1024, "height": 768})  # iPad
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(SCRATCH + "/", wait_until="networkidle")
            await pg.wait_for_timeout(1200)

            # ── 1. Breadcrumb + folder cards at root ───────────────────────
            crumbs = await pg.evaluate(
                "() => [...document.querySelectorAll('.gal-crumbs .crumb')].map(b => b.textContent)")
            check("root crumb", crumbs == ["/"], str(crumbs))
            folders = await pg.evaluate(
                "() => [...document.querySelectorAll('.gal-cell.folder')].map(c => c.dataset.folder)")
            check("folder card rendered", "zengostyle" in folders, str(folders))

            # ── 2. Descend two levels; crumbs track depth ─────────────────
            await descend(pg, "zengostyle")
            crumbs = await pg.evaluate(
                "() => [...document.querySelectorAll('.gal-crumbs .crumb')].map(b => b.textContent)")
            check("crumbs after descend", crumbs == ["/", "zengostyle"], str(crumbs))
            await descend(pg, "passes")
            names = await pg.evaluate(
                "() => [...document.querySelectorAll('.gal-cell:not(.folder) .name')].map(n => n.textContent)")
            check("deep listing", sorted(names) ==
                  ["zengostyle/passes/deep-a.png", "zengostyle/passes/deep-b.png"], str(names))

            # ── 3. Lightbox at depth; promote derives DEEPEST folder tag ──
            # deep-b is newest → listed first; promote it so the viewer
            # ADVANCES to deep-a (promoting the last item closes at end).
            await pg.evaluate(
                "() => [...document.querySelectorAll('.gal-cell:not(.folder)')]"
                ".find(c => c.dataset.path.includes('deep-b')).click()")
            await pg.wait_for_timeout(600)
            vis = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer]').style.display")
            check("lightbox opens at depth", vis == "flex", vis)
            # Uniform viewer action row: ⬆ · ✎ · 🗑
            row = await pg.evaluate(
                """() => ['viewer-promote','to-update','viewer-delete'].map(a => {
                     const b = document.querySelector(`[data-act=${a}]`);
                     const r = b.getBoundingClientRect();
                     return {a, present: !!b, w: r.width, h: r.height}; })""")
            check("viewer action row ⬆/✎/🗑", all(r["present"] for r in row), str(row))
            check("viewer actions ≥44px (iPad)",
                  all(r["w"] >= 44 and r["h"] >= 44 for r in row), str(row))

            async def accept_prompt(dialog):
                await dialog.accept("")  # accept the derived default
            pg.on("dialog", accept_prompt)
            await pg.evaluate("() => document.querySelector('[data-act=viewer-promote]').click()")
            await pg.wait_for_timeout(1500)
            lib_file = lroot / "passes" / "deep-b.png"
            check("promote from depth → tag from DEEPEST folder (passes/)",
                  lib_file.is_file(), str(list(lroot.rglob('*.png'))))
            # Advance happened (still in viewer on deep-b), close-at-end later.
            vis = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer]').style.display")
            check("viewer advanced after promote", vis == "flex", vis)

            # ── 4. Delete-in-viewer: two-step confirm → queue, never unlink ─
            # The viewer advanced to deep-a; delete queues THAT file.
            path_a = f"zengostyle/passes/deep-a.png"
            await pg.evaluate("() => document.querySelector('[data-act=viewer-delete]').click()")
            await pg.wait_for_timeout(200)
            armed = await pg.evaluate(
                "() => document.querySelector('[data-act=viewer-delete]').textContent")
            check("delete arms first (confirm step)", "Confirm" in armed, armed)
            await pg.evaluate("() => document.querySelector('[data-act=viewer-delete]').click()")
            await pg.wait_for_timeout(1200)
            check("deleted-from-viewer file STILL on disk (queued)",
                  (groot / path_a).is_file())
            pend = await pg.evaluate(
                "async () => await fetch('/api/pending/count').then(r => r.json())")
            check("enqueued into deletion queue", pend.get("count") == 1, str(pend))
            vis = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer]').style.display")
            check("viewer closed at end (last image)", vis == "none", vis)
            n = await pg.evaluate(
                "() => [...document.querySelectorAll('.gal-cell:not(.folder)')].length")
            check("listing count dropped", n == 0, str(n))

            # ── 5. Library lightbox: retag · send-to-update · delete ──────
            await pg.evaluate("() => { [...document.querySelectorAll('#tabbar .tab')]"
                              ".find(t => t.dataset.name === 'library')?.click(); }")
            await pg.wait_for_timeout(800)
            await pg.evaluate("() => document.querySelector('.lib-cell').click()")
            await pg.wait_for_timeout(600)
            vis = await pg.evaluate("() => document.querySelector('#lib-viewer').style.display")
            check("library lightbox opens", vis == "flex", vis)
            bar = await pg.evaluate(
                """() => ['libv-retag','libv-update','libv-delete'].map(id => {
                     const b = document.querySelector(`#${id}`);
                     const r = b.getBoundingClientRect();
                     return {id, present: !!b, w: r.width, h: r.height}; })""")
            check("library viewer bar 🏷/✎/🗑", all(x["present"] for x in bar), str(bar))
            check("library viewer ≥44px", all(x["w"] >= 44 and x["h"] >= 44 for x in bar), str(bar))
            # No promote in the library viewer.
            check("no promote in library viewer",
                  not await pg.evaluate(
                      "() => !!document.querySelector('#lib-viewer [data-act=viewer-promote]')"))

            # Retag via prompt → chips update.
            async def retag_dialog(dialog):
                await dialog.accept("flatdeep")
            pg.remove_listener("dialog", accept_prompt)
            pg.on("dialog", retag_dialog)
            await pg.evaluate("() => document.querySelector('#libv-retag').click()")
            await pg.wait_for_timeout(800)
            chips = await pg.evaluate(
                "() => [...document.querySelectorAll('.lib-cell .chip')].map(c => c.textContent)")
            check("retag updates chips", "flatdeep" in chips, str(chips))

            # Send-to-update: activates the Update tab with the image.
            await pg.evaluate("() => document.querySelector('#libv-update').click()")
            await pg.wait_for_timeout(800)
            active = await pg.evaluate(
                "() => document.querySelector('.tab.active')?.dataset.name")
            check("✎ send-to-update activates Update tab", active == "update", str(active))

            # Library delete: two-step confirm → pending area, not unlink.
            await pg.evaluate("() => { [...document.querySelectorAll('#tabbar .tab')]"
                              ".find(t => t.dataset.name === 'library')?.click(); }")
            await pg.wait_for_timeout(800)
            await pg.evaluate("() => document.querySelector('.lib-cell').click()")
            await pg.wait_for_timeout(500)
            await pg.evaluate("() => document.querySelector('#libv-delete').click()")
            await pg.wait_for_timeout(200)
            armed = await pg.evaluate("() => document.querySelector('#libv-delete').textContent")
            check("library delete arms first", "Confirm" in armed, armed)
            await pg.evaluate("() => document.querySelector('#libv-delete').click()")
            await pg.wait_for_timeout(1200)
            check("library delete: file SURVIVES in pending area",
                  (lroot / ".pending-delete" / "deep-b.png").is_file())
            listing = await pg.evaluate(
                "async () => await fetch('/api/library/list').then(r => r.json())")
            check("library listing drops deleted-soon item",
                  all(i["path"] != "passes/deep-a.png" for i in listing["items"]),
                  str([i["path"] for i in listing["items"]]))
            q = await pg.evaluate(
                "async () => await fetch('/api/library/pending').then(r => r.json())")
            check("library deletion queue counts 1", q.get("count") == 1, str(q))
            confirm = await pg.evaluate(
                "async () => await fetch('/api/library/pending/confirm', {method: 'POST'}).then(r => r.json())")
            check("library pending/confirm purges", confirm.get("deleted") == 1, str(confirm))

            check("no page errors", not errs, str(errs[:3]))
            await pg.screenshot(path=".probes/vp-01-final.png")
            await b.close()
    finally:
        srv.terminate()
        srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        raise SystemExit(1)
    print("VIEWERS-PASS PROBE PASS")


if __name__ == "__main__":
    asyncio.run(main())
