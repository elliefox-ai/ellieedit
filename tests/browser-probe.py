# Visual probe — curation redesign flow (2026-10-07t).
# Run: .venv/bin/python tests/browser-probe.py   (server on 127.0.0.1:8800)
# Uses a dedicated probe subdir with generated PNGs so the pending-delete
# CONFIRM step only ever destroys probe files. Restores a clean manifest.
# 07t coverage: view filter (All/Active/Pending), pending badges in All,
# bottom-bar Delete all, post-ladder champion highlight + rejected badges.

import asyncio, json, os, sys
from pathlib import Path
from playwright.async_api import async_playwright
from PIL import Image

BASE = "http://127.0.0.1:8800"
GALLERY_ROOT = Path(os.environ.get("ELLIEEDIT_GALLERY_ROOT", "/mnt/e/comfyui/output"))
MANIFEST = Path(__file__).resolve().parents[1] / ".pending-delete.json"
os.makedirs(".probes", exist_ok=True)

probe_dir = GALLERY_ROOT / f"probe-del-{os.getpid()}"
probe_dir.mkdir(exist_ok=True)
probe_files = []
for i, color in enumerate([(180, 40, 40), (40, 140, 200), (60, 170, 90), (220, 180, 60)]):
    p = probe_dir / f"probe-{i}.png"
    Image.new("RGB", (320, 240), color).save(p)
    probe_files.append(p)


async def click_btn(pg, pattern, scope=""):
    return await pg.evaluate(
        """([pattern, scope]) => {
          const root = scope ? document.querySelector(scope) : document;
          const b = [...root.querySelectorAll('button')].find(b => pattern.test(b.textContent.trim()));
          if (b) { b.click(); return b.textContent.trim(); }
          return null;
        }""", [pattern, scope])


