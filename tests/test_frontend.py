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


def test_js_layer_model():
    """F1 (2026-10-21): pure layer/ring/mask-ownership logic (node)."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "facecycle-layers.test.mjs")],
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
    """Task 10, revised 2026-10-16f: the tools drawer is ONE row now; the gen
    strip still lives in it, right-aligned; data-id unchanged."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    html = src[src.index("function panelHTML"):src.index("export class FaceCycle")]
    row_start = html.index('data-id="tools-drawer"')
    row_end = html.index('data-id="repaint-drawer"')
    row = html[row_start:row_end]
    assert 'data-id="gen-strip"' in row, "gen strip must live inside the tools drawer row"
    # 2026-10-21: the vestigial 'Edit layer' toggle is gone; the strip follows undo
    assert row.index('data-act="undo"') < row.index('data-id="gen-strip"')
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
           "randomize-seed", "detail-crop", "variant-count", "gen-strip", "repaint-source"]
OLD_ACTS = ["detect", "click-add", "layer-toggle", "draw-box", "draw-mask", "erase", "apply-mask", "remove-all",
            "generate", "keep", "discard", "undo", "zoom-fit"]


def _fc_html():
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    return src, src[src.index("function panelHTML"):src.index("export class FaceCycle")]


def test_task7_every_control_keeps_its_id_and_lives_in_the_right_surface():
    """Revised 2026-10-16f: two surfaces — main band (ONE tools-drawer row) and
    the repaint drawer (in-flow, offsets canvas). Detect is retired: no sheet
    markup, no detect/click-add controls; its diff sliders moved to the tools row.
    Every surviving data-id/data-act appears exactly once."""
    src, html = _fc_html()
    band = html[html.index('data-id="tools-drawer"'):html.index('data-id="repaint-drawer"')]
    rep = html[html.index('data-id="repaint-drawer"'):html.index('<div class="fc-canvas-wrap"')]
    for i in OLD_IDS + ["zoom-slider", "zoom-val"]:
        if i in ("face-mode",):
            continue
        assert html.count(f'data-id="{i}"') == 1, i
    for a in OLD_ACTS:
        if a in ("detect", "click-add", "open-detect", "sheet-close", "layer-toggle"):
            assert html.count(f'data-act="{a}"') == 0, a
            continue
        assert html.count(f'data-act="{a}"') == 1, a
    # tools drawer is ONE row: draw tools, erase/brush, undo, Generate, keep/discard,
    # layers, zoom — plus the diff sliders (retired from the Detect sheet)
    for x in ('data-act="draw-box"', 'data-act="draw-mask"', 'data-act="erase"', 'data-act="apply-mask"',
              'data-id="brush-controls"', 'data-act="undo"', 'data-act="generate"',
              'data-act="keep"', 'data-act="discard"',
              'data-id="threshold"', 'data-id="min-size"', 'data-id="max-size"'):
        assert x in band, x
    assert band.count('<div class="fc-row oneline"') == 1, "tools drawer must be a single row"
    # 2026-10-20 rev 23:25: compact single line on wide screens, but it WRAPS
    # when narrow — no horizontal scrollbar (vertical space over scrolling).
    rule = src[src.index(".fc-row.oneline {"):].split("}", 1)[0]
    assert "flex-wrap: wrap" in rule and "nowrap" not in rule, "tools row must wrap"
    assert "overflow-x" not in rule, "tools row must not scroll sideways"
    # repaint drawer wears the same panel treatment as the Tools bar (header)
    rp = src[src.index('.fc-drawer.fc-repaint:not([hidden])'):].split("}", 1)[0]
    assert "#161628" in rp and "#2a2a44" in rp, "repaint drawer needs the tools-bar border"
    assert 'class="fc-drawer fc-repaint" data-id="repaint-drawer"' in src
    # repaint drawer: prompt + repaint options + its own Generate (same handler)
    for x in ('data-id="repaint-prompt"', 'data-id="denoise"', 'data-id="seed-input"',
              'data-id="randomize-seed"', 'data-id="detail-crop"',
              'data-id="variant-count"', 'data-id="repaint-source"', 'data-act="generate-sheet"'):
        assert x in rep, x
    # Detect UI is fully retired
    assert 'data-sheet=' not in html and 'sheet-backdrop' not in html


