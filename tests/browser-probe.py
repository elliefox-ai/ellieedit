# Visual probe — curation redesign flow (2026-10-07s).
# Run: .venv/bin/python tests/browser-probe.py   (server on 127.0.0.1:8800)
# Uses a dedicated probe subdir with generated PNGs so the pending-delete
# CONFIRM step only ever destroys probe files. Restores a clean manifest.

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

            # ── 4. Delete-mode marking (red chrome + MARKING badge) ────────
            await pg.click('.tab[data-name="gallery"]')
            await pg.wait_for_timeout(400)
            await pg.evaluate("() => document.querySelector('[data-act=delete-mode]').click()")
            await pg.evaluate("() => [...document.querySelectorAll('.gal-cell')].slice(0, 2).forEach(c => c.click())")
            await pg.wait_for_timeout(700)
            report["deleteMode"] = await pg.evaluate(
                """() => ({gridMarking: document.querySelector('.gal-grid').classList.contains('marking'),
                          markingBadge: !!document.querySelector('#tabbar .marking-badge'),
                          markCount: document.querySelector('[data-id=mark-count]').textContent,
                          barOn: document.querySelector('[data-id=marking-bar]').classList.contains('on')})""")
            await pg.screenshot(path=".probes/05-delete-mode-marking.png")
            await pg.evaluate("() => document.querySelector('[data-act=done-marking]').click()")
            await pg.wait_for_timeout(400)
            report["badgeGoneAfterDone"] = await pg.evaluate(
                "() => !document.querySelector('#tabbar .marking-badge')")

            # ── 5. Pending (clemency) view → two-step confirm ──────────────
            await pg.evaluate("() => document.querySelector('[data-act=show-pending]').click()")
            await pg.wait_for_timeout(1000)
            report["pendingView"] = await pg.evaluate(
                """() => ({summary: document.querySelector('[data-id=pd-summary]').textContent,
                          cells: document.querySelectorAll('.pd-cell').length,
                          returnBtns: [...document.querySelectorAll('.pd-cell button')].every(b => /Return/.test(b.textContent))})""")
            await pg.screenshot(path=".probes/06-pending-view.png")
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
