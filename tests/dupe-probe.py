# Dupe view probe (2026-10-07v) — family browser, detail verdicts,
# send-to-pending, Gallery All badges. Non-destructive: pending additions
# from the probe are pardoned at the end (manifest restored byte-for-byte).
# Run: .venv/bin/python tests/dupe-probe.py   (server on 127.0.0.1:8800)

import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8800"
MANIFEST = Path(__file__).resolve().parents[1] / ".pending-delete.json"
os.makedirs(".probes", exist_ok=True)


async def main():
    manifest_backup = MANIFEST.read_bytes() if MANIFEST.exists() else None
    probe_paths = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page(viewport={"width": 1100, "height": 800})
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.wait_for_timeout(1500)

            # ── 1. Dupe tab: family browser ────────────────────────────
            await pg.evaluate("""() => {
              const btn = [...document.querySelectorAll('#tabbar .tab')]
                .find(t => t.dataset.name === 'dupe');
              btn.click();
            }""")
            await pg.wait_for_timeout(4000)  # thumbnails over /mnt are slow
            report = {"status": await pg.inner_text("#dupe-status")}
            await pg.screenshot(path=".probes/dupe-01-browser.png")

            # ── 2. Family detail with verdicts ─────────────────────────
            await pg.evaluate("""() => {
              document.querySelector('.fam-card').click();
            }""")
            await pg.wait_for_timeout(3000)
            # Reject 2nd member, Keep 1st
            await pg.evaluate("""() => {
              const rows = document.querySelectorAll('.mem-row');
              rows[0].querySelector('.vbtn.kept').click();
              if (rows[1]) rows[1].querySelector('.vbtn.rejected').click();
            }""")
            await pg.fill("#dupe-note", "probe verdict — first is sharpest")
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=".probes/dupe-02-detail-verdicts.png")

            # ── 3. Save verdict + send rejected to pending ─────────────
            await pg.evaluate("() => document.querySelector('#dupe-send').click()")
            await pg.wait_for_timeout(700)  # read the badge before the reload
            report["jobbar"] = await pg.inner_text("#jobbar")
            await pg.wait_for_timeout(2500)
            await pg.screenshot(path=".probes/dupe-03-after-send.png")

            # what landed in the manifest?
            m = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
            report["manifest_added"] = [k for k in m if k not in
                                        (json.loads(manifest_backup).keys()
                                         if manifest_backup else [])]
            probe_paths = report["manifest_added"]

            # ── 4. Gallery All view shows the badge ────────────────────
            await pg.evaluate("""() => {
              const btn = [...document.querySelectorAll('#tabbar .tab')]
                .find(t => t.dataset.name === 'gallery');
              btn.click();
            }""")
            await pg.wait_for_timeout(2500)
            # jump to the folder holding the first badged image
            if probe_paths:
                folder = str(Path(probe_paths[0]).parent)
                if folder and folder != ".":
                    try:
                        await pg.select_option('[data-id="dir-select"]', folder)
                        await pg.wait_for_timeout(2500)
                    except Exception as e:
                        report["dir_select"] = str(e)
            report["badged_cells"] = await pg.evaluate(
                "() => document.querySelectorAll('.gal-cell.ispending').length")
            await pg.screenshot(path=".probes/dupe-04-gallery-badges.png")

            print(json.dumps(report, indent=1))
            await b.close()
    finally:
        # restore manifest exactly; also pardon via API first so counts stay sane
        if probe_paths:
            import urllib.request
            req = urllib.request.Request(
                BASE + "/api/pending",
                data=json.dumps({"paths": probe_paths}).encode(),
                headers={"Content-Type": "application/json"}, method="DELETE")
            urllib.request.urlopen(req)
        if manifest_backup is None:
            MANIFEST.unlink(missing_ok=True)
        else:
            MANIFEST.write_bytes(manifest_backup)


asyncio.run(main())