def test_task7_sheets_never_touch_canvas_state_and_shortcuts_survive():
    """Revised 2026-10-16f: sheets replaced by in-flow drawers. The drawer toggle
    contract (hidden + aria only) plus shortcut/generator invariants survive."""
    src, html = _fc_html()
    ctl = (HERE.parent / "frontend" / "js" / "modules" / "facecycle-sheets.js").read_text()
    for forbidden in ("render(", "resetAll", "ensureOverlay", "setSize", "processImages",
                      "undoLog", "activeRegions", "stack"):
        assert forbidden not in ctl, f"sheet controller must not touch {forbidden}"
    # drawer toggles never touch canvas state: hidden flip + aria only
    assert "drawer.hidden = !open;" in src
    assert "btn.setAttribute('aria-expanded', String(open))" in src
    assert src.count("this.toggleDrawer(") == 3   # tools, thumbs, repaint
    # shortcuts untouched (B/M still wired at document level; F retired with detect)
    for k in ("e.key === 'b'", "e.key === 'm'"):
        assert k in src
    assert "e.key === 'f'" not in src and "toggleClickToAdd" not in src
    # drawer Generate + Enter use the one generateRepaint handler
    assert src.count("this.generateRepaint()") >= 3
    # repaint drawer is in-flow (offsets the canvas), not fixed overlay
    assert 'data-id="repaint-drawer" hidden' in html
    assert "position:fixed" not in html[html.index('data-id="repaint-drawer"') - 2000:html.index('data-id="repaint-drawer"')]