async def main():
    manifest_backup = MANIFEST.read_bytes() if MANIFEST.exists() else None
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page(viewport={"width": 900, "height": 700})
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.wait_for_timeout(1200)
            report = {"build": await pg.evaluate(
                "() => [...document.querySelectorAll('#tabbar span')].map(s=>s.textContent).find(t=>t.startsWith('build'))")}

            # ── 1. Gallery multi-select over the probe subdir ──────────────
            subdir = probe_dir.name
            await pg.select_option('[data-id="dir-select"]', subdir)
            await pg.wait_for_timeout(1200)
            await pg.evaluate("() => document.querySelector('[data-act=select-mode]').click()")
            await pg.evaluate("() => [...document.querySelectorAll('.gal-cell')].slice(0, 4).forEach(c => c.click())")
            await pg.wait_for_timeout(500)
            report["actionBar"] = await pg.evaluate(
                "() => ({sel: document.querySelector('[data-id=sel-count]').textContent,"
                " ladderBtn: document.querySelector('[data-act=ladder]').textContent.trim(),"
                " blendPairVisible: document.querySelector('[data-act=blend-pair]').style.display !== 'none'})")
            await pg.screenshot(path=".probes/01-gallery-multiselect.png")

            # ── 2. Ladder N launch → duel → results ────────────────────────
            await pg.evaluate("() => document.querySelector('[data-act=ladder]').click()")
            await pg.wait_for_timeout(900)
            report["ladderTabActive"] = await pg.evaluate(
                "() => document.querySelector('.tab.active').dataset.name")
            report["duelPhase"] = await pg.evaluate(
                "() => (document.body.innerText.match(/Challenger [^\\n]*/) || [null])[0]")
            await pg.screenshot(path=".probes/02-ladder-duel.png")
            for _ in range(4):
                done = await pg.evaluate(
                    "() => { const r = document.querySelector('[data-id=results]'); return r && r.style.display !== 'none'; }")
                if done:
                    break
                await (await pg.query_selector('button[data-act="keep-champion"]')).click()
                await pg.wait_for_timeout(600)
            report["results"] = await pg.evaluate(
                """() => ({champ: document.querySelector('[data-id=res-champ-label]')?.textContent,
                          sendBtn: document.querySelector('[data-act=res-send-pending]')?.textContent.trim()})""")
            await pg.screenshot(path=".probes/03-ladder-results.png")

            # ── 3. Send M rejected → Pending Delete ────────────────────────
            await pg.evaluate("() => document.querySelector('[data-act=res-send-pending]').click()")
            await pg.wait_for_timeout(800)
            report["sendToast"] = await pg.evaluate(
                "() => [...document.querySelectorAll('body > div')].map(d => d.textContent).find(t => /marked for delete/.test(t)) || null")
            report["manifestAfterSend"] = await pg.evaluate(
                "async () => await fetch('/api/pending').then(r => r.json()).then(j => j.count)")
            await pg.screenshot(path=".probes/04-send-rejected.png")

            # ── 4. Gallery return: sync, filter views, champion highlight ──
            await pg.click('.tab[data-name="gallery"]')
            await pg.wait_for_timeout(800)
            # 4a. Default Active view HIDES the 3 pending images.
            report["activeView"] = await pg.evaluate(
                """() => ({cells: document.querySelectorAll('.gal-cell').length,
                          badge: [...document.querySelectorAll('.gal-cell.ispending')].length,
                          champion: !!document.querySelector('.gal-cell.champion')})""")
            await pg.screenshot(path=".probes/04a-active-hides-pending.png")
            # 4b. All view: 4 cells, 3 red-badged pendings, champion visible.
            await pg.evaluate("() => document.querySelector('[data-act=view-all]').click()")
            await pg.wait_for_timeout(1000)
            report["allView"] = await pg.evaluate(
                "() => ({cells: document.querySelectorAll('.gal-cell').length,"
                " badged: document.querySelectorAll('.gal-cell.ispending').length})")
            await pg.screenshot(path=".probes/04b-all-badged-pending.png")
            # 4c. Pending filter: 3 cells with Return buttons, Delete all in the
            # sticky BOTTOM bar (destructive lives low/left, never thumb-top).
            await pg.evaluate("() => document.querySelector('[data-act=view-pending]').click()")
            await pg.wait_for_timeout(1000)
            report["pendingView"] = await pg.evaluate(
                """() => ({cells: document.querySelectorAll('.gal-cell').length,
                          returnBtns: document.querySelectorAll('.pd-return').length,
                          barOn: document.querySelector('[data-id=pending-bar]').classList.contains('on'),
                          deleteAllBottom: (() => { const b = document.querySelector('[data-act=pd-delete-all]'); const r = b.getBoundingClientRect(); return r.top > window.innerHeight * 0.6 && r.left < window.innerWidth / 2; })(),
                          backTopHidden: ![...document.querySelectorAll('.gal-header button')].some(b => /Pending/.test(b.textContent) && b.getBoundingClientRect().top < 100 && /Delete all/.test(b.textContent))})""")
            await pg.screenshot(path=".probes/04c-pending-bottom-bar.png")

            # ── 5. Champion highlight on Gallery return ─────────────────────
            await pg.evaluate("() => document.querySelector('[data-act=view-all]').click()")
            await pg.wait_for_timeout(800)
            await pg.click('.tab[data-name="ladder"]')
            await pg.wait_for_timeout(300)
            report["ladderSummarySurvives"] = await pg.evaluate(
                "() => document.querySelector('[data-id=res-summary]')?.textContent || null")
            await pg.click('.tab[data-name="gallery"]')
            await pg.wait_for_timeout(600)
            report["championReturn"] = await pg.evaluate(
                "() => { const c = document.querySelector('.gal-cell.champion'); return c ? {flash: c.classList.contains('flash'), name: c.querySelector('.name')?.textContent} : null; }")
            await pg.screenshot(path=".probes/05-champion-highlight.png")

            # ── 6. Delete-mode marking (red chrome + MARKING badge) ────────
            await pg.evaluate("() => document.querySelector('[data-act=delete-mode]').click()")
            await pg.evaluate("() => [...document.querySelectorAll('.gal-cell')].slice(0, 2).forEach(c => c.click())")
            await pg.wait_for_timeout(700)
            report["deleteMode"] = await pg.evaluate(
                """() => ({gridMarking: document.querySelector('.gal-grid').classList.contains('marking'),
                          markingBadge: !!document.querySelector('#tabbar .marking-badge'),
                          markCount: document.querySelector('[data-id=mark-count]').textContent,
                          barOn: document.querySelector('[data-id=marking-bar]').classList.contains('on')})""")
            await pg.screenshot(path=".probes/06-delete-mode-marking.png")
            await pg.evaluate("() => document.querySelector('[data-act=done-marking]').click()")
            await pg.wait_for_timeout(400)
            report["badgeGoneAfterDone"] = await pg.evaluate(
                "() => !document.querySelector('#tabbar .marking-badge')")

            # ── 7. Bottom-bar two-step confirm (Pending filter view) ───────
            await pg.evaluate("() => document.querySelector('[data-act=view-pending]').click()")
            await pg.wait_for_timeout(1000)
            await pg.evaluate("() => document.querySelector('[data-act=pd-delete-all]').click()")
            await pg.wait_for_timeout(300)
            report["confirmText"] = await pg.evaluate(
                "() => document.querySelector('[data-act=pd-delete-all]').textContent")
            await pg.screenshot(path=".probes/07-pending-confirm-armed.png")
            await pg.evaluate("() => document.querySelector('[data-act=pd-delete-all]').click()")
            await pg.wait_for_timeout(1200)
            report["deleteToast"] = await pg.evaluate(
                "() => [...document.querySelectorAll('body > div')].map(d => d.textContent).find(t => /Deleted \\d+ images/.test(t)) || null")
            report["manifestAfterConfirm"] = await pg.evaluate(
                "async () => await fetch('/api/pending').then(r => r.json()).then(j => j.count)")

            # ── 6. Post-delete grid (probe files gone) ─────────────────────
            await pg.click('.tab[data-name="gallery"]')
            await pg.wait_for_timeout(300)
            await pg.select_option('[data-id="dir-select"]', subdir)
            await pg.wait_for_timeout(1200)
            report["postDeleteGrid"] = await pg.evaluate(
                "() => ({cells: document.querySelectorAll('.gal-cell').length,"
                " status: document.querySelector('[data-id=status]').textContent})")
            await pg.screenshot(path=".probes/08-post-delete-grid.png")

            # Verify on disk: every probe file should be gone.
            report["filesLeftOnDisk"] = [p.name for p in probe_files if p.exists()]
            print(json.dumps(report, indent=1))
            await b.close()
    finally:
        # Cleanup: probe dir + clean manifest (probe-owned entries only).
        import shutil
        shutil.rmtree(probe_dir, ignore_errors=True)
        if manifest_backup is not None:
            MANIFEST.write_bytes(manifest_backup)
        elif MANIFEST.exists():
            MANIFEST.unlink()


asyncio.run(main())
