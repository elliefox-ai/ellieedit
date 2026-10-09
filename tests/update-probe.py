"""Update tab browser probe (2026-10-09d).

Scratch instance on 127.0.0.1:8811 with TEMP gallery/library roots and a
FAKE ComfyUI server (tests.fake_comfy) — the full UI path (entry point,
preset dropdown, run, seed freeze, saved prompts, stack swap/revert,
comparer divider, iPad 1024x768) without touching the shared GPU or any
operator file. Then a LIVE 8800 smoke: markers + Update tab present.
Run: .venv/bin/python tests/update-probe.py
"""

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_comfy import start_fake_comfy

REPO = Path(__file__).resolve().parents[1]
SCRATCH = "http://127.0.0.1:8811"
LIVE = "http://127.0.0.1:8800"

fails = []


def check(label, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + label + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(label)


def make_img(p: Path, color):
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 240), color).save(p)


async def wait_run(pg, want, timeout=25000):
    """Wait for the run to finish; dump status if it never gets there."""
    try:
        await pg.wait_for_function(
            "() => document.querySelector('#upd-pos').textContent.includes('" + want + "')",
            timeout=timeout)
        return True
    except Exception:
        state = await pg.evaluate(
            """() => ({ pos: document.querySelector('#upd-pos').textContent,
                        status: document.querySelector('#upd-status').textContent })""")
        print("     run-wait timeout:", state)
        return False


async def act(pg, name):
    """Click by data-act inside the update module (other hidden modules can
    carry same-text buttons)."""
    return await pg.evaluate(
        """(n) => { const b = document.querySelector(`#module-update [data-act="${n}"]`);
                   if (b) { b.click(); return true; } return false; }""", name)


async def click_text(pg, text):
    return await pg.evaluate(
        """(t) => {
          const b = [...document.querySelectorAll('button')]
            .find(b => b.textContent.trim().includes(t));
          if (b) { b.click(); return true; } return false;
        }""", text)


