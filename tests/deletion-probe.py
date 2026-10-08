# Stage-1 probe — Deletion view fix (2026-10-08f).
# Run: .venv/bin/python tests/deletion-probe.py   (server on 127.0.0.1:8800)
#
# NON-DESTRUCTIVE: backs up the real manifest, isolates it to probe-only
# content for the run, seeds probe images under BOTH roots (gallery + dupe
# pool), and restores everything afterward.
#
# Verifies: Deletion view shows real thumbnails (naturalWidth > 0) for
# dupe-pool-relative manifest entries, byte sizes > 0 via /api/pending,
# DELETION badges in the All view for gallery-root entries, renamed UI
# strings, zero console errors, iPad 1024×768 screenshots.

import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright
from PIL import Image

BASE = "http://127.0.0.1:8800"
GALLERY_ROOT = Path("/mnt/e/comfyui/output")
DUPE_ROOT = Path("/mnt/shared/_Incoming/DupeReview")
MANIFEST = Path(__file__).resolve().parents[1] / ".pending-delete.json"
os.makedirs(".probes", exist_ok=True)

gsuffix = os.getpid()
ddir = DUPE_ROOT / f"probe-del-{gsuffix}"
ddir.mkdir(exist_ok=True)
# Gallery entry at ROOT level: the All view is a non-recursive per-folder
# walk, so only root-level files can carry a DELETION badge there.
gimg = GALLERY_ROOT / f"probe-del-{gsuffix}.png"
dimg = ddir / "probe-dupe.png"
Image.new("RGB", (320, 240), (180, 40, 40)).save(gimg)
Image.new("RGB", (320, 240), (40, 140, 200)).save(dimg)
g_rel = f"probe-del-{gsuffix}.png"
d_rel = f"probe-del-{gsuffix}/probe-dupe.png"


async def main():
    backup = MANIFEST.read_bytes() if MANIFEST.exists() else None
    try:
        MANIFEST.write_text(json.dumps({g_rel: "2026-10-08T00:00:00",
                                        d_rel: "2026-10-08T00:00:00"}))
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page(viewport={"width": 1024, "height": 768})
            errs = []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.wait_for_timeout(1200)

            # API-level: sizes must be > 0 for both roots.
            api = await pg.evaluate("""async () => {
              const j = await fetch('/api/pending').then(r => r.json());
              return {count: j.count, bytes: j.bytes,
                      sizes: j.items.map(i => i.size)};
            }""")
            await pg.evaluate(
                "() => [...document.querySelectorAll('#tabbar .tab')]"
                ".find(t => t.dataset.name === 'gallery').click()")
            await pg.wait_for_timeout(600)
            # All view: gallery-root entry badged DELETION.
            await pg.evaluate("() => document.querySelector('[data-act=view-all]').click()")
            await pg.wait_for_timeout(2500)
            allv = await pg.evaluate("""() => {
              const badge = document.querySelector('.gal-cell.ispending');
              return {cells: document.querySelectorAll('.gal-cell').length,
                      badged: document.querySelectorAll('.gal-cell.ispending').length,
                      badgeText: badge ? getComputedStyle(badge, '::before').content : null};
            }""")
            await pg.screenshot(path=".probes/s1-all-view-badges.png")

            # Deletion view: both entries render with real thumbnails.
            await pg.evaluate("() => document.querySelector('[data-act=view-pending]').click()")
            await pg.wait_for_timeout(3500)
            delv = await pg.evaluate("""() => {
              const imgs = [...document.querySelectorAll('.gal-cell img')];
              return {
                cells: imgs.length,
                loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
                footer: document.querySelector('[data-id=pd-msg]').textContent,
                btnText: document.querySelector('[data-act=view-pending]').textContent.trim(),
                barOn: document.querySelector('[data-id=pending-bar]').classList.contains('on')};
            }""")
            await pg.screenshot(path=".probes/s1-deletion-view-thumbs.png")

            report = {"api": api, "allView": allv, "deletionView": delv,
                      "consoleErrors": errs}
            print(json.dumps(report, indent=1))
            ok = (api["count"] == 2 and api["bytes"] > 0
                  and all(v is not None and v > 0 for v in api["sizes"])
                  and allv["badged"] == 1 and "DELETION" in (allv["badgeText"] or "")
                  and delv["cells"] == 2 and delv["loaded"] == 2
                  and delv["footer"].startswith("Deletion queue")
                  and delv["btnText"].startswith("🗑 Deletion")
                  and not errs)
            print("STAGE1-PROBE:", "PASS" if ok else "FAIL")
            await b.close()
    finally:
        if backup is not None:
            MANIFEST.write_bytes(backup)
        elif MANIFEST.exists():
            MANIFEST.unlink()
        gimg.unlink(missing_ok=True)
        dimg.unlink(missing_ok=True)
        for d in (ddir,):
            try:
                d.rmdir()
            except OSError:
                pass


asyncio.run(main())
