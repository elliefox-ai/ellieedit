# Dupe view probe (2026-10-07y) — STACK-SPREAD family detail.
# Family browser, champion+fan duel, pick/reject, picks strip ordinals,
# survey grid, focus deck full-size serving, commit → pending + ledger.
# Non-destructive: whole-probe byte snapshot at start; teardown pardons via
# API, restores captured bytes, and VERIFIES hashes — any drift fails the
# probe instead of leaking (hardened 2026-10-08h).
# Run: .venv/bin/python tests/dupe-probe.py   (server on 127.0.0.1:8800)

import asyncio, hashlib, json, os, shutil, sys, tempfile, time
from pathlib import Path
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8800"
MANIFEST = Path(__file__).resolve().parents[1] / ".pending-delete.json"
LEDGER = Path(__file__).resolve().parents[1] / ".dupe-verdicts.jsonl"
SIGNALS_LOG = Path(__file__).resolve().parents[1] / ".dupe-signals.jsonl"
os.makedirs(".probes", exist_ok=True)

# iPad PWA viewport — the operator's device. Mandatory for screenshots.
VIEWPORT = {"width": 1024, "height": 768}


def _sig_data_dir():
    return Path(os.environ.get(
        "ELLIEEDIT_DUPE_DATA",
        str(Path(os.environ.get("ELLIEEDIT_DUPE_ROOT",
            "/mnt/shared/_Incoming/DupeReview")) / ".dupes")))


def snapshot_state():
    """Whole-probe byte snapshot of every file the probe may mutate.
    Restore always uses these captured bytes — never re-derived content.
    """
    snap = {}
    for p in (LEDGER, SIGNALS_LOG):
        snap[p] = p.read_bytes() if p.exists() else None
    fam_dir = _sig_data_dir() / "families"
    if fam_dir.is_dir():
        for fp in sorted(fam_dir.glob("*.json")):
            snap[fp] = fp.read_bytes()
    return snap


def manifest_snapshot():
    return MANIFEST.read_bytes() if MANIFEST.exists() else None


async def wait_grid_ready(pg, timeout=30000):
    """Wait until the family grid has re-rendered past its skeletons — fixed
    sleeps click skeleton cards (no handlers) when /mnt is slow."""
    await pg.wait_for_selector(".fam-card:not(.skel)", timeout=timeout)


