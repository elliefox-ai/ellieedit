# Meld probe (2026-10-08g) — Dupe family multi-select → FaceCycle → Save back / Cancel.
# Run: .venv/bin/python tests/meld-probe.py   (server on 127.0.0.1:8800)
#
# NON-DESTRUCTIVE: pending manifest + verdict ledger are backed up and
# restored byte-for-byte; the probe's meld result PNG is deleted afterward.
# Covers: family multi-select → "Meld these" → FaceCycle batch receipt +
# meld bar → Save back (family shows result, components on the deletion
# manifest, ledger ACCEPTED entry) → Cancel variant writes nothing.
# Zero console errors; iPad 1024×768 screenshots each state.

import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8800"
MANIFEST = Path(__file__).resolve().parents[1] / ".pending-delete.json"
LEDGER = Path(__file__).resolve().parents[1] / ".dupe-verdicts.jsonl"
os.makedirs(".probes", exist_ok=True)
VIEWPORT = {"width": 1024, "height": 768}


async def main():
    manifest_backup = MANIFEST.read_bytes() if MANIFEST.exists() else None
    ledger_backup = LEDGER.read_bytes() if LEDGER.exists() else None
    meld_files_before = set()
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport=VIEWPORT, has_touch=True)
            pg = await ctx.new_page()
            console_errors = []
            pg.on("console", lambda m: console_errors.append(m.text)
                  if m.type == "error" else None)
            pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.wait_for_timeout(1500)
            report = {}

            # ── 1. Dupe tab → first family → Survey → meld select ──────
            await pg.evaluate("""() => [...document.querySelectorAll('#tabbar .tab')]
                .find(t => t.dataset.name === 'dupe').click()""")
            await pg.wait_for_timeout(4000)
            await pg.evaluate("() => document.querySelector('.fam-card').click()")
            await pg.wait_for_timeout(2500)
            fam_id = await pg.evaluate(
                "() => document.querySelector('.ss-header .fam-id')?.textContent")
            report["family"] = fam_id
            await pg.evaluate("() => document.querySelector('#ss-survey-btn')?.click()")
            await pg.wait_for_timeout(800)
            await pg.evaluate("() => document.querySelector('#ss-meld-mode')?.click()")
            await pg.wait_for_timeout(300)
            bar0 = await pg.evaluate("""() => ({
              bar: document.querySelector('#ss-meld-bar').style.display,
              goDisabled: document.querySelector('#ss-meld-go').disabled})""")
            report["meldBarInitial"] = bar0
            # select first two members
            await pg.evaluate("""() => [...document.querySelectorAll('#ss-survey .ss-cell')]
                .slice(0, 2).forEach(c => c.click())""")
            await pg.wait_for_timeout(300)
            sel = await pg.evaluate("""() => ({
              rings: document.querySelectorAll('#ss-survey .ss-cell.meldsel').length,
              go: document.querySelector('#ss-meld-go').textContent,
              goEnabled: !document.querySelector('#ss-meld-go').disabled,
              goH: Math.round(document.querySelector('#ss-meld-go').getBoundingClientRect().height)})""")
            report["meldSelect"] = sel
            assert sel["rings"] == 2 and sel["goEnabled"] and sel["goH"] >= 40, sel
            await pg.screenshot(path=".probes/meld-01-multiselect.png")

            # ── 2. Meld these → FaceCycle batch receipt + meld bar ─────
            await pg.evaluate("() => document.querySelector('#ss-meld-go').click()")
            await pg.wait_for_timeout(4000)
            fc = await pg.evaluate("""() => ({
              tab: document.querySelector('#tabbar .tab.active')?.dataset.name,
              receipt: document.querySelector('[data-id=status-bar]')?.textContent.slice(0, 120),
              meldBar: document.querySelector('[data-id=meld-bar]')?.style.display,
              meldMsg: document.querySelector('[data-id=meld-msg]')?.textContent.slice(0, 90),
              saveH: Math.round(document.querySelector('[data-act=meld-save]')?.getBoundingClientRect().height || 0)})""")
            report["facecycle"] = fc
            assert fc["tab"] == "facecycle" and "family" in (fc["meldMsg"] or ""), fc
            assert fc["meldBar"] == "flex" and fc["saveH"] >= 40, fc
            await pg.screenshot(path=".probes/meld-02-facecycle-batch.png")

            # ── 3. CANCEL variant first: writes nothing ────────────────
            m_before = MANIFEST.read_bytes() if MANIFEST.exists() else b""
            await pg.evaluate("() => document.querySelector('[data-act=meld-cancel]').click()")
            await pg.wait_for_timeout(1500)
            cancel = await pg.evaluate("""() => ({
              tab: document.querySelector('#tabbar .tab.active')?.dataset.name,
              meldBar: document.querySelector('[data-id=meld-bar]')?.style.display})""")
            m_after = MANIFEST.read_bytes() if MANIFEST.exists() else b""
            led_after = LEDGER.read_text() if LEDGER.exists() else ""
            report["cancel"] = {**cancel,
                                "manifestUnchanged": m_before == m_after,
                                "noMeldInLedger": "meld_result" not in led_after}
            assert cancel["tab"] == "dupe" and report["cancel"]["manifestUnchanged"]
            assert report["cancel"]["noMeldInLedger"]
            await pg.screenshot(path=".probes/meld-03-cancel.png")

            # ── 4. Redo handoff → Save back ─────────────────────────────
            await pg.wait_for_timeout(1500)
            await pg.evaluate("() => document.querySelector('.fam-card').click()")
            await pg.wait_for_timeout(2000)
            await pg.evaluate("() => document.querySelector('#ss-survey-btn')?.click()")
            await pg.wait_for_timeout(600)
            await pg.evaluate("() => document.querySelector('#ss-meld-mode')?.click()")
            await pg.evaluate("""() => [...document.querySelectorAll('#ss-survey .ss-cell')]
                .slice(0, 2).forEach(c => c.click())""")
            await pg.evaluate("() => document.querySelector('#ss-meld-go').click()")
            await pg.wait_for_timeout(4000)
            await pg.evaluate("() => document.querySelector('[data-act=meld-save]').click()")
            await pg.wait_for_timeout(4000)
            saved = await pg.evaluate("""() => ({
              tab: document.querySelector('#tabbar .tab.active')?.dataset.name,
              meldResult: !!document.querySelector('.ss-meld-result img'),
              resultLoaded: (() => { const i = document.querySelector('.ss-meld-result img');
                return i && i.complete && i.naturalWidth > 0; })(),
              tag: document.querySelector('.ss-meld-result .tag')?.textContent.slice(0, 100),
              header: document.querySelector('.ss-committed .big')?.textContent})""")
            report["saveBack"] = saved
            assert saved["tab"] == "dupe" and saved["meldResult"] and saved["resultLoaded"], saved
            await pg.screenshot(path=".probes/meld-04-saveback-family.png")

            # ── 5. Server truth: manifest + ledger + gallery-root file ──
            truth = await pg.evaluate(f"""async () => {{
              const pd = await fetch('/api/pending').then(r => r.json());
              const fam = await fetch('/api/dupe/families/{fam_id}').then(r => r.json());
              return {{ pendingCount: pd.count, pendingBytes: pd.bytes,
                       meld: fam.meld, state: fam.state }};
            }}""")
            report["serverTruth"] = truth
            assert truth["meld"] and truth["state"] == "resolved", truth
            meld_png = Path("/mnt/e/comfyui/output") / truth["meld"]["result"]
            assert meld_png.is_file() and meld_png.stat().st_size > 0
            meld_files_before.add(meld_png)
            await pg.screenshot(path=".probes/meld-05-manifest.png", full_page=False)

            report["consoleErrors"] = console_errors
            assert not console_errors, console_errors
            print(json.dumps(report, indent=1))
            print("MELD-PROBE: PASS")
            await b.close()
    finally:
        if manifest_backup is not None:
            MANIFEST.write_bytes(manifest_backup)
        elif MANIFEST.exists():
            MANIFEST.unlink()
        if ledger_backup is not None:
            LEDGER.write_bytes(ledger_backup)
        elif LEDGER.exists():
            LEDGER.unlink()
        for f in meld_files_before:
            f.unlink(missing_ok=True)


asyncio.run(main())
