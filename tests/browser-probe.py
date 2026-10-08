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
    # ISOLATE: run against an empty manifest so the in-probe CONFIRM can only
    # ever delete probe files — never real queued entries (which may resolve
    # under either the gallery or dupe root). Backup restored at the end.
    MANIFEST.write_text("{}")
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

            # ── 2.5 (10-08l). Blend stage: mask box wired + UI renders ─────
            # Regression: markup data-id="maskbox" vs query [data-id=mask-box]
            # left maskBox null → renderBlend threw on .style.
            blend_console_errors = []
            pg.on('console', lambda m: blend_console_errors.append(m.text)
                  if m.type == 'error' else None)
            await pg.evaluate("() => document.querySelector('[data-act=res-blend]').click()")
            await pg.wait_for_timeout(1500)  # images load over /mnt
            report["blend"] = await pg.evaluate(
                """() => ({maskBoxFound: !!document.querySelector('[data-id=maskbox]'),
                          maskBoxVisible: (() => { const b = document.querySelector('[data-id=maskbox]'); return b && b.style.display !== 'none'; })(),
                          saveBtn: !!document.querySelector('[data-act=save]'),
                          useMask: !!document.querySelector('[data-id=use-mask]'),
                          canvas: (() => { const c = document.querySelector('[data-id=canvas]'); return c && c.width > 0; })()})""")
            assert report["blend"]["maskBoxFound"], "mask box element not found — selector regression"
            assert report["blend"]["saveBtn"] and report["blend"]["useMask"] and report["blend"]["canvas"], \
                f"blend UI did not render: {report['blend']}"
            assert not blend_console_errors, f"console errors in blend stage: {blend_console_errors}"
            await pg.screenshot(path=".probes/03b-blend-stage.png")
            # Leave blend (do NOT save): exit back to the ladder results.
            await pg.evaluate("() => { const b = document.querySelector('[data-act=exit]'); if (b) b.click(); }")
            await pg.wait_for_timeout(600)

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
                          backTopHidden: ![...document.querySelectorAll('.gal-header button')].some(b => /Deletion/.test(b.textContent) && b.getBoundingClientRect().top < 100 && /Delete all/.test(b.textContent))})""")
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

            # ── 8 (07u). Pending view is GLOBAL: mark in folder A + a second
            # folder image reachable without switching dropdowns; switch to
            # Pending while dropdown points at A — grid count must equal
            # status/manifest count even though the folder is A.
            await pg.evaluate("() => document.querySelector('[data-act=view-active]').click()")
            await pg.wait_for_timeout(600)
            other_dir = GALLERY_ROOT / f"probe-del-other-{os.getpid()}"
            other_dir.mkdir(exist_ok=True)
            other_img = other_dir / "probe-other.png"
            Image.new("RGB", (300, 200), (90, 60, 160)).save(other_img)
            other_rel = f"{other_dir.name}/probe-other.png"
            async def _mark(paths, on=True):
                await pg.evaluate(
                    "async (args) => fetch('/api/pending', {method: args[1] ? 'POST' : 'DELETE',"
                    "headers: {'Content-Type': 'application/json'},"
                    "body: JSON.stringify({paths: args[0]})}).then(r => r.json())",
                    [[other_rel] + [f"{subdir}/{p.name}" for p in probe_files[:2]], on])
                await pg.wait_for_timeout(400)
            await _mark([other_rel, f"{subdir}/{probe_files[0].name}", f"{subdir}/{probe_files[1].name}"])
            report["manifestCrossFolder"] = await pg.evaluate(
                "async () => await fetch('/api/pending').then(r => r.json()).then(j => j.count)")
            # Dropdown points at A (subdir); switch to Pending view.
            await pg.evaluate("() => document.querySelector('[data-act=view-pending]').click()")
            await pg.wait_for_timeout(1200)
            report["pendingGlobal"] = await pg.evaluate(
                """() => ({gridCells: document.querySelectorAll('.gal-cell').length,
                          folderLabels: [...document.querySelectorAll('.gal-cell .name')].map(n => n.textContent),
                          status: document.querySelector('[data-id=status]').textContent,
                          dropdown: document.querySelector('[data-id=dir-select]').value})""")
            report["pendingCountAgrees"] = (
                report["pendingGlobal"]["gridCells"] == report["manifestCrossFolder"])
            await pg.screenshot(path=".probes/09-pending-global-crossfolder.png")
            await _mark([other_rel], on=False)

            # ── 9 (08e fix). Select-mode active styling — uses a FRESH dir.
            # The original clicked cells right after switching views in the
            # (by now emptied) probe dir; the async reload raced the clicks
            # and it only passed when stale cells were clicked. A fresh dir
            # makes the selection deterministic.
            await pg.evaluate("() => document.querySelector('[data-act=view-active]').click()")
            sel_dir = GALLERY_ROOT / f"probe-sel-{os.getpid()}"
            sel_dir.mkdir(exist_ok=True)
            Image.new("RGB", (300, 200), (200, 120, 20)).save(sel_dir / "s0.png")
            Image.new("RGB", (300, 200), (20, 120, 200)).save(sel_dir / "s1.png")
            await pg.reload(wait_until="networkidle")
            await pg.wait_for_timeout(1200)
            await pg.select_option('[data-id="dir-select"]', sel_dir.name)
            await pg.wait_for_timeout(1200)
            await pg.evaluate("() => document.querySelector('[data-act=select-mode]').click()")
            await pg.wait_for_timeout(300)
            await pg.evaluate("() => [...document.querySelectorAll('.gal-cell')].slice(0, 2).forEach(c => c.click())")
            await pg.wait_for_timeout(500)
            report["selCountAfterClicks"] = await pg.evaluate(
                "() => document.querySelector('[data-id=sel-count]').textContent")
            assert report["selCountAfterClicks"] != "0", "selection did not register"
            async def _btnstyle(sel):
                js = ("(sel) => { const b = document.querySelector(sel);"
                      " const s = getComputedStyle(b);"
                      " return {text: b.textContent.trim(), bg: s.backgroundColor, color: s.color}; }")
                return await pg.evaluate(js, sel)
            report["selectActive"] = await _btnstyle('[data-act=select-mode]')
            await pg.evaluate("() => document.querySelector('[data-act=clear-sel]')?.click()")
            await pg.evaluate("() => document.querySelector('[data-act=delete-mode]').click()")
            await pg.wait_for_timeout(300)
            report["deleteActive"] = await _btnstyle('[data-act=delete-mode]')
            await pg.evaluate("() => document.querySelector('[data-act=done-marking]').click()")
            import shutil
            shutil.rmtree(sel_dir, ignore_errors=True)
            await pg.screenshot(path=".probes/10-select-active-styling.png")

            # ── 11 (08e). Gallery → FaceCycle multi-select handoff ──────────
            # Fresh probe dir, own images, never added to the pending manifest;
            # removed below so the disk-clean check is unaffected. Console
            # errors are collected across the section and must stay empty.
            console_errors = []
            pg.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)
            fc_dir = GALLERY_ROOT / f"probe-fc-{os.getpid()}"
            fc_dir.mkdir(exist_ok=True)
            for i, color in enumerate([(200, 90, 30), (30, 90, 200), (30, 170, 130)]):
                Image.new("RGB", (256, 256), color).save(fc_dir / f"fc-{i}.png")
            try:
                # fc_dir was created after page load — reload so refreshDirs
                # picks it up in the dropdown.
                await pg.reload(wait_until="networkidle")
                await pg.wait_for_timeout(1200)
                await pg.select_option('[data-id="dir-select"]', fc_dir.name)
                await pg.wait_for_timeout(1200)
                await pg.evaluate("() => document.querySelector('[data-act=select-mode]').click()")
                await pg.evaluate("() => [...document.querySelectorAll('.gal-cell')].slice(0, 3).forEach(c => c.click())")
                await pg.wait_for_timeout(400)
                report["fcBar"] = await pg.evaluate(
                    """() => { const b = document.querySelector('[data-act=to-facecycle-multi]');
                             const r = b.getBoundingClientRect();
                             return {visible: b.style.display !== 'none',
                                     touch40: r.height >= 40,
                                     text: b.textContent.trim()}; }""")
                await pg.screenshot(path=".probes/11a-multiselect-fc-action.png")
                await pg.evaluate("() => document.querySelector('[data-act=to-facecycle-multi]').click()")
                await pg.wait_for_timeout(1500)
                report["fcHandoff"] = await pg.evaluate(
                    """() => ({tab: document.querySelector('.tab.active').dataset.name,
                             dropZoneHidden: document.querySelector('[data-id=drop-zone]').style.display === 'none',
                             mainVisible: document.querySelector('[data-id=main-view]').style.display === 'flex',
                             thumbs: [...document.querySelectorAll('[data-id=thumbnail-strip] .thumb .label')].map(l => l.textContent),
                             receipt: document.querySelector('[data-id=status-bar]').textContent});""")
                assert report["fcHandoff"]["tab"] == "facecycle", "did not navigate to FaceCycle"
                assert len(report["fcHandoff"]["thumbs"]) == 3, "thumb strip does not show 3 handed-off images"
                assert "handed off from Gallery" in report["fcHandoff"]["receipt"], "no visible receipt"
                await pg.screenshot(path=".probes/11b-facecycle-preload.png")
                # Selection persists on return: rings still on, bar still shows the action.
                await pg.click('.tab[data-name="gallery"]')
                await pg.wait_for_timeout(800)
                report["fcReturn"] = await pg.evaluate(
                    "() => ({selRings: document.querySelectorAll('.gal-cell.sel').length," 
                    "        fcBtnVisible: document.querySelector('[data-act=to-facecycle-multi]').style.display !== 'none'})")
                assert report["fcReturn"]["selRings"] == 3, "selection did not persist on return"
                await pg.screenshot(path=".probes/11c-gallery-return-persist.png")
                # iPad 1024×768 screenshots of both states.
                await pg.set_viewport_size({"width": 1024, "height": 768})
                await pg.wait_for_timeout(400)
                await pg.screenshot(path=".probes/11d-ipad-gallery-bar.png")
                await pg.click('.tab[data-name="facecycle"]')
                await pg.wait_for_timeout(600)
                await pg.screenshot(path=".probes/11e-ipad-facecycle.png")
                report["consoleErrors"] = console_errors
                assert not console_errors, f"console errors: {console_errors}"
            finally:
                import shutil
                shutil.rmtree(fc_dir, ignore_errors=True)

            # ── 12 (08i). Deferred delete-marking + async thumbs ────────────
            # Fresh probe dir, 3 images. Assert: (a) cells render as
            # skeletons then reveal; (b) marking taps are local-only — zero
            # /api/pending fetches, zero grid re-render (DOM nodes stable);
            # (c) Done marking commits in ONE batch; (d) console clean.
            console_errors = []
            pg.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)
            mk_dir = GALLERY_ROOT / f"probe-mk-{os.getpid()}"
            mk_dir.mkdir(exist_ok=True)
            for i, color in enumerate([(40, 200, 40), (200, 40, 200), (40, 40, 200)]):
                Image.new("RGB", (256, 256), color).save(mk_dir / f"mk-{i}.png")
            try:
                await pg.reload(wait_until="networkidle")
                await pg.wait_for_timeout(800)
                await pg.select_option('[data-id="dir-select"]', mk_dir.name)
                # Skeletons first: cells exist but thumbs not yet revealed.
                report["asyncSkeletons"] = await pg.evaluate(
                    "() => ({cells: document.querySelectorAll('.gal-cell').length,"
                    " loading: document.querySelectorAll('.gal-cell.thumb-loading').length})")
                await pg.wait_for_function(
                    "() => { const n = document.querySelectorAll('.gal-cell').length;"
                    " const l = document.querySelectorAll('.gal-cell.thumb-loading').length;"
                    " return n > 0 && l === 0; }", timeout=30000)
                report["asyncRevealed"] = await pg.evaluate(
                    "() => ({cells: document.querySelectorAll('.gal-cell').length,"
                    " loaded: document.querySelectorAll('.gal-cell.thumb-loaded').length})")
                assert report["asyncRevealed"]["loaded"] == 3, "thumbs did not all reveal"

                # Delete-marking: tap 3 thumbs; between taps NOTHING may hit
                # the network or rebuild the grid.
                await pg.evaluate(
                    "() => { window.__pendingFetches = 0; const of = window.fetch;"
                    " window.fetch = (...a) => { const u = String(a[0]); if (u.includes('/api/pending')) { window.__pendingFetches++; const m = (a[1] && a[1].method) || 'GET'; if (m !== 'GET') window.__pendingMut = (window.__pendingMut || 0) + 1; } return of(...a); };"
                    " window.__cells = [...document.querySelectorAll('.gal-cell')]; }")
                await pg.evaluate("() => document.querySelector('[data-act=delete-mode]').click()")
                for i in range(3):
                    await pg.evaluate(f"() => window.__cells[{i}].click()")
                    await pg.wait_for_timeout(150)
                report["deferredMarking"] = await pg.evaluate(
                    "() => ({pendingFetches: window.__pendingFetches,"
                    " nodesStable: document.querySelectorAll('.gal-cell').length === window.__cells.length"
                    "   && [...document.querySelectorAll('.gal-cell')].every((c, i) => c === window.__cells[i]),"
                    " rings: document.querySelectorAll('.gal-cell.marked').length})")
                assert report["deferredMarking"]["pendingFetches"] == 0, "marking taps hit the network"
                assert report["deferredMarking"]["nodesStable"], \
                    "marking taps rebuilt the grid cells"
                assert report["deferredMarking"]["rings"] == 3, "marked rings did not toggle locally"
                await pg.set_viewport_size({"width": 1024, "height": 768})
                await pg.wait_for_timeout(300)
                await pg.screenshot(path=".probes/12a-ipad-marking-rings.png")
                # Done marking: ONE batched commit → manifest count 3.
                await pg.evaluate("() => document.querySelector('[data-act=done-marking]').click()")
                await pg.wait_for_timeout(1200)
                report["afterDone"] = await pg.evaluate(
                    "async () => ({manifest: await fetch('/api/pending').then(r => r.json()).then(j => j.count),"
                    " mutFetches: window.__pendingMut || 0})")
                assert report["afterDone"]["manifest"] == 3, "Done marking did not commit the batch"
                assert report["afterDone"]["mutFetches"] == 1, \
                    f"expected exactly 1 batched POST on Done, got {report['afterDone']['mutFetches']}"
                await pg.screenshot(path=".probes/12b-ipad-post-done-grid.png")
                report["consoleErrors"] = console_errors
                assert not console_errors, f"console errors: {console_errors}"
            finally:
                import shutil
                shutil.rmtree(mk_dir, ignore_errors=True)

            # Verify on disk: every probe file should be gone.
            report["filesLeftOnDisk"] = [p.name for p in probe_files if p.exists()]
            print(json.dumps(report, indent=1))
            await b.close()
    finally:
        # Cleanup: probe dir + clean manifest (probe-owned entries only).
        import shutil
        shutil.rmtree(probe_dir, ignore_errors=True)
        shutil.rmtree(GALLERY_ROOT / f"probe-del-other-{os.getpid()}", ignore_errors=True)
        if manifest_backup is not None:
            MANIFEST.write_bytes(manifest_backup)
        elif MANIFEST.exists():
            MANIFEST.unlink()


asyncio.run(main())