# ------------------------------------------------------- drawers + receipt (2026-10-16c)
def test_facecycle_drawers_default_closed_and_only_flip_hidden():
    """Tools + media drawers: wrappers hidden by default; the toggle handler only
    flips the hidden attribute + aria state — no canvas/region/undo contact."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    html = src[src.index("function panelHTML"):src.index("export class FaceCycle")]
    assert 'data-id="tools-drawer" hidden' in html
    assert 'data-id="thumbs-drawer" hidden' in html
    for act in ('data-act="toggle-tools"', 'data-act="toggle-thumbs"'):
        assert html.count(act) == 1, act
    # toggle handler contract: hidden flip + aria only
    assert "drawer.hidden = !open;" in src
    assert "btn.setAttribute('aria-expanded', String(open))" in src
    # replace sources moved to the top row, tinted, no warning bar
    assert 'data-act="replace-sources"' in html[:html.index('data-group="controls"')]
    assert 'class="ee-btn warn"' in html
    assert "fc-replace-bar" not in src and "replace-msg" not in src


def test_facecycle_handoff_receipt_survives_status_rerender():
    """The middle-ellipsized filename receipt (2026-10-15) is stored on the
    instance and re-rendered by updateStatusBar instead of being overwritten."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    assert "this.handoffReceipt = { src, list, full" in src
    us = src[src.index("updateStatusBar() {"):]
    assert "const receipt = this.handoffReceipt" in us
    assert us.count("+ receipt;") == 2          # both branches re-attach it
    assert src.count("this.handoffReceipt = null;") == 1   # fresh stack clears it


def test_detect_method_fully_removed():
    """Work order 2026-10-20 item 2: no face-api, no detect/click-add code paths."""
    src, _ = _fc_html()
    for gone in ("faceapi", "face-api", "loadFaceModels", "detectFaces", "detectFaceAtPoint",
                 "clickToAddMode", "detectBtn", "clickAddBtn", "rectOverlap"):
        assert gone not in src, gone


def test_death_row_ui_fully_torn_down():
    """Work order 2026-10-20 item 5: backend retired death-row rehydration
    (fae8757), so the dead UI is gone. The /death-row/dismiss endpoint and the
    ledger stay (backend untouched). Straggler '✓ in Library' chips share the
    .ghost-chip class and are LIVE — they must survive."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    assert not (mods / "death-row.js").exists()
    src = (mods / "dupe.js").read_text()
    for gone in ("death-row", "dupe-deathbar", "dupe-death-", "dismiss-zero",
                 "Dismiss all with no files", "rehydrate", "rehydrated",
                 "queueCounts", "paintDeathBar", "dismissRows", "dr-section",
                 "include_archived", "dupe-archived", "ghost-chip gone"):
        assert gone not in src, gone
    # live straggler chips + their CSS are untouched
    assert ".ghost-chip.lib" in src and ".ghost-chip.straggler" in src
    assert "stragglerChips(f)" in src
    # the precache/shell never referenced the removed module
    for name in ("sw.js",):
        assert "death-row" not in (HERE.parent / "frontend" / name).read_text()


def test_paint_target_workflow_wiring():
    """F2b (2026-10-21): explicit apply — Enter and a button share ONE handler;
    cycling keys act on the mask-edit region; the gen strip highlights by the
    renderer's convention (gsel -1 = a photo layer is showing)."""
    src, html = _fc_html()
    assert html.count('data-act="apply-mask"') == 1
    assert src.count("this.applyMaskToTarget()") >= 2        # Enter + button
    assert "this.maskEditRegion() ??" in src                   # [ ] target the edited region
    assert "(i === (region.gsel ?? -1) ? ' current' : '')" in src
    assert "region.gsel ?? 0)" not in src, "strip highlight must not default to gen 0"
    # the live preview is display-only: it is gated on !opts.exporting
    assert "!opts.exporting && this.maskEditId === region.id" in src


# ------------------------------------------------------- Puppet Theater (2026-10-22)
def test_js_puppet_core():
    """Pure logic: transform math, z-order, mask compositing, denoise fence."""
    r = subprocess.run(
        ["node", "--test", str(HERE / "js" / "puppet-core.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "fail 0" in r.stdout


def test_puppet_module_wiring_and_fence():
    """Shell imports the module (build marker NOT bumped by the builder —
    the operator bumps on landing); the module registers as a stage with a
    mask tool and a fenced final pass, and never ships a d0.8 default."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    src = (mods / "puppet.js").read_text()
    core = (mods / "puppet-core.js").read_text()
    shell = (HERE.parent / "frontend" / "js" / "shell.js").read_text()
    assert "modules/puppet.js" in shell
    assert "name: 'puppet'" in src and "registerModule" in src
    for needle in ('data-id="stage"', 'data-id="llist"', 'data-tool="erase"',
                   'data-tool="restore"', 'data-id="render"', 'data-id="expng"',
                   'data-id="exjson"', 'data-id="pvaccept"', 'data-id="pvdiscard"',
                   "/rmbg", "clampDenoise"):
        assert needle in src, needle
    assert "DENOISE_MIN = 0.2" in core and "DENOISE_MAX = 0.8" in core
    assert 'min="0.4" max="0.5"' in src          # the slider itself is fenced
    assert (mods / "puppet.css").exists()


def test_puppet_v11_fill_area_and_cutout_wiring():
    """v1.1 (WORKORDER puppet-render-mask): the Fill Area step, the render
    mode choice, per-layer Cut Out/Restore, and the Amendment A/C plumbing
    must all be wired in the module — and the drop path must NOT call rmbg
    anymore (Amendment D1: drops place the original immediately)."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    src = (mods / "puppet.js").read_text()
    core = (mods / "puppet-core.js").read_text()
    for needle in ('data-step="fill"', 'data-id="fillclear"', 'data-id="fillov"',
                   'data-rmode="fill"', 'data-rmode="all"', 'data-id="rmnote"',
                   'data-id="dropind"', 'Cut Out', 'Restore',
                   'rendermask', 'planRestore', 'runRestore', 'loadImageDecoded',
                   'setBusy', 'mode: renderMode', 'mask_used'):
        assert needle in src, needle
    for needle in ('planRestore', 'runRestore', 'grayMaskIsEmpty',
                   'resolveRenderMask', 'rendermask', 'cutout'):
        assert needle in core, needle
    # the drop path is originals-only now: addPuppetFile must not await rmbg
    add_fn = src.split('async function addPuppetFile')[1].split('async function addPuppetFiles')[0]
    assert 'rmbg(' not in add_fn
    assert 'fileToDataURL' in add_fn
    # rmbg survives exactly where Amendment D puts it: the Cut Out action
    cut_fn = src.split('async function cutOut')[1].split('function restoreCut')[0]
    assert 'rmbg(' in cut_fn and 'cutPending' in cut_fn
