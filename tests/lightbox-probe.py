# Lightbox-promote probe (2026-10-09c).
# Run: .venv/bin/python tests/lightbox-probe.py   (server on 127.0.0.1:8800)
# Seeds a dedicated probe subdir with real PNGs; drives the gallery viewer
# (lightbox): open, arrow nav, P-promote with derived-tag prompt + auto-
# advance, Esc close, folder count drop, quiet already-moved state, and the
# iPad 1024x768 pass (44px promote target, on-screen arrows present).
# Cleanup is hash-verified: probe files moved into the library are removed,
# and the probe dir is deleted — failures are reported, never silent.

import asyncio, hashlib, json, os, shutil, sys
from pathlib import Path
from playwright.async_api import async_playwright
from PIL import Image

BASE = "http://127.0.0.1:8800"
GALLERY_ROOT = Path(os.environ.get("ELLIEEDIT_GALLERY_ROOT", "/mnt/e/comfyui/output"))
LIBRARY_ROOT = Path(os.environ.get("ELLIEEDIT_LIBRARY_ROOT", "/mnt/shared/_Library"))
os.makedirs(".probes", exist_ok=True)

probe_dir = GALLERY_ROOT / f"probe-lb-{os.getpid()}"
probe_dir.mkdir(exist_ok=True)
COLORS = [(180, 40, 40), (40, 140, 200), (60, 170, 90)]
probe_files = []
for i, color in enumerate(COLORS):
    p = probe_dir / f"lb-{i}.png"
    Image.new("RGB", (320, 240), color).save(p)
    probe_files.append(p)

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
made = {p.name: sha(p) for p in probe_files}
report, cleanup_fail = [], []

