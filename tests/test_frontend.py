"""Runs the headless JS load-path regression test (node)."""

import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent


def test_js_load_path():
    r = subprocess.run(
        ["node", str(HERE / "js" / "load-path.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


def test_js_operator_sequence():
    """Full operator flow (select A → generate → Keep → select B → generate →
    Keep) with real dimension math — the test that models the iPad failure."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "facecycle-sequence.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


def test_no_global_pending_preview():
    """Region-status refactor (2026-10-07h): the global pending preview store is
    deleted. Generation lifecycle lives on state.activeRegions[].status only."""
    assert not (HERE.parent / "frontend" / "js" / "components" / "pending.js").exists(), \
        "pending.js (global pending store) must be deleted"
    fc = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    for banned in ("PendingPreview", "pendingStore", "stack.pending", "addPendingVariant"):
        assert banned not in fc, f"facecycle.js still references global pending API: {banned}"
    stack = (HERE.parent / "frontend" / "js" / "components" / "canvas-stack.js").read_text()
    assert "this.pending" not in stack, "canvas-stack still carries a global pending layer"


def test_sw_cache_version_matches_build_marker():
    """The SW cache name and the UI build marker must move together on deploy —
    this is the stale-cache guard (blank-canvas incident 2026-10-07)."""
    sw = (HERE.parent / "frontend" / "sw.js").read_text()
    shell = (HERE.parent / "frontend" / "js" / "shell.js").read_text()
    import re
    cache = re.search(r"const CACHE = '([^']+)'", sw).group(1)
    build = re.search(r"const BUILD = '([^']+)'", shell).group(1)
    # Both must carry the same deploy stamp. shell.js BUILD is dashed
    # (2026-10-08k), sw.js CACHE is compact (20261008k) — same version,
    # two spellings. Exact comparison: a wrong pairing must fail.
    stamp = re.search(r"(\d{8}[a-z])", cache)
    assert stamp, f"SW cache name lacks a deploy stamp: {cache}"
    assert stamp.group(1) == build.replace("-", ""), \
        f"build marker {build!r} does not match SW cache stamp {stamp.group(1)!r} " \
        f"(same deploy, dashed vs compact form expected)"


def test_no_invalid_star_class_in_module():
    """Regression: `.*** {` / class="***" is an invalid CSS class (rule silently
    dropped) left over from an editing artifact."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    assert 'class="***"' not in src
    assert ".*** {" not in src
    assert 'fc-canvas-wrap' in src


def test_js_gallery_path_helpers():
    """Breadcrumb path helpers for subfolder navigation (2026-10-09e)."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "gallery-path.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


def test_js_foxden_recent_helpers():
    """FoxDen recent-strip collapse persistence + count label (Task 5)."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "foxden-recent.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


def test_js_deploy_gate_covers_foxden():
    """The Safari-syntax deploy gate must parse FoxDen's modules too."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "syntax-check.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"syntax gate failed:\n{r.stdout}\n{r.stderr}"
    assert "ok js/modules/foxden.js" in r.stdout
    assert "ok js/modules/foxden-recent.js" in r.stdout


def test_kept_gens_share_the_layers_row():
    """Task 10: the gen strip is a child of the repaint/layers row, right-aligned,
    not a separate block under the canvas; data-id unchanged."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    html = src[src.index("function panelHTML"):src.index("export class FaceCycle")]
    row_start = html.index('data-group="repaint"')
    row_end = html.index('<div class="fc-drop"')
    row = html[row_start:row_end]
    assert 'data-id="gen-strip"' in row, "gen strip must live inside the layers row"
    assert row.index('data-act="layer-toggle"') < row.index('data-id="gen-strip"')
    main = html[html.index('data-id="main-view"'):]
    assert 'data-id="gen-strip"' not in main, "no gens bar below the canvas"
    assert html.count('data-id="gen-strip"') == 1
    assert "margin-left: auto" in html[html.index(".fc-gens {"):html.index(".fc-gens .label")]


def test_facecycle_zoom_controls_and_persistence():
    """Task 6 (+10-15 revision): slider 25%..300% with fit=100 default, Fit button, localStorage persistence,
    two-finger touch pan; zoom is CSS-width driven (never transform:scale)."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    for needle in ('data-id="zoom-slider"', 'min="25"', 'max="300"', 'value="100"',
                   'data-act="zoom-fit"', "ellieedit.facecycle.zoom",
                   "localStorage.getItem(KEY)", "localStorage.setItem(KEY",
                   "touches.size >= 2"):
        assert needle in src, needle
    cs = (HERE.parent / "frontend" / "js" / "components" / "canvas-stack.js").read_text()
    assert "transform" not in cs.split("setZoom")[1].split("render(opts")[0], \
        "zoom must not use transform:scale (breaks scrollable overflow)"
    # fit button resets to 100 through the same persisted setter
    assert "zoomFitBtn.addEventListener('click', () => this.setZoomPct(100))" in src


def test_foxden_pinned_chips_sit_above_the_list():
    """Task 5 add.6: pins + suspended tray render just above the scrollable
    list, and the submitted payload comes from the pin state (active only)."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "foxden.js").read_text()
    order = [src.index(f'data-id="{k}"') for k in ("pins", "susp", "lfilter", "loras")]
    assert order == sorted(order), "pins, suspended tray, filter, list — in that order"
    assert "loras: pins.payload()" in src and "suspended_loras: pins.suspendedPayload()" in src
    assert "pins.restoreFrom(e.loras, e.suspended_loras)" in src      # faithful Reuse
    assert "pickList(allLoras, el.lfilter.value)" in src              # filter -> list only


def test_foxden_presets_wiring():
    """Task 5 add.2: preset bar markup, 44px targets, confirm-on-delete,
    auto-remember held back until restore, no _last re-apply on tab activation."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "foxden.js").read_text()
    css = (HERE.parent / "frontend" / "js" / "modules" / "foxden.css").read_text()
    for needle in ('data-id="preset-pick"', 'data-id="preset-lock"',
                   'data-id="preset-save"', 'data-id="preset-del"',
                   "confirm(`Delete preset", "method: 'DELETE'", "'/presets'",
                   "API + '/last'", "keepalive: true", "if (!restored) return;",
                   "presetState(collectState(), el['preset-lock'].checked)"):
        assert needle in src, needle
    assert ".fx-presets .fx-btn { min-width:44px; min-height:44px; }" in css
    # restore happens once, at construction — activation only refreshes lists
    assert src.count("applyState(last)") == 1
    act = src[src.index("ellieedit:tab-activated"):]
    assert "applyState" not in act.split("});")[0]


def test_foxden_denoise_always_visible_always_sent_and_img2img_wiring():
    """Add.5 revision: slider never hidden/grayed, value ALWAYS in /generate;
    input-image chips toggle; aspect buttons gray (only those) when an input is set."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "foxden.js").read_text()
    css = (HERE.parent / "frontend" / "js" / "modules" / "foxden.css").read_text()
    assert 'data-id="denoise" min="0.1" max="1" step="0.05" value="1"' in src
    gen = src[src.index("async function generate()"):src.index("async function poll(")]
    assert "denoise: parseFloat(el.denoise.value)" in gen          # unconditional
    assert "if (inputImage) body.input_image = inputImage" in gen
    # nothing ever hides/disables the denoise slider
    for bad in ("el.denoise.disabled", "el.denoise.style.display", "el.denoise.hidden",
                "el.dval.style.display"):
        assert bad not in src, bad
    assert "[data-id=\"aspects\"].dim { opacity:.4; }" in css     # only aspects dim
    # captured by presets + Reuse
    assert "denoise: parseFloat(el.denoise.value), input_image: inputImage" in src
    assert "setDenoise(e.denoise ?? 1)" in src and "setDenoise(st.denoise)" in src
    # chips: tap toggles selection; upload + none controls exist
    for needle in ('data-id="ichips"', 'data-id="iup"', 'data-id="iclear"',
                   "setInput(n === inputImage ? null : n)", "type=input"):
        assert needle in src, needle


# ------------------------------------------------------------------ Task 7
OLD_IDS = ["threshold", "threshold-val", "min-size", "min-size-val", "max-size",
           "max-size-val", "brush-controls", "brush-size", "brush-size-val",
           "face-mode", "repaint-prompt", "denoise", "denoise-val", "seed-input",
           "randomize-seed", "detail-crop", "variant-count", "gen-strip"]
OLD_ACTS = ["detect", "click-add", "draw-box", "draw-mask", "erase", "remove-all",
            "generate", "keep", "discard", "undo", "layer-toggle", "zoom-fit"]


def _fc_html():
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    return src, src[src.index("function panelHTML"):src.index("export class FaceCycle")]


def test_task7_every_control_keeps_its_id_and_lives_in_the_right_surface():
    """Three surfaces: main band (draw/erase/undo/Generate...), 🖌 Repaint sheet,
    🔍 Detect sheet. Every pre-existing data-id/data-act survives, exactly once."""
    _, html = _fc_html()
    band = html[html.index('data-group="controls"'):html.index('data-id="sheet-backdrop"')]
    rep = html[html.index('data-sheet="repaint"'):html.index('data-sheet="detect"')]
    det = html[html.index('data-sheet="detect"'):]
    for i in OLD_IDS + ["zoom-slider", "zoom-val"]:
        assert html.count(f'data-id="{i}"') == 1, i
    for a in OLD_ACTS:
        assert html.count(f'data-act="{a}"') == 1, a
    # main band: draw tools, erase/brush, undo, Generate (+ keep/discard/layers row)
    for x in ('data-act="draw-box"', 'data-act="draw-mask"', 'data-act="erase"',
              'data-id="brush-controls"', 'data-act="undo"', 'data-act="generate"',
              'data-act="keep"', 'data-act="discard"', 'data-act="open-repaint"',
              'data-act="open-detect"'):
        assert x in band, x
    # Repaint sheet: prompt + repaint options + its own Generate (same handler)
    for x in ('data-id="repaint-prompt"', 'data-id="denoise"', 'data-id="seed-input"',
              'data-id="randomize-seed"', 'data-id="detail-crop"',
              'data-id="variant-count"', 'data-act="generate-sheet"'):
        assert x in rep, x
    # Detect sheet: detection + diff sensitivity + min/max region (one diff engine)
    for x in ('data-act="detect"', 'data-act="click-add"', 'data-id="face-mode"',
              'data-id="threshold"', 'data-id="min-size"', 'data-id="max-size"'):
        assert x in det, x
    # nothing detection/repaint-specific left in the everyday band
    for gone in ('data-id="threshold"', 'data-id="repaint-prompt"', 'data-act="detect"'):
        assert gone not in band, gone


def test_task7_sheets_never_touch_canvas_state_and_shortcuts_survive():
    src, _ = _fc_html()
    ctl = (HERE.parent / "frontend" / "js" / "modules" / "facecycle-sheets.js").read_text()
    for forbidden in ("render(", "resetAll", "ensureOverlay", "setSize", "processImages",
                      "undoLog", "activeRegions", "stack"):
        assert forbidden not in ctl, f"sheet controller must not touch {forbidden}"
    # Escape closes an open sheet BEFORE the mask-mode Escape handling
    assert src.index("e.key === 'Escape' && this.sheets.isOpen()") < src.index("if (e.target.tagName === 'INPUT'")
    # shortcuts untouched (F/B/M still wired at document level)
    for k in ("e.key === 'f'", "e.key === 'b'", "e.key === 'm'"):
        assert k in src
    # sheet Generate + Enter use the one generateRepaint handler
    assert src.count("this.generateRepaint()") >= 3
    # sheets are fixed-position (no layout/canvas-box impact)
    assert ".fc-sheet { position:fixed;" in src
    # 44px targets inside sheets
    assert ".fc-sheet-body .ee-btn, .fc-sheet-head .ee-btn { min-height:44px; min-width:44px; }" in src