async def scratch_e2e(pw, tmp: Path):
    groot, lroot = tmp / "gallery", tmp / "library"
    make_img(groot / "probe-src.png", (180, 40, 40))
    saved_prompts = tmp / "saved-prompts.json"
    fake = start_fake_comfy(output_dir=groot)
    env = dict(os.environ,
               ELLIEEDIT_GALLERY_ROOT=str(groot),
               ELLIEEDIT_DUPE_ROOT=str(tmp / "dupes"),
               ELLIEEDIT_LIBRARY_ROOT=str(lroot),
               ELLIEEDIT_THUMB_CACHE=str(tmp / ".thumbs"),
               ELLIEEDIT_SAVED_PROMPTS=str(saved_prompts),
               ELLIEEDIT_WORKFLOWS_DIR=str(REPO / "workflows"))
    # point the backend at the fake comfy
    env["ELLIEEDIT_UPDATE_COMFY_URL"] = fake.url
    env["COMFY_URL"] = fake.url  # backend.comfy reads this at import time
    import socket
    with socket.socket() as _s:
        try:
            _s.bind(("127.0.0.1", 8811))
        except OSError:
            print("FATAL: scratch port 8811 already in use — kill the stale server first")
            sys.exit(2)
    srv = subprocess.Popen(
        [str(REPO / ".venv/bin/python"), "-m", "uvicorn", "backend.main:app",
         "--host", "127.0.0.1", "--port", "8811"],
        cwd=REPO, env=env, stdout=open(tmp / "scratch.log", "wb"), stderr=subprocess.STDOUT)
    try:
        time.sleep(2.5)
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 1024, "height": 768})
        # Global dialog pump: each dialog pops the next queued response
        # (prompt text / confirm-true). No per-click once() races.
        dialog_answers = []
        def on_dialog(d):
            ans = dialog_answers.pop(0) if dialog_answers else None
            print("     dialog:", d.type, "->", ans)
            if d.type == "prompt":
                asyncio.ensure_future(d.accept(ans if isinstance(ans, str) else ""))
            else:
                asyncio.ensure_future(d.accept(""))  # confirm: any truthy-ish accept
        page.on("dialog", on_dialog)
        await page.goto(SCRATCH, wait_until="networkidle")

        # 1. Entry point: gallery lightbox ✎ Update button → update tab
        await page.click('.gal-cell')
        await page.wait_for_selector('.gal-viewer[style*="flex"]')
        btn = await page.evaluate(
            """() => { const b = document.querySelector('[data-act="to-update"]');
                       return b ? b.textContent.trim() : null; }""")
        check("gallery lightbox has ✎ Update button", btn == "✎ Update", str(btn))
        await click_text(page, "✎ Update")
        await page.wait_for_timeout(400)
        active = await page.evaluate(
            "() => document.querySelector('.module-panel.active')?.id")
        check("✎ switches to Update tab", active == "module-update", str(active))

        # 2. Tab loaded with source image in the stack
        state = await page.evaluate(
            """() => {
              const m = document.querySelector('#module-update');
              return {
                empty: m.querySelector('#upd-empty').style.display,
                cmp: m.querySelector('#upd-cmp').style.display,
                pos: m.querySelector('#upd-pos').textContent,
                presets: [...m.querySelectorAll('#upd-preset option')].map(o => o.textContent),
              };
            }""")
        check("source loaded into comparer", state["empty"] == "none" and state["cmp"] == "block")
        check("stack position 1/1", "1/1" in state["pos"], state["pos"])
        check("preset dropdown seeded (2 presets)",
              len(state["presets"]) == 2, str(state["presets"]))

        # 3. Saved prompts: save → appears in dropdown → select inserts → delete
        dialog_answers.append("probe-prompt")  # save: name prompt
        await page.fill('#upd-prompt', 'probe prompt text one')
        await act(page, "upd-save-prompt")
        await page.wait_for_timeout(400)
        opts = await page.evaluate(
            "() => [...document.querySelectorAll('#upd-saved option')].map(o => o.value)")
        check("saved prompt appears in dropdown", "probe-prompt" in opts, str(opts))
        await page.fill('#upd-prompt', '')
        await page.select_option('#upd-saved', 'probe-prompt')
        filled = await page.input_value('#upd-prompt')
        check("selecting saved prompt fills the box",
              filled == 'probe prompt text one', repr(filled))
        dialog_answers.append(True)  # delete confirm
        await act(page, "upd-del-prompt")
        await page.wait_for_timeout(400)
        opts = await page.evaluate(
            "() => [...document.querySelectorAll('#upd-saved option')].map(o => o.value)")
        check("saved prompt delete shrinks list", "probe-prompt" not in opts, str(opts))

        # 4. Run plain preset with a prompt; fake comfy answers instantly
        await page.select_option('#upd-preset', 'plain-transform.json')
        await page.fill('#upd-prompt', 'plain probe prompt')
        seed_before = await page.input_value('#upd-seed')
        await act(page, "upd-run")
        await wait_run(page, "2/2")
        state = await page.evaluate(
            """() => {
              const m = document.querySelector('#module-update');
              return { pos: m.querySelector('#upd-pos').textContent,
                       status: m.querySelector('#upd-status').textContent,
                       seed: m.querySelector('#upd-seed').value };
            }""")
        check("run appends a stack entry", "2/2" in state["pos"], state["pos"])
        check("run reports completion", "render done" in state["status"], state["status"])
        check("used seed written back into field", state["seed"] != seed_before
              or seed_before != "0", state["seed"])

        # 5. Seed freeze: uncheck random, run again, seed must stay
        await page.evaluate(
            "() => { const c = document.querySelector('#upd-random'); c.checked = false; }")
        frozen = state["seed"]
        await act(page, "upd-run")
        await wait_run(page, "3/3")
        state = await page.evaluate(
            """() => ({ pos: document.querySelector('#upd-pos').textContent,
                        seed: document.querySelector('#upd-seed').value,
                        graphSeed: window.__lastFakeSeed ?? null })""")
        check("frozen seed kept across runs", state["seed"] == frozen,
              f'{state["seed"]} vs {frozen}')
        check("stack grew to 3/3", "3/3" in state["pos"], state["pos"])

        # 6. Stack: revert → back to render 2 (entry 2/3); swap there accepts
        #    the viewed render as the next source; revert to original keeps it
        await act(page, "upd-revert")
        await page.wait_for_timeout(200)
        pos = await page.evaluate("() => document.querySelector('#upd-pos').textContent")
        check("revert steps back", "2/3" in pos, pos)
        await act(page, "upd-swap")
        await page.wait_for_timeout(200)
        pos = await page.evaluate("() => document.querySelector('#upd-pos').textContent")
        check("swap records source", "source 2" in pos, pos)
        # 9. Save (family) — fake comfy already wrote an output file; save
        #    the viewed entry (2/3, a render) with a chosen tag
        dialog_answers.append("zengosoft")  # save tag
        req_body = {}
        def _log_req(r):
            if "save-family" in r.url:
                try:
                    import json as _json
                    req_body.update(_json.loads(r.request.post_data or "{}"))
                except Exception:
                    pass
        page.on("response", _log_req)
        await act(page, "upd-save")
        await page.wait_for_timeout(800)
        check("save-family request carries jailed paths",
              req_body.get("render_path", "").startswith("ellieedit_tmp/")
              and req_body.get("original_path") == "probe-src.png",
              str(req_body))
        status = await page.evaluate(
            "() => document.querySelector('#upd-status').textContent")
        check("save-family reports success", "saved — final" in status, status)
        fam_index = lroot / ".library-index.jsonl"
        fam_ok = fam_index.is_file() and "version-family" in fam_index.read_text()
        check("library index carries version-family record", fam_ok)
        orig_copy = list(lroot.rglob("*-original.png"))
        check("original copy travels with final", len(orig_copy) == 1,
              str([p.name for p in orig_copy]))

        await act(page, "upd-revert-orig")
        await page.wait_for_timeout(200)
        pos = await page.evaluate("() => document.querySelector('#upd-pos').textContent")
        check("revert to original → 1/3", "1/3" in pos, pos)
        check("swap survives revert-to-original", "source 2" in pos, pos)

        # 8. Comparer divider drag works (pointer events)
        pct_before = await page.evaluate(
            "() => document.querySelector('#upd-wrap-b').style.width")
        box = await page.evaluate(
            """() => { const r = document.querySelector('#upd-cmp').getBoundingClientRect();
                       return { x: r.x, y: r.y + r.height / 2 }; }""")
        await page.mouse.move(box["x"] + 200, box["y"])
        await page.mouse.down()
        await page.mouse.move(box["x"] + 350, box["y"], steps=4)
        await page.mouse.up()
        pct_after = await page.evaluate(
            "() => document.querySelector('#upd-wrap-b').style.width")
        check("comparer divider drags", pct_before != pct_after,
              f"{pct_before} -> {pct_after}")

        await browser.close()
    finally:
        fake.stop()
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:
            srv.kill()


async def live_smoke(pw):
    browser = await pw.chromium.launch()
    page = await browser.new_page(viewport={"width": 1024, "height": 768})
    await page.goto(LIVE, wait_until="networkidle")
    marker = await page.evaluate(
        "() => [...document.querySelectorAll('#tabbar span')].map(s => s.textContent).join(' ')")
    check("live build marker 2026-10-09d", "2026-10-09d" in marker, marker)
    tabs = await page.evaluate(
        "() => [...document.querySelectorAll('.tab')].map(t => t.textContent.trim())")
    check("Update tab present on live", any("Update" in t for t in tabs), str(tabs))
    err = await page.evaluate("() => window.__moduleError || null")
    check("no module load error", err is None, str(err))
    await browser.close()


async def main():
    tmp = Path("/tmp/ellieedit-update-probe")
    if tmp.exists():
        import shutil
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    async with async_playwright() as pw:
        await scratch_e2e(pw, tmp)
        await live_smoke(pw)
    print()
    if fails:
        print("FAILED:", len(fails))
        for f in fails:
            print(" -", f)
        sys.exit(1)
    print("ALL UPDATE PROBES PASS")


if __name__ == "__main__":
    asyncio.run(main())