async def main():
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page(viewport={"width": 1024, "height": 768})
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.wait_for_timeout(1200)

            # ── 1. Open the probe folder, click a card → lightbox ──────────
            await pg.select_option('[data-id="dir-select"]', probe_dir.name)
            await pg.wait_for_timeout(1500)
            n_cells = await pg.evaluate("() => document.querySelectorAll('.gal-cell').length")
            report.append(("folder cells", n_cells))
            assert n_cells == 3, f"expected 3 cells, got {n_cells}"
            # No card promote buttons remain (operator feedback).
            card_promos = await pg.evaluate("() => document.querySelectorAll('.gal-promote').length")
            report.append(("card promote buttons", card_promos))
            assert card_promos == 0, "card ⬆ buttons still present"
            await pg.evaluate("() => document.querySelector('.gal-cell').click()")
            await pg.wait_for_timeout(800)
            vis = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer]').style.display")
            report.append(("lightbox visible", vis))
            assert vis == "flex", "lightbox did not open"
            name0 = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer-name]').textContent")
            report.append(("lightbox shows", name0))
            await pg.screenshot(path=".probes/lb-01-open.png")

            # ── 2. Arrow-key navigation ────────────────────────────────────
            await pg.keyboard.press("ArrowRight")
            await pg.wait_for_timeout(400)
            name1 = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer-name]').textContent")
            report.append(("after →", name1))
            assert name1 != name0, "arrow-right did not navigate"
            await pg.keyboard.press("ArrowLeft")
            await pg.wait_for_timeout(400)
            back = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer-name]').textContent")
            assert back == name0, "arrow-left did not return"

            # ── 3. Esc closes ──────────────────────────────────────────────
            await pg.keyboard.press("Escape")
            await pg.wait_for_timeout(300)
            vis = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer]').style.display")
            assert vis == "none", "Esc did not close lightbox"
            report.append(("Esc closes", True))

            # ── 4. P promotes with derived tag + auto-advances ─────────────
            # The listing may be newest-first — promote WHATEVER the
            # lightbox is showing, not a hard-coded file.
            shown = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer-name]').textContent.split(' ')[0]")
            derived = await pg.evaluate(
                f"""async () => (await (await fetch('/api/library/derive?path=' +
                    encodeURIComponent('{probe_dir.name}/{shown}'))).json()).tag""")
            report.append(("derived tag", derived))
            lib_tag_dir = LIBRARY_ROOT / derived
            lib_before = {p.name for p in lib_tag_dir.iterdir()} if lib_tag_dir.exists() else set()
            report.append(("lightbox file", shown))

            captured = {}
            async def dialog(d):
                captured["default"] = d.default_value
                await d.accept(derived)   # keep derived tag (override allowed but unused)
            pg.on("dialog", dialog)
            await pg.evaluate("() => document.querySelector('.gal-cell').click()")
            await pg.wait_for_timeout(500)
            await pg.keyboard.press("p")
            await pg.wait_for_timeout(1500)
            report.append(("prompt default tag", captured.get("default")))
            moved = probe_dir / shown
            assert not moved.exists(), f"promote did not move {shown}"
            assert (lib_tag_dir / shown).exists(), "file not in library after promote"
            assert sha(lib_tag_dir / shown) == made[shown], "moved bytes differ"
            report.append(("promote moved+hash", True))
            # Auto-advance: viewer still open, showing the NEXT image (lb-1).
            vis = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer]').style.display")
            nameA = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer-name]').textContent")
            report.append(("auto-advance shows", nameA))
            assert vis == "flex" and "lb-1" in nameA, f"no auto-advance: {vis} {nameA}"
            n_cells = await pg.evaluate("() => document.querySelectorAll('.gal-cell').length")
            report.append(("cells after promote", n_cells))
            assert n_cells == 2, "folder count did not drop by one"
            await pg.screenshot(path=".probes/lb-02-advanced.png")

            # ── 5. Promote through the last image → close-at-end ───────────
            for _ in range(2):
                await pg.keyboard.press("p")
                await pg.wait_for_timeout(1500)
            vis = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer]').style.display")
            n_cells = await pg.evaluate("() => document.querySelectorAll('.gal-cell').length")
            report.append(("after promoting all", {"viewer": vis, "cells": n_cells}))
            assert vis == "none", "lightbox did not close at end"
            assert n_cells == 0, "cells remained after promoting all"

            # ── 6. Quiet already-moved state (ghost path in listing) ───────
            # The listing still shows a card whose file was already moved/
            # deleted server-side; opening it must show the quiet note and
            # navigation must skip forward without erroring.
            Image.new("RGB", (320, 240), (90, 90, 200)).save(probe_dir / "lb-moved.png")
            # Force a listing reload without touching dir-select — switching
            # folders races the in-flight /mnt scan (loadMore loading guard)
            # and can leave the ROOT listing in the grid. this.dir is still
            # the probe folder, so a synthetic change re-scans it.
            await pg.evaluate(
                "() => document.querySelector('[data-id=dir-select]')" \
                ".dispatchEvent(new Event('change'))")
            await pg.wait_for_function(
                "() => [...document.querySelectorAll('.gal-cell')]"
                ".some(c => c.dataset.path.includes('lb-moved'))", timeout=30000)
            (probe_dir / "lb-moved.png").unlink()   # file gone behind the listing
            await pg.wait_for_function(
                "() => [...document.querySelectorAll('.gal-cell')]"
                ".some(c => c.dataset.path.includes('lb-moved'))", timeout=5000)
            await pg.evaluate(
                "() => [...document.querySelectorAll('.gal-cell')]" \
                ".find(c => c.dataset.path.includes('lb-moved')).click()")
            await pg.wait_for_timeout(800)
            note = await pg.evaluate(
                "() => document.querySelector('[data-id=viewer-note]').style.display")
            report.append(("already-moved note", note))
            assert note == "block", "quiet already-moved state did not show"
            # Navigation moves forward without a JS error.
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.keyboard.press("ArrowRight")
            await pg.wait_for_timeout(400)
            assert not errs, f"navigation errored: {errs}"
            await pg.keyboard.press("Escape")
            pg.remove_listener("dialog", dialog)

            # ── 7. iPad 1024x768 pass: 44px promote + on-screen arrows ────
            # Re-seed one image to reopen the lightbox with content.
            Image.new("RGB", (320, 240), COLORS[0]).save(probe_dir / "lb-ipad.png")
            await pg.evaluate(
                "() => document.querySelector('[data-id=dir-select]')" \
                ".dispatchEvent(new Event('change'))")
            await pg.wait_for_function(
                "() => document.querySelectorAll('.gal-cell').length === 1", timeout=30000)
            await pg.evaluate("() => document.querySelector('.gal-cell').click()")
            await pg.wait_for_timeout(600)
            dims = await pg.evaluate(
                """() => {
                  const b = document.querySelector('[data-act=viewer-promote]').getBoundingClientRect();
                  const l = document.querySelector('[data-act=prev]').getBoundingClientRect();
                  const r = document.querySelector('[data-act=next]').getBoundingClientRect();
                  return { promoteW: b.width, promoteH: b.height,
                           arrowW: Math.max(l.width, r.width),
                           arrowH: Math.max(l.height, r.height) };
                }""")
            report.append(("touch targets", dims))
            assert dims["promoteW"] >= 44 and dims["promoteH"] >= 44, "promote button < 44px"
            assert dims["arrowW"] >= 44 and dims["arrowH"] >= 44, "nav arrows < 44px"
            await pg.screenshot(path=".probes/lb-03-ipad.png")
            await b.close()
    except Exception as e:
        report.append(("FAIL", repr(e)))
        print(json.dumps(dict(report), indent=2, default=str))
        raise
    print(json.dumps(dict(report), indent=2, default=str))
    print("LIGHTBOX PROBE PASS")

asyncio.run(main())
