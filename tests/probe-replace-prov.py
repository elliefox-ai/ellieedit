# Regression probe (2026-10-15): a Gallery handoff with provenance must enable Replace
# sources (green bar, enabled button). Caught the operator's 'disabled hint' report; run
# after any handoff refactor:  .venv/bin/python tests/probe-replace-prov.py
# Reproduces operator report: 5-image handoff showed the disabled hint instead of the green bar.
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8800"

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(BASE, wait_until="networkidle")
        # activate facecycle like the tab flow does
        await page.evaluate("window.dispatchEvent(new CustomEvent('ellieedit:activate', { detail: { name: 'facecycle' } }))")
        await page.wait_for_timeout(800)
        # real gallery paths (3 files from gallery root listing)
        listing = await page.evaluate("fetch('/api/gallery/list').then(r => r.json())")
        items = [it for it in listing.get("items", []) if it.get("path", "").lower().endswith((".png", ".jpg"))][:3]
        print("gallery items found:", len(items))
        if len(items) < 1:
            print("NO GALLERY FILES — probe cannot proceed"); await browser.close(); return
        from urllib.parse import quote
        payload = {
            "urls": [f"/api/gallery/file?path={quote(it['path'])}" for it in items],
            "names": [it.get("name") or it["path"].split("/")[-1] for it in items],
            "provenance": {"kind": "gallery", "paths": [it["path"] for it in items]},
        }
        res = await page.evaluate("""async (payload) => {
            window.dispatchEvent(new CustomEvent('ellieedit:facecycle-handoff', { detail: payload }));
            await new Promise(r => setTimeout(r, 2500));
            const bar = document.querySelector('[data-id="replace-bar"]');
            const msg = document.querySelector('[data-id="replace-msg"]');
            const btn = document.querySelector('[data-act="replace-sources"]');
            const thumbs = document.querySelectorAll('.thumb').length;
            return {
                barVisible: bar ? getComputedStyle(bar).display !== 'none' : null,
                barClass: bar ? bar.className : null,
                msg: msg ? msg.textContent : null,
                btnDisabled: btn ? btn.disabled : null,
                thumbs,
            };
        }""", payload)
        print("result:", json.dumps(res, indent=2))
        print("page errors:", errors[:5])
        await browser.close()

asyncio.run(main())