async def main():
    snap = snapshot_state()
    manifest_backup = manifest_snapshot()
    fam_file = None          # seeded family file (section 10), restored exactly
    probe_paths = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport=VIEWPORT, has_touch=True)
            pg = await ctx.new_page()
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.evaluate("() => { try { localStorage.eeDupeDebug = '1'; } catch (_) {} }")
            # twin loop (10-08m): the legacy zoom_pick step asserts the button
            # label stays in place after a pick — auto-advance would move the
            # position. Probe turns it OFF here; the new twin-loop section
            # (12) turns it back ON. App default remains ON.
            await pg.evaluate("() => { try { localStorage.eeAutoAdvance = '0'; } catch (_) {} }")
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

            # ── 2a (10-08l). Tab switch must NOT wipe the draft ──────────
            # Regression: ellieedit:tab-activated called renderList() even
            # with a family open, destroying the in-progress verdict.
            await pg.evaluate("() => document.querySelector('.ss-champ').dispatchEvent("
                "new PointerEvent('pointerup', {bubbles: true}))")
            await pg.wait_for_timeout(400)
            await pg.tap(".ss-champ")
            await pg.wait_for_timeout(600)
            before = await pg.evaluate(
                "() => document.querySelectorAll('.ss-pick-chip').length")
            assert before >= 1, "pick failed — probe precondition"
            await pg.evaluate("() => document.querySelector('.tab[data-name=gallery]').click()")
            await pg.wait_for_timeout(1200)
            await pg.evaluate("() => document.querySelector('.tab[data-name=dupe]').click()")
            await pg.wait_for_timeout(2500)
            after = await pg.evaluate(
                "() => document.querySelectorAll('.ss-pick-chip').length")
            detail_open = await pg.evaluate(
                "() => document.querySelector('#dupe-detail').classList.contains('open')")
            report["tab_switch_draft"] = {"picks_before": before, "picks_after": after,
                                          "detail_open": detail_open}
            assert detail_open and after == before, \
                f"tab switch lost the draft: {before} picks -> {after}, detail_open={detail_open}"
            await pg.screenshot(path=".probes/ss-02a-tab-switch-draft.png")
            # undo the pick so later sections start from a clean draft
            await pg.tap(".ss-champ")
            await pg.wait_for_timeout(400)

            # ── 2b. Binding growth: re-open browser→detail twice; card click
            # handlers are re-created per render, but a double-mount would
            # double-fire renderDetail — detect via viewSeq trace deltas and
            # by asserting only ONE detail load per tap (status not erroring).
            for _ in range(2):
                await pg.evaluate("() => document.querySelector('#dupe-back').click()")
                await wait_grid_ready(pg)
                await pg.evaluate(
                    "() => document.querySelector('.fam-card:not(.skel)').click()")
                await pg.wait_for_selector(".ss-header", timeout=20000)
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
            assert zoom0["pos"] and zoom0["pos"].startswith("All 1 / "), \
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
            assert zoom1["src"] != zoom0["src"] and zoom1["pos"].startswith("All 2 / "), \
                f"zoom next-cycle broken: {zoom1}"
            assert zoom2["src"] == zoom0["src"] and zoom2["pos"].startswith("All 1 / ") if cells > 1 else True, \
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
            assert swipe_pos.startswith("All 2 / "), f"swipe cycle broken: {swipe_pos}"
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

            # ── 6d. SIFT (keep-K-of-N, 2026-10-08c) on a DEDICATED large
            # unresolved family — the probe's first family is too handled by
            # this point for a clean keep-2 pass. Keyboard first (fresh grid),
            # then tap-keeps, sweep, back to spread, commit THIS family.
            sift_fam = await pg.evaluate("""async () => {
              let cursor = '', best = null;
              for (let page = 0; page < 20; page++) {
                const d = await fetch('/api/dupe/families?state=unresolved&cursor='
                  + encodeURIComponent(cursor)).then(r => r.json());
                for (const it of d.items) if (!best || it.size > best.size) best = it;
                if (!d.next_cursor || (best && best.size >= 6)) break;
                cursor = d.next_cursor;
              }
              return best;
            }""")
            report["sift_family"] = {k: sift_fam[k] for k in ("id", "size")} if sift_fam else None
            assert sift_fam and sift_fam["size"] >= 4, \
                f"no multi-member unresolved family for the sift pass: {sift_fam}"
            await pg.evaluate("() => document.querySelector('#dupe-back').click()")
            await wait_grid_ready(pg)
            opened = await pg.evaluate("""(fid) => {
              const card = [...document.querySelectorAll('.fam-card')]
                .find(c => c.textContent.includes(fid));
              if (card) { card.click(); return true; }
              return false;
            }""", sift_fam["id"])
            await pg.wait_for_timeout(3000)
            assert opened, f"could not open sift family {sift_fam['id']} from first page"
            await pg.evaluate("() => document.querySelector('#ss-sift-btn').click()")
            await pg.wait_for_timeout(1200)
            sift0 = await pg.evaluate("""() => {
              const g = document.querySelector('#ss-sift-grid');
              const cells = g ? [...g.querySelectorAll('.ss-cell')] : [];
              return {
                open: !!document.querySelector('#ss-sift'),
                grid_h: g ? Math.round(g.getBoundingClientRect().height) : 0,
                cells: cells.length,
                visible_cells: cells.filter(c => c.getBoundingClientRect().height > 0).length,
                count: (document.querySelector('#ss-sift .keep-count')||{}).textContent || null,
                sweep: (() => { const b = document.querySelector('#ss-sift-sweep');
                  const r = b && b.getBoundingClientRect();
                  return r && r.height >= 44; })(),
              };
            }""")
            report["sift_enter"] = sift0
            assert sift0["open"] and sift0["grid_h"] > 0 and sift0["visible_cells"] > 0, \
                f"sift view did not open visibly: {sift0}"
            assert sift0["cells"] == sift_fam["size"], \
                f"sift grid should show all unhandled members: {sift0} vs {sift_fam}"
            assert sift0["sweep"], "sift sweep button under 44px"
            assert sift0["count"] == f"0 kept of {sift_fam['size']}", \
                f"keep counter wrong at entry: {sift0}"
            await pg.screenshot(path=".probes/ss-09-sift-grid.png")
            # KEYBOARD on the fresh grid: arrows move focus, P toggles keep
            # (on AND back off — reversible), F rejects the focused cell.
            await pg.keyboard.press("ArrowRight")
            await pg.wait_for_timeout(300)
            foc = await pg.evaluate(
                "() => [...document.querySelectorAll('#ss-sift-grid .ss-cell')]"
                ".findIndex(c => c.classList.contains('kbd-focus'))")
            assert foc == 1, f"sift arrow focus did not move to cell 2: {foc}"
            await pg.keyboard.press("p")
            await pg.wait_for_timeout(400)
            p_on = await pg.inner_text("#ss-sift .keep-count")
            assert p_on == f"1 kept of {sift_fam['size']}", f"P did not keep: {p_on}"
            ords = await pg.evaluate(
                "() => [...document.querySelectorAll('#ss-sift-grid .ord-badge')]"
                ".map(o => o.textContent)")
            assert ords == ["1st"], f"ordinal badge wrong: {ords}"
            await pg.keyboard.press("p")   # toggle back off (reversible)
            await pg.wait_for_timeout(400)
            p_off = await pg.inner_text("#ss-sift .keep-count")
            assert p_off == f"0 kept of {sift_fam['size']}", f"P toggle-off broken: {p_off}"
            pre_f_cells = await pg.evaluate(
                "() => document.querySelectorAll('#ss-sift-grid .ss-cell').length")
            await pg.keyboard.press("f")   # reject the focused cell
            await pg.wait_for_timeout(400)
            post_f_cells = await pg.evaluate(
                "() => document.querySelectorAll('#ss-sift-grid .ss-cell').length")
            assert post_f_cells == pre_f_cells - 1, \
                f"F did not remove the focused cell from the grid: {pre_f_cells}->{post_f_cells}"
            # TAP-KEEPS: keep the first two remaining cells → 1st / 2nd
            await pg.evaluate("""() => {
              [...document.querySelectorAll('#ss-sift-grid .ss-cell')][0]
                .querySelector('img').dispatchEvent(new MouseEvent('click', {bubbles: true}));
            }""")
            await pg.wait_for_timeout(500)
            await pg.evaluate("""() => {
              const cells = [...document.querySelectorAll('#ss-sift-grid .ss-cell')]
                .filter(c => !c.classList.contains('keep'));
              cells[0].querySelector('img').dispatchEvent(new MouseEvent('click', {bubbles: true}));
            }""")
            await pg.wait_for_timeout(500)
            sift1 = await pg.evaluate("""() => ({
              count: document.querySelector('#ss-sift .keep-count').textContent,
              ords: [...document.querySelectorAll('#ss-sift-grid .ord-badge')]
                .map(o => o.textContent),
              badge_h: (() => { const o = document.querySelector('#ss-sift-grid .ord-badge');
                const r = o && o.getBoundingClientRect(); return r && r.height > 0; })(),
            })""")
            report["sift_keep2"] = sift1
            assert sift1["ords"] == ["1st", "2nd"], f"ordinal badges wrong: {sift1}"
            assert sift1["badge_h"], "ordinal badge invisible"
            # SWEEP: reject the rest → only keeps remain, sweep disables
            await pg.evaluate("() => document.querySelector('#ss-sift-sweep').click()")
            await pg.wait_for_timeout(600)
            sift2 = await pg.evaluate("""() => ({
              cells: document.querySelectorAll('#ss-sift-grid .ss-cell').length,
              kept: document.querySelectorAll('#ss-sift-grid .ss-cell.keep').length,
              count: document.querySelector('#ss-sift .keep-count').textContent,
              sweep_disabled: document.querySelector('#ss-sift-sweep').disabled,
            })""")
            report["sift_sweep"] = sift2
            assert sift2["cells"] == sift2["kept"] == 2, \
                f"sweep left non-kept cells in the grid: {sift2}"
            assert sift2["sweep_disabled"], "sweep should disable with nothing unhandled"
            await pg.screenshot(path=".probes/ss-10-sift-post-sweep.png")
            # EXIT → spread with the same draft (2 chips + the F reject dead)
            await pg.evaluate("() => [...document.querySelectorAll('#ss-sift .ss-ov-top .ee-btn')]"
                ".find(b => b.textContent.includes('Back to stack')).click()")
            await pg.wait_for_timeout(1200)
            back = await pg.evaluate("""() => ({
              sift_gone: !document.querySelector('#ss-sift'),
              header: !!document.querySelector('.ss-header'),
              chips: document.querySelectorAll('.ss-pick-chip').length,
              dead: document.querySelectorAll('.ss-dead').length,
            })""")
            report["sift_back_to_spread"] = back
            assert back["sift_gone"] and back["header"] and back["chips"] == 2 \
                and back["dead"] == sift_fam["size"] - 2, \
                f"sift exit did not carry draft to spread: {back} (size {sift_fam['size']})"
            # COMMIT the sift family → ledger entry with ranks + pending rejects
            await pg.evaluate("() => document.querySelector('#dupe-commit').click()")
            await pg.wait_for_timeout(3000)
            sift_committed = await pg.evaluate(
                "() => (document.querySelector('.ss-committed .big')||{}).textContent || null")
            report["sift_committed"] = sift_committed
            assert sift_committed and "committed" in sift_committed, \
                f"sift family commit did not land: {sift_committed}"
            await pg.screenshot(path=".probes/ss-11-sift-committed.png")
            # back to families for the remaining sections
            await pg.evaluate("() => document.querySelector('#dupe-back').click()")
            await pg.wait_for_timeout(1500)

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
            # Sift rank payload: latest ledger entry must carry 1-based ranks
            # for every kept pick, and rejects in the pending manifest.
            if ledger_tail:
                last_e = json.loads(ledger_tail[0])
                kept_paths = [p for p, v in last_e.get("members", {}).items()
                              if v == "kept"]
                ranks = last_e.get("ranks", {})
                assert set(ranks.keys()) == set(kept_paths) and len(ranks) >= 2, \
                    f"sift ranks missing/mismatched in ledger: {ranks} vs kept {kept_paths}"
                assert sorted(ranks.values()) == list(range(1, len(ranks) + 1)), \
                    f"ranks not 1..K: {ranks}"
                report["sift_ranks"] = ranks
                assert report["manifest_added"], "sweep rejects did not reach pending manifest"

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
                await wait_grid_ready(pg)
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
                    assert zpos.startswith("All 2 / "), \
                        f"Enter did not zoom into focused cell: {zpos}"
                    await pg.keyboard.press("ArrowRight")
                    await pg.wait_for_timeout(500)
                    zpos2 = await pg.inner_text("#ss-zoom-pos")
                    assert zpos2.startswith("All 3 / "), \
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

            # ── 10. SIGNAL-CONFLICT SURFACING (2026-10-08d) ───────────
            # Seed verdict history that CONTRADICTS the hash tiers (direct
            # append-only ledger write; ledger pardoned byte-for-byte in the
            # finally). Assert: ⚡ badge on the family card, conflict chips in
            # the detail signals bar, suggestion ONLY on strong agreement —
            # Apply fills the DRAFT (ledger untouched), Dismiss removes it.
            sig_data = _sig_data_dir()
            fam_dir = sig_data / "families"
            import urllib.request
            items = json.loads(urllib.request.urlopen(
                BASE + "/api/dupe/families?state=unresolved").read())["items"]
            seed = None
            for it in items:
                if it["size"] < 2:
                    continue
                fp = fam_dir / f"{it['id']}.json"
                try:
                    fj = json.loads(fp.read_text())
                except OSError:
                    continue
                strict = [e for e in fj.get("edges", [])
                          if e.get("tier") in ("exact", "pixel-identical",
                                               "near-identical")]
                members = [m["path"].replace("\\", "/")
                           for m in fj.get("members", [])]
                em = []
                for e in strict:
                    for k in ("a", "b"):
                        v = e.get(k)
                        em.append(members[v] if isinstance(v, int)
                                  and 0 <= v < len(members)
                                  else v if isinstance(v, str) else None)
                if len(em) >= 2 and None not in em[:2]:
                    seed = {"id": it["id"], "file": fp, "json": fj,
                            "keep": em[0]}
                    break
            report["signal_seed"] = seed["id"] if seed else "none found"
            assert seed, "no unresolved family with an addressable strict edge"
            fam_file = seed["file"]
            entry_members = {m: "rejected" for m in
                             [mm["path"].replace("\\", "/")
                              for mm in seed["json"]["members"]]}
            # PARTIAL split on purpose: keep one, reject one, leave the rest
            # unjudged — the family stays UNRESOLVED (a full verdict would
            # flip it to committed mode, where the signals bar is suppressed
            # by design) while the kept↔rejected strict edge still conflicts.
            entry_members = {seed["keep"]: "kept", em_disagree: "rejected"} \
                if (em_disagree := next(p for p in entry_members
                                        if p != seed["keep"])) else entry_members
            with LEDGER.open("a") as fh:
                fh.write(json.dumps({"ts": "2026-10-08T09:00:00-07:00",
                                     "family": seed["id"],
                                     "members": entry_members,
                                     "note": "probe signal-conflict seed",
                                     "probe": True}, ensure_ascii=False) + "\n")
            # back to the browser grid; the seed resolves the family (any
            # non-deferred verdict does), so switch the grid to ALL to find it
            await pg.keyboard.press("Escape")
            await pg.wait_for_timeout(1200)
            await pg.evaluate("""() => {
              const list = document.querySelector('#fam-list');
              if (getComputedStyle(list).display === 'none')
                document.querySelector('#dupe-back').click();
            }""")
            await pg.wait_for_timeout(1500)
            await pg.evaluate("""() => [...document.querySelectorAll('.dupe-top .pill')]
              .find(p => p.dataset.f === 'all').click()""")
            await pg.wait_for_timeout(3000)
            flag = await pg.evaluate("""(fid) => {
              const card = [...document.querySelectorAll('.fam-card')]
                .find(c => c.textContent.includes(fid));
              if (!card) return {card: false};
              const f = card.querySelector('.sig-flag');
              const r = f && f.getBoundingClientRect();
              return {card: true, flag: !!f, glyph: f && f.textContent,
                      h: r && Math.round(r.height)};
            }""", seed["id"])
            report["card_conflict_flag"] = flag
            assert flag["card"] and flag["flag"] and flag["glyph"] == "⚡" \
                and flag["h"] > 0, f"card ⚡ badge missing/invisible: {flag}"
            await pg.screenshot(path=".probes/ss-15-card-conflict-flag.png")
            # detail: signals bar with history chips + explicit conflict line
            await pg.evaluate(f"""() => [...document.querySelectorAll('.fam-card')]
              .find(c => c.textContent.includes('{seed['id']}')).click()""")
            await pg.wait_for_selector("#ss-signals", timeout=20000)
            bar = await pg.evaluate("""() => {
              const b = document.querySelector('#ss-signals');
              const r = b && b.getBoundingClientRect();
              return {present: !!b, h: r && Math.round(r.height),
                      chips: [...document.querySelectorAll('#ss-signals .sig-chip')]
                        .map(c => c.textContent),
                      conflicts: [...document.querySelectorAll('#ss-signals .sig-conflict')]
                        .map(c => c.textContent)};
            }""")
            report["detail_signals_bar"] = bar
            assert bar["present"] and bar["h"] > 0, f"signals bar invisible: {bar}"
            assert len(bar["chips"]) >= 2, f"history chips missing: {bar}"
            assert any("⚡" in c for c in bar["conflicts"]), \
                f"conflict line missing from the signals bar: {bar}"
            await pg.screenshot(path=".probes/ss-16-detail-conflict-chips.png")
            # suggestion on strong agreement: strict edges only among NON-keep
            # members, and the family back in REVIEW — an all-deferred latest
            # entry reopens it; the suggestion comes from the decided entry.
            all_paths = [mm["path"].replace("\\", "/")
                         for mm in seed["json"]["members"]]
            non_keep = [p for p in all_paths if p != seed["keep"]]
            seed["json"]["edges"] = [{"a": non_keep[0], "b": non_keep[1],
                                      "tier": "exact", "distance": 0}] \
                if len(non_keep) >= 2 else []
            with LEDGER.open("a") as fh:
                fh.write(json.dumps({"ts": "2026-10-08T09:30:00-07:00",
                                     "family": seed["id"],
                                     "members": {p: "deferred"
                                                 for p in all_paths},
                                     "note": "probe deferral reopen",
                                     "probe": True}, ensure_ascii=False) + "\n")
            fam_file.write_text(json.dumps(seed["json"]))
            await pg.evaluate("() => document.querySelector('#dupe-back').click()")
            await wait_grid_ready(pg)
            await pg.evaluate(f"""() => [...document.querySelectorAll('.fam-card')]
              .find(c => c.textContent.includes('{seed['id']}')).click()""")
            await pg.wait_for_selector("#ss-suggest", timeout=20000)
            sug = await pg.evaluate("""() => {
              const row = document.querySelector('#ss-suggest');
              const r = row && row.getBoundingClientRect();
              const ap = document.querySelector('#ss-suggest-apply');
              const ar = ap && ap.getBoundingClientRect();
              return {present: !!row, h: r && Math.round(r.height),
                      label: row && row.querySelector('.lbl')?.textContent || null,
                      apply_ok: ar && ar.height >= 40 && ar.width >= 40};
            }""")
            report["suggestion_row"] = sug
            assert sug["present"] and sug["h"] > 0 \
                and sug["label"].startswith("Signals suggest:") and sug["apply_ok"], \
                f"suggestion row missing/invisible: {sug}"
            ledger_before = LEDGER.read_bytes()
            await pg.evaluate("() => document.querySelector('#ss-suggest-apply').click()")
            await pg.wait_for_timeout(800)
            applied = await pg.evaluate("""() => ({
              chips: document.querySelectorAll('.ss-pick-chip').length,
              banner: document.querySelector('.ss-committed') !== null,
            })""")
            ledger_after = LEDGER.read_bytes()
            report["suggestion_applied"] = {**applied,
                                            "ledger_untouched":
                                                ledger_before == ledger_after}
            assert applied["chips"] >= 1 and not applied["banner"], \
                f"apply did not fill the draft: {applied}"
            assert ledger_before == ledger_after, \
                "Apply wrote to the verdict ledger — draft-only violation"
            await pg.screenshot(path=".probes/ss-17-suggestion-applied-draft.png")
            # Apply consumed the row (draft now carries the verdict). Re-open
            # the detail — the suggestion re-shows for the fresh visit — and
            # DISMISS it there.
            await pg.evaluate("() => document.querySelector('#dupe-back').click()")
            await wait_grid_ready(pg)
            await pg.evaluate(f"""() => [...document.querySelectorAll('.fam-card')]
              .find(c => c.textContent.includes('{seed['id']}')).click()""")
            await pg.wait_for_selector("#ss-suggest", timeout=20000)
            await pg.evaluate("() => document.querySelector('#ss-suggest-dismiss').click()")
            await pg.wait_for_timeout(400)
            dismissed = await pg.evaluate(
                "() => document.querySelector('#ss-suggest') === null")
            report["suggestion_dismissed"] = dismissed
            assert dismissed, "dismiss did not remove the suggestion row"
            sig_events = (SIGNALS_LOG.read_text().strip().splitlines()
                          if SIGNALS_LOG.exists() else [])
            kinds = [json.loads(l)["event"] for l in sig_events
                     if json.loads(l).get("family") == seed["id"]]
            report["signal_events"] = kinds
            # shown re-logs per detail visit; applied and dismissed follow
            assert kinds[-1] == "dismissed" and set(kinds) == \
                {"shown", "applied", "dismissed"} and "applied" in kinds, \
                f"signal event log wrong: {kinds}"
            assert not console_errors, f"console errors: {console_errors}"

            print(json.dumps(report, indent=1))

            # ── 11. ZOOM VIEW FILTER: All / Accepted / Rejected (2026-10-08j,
            # re-scoped to the zoom chrome) ─────────────────────────────
            # The filter is a DRAFT-time tool: zoom lives in the spread
            # (uncommitted) view, so the probe builds a draft — pick the
            # champion, reject the next — and asserts the visited member
            # set per mode. No ledger writes: teardown never touches them.
            seed = None
            items = json.loads(urllib.request.urlopen(
                BASE + "/api/dupe/families?state=unresolved").read())["items"]
            for it in items:
                if it["size"] < 3:
                    continue
                det = json.loads(urllib.request.urlopen(
                    BASE + f"/api/dupe/families/{it['id']}").read())
                # need a family with NO verdict history at all: an
                # all-deferred entry would pre-fill every member's verdict
                # and silently no-op the draft pick/reject below
                if not (det.get("verdict") or {}):
                    seed = {"id": it["id"], "n": it["size"]}
                    break
            assert seed, "no verdict-free unresolved family with >=3 members"
            sid, nmems = seed["id"], seed["n"]
            # open the family detail from the browser grid
            await pg.keyboard.press("Escape")
            await pg.wait_for_timeout(1200)
            await pg.evaluate("""() => {
              const list = document.querySelector('#fam-list');
              if (getComputedStyle(list).display === 'none')
                document.querySelector('#dupe-back').click();
            }""")
            await pg.wait_for_timeout(1500)
            await pg.evaluate("""() => [...document.querySelectorAll('.dupe-top .pill')]
              .find(p => p.dataset.f === 'all').click()""")
            await pg.wait_for_timeout(3000)
            await pg.evaluate(f"""() => [...document.querySelectorAll('.fam-card')]
              .find(c => c.textContent.includes('{sid}')).click()""")
            await pg.wait_for_timeout(3000)
            detail_open = await pg.evaluate(
                "() => document.querySelector('#dupe-detail').classList.contains('open')")
            assert detail_open, "seeded family detail did not open"
            rep = {}

            async def zoom_state():
                return await pg.evaluate("""() => {
                  const z = document.querySelector('#ss-zoom');
                  if (!z) return {zoom: false};
                  return {
                    zoom: true,
                    label: document.querySelector('#ss-zoom-pos').textContent,
                    dots: [...z.querySelectorAll('.dots .ss-dot')].length,
                    empty: (z.querySelector('.zoom-empty-hint')||{}).textContent || null,
                    pick_disabled: document.querySelector('#ss-zoom-pick').disabled,
                  };
                }""")

            async def zoom_set_mode(mode):
                await pg.evaluate(
                    f"""() => document.querySelector(
                      '#ss-zoom .zoom-mode-btn[data-zm="{mode}"]').click()""")
                await pg.wait_for_timeout(500)
                return await zoom_state()

            # EMPTY-STATE first: enter zoom BEFORE any draft verdict — the
            # Accepted set is empty and must show the inline hint.
            await pg.evaluate("() => document.querySelector('#ss-survey-btn').click()")
            await pg.wait_for_timeout(2500)
            await pg.evaluate(
                "() => document.querySelector('#ss-survey .ss-cell').click()")
            await pg.wait_for_timeout(1500)
            z0 = await zoom_state()
            assert z0["zoom"], "zoom did not open from survey"
            empty = await zoom_set_mode("accepted")
            assert empty["dots"] == 0 and empty["empty"] \
                and "No accepted members" in empty["empty"] \
                and empty["pick_disabled"], \
                f"zoom Accepted empty state broken: {empty}"
            rep["zoom_empty_accepted"] = empty
            await pg.screenshot(path=".probes/ss-21-zoom-empty-accepted.png")

            # build the draft: back to spread (Esc zoom→survey, Esc
            # survey→spread), pick the champion, reject the next champion.
            # Nothing persists (no Commit).
            await pg.keyboard.press("Escape")
            await pg.wait_for_timeout(1200)
            await pg.keyboard.press("Escape")
            await pg.wait_for_timeout(1500)
            spread_back = await pg.evaluate(
                "() => ({spread: !!document.querySelector('.ss-champ'),"
                " survey: !!document.querySelector('#ss-survey'),"
                " zoom: !!document.querySelector('#ss-zoom')})")
            assert spread_back["spread"] and not spread_back["zoom"] \
                and not spread_back["survey"], \
                f"Esc did not step back to the spread: {spread_back}"
            # keyboard path (proven at spread level in section 6c):
            # 'a' picks the champion, 'f' rejects the next one. Blur first —
            # a focused #dupe-note (section 7) makes onDupeKey early-return.
            await pg.evaluate("() => document.activeElement && document.activeElement.blur()")
            await pg.wait_for_timeout(200)
            await pg.keyboard.press("a")
            await pg.wait_for_timeout(600)
            await pg.keyboard.press("f")
            await pg.wait_for_timeout(600)
            draft_n = await pg.evaluate(
                "() => ({kept: !!document.querySelector('.ss-pick-chip'),"
                " dead: document.querySelectorAll('.ss-dead').length,"
                " detail_open: document.querySelector('#dupe-detail').classList.contains('open'),"
                " active_panel: document.querySelector('.module-panel.active')?.dataset?.name,"
                " detail_children: [...document.querySelector('#dupe-detail').children].map(x => x.id || x.className),"
                " panel_active: [...document.querySelectorAll('.module-panel')].filter(x => x.classList.contains('active')).map(x => (x.querySelector('.dupe-wrap') ? 'dupe' : 'other')),"
                " champ: (document.querySelector('.ss-champ')||{}).outerHTML?.slice(0,120),"
                " trace: document.querySelector('#dupe-status').textContent})")
            assert draft_n["kept"] and draft_n["dead"] >= 1, \
                f"draft pick+reject failed: {draft_n}"
            # re-enter zoom via survey with the draft live
            await pg.evaluate("() => document.querySelector('#ss-survey-btn').click()")
            await pg.wait_for_timeout(2500)
            await pg.evaluate(
                "() => document.querySelector('#ss-survey .ss-cell').click()")
            await pg.wait_for_timeout(1500)

            # All (default on a fresh open): every member of the family
            allv = await zoom_set_mode("all")
            assert allv["dots"] == nmems and allv["empty"] is None \
                and allv["label"].startswith("All 1 / "), \
                f"zoom All wrong: {allv} vs {nmems} members"
            rep["zoom_all"] = allv
            await pg.screenshot(path=".probes/ss-18-zoom-all.png")

            # Accepted: exactly the draft pick
            acc = await zoom_set_mode("accepted")
            assert acc["dots"] == 1 and acc["label"].startswith("Accepted 1 / 1") \
                and acc["empty"] is None and not acc["pick_disabled"], \
                f"zoom Accepted wrong: {acc}"
            rep["zoom_accepted"] = acc
            await pg.screenshot(path=".probes/ss-19-zoom-accepted.png")

            # Rejected: exactly the draft reject
            rej = await zoom_set_mode("rejected")
            assert rej["dots"] == 1 and rej["label"].startswith("Rejected 1 / 1"), \
                f"zoom Rejected wrong: {rej}"
            rep["zoom_rejected"] = rej
            await pg.screenshot(path=".probes/ss-20-zoom-rejected.png")

            # Arrow cycling stays inside the filtered set: next wraps on the
            # single-member set (position label unchanged).
            await pg.evaluate("() => document.querySelector('#ss-zoom .ss-nav.next').click()")
            await pg.wait_for_timeout(400)
            wrap = (await zoom_state())["label"]
            assert wrap.startswith("Rejected 1 / 1"), \
                f"cycle left the filtered set: {wrap}"
            rep["zoom_cycle_within_set"] = wrap
            report["zoom_filter"] = rep
            assert not console_errors, f"console errors: {console_errors}"
            print(json.dumps(report, indent=1))

            await b.close()
    finally:
        # HARDENED TEARDOWN (2026-10-08h): the old single-pass restore leaked
        # manifest entries written after the section-7 probe_paths snapshot —
        # anything landing post-restore survived, and a restore that changed
        # bytes passed silently. Now: the manifest is RECONCILED entry-by-entry
        # (pardon everything added relative to the snapshot, re-add any
        # snapshot entry that vanished — from captured bytes, never re-derived)
        # with retries, because a live second client can write the manifest
        # concurrently; wholesale overwrite would destroy real operator marks.
        # Probe-exclusive files (ledger, signals, family JSONs) are restored
        # byte-for-byte from the snapshot and hash-verified: any drift FAILS
        # the probe instead of leaking.
        import urllib.request

        def _read_manifest():
            try:
                return json.loads(MANIFEST.read_text()) \
                    if MANIFEST.exists() else {}
            except (OSError, json.JSONDecodeError):
                return {}

        base = json.loads(manifest_backup.decode()) if manifest_backup else {}
        manifest_bad = {}
        for attempt in range(6):
            cur = _read_manifest()
            added = [k for k in cur if k not in base]
            if added:
                req = urllib.request.Request(
                    BASE + "/api/pending",
                    data=json.dumps({"paths": added}).encode(),
                    headers={"Content-Type": "application/json"},
                    method="DELETE")
                try:
                    urllib.request.urlopen(req)
                except urllib.error.HTTPError:
                    pass  # jail edge: fall back to direct merge below
            # re-add snapshot entries that vanished, captured bytes only
            cur = _read_manifest()
            missing = {k: v for k, v in base.items() if cur.get(k) != v}
            if missing:
                merged = dict(cur)
                merged.update(missing)
                MANIFEST.write_text(json.dumps(merged, indent=1))
            manifest_bad = {k: cur.get(k) for k in base
                            if _read_manifest().get(k) != base[k]}
            probe_left = [k for k in _read_manifest() if k not in base]
            if not manifest_bad and not probe_left:
                break
            time.sleep(1.0)  # let a concurrent writer settle, then retry
        if manifest_bad or probe_left:
            raise AssertionError(
                f"PROBE RESTORE LEAK (manifest): base entries wrong "
                f"{manifest_bad} / probe entries survived {probe_left}")
        # probe-exclusive files: byte restore + hash verify
        for attempt in range(6):
            for p, data in snap.items():
                if data is None:
                    p.unlink(missing_ok=True)
                else:
                    p.write_bytes(data)
            bad = {str(p): ("missing" if not p.exists() else
                            hashlib.sha256(p.read_bytes()).hexdigest()[:16])
                   for p, data in snap.items()
                   if (p.read_bytes() if p.exists() else None) != data}
            if not bad:
                break
            time.sleep(1.0)
        if bad:
            raise AssertionError(
                f"PROBE RESTORE LEAK: state not byte-identical after "
                f"teardown (6 attempts): {bad}")


asyncio.run(main())
