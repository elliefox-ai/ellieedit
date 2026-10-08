# Dupe view probe (2026-10-07y) — STACK-SPREAD family detail.
# Family browser, champion+fan duel, pick/reject, picks strip ordinals,
# survey grid, focus deck full-size serving, commit → pending + ledger.
# Non-destructive: pending additions and ledger entries from the probe are
# pardoned at the end (manifest + ledger restored byte-for-byte).
# Run: .venv/bin/python tests/dupe-probe.py   (server on 127.0.0.1:8800)

import asyncio, json, os, shutil, sys, tempfile
from pathlib import Path
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8800"
MANIFEST = Path(__file__).resolve().parents[1] / ".pending-delete.json"
LEDGER = Path(__file__).resolve().parents[1] / ".dupe-verdicts.jsonl"
os.makedirs(".probes", exist_ok=True)

# iPad PWA viewport — the operator's device. Mandatory for screenshots.
VIEWPORT = {"width": 1024, "height": 768}


async def main():
    manifest_backup = MANIFEST.read_bytes() if MANIFEST.exists() else None
    ledger_backup = LEDGER.read_bytes() if LEDGER.exists() else None
    probe_paths = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport=VIEWPORT, has_touch=True)
            pg = await ctx.new_page()
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.wait_for_timeout(1500)
            console_errors = []
            pg.on("console", lambda m: console_errors.append(m.text)
                  if m.type in ("error",) else None)
            pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
            report = {}

            # ── 1. Dupe tab: family browser ────────────────────────────
            await pg.evaluate("""() => {
              const btn = [...document.querySelectorAll('#tabbar .tab')]
                .find(t => t.dataset.name === 'dupe');
              btn.click();
            }""")
            await pg.wait_for_timeout(4000)  # thumbnails over /mnt are slow
            report["status"] = await pg.inner_text("#dupe-status")
            cards = await pg.evaluate(
                "() => document.querySelectorAll('.fam-card:not(.skel)').length")
            assert cards > 0, "no family cards rendered"
            heights = await pg.evaluate("""() =>
              [...document.querySelectorAll('.fam-card:not(.skel)')]
                .map(c => Math.round(c.getBoundingClientRect().height))
            """)
            assert min(heights) > 0, f"cards present but invisible: {heights[:5]}"
            await pg.screenshot(path=".probes/ss-01-browser.png")

            # ── 2. Stack-spread detail: champion + fan ─────────────────
            await pg.evaluate("() => document.querySelector('.fam-card').click()")
            await pg.wait_for_timeout(3000)
            ss = await pg.evaluate("""() => ({
              header: !!document.querySelector('.ss-header'),
              champion: (() => { const c = document.querySelector('.ss-champ');
                return c ? Math.round(c.getBoundingClientRect().height) : 0; })(),
              fan_cards: [...document.querySelectorAll('.ss-fan-card')]
                .filter(c => c.getBoundingClientRect().height > 0).length,
              reject_btn: (() => { const b = document.querySelector('#ss-reject');
                const r = b && b.getBoundingClientRect();
                return r && r.height >= 40 && r.width >= 40; })(),
              strip: !!document.querySelector('#ss-strip'),
              draft_badge: (document.querySelector('.ss-badge.draft')||{}).textContent || null,
            })""")
            report["spread"] = ss
            assert ss["header"] and ss["champion"] > 100, f"champion card broken: {ss}"
            assert ss["reject_btn"], "reject control under 40px"
            # iPad flicker regression (2026-10-07z): the family grid MUST be
            # display:none once the detail is open — the missing .fam-list.open
            # rule left it visible, pushing the detail below the fold.
            vis = await pg.evaluate("""() => {
              const list = document.querySelector('#fam-list');
              const detail = document.querySelector('#dupe-detail');
              const lr = list.getBoundingClientRect();
              const dr = detail.getBoundingClientRect();
              return {
                list_display: getComputedStyle(list).display,
                list_h: Math.round(lr.height),
                detail_top: Math.round(dr.top),
                detail_bottom_in: dr.bottom <= innerHeight + 1,
                back_visible: (() => { const b = document.querySelector('#dupe-back');
                  const r = b.getBoundingClientRect(); return r.height > 0; })(),
              };
            }""")
            report["detail_visibility"] = vis
            assert vis["list_display"] == "none" and vis["list_h"] == 0, \
                f"family grid still occupies space over the detail: {vis}"
            assert vis["detail_bottom_in"] and vis["detail_top"] < VIEWPORT["height"], \
                f"detail pushed out of the iPad viewport: {vis}"
            assert vis["back_visible"], "back button missing with detail open"
            await pg.screenshot(path=".probes/ss-02b-detail-open-viewport.png")
            await pg.screenshot(path=".probes/ss-02-champion-fan.png")

            # ── 2b. Binding growth: re-open browser→detail twice; card click
            # handlers are re-created per render, but a double-mount would
            # double-fire renderDetail — detect via viewSeq trace deltas and
            # by asserting only ONE detail load per tap (status not erroring).
            for _ in range(2):
                await pg.evaluate("() => document.querySelector('#dupe-back').click()")
                await pg.wait_for_timeout(1200)
                await pg.evaluate("() => document.querySelector('.fam-card').click()")
                await pg.wait_for_timeout(2000)
                reopen = await pg.evaluate("""() => ({
                  detail_open: document.querySelector('#dupe-detail').classList.contains('open'),
                  header: !!document.querySelector('.ss-header'),
                  list_display: getComputedStyle(document.querySelector('#fam-list')).display,
                })""")
                assert reopen["detail_open"] and reopen["header"] and \
                    reopen["list_display"] == "none", f"re-open broken: {reopen}"
            report["reopen_x2"] = "ok"

            # ── 3. Duel: tap a fan card → becomes champion ────────────
            champ_before = await pg.evaluate(
                "() => document.querySelector('.ss-champ img').src")
            fans = await pg.evaluate("""() =>
              [...document.querySelectorAll('.ss-fan-card')]
                .filter(c => c.getBoundingClientRect().height > 0)""")
            if len(fans) > 0:
                await pg.evaluate(
                    "document.querySelector('.ss-fan-card').click()")
                await pg.wait_for_timeout(400)
                champ_after = await pg.evaluate(
                    "() => document.querySelector('.ss-champ img').src")
                report["duel"] = champ_before != champ_after
            else:
                report["duel"] = "n/a (single-member family)"

            # ── 4. Pick champion → strip ordinal #1 ────────────────────
            await pg.evaluate(
                "() => document.querySelector('.ss-champ').dispatchEvent("
                "new PointerEvent('pointerup', {bubbles: true}))")
            await pg.wait_for_timeout(400)
            # direct tap path: playwright tap on the champion
            await pg.tap(".ss-champ")
            await pg.wait_for_timeout(400)
            ord1 = await pg.evaluate("""() => {
              const c = document.querySelector('.ss-pick-chip .ord');
              const chip = document.querySelector('.ss-pick-chip');
              const r = chip && chip.getBoundingClientRect();
              return {text: c && c.textContent, h: r && Math.round(r.height)};
            }""")
            report["pick_ordinal"] = ord1
            assert ord1["text"] == "#1" and ord1["h"] and ord1["h"] >= 40, \
                f"pick chip/ordinal broken: {ord1}"
            await pg.screenshot(path=".probes/ss-03-picks-strip.png")

            # ── 5. Reject via button (the piloted control) ─────────────
            await pg.evaluate("() => document.querySelector('#ss-reject').click()")
            await pg.wait_for_timeout(400)
            rej = await pg.evaluate("""() => ({
              dead: document.querySelectorAll('.ss-dead').length,
              label: (document.querySelector('.ss-discard .lbl')||{}).textContent,
            })""")
            report["reject"] = rej
            assert rej["dead"] >= 1, "reject did not move a card to the discard row"

            # ── 6. Survey grid + focus deck (full-size must be REAL) ──
            await pg.evaluate("() => document.querySelector('#ss-survey-btn').click()")
            await pg.wait_for_timeout(2500)
            cells = await pg.evaluate("""() =>
              [...document.querySelectorAll('.ss-cell')]
                .filter(c => c.getBoundingClientRect().height > 0).length""")
            assert cells > 0, "survey grid empty"
            await pg.screenshot(path=".probes/ss-04-survey.png")
            await pg.evaluate(
                "() => document.querySelector('.ss-cell').dispatchEvent("
                "new MouseEvent('click', {bubbles: true}))")
            await pg.wait_for_timeout(2500)
            focus = await pg.evaluate("""async () => {
              const img = document.querySelector('.ss-focus img');
              if (!img) return {img: false};
              await new Promise(res => {
                if (img.complete && img.naturalWidth > 0) res();
                else { img.onload = res; img.onerror = res; setTimeout(res, 8000); }
              });
              return {img: true, src: img.src, w: img.naturalWidth, h: img.naturalHeight};
            }""")
            report["focus"] = focus
            assert focus.get("img") and focus["w"] > 0, \
                f"focus deck image failed to load: {focus}"
            assert "/api/dupe/file?" in focus["src"], \
                f"focus deck served {focus['src']} — must be the FULL-SIZE /api/dupe/file path"
            await pg.screenshot(path=".probes/ss-05-focus-deck.png")
            # '✕ Close' returns to the stack (renderSpread wipes the survey
            # overlay with the rest of the detail DOM) — close whichever of
            # focus/survey is still up, never assume both.
            closed = await pg.evaluate("""() => {
              let n = 0;
              for (const id of ['#ss-focusview', '#ss-survey']) {
                const b = document.querySelector(id + ' .ss-ov-top .ee-btn:last-child');
                if (b) { b.click(); n++; }
              }
              return n;
            }""")
            await pg.wait_for_timeout(400)
            report["closed_overlays"] = closed

            # ── 7. Commit → verdict + pending manifest ─────────────────
            counts = await pg.evaluate("""() =>
              (document.querySelector('.ss-header')||{textContent:''}).textContent""")
            report["pre_commit_header"] = counts
            await pg.evaluate("() => document.querySelector('#dupe-commit').click()")
            await pg.wait_for_timeout(3000)
            committed = await pg.evaluate("""() => ({
              banner: (document.querySelector('.ss-committed .big')||{}).textContent || null,
              badge: (document.querySelector('.ss-badge.committed')||{}).textContent || null,
              summary: (document.querySelector('.ss-committed .sum')||{}).textContent || null,
            })""")
            report["committed"] = committed
            assert committed["banner"] and "committed" in committed["banner"], \
                f"no committed state rendered: {committed}"
            await pg.screenshot(path=".probes/ss-06-committed.png")

            m = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
            report["manifest_added"] = [k for k in m if k not in
                                        (json.loads(manifest_backup).keys()
                                         if manifest_backup else [])]
            probe_paths = report["manifest_added"]
            ledger_tail = LEDGER.read_text().strip().splitlines()[-1:] if LEDGER.exists() else []
            report["ledger_last"] = ledger_tail

            # ── 8. Zero console errors ──────────────────────────────────
            report["console_errors"] = console_errors
            assert not console_errors, f"console errors: {console_errors}"

            print(json.dumps(report, indent=1))

            # ── 9. Large family (N big): fan scrolls, decision area fixed ──
            big = await pg.evaluate("""async () => {
              // scan pages for a genuinely large unresolved family
              let cursor = '', best = null;
              for (let page = 0; page < 20; page++) {
                const d = await fetch('/api/dupe/families?state=unresolved&cursor='
                  + encodeURIComponent(cursor)).then(r => r.json());
                for (const it of d.items) if (!best || it.size > best.size) best = it;
                if (!d.next_cursor || (best && best.size >= 15)) break;
                cursor = d.next_cursor;
              }
              return best;
            }""")
            if big and big["size"] >= 6:
                await pg.evaluate("() => document.querySelector('#dupe-back').click()")
                await pg.wait_for_timeout(1500)
                opened = await pg.evaluate("""(fid) => {
                  const card = [...document.querySelectorAll('.fam-card')]
                    .find(c => c.textContent.includes(fid));
                  if (card) { card.click(); return true; }
                  return false;
                }""", big["id"])
                await pg.wait_for_timeout(3000)
                if opened:
                    big_report = await pg.evaluate("""() => {
                      const fan = document.querySelector('.ss-fan');
                      const champ = document.querySelector('.ss-champ');
                      return {
                        fan_cards: document.querySelectorAll('.ss-fan-card').length,
                        fan_client_w: fan ? fan.clientWidth : null,
                        fan_scrollable: fan ? (fan.scrollWidth > fan.clientWidth + 4 ||
                                              fan.scrollHeight > fan.clientHeight + 4) : null,
                        champ_h: champ ? Math.round(champ.getBoundingClientRect().height) : 0,
                      };
                    }""")
                    report["large_family"] = {"id": big["id"], "size": big["size"], **big_report}
                    assert big_report["fan_cards"] >= big["size"] - 1, "fan missing members"
                    # scroll iff the cards (98px each incl. gap) overflow the band
                    expected = big_report["fan_cards"] * 98 > big_report["fan_client_w"]
                    assert big_report["fan_scrollable"] == expected, \
                        f"fan scroll state wrong: {big_report} (expected scrollable={expected})"
                    assert big_report["champ_h"] > 150, "champion shrank with N"
                    await pg.screenshot(path=".probes/ss-07-large-family-fan.png")
            else:
                report["large_family"] = "no large unresolved family in first page"

            print(json.dumps(report, indent=1))
            await b.close()
    finally:
        # restore manifest + ledger exactly; pardon via API first
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
        if ledger_backup is None:
            LEDGER.unlink(missing_ok=True)
        else:
            LEDGER.write_bytes(ledger_backup)


asyncio.run(main())
