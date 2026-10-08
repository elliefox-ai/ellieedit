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

            # ── 6. Survey grid + unified ZOOM (2026-10-08a) ──────────
            await pg.evaluate("() => document.querySelector('#ss-survey-btn').click()")
            await pg.wait_for_timeout(2500)
            cells = await pg.evaluate("""() =>
              [...document.querySelectorAll('.ss-cell')]
                .filter(c => c.getBoundingClientRect().height > 0).length""")
            assert cells > 0, "survey grid empty"
            survey = await pg.evaluate("""() => ({
              hint: (document.querySelector('#ss-survey .ss-ov-top span')||{}).textContent || '',
              overlay_icons: document.querySelectorAll('.ss-cell .tools, .ss-cell button').length,
              cells: document.querySelectorAll('.ss-cell').length,
            })""")
            report["survey"] = survey
            assert "tap an image to inspect" in survey["hint"], \
                f"survey header hint missing: {survey}"
            assert survey["overlay_icons"] == 0, \
                f"big overlay icon still in survey cells: {survey}"
            await pg.screenshot(path=".probes/ss-04-survey-clean.png")
            # tap a cell → unified zoom
            await pg.evaluate(
                "() => document.querySelector('.ss-cell').dispatchEvent("
                "new MouseEvent('click', {bubbles: true}))")
            await pg.wait_for_timeout(2500)
            zoom0 = await pg.evaluate("""async () => {
              const img = document.querySelector('#ss-zoom .ss-focus img');
              if (!img) return {img: false};
              await new Promise(res => {
                if (img.complete && img.naturalWidth > 0) res();
                else { img.onload = res; img.onerror = res; setTimeout(res, 8000); }
              });
              const r = id => { const b = document.querySelector(id);
                const rc = b && b.getBoundingClientRect();
                return rc && rc.height >= 40 && rc.width >= 40; };
              return {img: true, src: img.src, w: img.naturalWidth, h: img.naturalHeight,
                      pos: (document.querySelector('#ss-zoom-pos')||{}).textContent || null,
                      back: r('#ss-zoom-back'), pick: r('#ss-zoom-pick'),
                      rej: r('#ss-zoom-reject'),
                      nav: r('.ss-nav.prev') && r('.ss-nav.next')};
            }""")
            report["zoom"] = zoom0
            assert zoom0.get("img") and zoom0["w"] > 0, \
                f"zoom image failed to load: {zoom0}"
            assert "/api/dupe/file?" in zoom0["src"], \
                f"zoom served {zoom0['src']} — must be full-size /api/dupe/file"
            assert zoom0["pos"] and zoom0["pos"].startswith("1 / "), \
                f"position label wrong: {zoom0}"
            assert zoom0["back"] and zoom0["pick"] and zoom0["rej"] and zoom0["nav"], \
                f"zoom controls missing or under 44px: {zoom0}"
            await pg.screenshot(path=".probes/ss-05-zoom.png")
            # cycle next: image + position must change
            await pg.evaluate("() => document.querySelector('.ss-nav.next').click()")
            await pg.wait_for_timeout(800)
            zoom1 = await pg.evaluate("""() => ({
              src: document.querySelector('#ss-zoom .ss-focus img').src,
              pos: document.querySelector('#ss-zoom-pos').textContent,
            })""")
            await pg.evaluate("() => document.querySelector('.ss-nav.prev').click()")
            await pg.wait_for_timeout(800)
            zoom2 = await pg.evaluate("""() => ({
              src: document.querySelector('#ss-zoom .ss-focus img').src,
              pos: document.querySelector('#ss-zoom-pos').textContent,
            })""")
            report["zoom_cycle"] = {"next": zoom1, "prev": zoom2}
            assert zoom1["src"] != zoom0["src"] and zoom1["pos"].startswith("2 / "), \
                f"zoom next-cycle broken: {zoom1}"
            assert zoom2["src"] == zoom0["src"] and zoom2["pos"].startswith("1 / ") if cells > 1 else True, \
                f"zoom prev-cycle broken: {zoom2}"
            # swipe-left gesture also cycles (pointer events, no scroll fight)
            await pg.evaluate("""() => {
              const st = document.querySelector('#ss-zoom .ss-focus');
              const r = st.getBoundingClientRect();
              const y = r.top + r.height / 2, x0 = r.left + r.width * 0.8,
                    x1 = r.left + r.width * 0.2;
              st.dispatchEvent(new PointerEvent('pointerdown',
                {bubbles: true, pointerId: 7, clientX: x0, clientY: y}));
              st.dispatchEvent(new PointerEvent('pointerup',
                {bubbles: true, pointerId: 7, clientX: x1, clientY: y}));
            }""")
            await pg.wait_for_timeout(600)
            swipe_pos = await pg.evaluate(
                "() => document.querySelector('#ss-zoom-pos').textContent")
            report["zoom_swipe"] = swipe_pos
            assert swipe_pos.startswith("2 / "), f"swipe cycle broken: {swipe_pos}"
            # pick IN zoom — advance to an unhandled member, then pick in place
            for _ in range(list_len_placeholder := cells):
                btn_txt = await pg.evaluate(
                    "() => document.querySelector('#ss-zoom-pick').textContent")
                if btn_txt.strip() == "\u2713 Pick":
                    break
                await pg.evaluate("() => document.querySelector('.ss-nav.next').click()")
                await pg.wait_for_timeout(400)
            await pg.evaluate("() => document.querySelector('#ss-zoom-pick').click()")
            await pg.wait_for_timeout(400)
            picked = await pg.evaluate(
                "() => document.querySelector('#ss-zoom-pick').textContent")
            report["zoom_pick"] = picked
            assert "Un-pick" in picked, f"pick-in-zoom broken: {picked}"
            # back → returns to SURVEY, draft intact
            await pg.evaluate("() => document.querySelector('#ss-zoom-back').click()")
            await pg.wait_for_timeout(1500)
            back_survey = await pg.evaluate("""() => ({
              survey_open: !!document.querySelector('#ss-survey'),
              zoom_gone: !document.querySelector('#ss-zoom'),
              first_cell_class: document.querySelector('.ss-cell').className,
              pick_cells: document.querySelectorAll('#ss-survey .ss-cell.pick').length,
              reject_cells: document.querySelectorAll('#ss-survey .ss-cell.reject').length,
            })""")
            report["back_to_survey"] = back_survey
            assert back_survey["survey_open"] and back_survey["zoom_gone"] and \
                back_survey["pick_cells"] >= 1, \
                f"zoom back did not restore survey with draft: {back_survey}"
            await pg.screenshot(path=".probes/ss-05b-back-at-survey-draft.png")
            # survey's single exit → spread with the draft pick intact
            await pg.evaluate(
                "() => [...document.querySelectorAll('#ss-survey .ss-ov-top .ee-btn')]"
                ".find(b => b.textContent.includes('Back to stack')).click()")
            await pg.wait_for_timeout(1200)
            spread_state = await pg.evaluate("""() => ({
              survey_gone: !document.querySelector('#ss-survey'),
              header: !!document.querySelector('.ss-header'),
              chips: document.querySelectorAll('.ss-pick-chip').length,
            })""")
            report["spread_after_zoom"] = spread_state
            assert spread_state["survey_gone"] and spread_state["header"] and \
                spread_state["chips"] >= 2, \
                f"spread draft lost after zoom round-trip: {spread_state}"

            # ── 6c. KEYBOARD SHORTCUTS at spread level (2026-10-08b) ─
            # keydown only; desktop viewport (1024x768) — same as iPad PWA
            # viewport size but no touch dispatch, so touch paths untouched.
            pos0 = await pg.inner_text("#ss-kbd-pos")
            await pg.keyboard.press("ArrowRight")
            await pg.wait_for_timeout(400)
            pos1 = await pg.inner_text("#ss-kbd-pos")
            await pg.keyboard.press("ArrowLeft")
            await pg.wait_for_timeout(400)
            pos2 = await pg.inner_text("#ss-kbd-pos")
            report["kbd_cycle"] = {"start": pos0, "right": pos1, "left": pos2}
            assert pos1 != pos0 and pos2 == pos0, \
                f"arrows did not cycle the champion label: {pos0}→{pos1}→{pos2}"
            chips0 = await pg.evaluate(
                "() => document.querySelectorAll('.ss-pick-chip').length")
            dead0 = await pg.evaluate(
                "() => document.querySelectorAll('.ss-dead').length")
            await pg.keyboard.press("a")
            await pg.wait_for_timeout(400)
            chips1 = await pg.evaluate(
                "() => document.querySelectorAll('.ss-pick-chip').length")
            await pg.keyboard.press("f")
            await pg.wait_for_timeout(400)
            dead1 = await pg.evaluate(
                "() => document.querySelectorAll('.ss-dead').length")
            report["kbd_pick_reject"] = {"chips": [chips0, chips1],
                                         "dead": [dead0, dead1]}
            assert chips1 == chips0 + 1, \
                f"A did not pick the champion: {chips0}→{chips1}"
            assert dead1 == dead0 + 1, \
                f"F did not reject the champion: {dead0}→{dead1}"
            # legend affordance is coarse-pointer-aware: this context emulates
            # touch (has_touch=True → pointer:coarse), so the button must be
            # HIDDEN here — exactly the iPad behavior we want.
            legend_vis = await pg.evaluate(
                "() => getComputedStyle(document.querySelector('.kbd-btn')).display")
            assert legend_vis == "none", \
                f"kbd legend button visible on coarse-pointer (iPad) context: {legend_vis}"
            # desktop (fine pointer) context: button visible, legend opens
            b2 = await p.chromium.launch()
            ctx2 = await b2.new_context(viewport=VIEWPORT)  # no has_touch → fine
            pg2 = await ctx2.new_page()
            await pg2.goto(BASE + "/", wait_until="networkidle")
            await pg2.wait_for_timeout(1500)
            await pg2.evaluate("""() => {
              const btn = [...document.querySelectorAll('#tabbar .tab')]
                .find(t => t.dataset.name === 'dupe');
              btn.click();
            }""")
            await pg2.wait_for_timeout(4000)
            await pg2.evaluate("() => document.querySelector('.fam-card').click()")
            await pg2.wait_for_timeout(2000)
            legend_vis2 = await pg2.evaluate(
                "() => getComputedStyle(document.querySelector('.kbd-btn')).display")
            assert legend_vis2 != "none", \
                f"kbd legend button hidden at desktop viewport: {legend_vis2}"
            await pg2.evaluate(
                "() => document.querySelector('.ss-header .kbd-btn').click()")
            await pg2.wait_for_timeout(300)
            legend_open = await pg2.evaluate(
                "() => !!document.querySelector('.ss-header .kbd-legend') && "
                "document.querySelector('.ss-header .kbd-legend').style.display !== 'none'")
            assert legend_open, "legend did not open"
            await pg2.screenshot(path=".probes/ss-08-kbd-legend.png")
            await b2.close()

            # ── 7. Commit → verdict + pending manifest ───────────────
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

            # ── 7b. Esc at committed view → back to families ─────────
            await pg.keyboard.press("Escape")
            await pg.wait_for_timeout(1200)
            esc_fam = await pg.evaluate("""() => ({
              detail_closed: !document.querySelector('#dupe-detail')
                .classList.contains('open'),
              grid_back: getComputedStyle(document.querySelector('#fam-list'))
                .display !== 'none',
            })""")
            report["kbd_esc_to_families"] = esc_fam
            assert esc_fam["detail_closed"] and esc_fam["grid_back"], \
                f"Esc did not step back to families: {esc_fam}"

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
                    # ── keyboard at SURVEY + ZOOM levels ──────────────────
                    await pg.evaluate(
                        "() => document.querySelector('#ss-survey-btn').click()")
                    await pg.wait_for_timeout(2000)
                    await pg.keyboard.press("ArrowRight")
                    await pg.wait_for_timeout(300)
                    foc = await pg.evaluate(
                        "() => [...document.querySelectorAll('#ss-survey .ss-cell')]"
                        ".findIndex(c => c.classList.contains('kbd-focus'))")
                    assert foc == 1, f"survey arrow focus did not move to cell 2: {foc}"
                    await pg.keyboard.press("Enter")
                    await pg.wait_for_timeout(2000)
                    zpos = await pg.inner_text("#ss-zoom-pos")
                    assert zpos.startswith("2 / "), \
                        f"Enter did not zoom into focused cell: {zpos}"
                    await pg.keyboard.press("ArrowRight")
                    await pg.wait_for_timeout(500)
                    zpos2 = await pg.inner_text("#ss-zoom-pos")
                    assert zpos2.startswith("3 / "), \
                        f"arrow did not cycle zoom: {zpos2}"
                    await pg.keyboard.press("f")
                    await pg.wait_for_timeout(400)
                    zbtn = await pg.inner_text("#ss-zoom-reject")
                    assert "Un-reject" in zbtn, f"F did not reject in zoom: {zbtn}"
                    await pg.keyboard.press("Escape")
                    await pg.wait_for_timeout(1200)
                    back1 = await pg.evaluate("() => !!document.querySelector('#ss-survey')")
                    await pg.keyboard.press("Escape")
                    await pg.wait_for_timeout(1200)
                    back2 = await pg.evaluate("() => !!document.querySelector('.ss-header')")
                    report["kbd_survey_zoom"] = {"esc1_survey": back1, "esc2_spread": back2}
                    assert back1 and back2, \
                        f"Esc ladder broken: survey={back1} spread={back2}"
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
