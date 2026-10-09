# Library tier browser probe (2026-10-09a).
# Two parts:
#  1. SCRATCH instance on 127.0.0.1:8810 with TEMP gallery/dupe/library roots
#     — full destructive promote e2e (promote → file gone from output root,
#     present in library, tag chip filter, iPad 1024x768 checks). No real
#     operator file is ever touched.
#  2. LIVE 8800 smoke: markers, Library tab present, count line renders.
# Run: .venv/bin/python tests/library-probe.py
import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

REPO = Path(__file__).resolve().parents[1]
SCRATCH = "http://127.0.0.1:8810"
LIVE = "http://127.0.0.1:8800"

fails = []


def check(label, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + label + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(label)


def make_img(p: Path, color):
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 240), color).save(p)


async def click_button(pg, match):
    return await pg.evaluate(
        """(m) => {
          const b = [...document.querySelectorAll('button')]
            .find(b => m === '⬆' ? b.textContent.trim() === '⬆' : b.textContent.trim().includes(m));
          if (b) { b.click(); return true; } return false;
        }""", match)


async def scratch_e2e(pw, tmp: Path):
    groot, droot, lroot = tmp / "gallery", tmp / "dupes", tmp / "library"
    make_img(groot / "probe-a.png", (180, 40, 40))  # root files — visible in root listing
    make_img(groot / "probe-b.png", (40, 140, 200))
    make_img(groot / "probe-c.png", (60, 170, 90))
    env = dict(os.environ,
               ELLIEEDIT_GALLERY_ROOT=str(groot),
               ELLIEEDIT_DUPE_ROOT=str(droot),
               ELLIEEDIT_LIBRARY_ROOT=str(lroot),
               ELLIEEDIT_THUMB_CACHE_DIR=str(tmp / ".thumbs"))
    srv = subprocess.Popen(
        [str(REPO / ".venv/bin/python"), "-m", "uvicorn", "backend.main:app",
         "--host", "127.0.0.1", "--port", "8810"],
        cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                import urllib.request
                urllib.request.urlopen(SCRATCH + "/health", timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        b = await pw.chromium.launch()
        pg = await b.new_page(viewport={"width": 1024, "height": 768})  # iPad
        await pg.goto(SCRATCH + "/", wait_until="networkidle")
        await pg.wait_for_timeout(1200)
        # Gallery tab is default; promote probe-a with the DERIVED tag (accept prompt default)
        await pg.wait_for_selector(".gal-cell", timeout=8000)
        promote_hit = 0

        async def handler(dialog):
            nonlocal promote_hit
            promote_hit += 1
            check("derive default tag", dialog.default_value == "misc",
                  dialog.default_value)
            await dialog.accept("")  # accept default
        pg.on("dialog", handler)
        cell = pg.locator(".gal-cell", has_text="probe-a")
        btn = cell.locator("button.gal-promote")
        check("promote button present", await btn.count() == 1)
        box = await btn.bounding_box()
        check("promote 44px iPad-reachable",
              box and box["width"] >= 44 and box["height"] >= 44,
              f"{box}")
        await btn.click()
        await pg.wait_for_timeout(1500)
        check("prompt showed + accepted", promote_hit == 1)
        check("file GONE from output root (move, not copy)",
              not (groot / "probe-a.png").exists())
        lib_file = lroot / "misc" / "probe-a.png"
        check("file present in library", lib_file.is_file())
        check("no copy left in gallery tree",
              not list(groot.rglob("probe-a.png")))
        check("ghost card removed", not await pg.locator(
            ".gal-cell", has_text="probe-a").count())
        # Library tab: grid + tag chips + filter + count line
        await click_button(pg, "Library")
        await pg.wait_for_selector(".lib-cell", timeout=8000)
        count = await pg.locator("#lib-status").text_content()
        check("count line", count.strip() == "showing 1 of 1", count)
        chips = await pg.locator(".lib-tag").all_text_contents()
        check("tag chips", "misc" in " ".join(chips), str(chips))
        # Promote probe-b with explicit tag override "toon" → two tags now
        await click_button(pg, "Gallery")
        await pg.wait_for_selector(".gal-cell", timeout=8000)

        # Explicit tag override for probe-b (root file → derived would be misc).
        # Detach the first handler or it double-accepts the prompt.
        async def handler2(dialog):
            await dialog.accept("flatdeep")
        pg.remove_listener("dialog", handler)
        pg.on("dialog", handler2)
        pg.on("dialog", handler2)
        await pg.locator(".gal-cell", has_text="probe-b").locator(
            "button.gal-promote").click()
        await pg.wait_for_timeout(1200)
        await click_button(pg, "Library")
        await pg.wait_for_timeout(800)
        count = await pg.locator("#lib-status").text_content()
        check("library now 2", "showing 2 of 2" in count, count)
        # Click the flatdeep chip → filtered
        await pg.locator(".lib-tag", has_text="flatdeep").click()
        await pg.wait_for_timeout(600)
        count = await pg.locator("#lib-status").text_content()
        check("tag filter count line", count.strip() == "showing 1 of 1 — tag: flatdeep", count)
        names = await pg.locator(".lib-cell .name").all_text_contents()
        check("filter shows only flatdeep member", names == ["probe-b.png"], str(names))
        check("explicit tag override honored", (lroot / "flatdeep" / "probe-b.png").is_file())
        # iPad layout: tab bar reachable, library cell visible
        tab = await pg.locator("#tabbar button", has_text="Library").bounding_box()
        check("Library tab within 1024px viewport", tab and tab["x"] + tab["width"] <= 1024)
        await b.close()
    finally:
        srv.terminate()
        srv.wait(timeout=10)


async def live_smoke(pw):
    b = await pw.chromium.launch()
    pg = await b.new_page(viewport={"width": 1024, "height": 768})
    await pg.goto(LIVE + "/", wait_until="networkidle")
    await pg.wait_for_timeout(1200)
    build = await pg.evaluate(
        "() => [...document.querySelectorAll('#tabbar span')].map(s => s.textContent).find(t => t.startsWith('build'))")
    check("live 8800 build marker", "2026-10-09a" in (build or ""), str(build))
    tabs = await pg.locator("#tabbar button").all_text_contents()
    check("Library tab present on live", any("Library" in t for t in tabs), str(tabs))
    await pg.locator("#tabbar button", has_text="Library").click()
    await pg.wait_for_timeout(1200)
    count = await pg.locator("#lib-status").text_content()
    check("live library count line renders", (count or "").startswith("showing"), count)
    await b.close()


async def main():
    async with async_playwright() as p:
        await scratch_e2e(p, Path("/tmp/ellieedit-lib-probe"))
        await live_smoke(p)
    print(f"\n{'ALL GREEN' if not fails else f'{len(fails)} FAILURES: {fails}'}")
    sys.exit(1 if fails else 0)


asyncio.run(main())
