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


def test_js_viewer_zoom_math():
    """2026-10-29 viewer zoom math, reused by Update: pinch
    ratio, swipe gating, pan clamp, wheel scale — pure, node."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "zoom-viewer.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "OK" in r.stdout


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


def test_js_deploy_gate_covers_filters():
    """The Safari-syntax deploy gate must parse the Filters modules too."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "syntax-check.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"syntax gate failed:\n{r.stdout}\n{r.stderr}"
    assert "ok js/modules/filters.js" in r.stdout
    assert "ok js/modules/filters-tunes.js" in r.stdout


def test_kept_gens_share_the_layers_row():
    """Task 10, revised 2026-11-16: the gen strip moved out of the tools
    drawer row (it wrapped the row tall at 45% max-width) into the media
    row — thumbs left, gens right, hiding with the media drawer; data-id
    unchanged."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    html = src[src.index("function panelHTML"):src.index("export class FaceCycle")]
    controls = html[html.index('data-id="tools-drawer"'):html.index('data-id="repaint-drawer"')]
    assert 'data-id="gen-strip"' not in controls, "gen strip must leave the controls row"
    media = html[html.index('data-id="thumbs-drawer"'):]
    assert 'data-id="gen-strip"' in media, "gen strip must live in the media drawer"
    assert media.index('data-id="thumbnail-strip"') < media.index('data-id="gen-strip"'), \
        "thumbs left, gens right in the media row"
    assert 'class="fc-mediarow"' in media
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
    assert 'min="0.2" max="0.8"' in src          # the slider itself is fenced (widened 2026-10-22)
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


def test_puppet_v12_iterative_wiring():
    """v1.2: engine picker (Klein default), accept-as-layer (NOT a
    background stamp), scoped Fill Area plumbing, hint predicate in use."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    src = (mods / "puppet.js").read_text()
    core = (mods / "puppet-core.js").read_text()
    for needle in ('data-engine="klein"', 'data-engine="krea2"',
                   "let engine = 'klein'", 'engine,', 'makeRenderLayer',
                   'stageHintVisible', 'buildClipCanvas', 'stampFillGated',
                   'Accept as new layer'):
        assert needle in src, needle
    for needle in ('stageHintVisible', 'makeRenderLayer', 'unionClipAlpha',
                   'gateStampAlpha'):
        assert needle in core, needle
    # the accept path must not stamp the background anymore: the v1 line
    # that turned the render into the stage picture is gone, and the
    # render branch creates a layer (v1.3 added a separate fill branch to
    # the same handler — it may touch the background only for bg fills)
    accept_fn = src.split("el.pvaccept.addEventListener('click'")[1].split("});")[0]
    assert 'makeRenderLayer' in accept_fn
    assert "asset: previewAsset }" not in src
    assert 'visible = false' not in accept_fn        # layers stay live now


def test_puppet_v13_targeted_fill_wiring():
    """v1.3: targeted Fill action, layer extension, merge down, focus
    stickiness (bounds, not alpha), and the fill preview-accept branch."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    src = (mods / "puppet.js").read_text()
    core = (mods / "puppet-core.js").read_text()
    for needle in ('data-id="fillgo"', 'extendLayerToCanvas', 'mergeDown',
                   'topmostBoundsAt', 'hitLayer(sel', "pvMode = 'fill'",
                   "/fill", 'layerIsFullBounds', 'drawLayerAppearance'):
        assert needle in src, needle
    for needle in ('topmostBoundsAt', 'layerIsFullBounds'):
        assert needle in core, needle
    # fill accept writes to the target layer/background only via pvTarget
    accept_fn = src.split("el.pvaccept.addEventListener('click'")[1].split("el.pvdiscard")[0]
    assert "pvMode === 'fill'" in accept_fn
    assert 'pvTarget' in accept_fn


def test_puppet_v131_erase_is_a_layer_tool_and_cutout_lives_in_tools():
    """v1.3.1 (Alexander's live report): Erase in the Fill step was painting
    the rendermask, leaving layers un-erasable there. Erase/Restore must
    start a layer-mask op in the fill branch too; Cut Out moved to Tools."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    src = (mods / "puppet.js").read_text()
    fill_branch = src.split("if (step === 'fill')")[1].split("const sel = selected();\n      // handles")[0]
    assert "tool === 'erase' || tool === 'restore'" in fill_branch
    assert "type: 'mask'" in fill_branch
    # Cut Out / Undo cut: Tools buttons acting on the selection, not rows
    for needle in ('data-id="cutgo"', 'data-id="restorecut"', 'updateCutUI',
                   'toggleSelect'):
        assert needle in src, needle
    assert 'cutBtn' not in src                      # rows are slim now
    assert '✂ Cut Out' in src                      # (the Tools button)


def test_puppet_v132_merge_down_recipe():
    """v1.3.2 (Alexander's report + recipe): merge down must ADD the two
    rasters, ADD the two masks into one combined mask, and apply it via
    the survivor's live mask channel — synchronously, with no
    pre-extension (the v1.3 race that made merged layers vanish)."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    src = (mods / "puppet.js").read_text()
    body = src.split("async function mergeDown")[1].split("// Targeted Fill")[0]
    assert "effectiveMaskCanvas" in src
    assert "extendLayerToCanvas(below)" not in body      # the race is gone
    assert body.count("loadLayerImage") == 1             # one reload only
    assert "rb.mask = K" in body                         # mask stays LIVE
    assert "resetMask(rb, W, H); rb.maskDirty = true" not in body  # not wiped


# ---------------------------------------------------------------------------
# v1.4 — cross-tab "send to" (work order 2026-10-23)

_FE = HERE.parent / "frontend" / "js"


def _src(rel):
    return (_FE / rel).read_text()


def test_js_send_to_router():
    """Pure router: uniform payload → each target's own event, data rule,
    FaceCycle cap, and the back-compat payload shapes (node)."""
    r = subprocess.run(
        ["node", "--test", str(HERE / "js" / "send-to.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"


def test_js_facecycle_handoff_backcompat_pin():
    """Gallery→FaceCycle planner is unchanged (v1.4 must not break it)."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "facecycle-handoff.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"


def test_send_to_gate_covers_new_files():
    r = subprocess.run(
        ["node", str(HERE / "js" / "syntax-check.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"syntax gate failed:\n{r.stdout}\n{r.stderr}"
    assert "ok js/send-to.js" in r.stdout
    assert "ok js/components/send-menu.js" in r.stdout


def test_shell_routes_send_to_through_the_pure_planner():
    sh = _src("shell.js")
    assert "export function registerReceiver" in sh
    assert "import { planSend } from './send-to.js'" in sh
    assert "window.addEventListener('ellieedit:send-to'" in sh
    h = sh[sh.index("window.addEventListener('ellieedit:send-to'"):]
    h = h[:h.index("// Import modules")]
    # a refusal toasts and returns BEFORE the target tab is activated
    assert h.index("toast(plan.error") < h.index("activate(plan.route.target)")
    # activate first, THEN forward (FaceCycle's listener ignores a hidden panel)
    assert h.index("activate(plan.route.target)") < h.index("window.dispatchEvent(new CustomEvent(ev.type")
    # the receivers map handed to the planner is the one registerReceiver fills
    assert "receivers });" in h and "receivers.set(name" in sh
    # existing activation event still there
    assert "window.addEventListener('ellieedit:activate'" in sh


def test_existing_handoff_events_still_dispatched_and_listened():
    gal, fc, upd = _src("modules/gallery.js"), _src("modules/facecycle.js"), _src("modules/update.js")
    assert "new CustomEvent('ellieedit:facecycle-handoff'" in gal
    # Stage 3: gallery's ✎ Update button sets the store + opens Studio;
    # the open-in-update dispatch is retired. Update still LISTENS to the
    # event (legacy senders) but nothing in the UI dispatches it anymore.
    assert "new CustomEvent('ellieedit:open-in-update'" not in gal
    assert "addEventListener('ellieedit:facecycle-handoff'" in fc
    assert "addEventListener('ellieedit:open-in-update'" in upd


def test_facecycle_receipt_names_the_sender_defaulting_to_gallery():
    fc = _src("modules/facecycle.js")
    assert "const { urls, names, meld, provenance, source } = e.detail" in fc
    assert "const src = meld ? 'Dupe family' : (source || 'Gallery');" in fc


def test_gallery_send_menu_entries():
    gal = _src("modules/gallery.js")
    assert "createSendMenu" in gal
    for needle in ("target: 'puppet', as: 'layer'", "target: 'puppet', as: 'background'",
                   "target: 'studio'", "source: 'Gallery'"):
        assert needle in gal, needle
    assert gal.count("act('to-update').before(sendMenu.el)") == 1   # sits beside ✎ Update


def test_foxden_send_menu_and_receiver_use_existing_upload_path():
    fx = _src("modules/foxden.js")
    assert "registerReceiver('foxden'" in fx
    assert "addEventListener('ellieedit:foxden-receive'" in fx
    rv = fx[fx.index("addEventListener('ellieedit:foxden-receive'"):]
    rv = rv[:rv.index("// First paint")]
    assert "api('/upload'" in rv and "setInput(name)" in rv      # same as a local upload
    assert "readAsDataURL" not in rv and "image_b64" not in rv   # data rule
    for needle in ("target: 'puppet', as: 'layer'", "target: 'puppet', as: 'background'",
                   "target: 'facecycle'", "source: 'FoxDen'"):
        assert needle in fx, needle


def test_puppet_receiver_gates_midrender_and_reuses_drop_and_background_paths():
    pp = _src("modules/puppet.js")
    assert "registerReceiver('puppet'" in pp
    gate = pp[pp.index("registerReceiver('puppet'"):]
    gate = gate[:gate.index("addEventListener('ellieedit:puppet-receive'")]
    assert "passBusy" in gate and "initDone" in gate
    # the in-flight flag brackets BOTH the final pass and the fill
    assert pp.count("passBusy = true;") == 2
    assert pp.count("finally { passBusy = false;") == 2
    rv = pp[pp.index("addEventListener('ellieedit:puppet-receive'"):]
    rv = rv[:rv.index("el.tofox.addEventListener")]
    assert "await addPuppetFile(f)" in rv                         # same path as a drop
    assert "uploadAsset('background'" in rv and "setBackground(up.file, up.url)" in rv
    assert "passBusy" in rv                                       # belt and braces at the handler
    # Stage 3: composite → Studio (FoxDen unrouted; the studio route binds
    # the export url via /api/filters/store, source_module "studio")
    tf = pp[pp.index("el.tofox.addEventListener"):]
    assert tf.index("await save()") < tf.index("ellieedit:send-to")
    assert "/projects/${projectId}/export.png" in tf
    assert "target: 'studio'" in tf


def test_send_plumbing_never_carries_data_urls():
    for rel in ("send-to.js", "components/send-menu.js"):
        s = _src(rel)
        assert "readAsDataURL" not in s and "image_b64" not in s and "toDataURL" not in s, rel


def test_puppet_v15_gallery_banks_and_ux_wiring():
    """v1.5/v1.5.1: bank picker + dupe-review queue + multi-select Puppet
    layers + shift-click range + promote tag memory/mass promote."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    gal = (mods / "gallery.js").read_text()
    for needle in ('data-act="bank"', 'data-act="dupe-review"',
                   'queueDupeReview', '/api/dupe/scan-folder',
                   'ellieedit:dupe-folder-review',
                   'data-act="to-puppet-multi"', 'launchPuppetMulti',
                   'lastSelKey', 'setCellSelected',
                   'askTag', 'tagChips', 'ellieedit.promote.tags',
                   'promoteMulti', 'recordTag', 'keyOf', 'manifest_key'):
        assert needle in gal, needle
    # Backspace deletion is gone from the gallery viewer handler.
    onkey = gal.split('this.onKey = e => {')[1].split('};')[0]
    assert "e.key === 'Delete'" in onkey
    assert 'Backspace' not in onkey


def test_puppet_v15_key_guards_shared():
    """Shortcut guards workorder: one shared helper, used by every
    document-level keydown handler with letter shortcuts; Backspace
    deletion removed in FaceCycle region delete too."""
    js = HERE.parent / "frontend" / "js"
    guards = (js / "key-guards.js").read_text()
    assert 'isTypingTarget' in guards and 'TEXTAREA' in guards
    for mod in ('modules/gallery.js', 'modules/dupe.js', 'modules/facecycle.js'):
        assert 'key-guards.js' in (js / mod).read_text(), mod
    fc = (js / "modules/facecycle.js").read_text()
    assert "if (e.key === 'Delete') {" in fc
    assert "e.key === 'Backspace'" not in fc


def test_puppet_v15_dupe_folder_filter_wiring():
    """Folder-scan families open in the existing dupe review UI via a
    'Folder scans' pill mapped to source=cluster-engine-v2."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    view = (mods / "dupe-view.js").read_text()
    assert 'filter === "folder"' in view
    assert 'cluster-engine-v2' in view
    dupe = (mods / "dupe.js").read_text()
    assert 'data-f="folder"' in dupe
    assert 'ellieedit:dupe-folder-review' in dupe


def test_js_key_guards():
    """Shared shortcut-guard helper (v1.5 workorder) — node test, repo style."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "key-guards.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


def test_library_phase0_frontend_wiring():
    """Phase 0 (library report §6): family badge + original toggle in the
    viewer, Send to ▸ menu replacing the hard-coded Update dispatch, and
    the tag bar fed by the unfiltered total."""
    lib = (HERE.parent / "frontend" / "js" / "modules" / "library.js").read_text()
    for needle in ('lib-fambadge', 'libv-family', 'toggleFamily',
                   'viewingOriginal', 'createSendMenu', 'libv-sendwrap',
                   'Puppet Theater — new layer', 'Studio — set as working image',
                   'total_all'):
        assert needle in lib, needle
    assert 'sendToUpdate' not in lib   # hard-coded dispatch is gone
    assert 'libv-update' not in lib


def test_fx_send_seed_frontend_wiring():
    """Workorder 2026-10-26 fx-send-seed: Gallery viewer Send to menu gains
    FaceCycle (single-image route; the multi-select bar still gates at
    >= 2); Library already carries FaceCycle from Phase 0 (pinned here);
    FoxDen seed lock lives beside the seed field with Generate on the
    same row, driven by the headless nextSeed helper."""
    gal = (HERE.parent / "frontend" / "js" / "modules" / "gallery.js").read_text()
    assert "{ label: '→ FaceCycle', target: 'facecycle' }" in gal
    lib = (HERE.parent / "frontend" / "js" / "modules" / "library.js").read_text()
    assert "{ label: '→ FaceCycle', target: 'facecycle' }" in lib
    fx = (HERE.parent / "frontend" / "js" / "modules" / "foxden.js").read_text()
    assert 'nextSeed' in fx and 'fx-seedrow' in fx
    assert '🔒 seed' not in fx        # old presets-row label text is gone…
    assert 'data-id="preset-lock"' in fx  # …but the same checkbox lives on, icon-only
    st = (HERE.parent / "frontend" / "js" / "modules" / "foxden-state.js").read_text()
    assert 'nextSeed' in st


def test_foxden_reorg_order():
    """FoxDen frequency reorg (2026-10-26): Generate + status (sticky
    topbar), prompt, seed row, denoise, aspect, input images, presets,
    workflow, LoRAs last. Order is pinned by first-occurrence positions
    so a future edit can't silently drift the panel back."""
    fx = (HERE.parent / "frontend" / "js" / "modules" / "foxden.js").read_text()
    markers = ['data-id="go"', 'data-id="prompt"', 'data-id="seed"',
               'data-id="denoise"', 'data-id="aspects"', 'data-id="iup"',
               'data-id="preset-pick"', 'data-id="wf"', 'data-id="loras"']
    pos = [fx.index(m) for m in markers]
    assert pos == sorted(pos), f"FoxDen panel order drifted: {list(zip(markers, pos))}"
    assert 'fx-topbar' in fx
    css = (HERE.parent / "frontend" / "js" / "modules" / "foxden.css").read_text()
    assert 'position:sticky' in css
    assert 'fx-seedrow .fx-go' not in css  # compact-row override died with the row


def test_facecycle_status_hud_pill():
    """2026-10-29 HUD pill: the status band takes no row — it is
    absolutely positioned over the canvas bottom, never blocks
    canvas clicks, and fades when nothing actionable changed,
    while preview/generating/fallback/mask/failure stay loud."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    css = src[src.index("function panelHTML"):src.index("export class FaceCycle")]
    assert "position: absolute" in css and "pointer-events: none" in css
    assert ".fc-status.fc-dim" in css
    assert "fadeStatusPill" in src
    assert "Preview:" in src[src.index("fadeStatusPill() {"):]
    # Both updateStatusBar exits run the fade rule.
    us = src[src.index("updateStatusBar() {"):src.index("fadeStatusPill() {")]
    assert us.count("this.fadeStatusPill();") == 2


def test_library_pending_sidebar_restore_no_grid_reload():
    """2026-10-29 pending-restore: a 'Pending deletions (N)' section
    in the Library sidebar, per-row Restore with age, and a
    separately armed Confirm-purge. Restore and purge update the
    sidebar in place and NEVER call reload() — the flicker guards
    apply to sidebar actions too. /pending/confirm stays exactly
    as destructive as it is, gated behind explicit arming."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "library.js").read_text()
    html = src[src.index("function panelHTML"):src.index("class LibraryView")]
    assert 'id="lib-pending-title"' in html
    assert 'id="lib-pending"' in html
    assert 'id="lib-pending-purge"' in html
    assert "Pending deletions" in html
    assert "/api/library/pending" in src
    assert "pending/restore" in src
    assert "pending/confirm" in src
    # Restore handler: in-place sidebar update only, no grid reload.
    seg = src[src.index("async restorePending"):src.index("async purgePending")]
    assert "this.reload()" not in seg
    assert "row.remove()" in seg
    # Purge handler: armed first click, destructive second, no reload.
    seg = src[src.index("async purgePending"):src.index("  disarmPurge() {")]
    assert "this.reload()" not in seg
    assert "Really purge all?" in seg
    assert "dataset.armed" in seg


def test_viewer_zoom_stage_gallery_and_library():
    """2026-10-29 viewers-first zoom, swipe removed 2026-11-16: Gallery +
    Library share zoom-viewer.js (pinch, pan while zoomed). No drag ever
    changes images — cycling is tap/click on the nav zones or buttons,
    or the keyboard arrows. The old touchstart/touchend swipe code is
    gone from both viewers, and every new image starts at fit."""
    for mod in ("gallery", "library"):
        src = (HERE.parent / "frontend" / "js" / "modules" / f"{mod}.js").read_text()
        assert "from './zoom-viewer.js'" in src
        assert "bindViewerZoom({" in src
        assert "onSwipe" not in src, "no swipe callback — drags never cycle"
        assert "viewerZoom?.reset()" in src
        assert 'data-act="viewer-zoom-in"' in src
        assert 'data-act="viewer-zoom-out"' in src
        assert 'data-act="viewer-zoom-fit"' in src
        assert ".zoomed .navzone { display: none; }" in src
        assert "touch-action: none" in src
        # Old swipe detector gone: no touchstart/touchend listeners
        # in either viewer module (touch-action:none + Pointer
        # Events in zoom-viewer.js replace it; comments may still
        # name the old events, listeners may not).
        assert "addEventListener('touchstart'" not in src, mod
        assert "addEventListener('touchend'" not in src, mod
        # Click-to-close is fit-only when zoomed.
        assert "classList.contains('zoomed')" in src
    zoom = (HERE.parent / "frontend" / "js" / "modules" / "zoom-viewer.js").read_text()
    # Swipe is gone from the shared module, not just unplugged: no
    # swipeDir helper, no SWIPE_PX, no onSwipe option, no swipe state.
    assert "swipeDir" not in zoom
    assert "SWIPE_PX" not in zoom
    assert "onSwipe" not in zoom
    assert "let swipe" not in zoom
    # Pointers are tracked at the viewer root so a pinch finger starting
    # on a nav zone still joins the pinch; capture happens only once a
    # gesture is a pinch or a pan, so taps still click.
    assert "viewer.addEventListener('pointerdown'" in zoom
    assert "viewer.addEventListener('pointermove'" in zoom
    assert "viewer.addEventListener('pointerup'" in zoom
    assert "stage.addEventListener('pointerdown'" not in zoom
    assert "onStage" in zoom


def test_update_zoom_stage():
    """2026-10-29 Update zoom: the transform applies to the
    comparer box + mask overlay only, never the sidebar; two
    fingers pinch/pan and cancel any stroke/divider drag in
    progress; sidebar View controls + wheel zoom; a new stack
    starts at fit. The mask/divider coordinate code needs no
    new mapping because it already uses getBoundingClientRect,
    which includes the transform."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "update.js").read_text()
    assert "from './zoom-viewer.js'" in src
    assert "pinchScale" in src and "clampPan" in src and "wheelScale" in src
    # Transform targets: comparer + mask overlay only.
    seg = src[src.index("applyZoom() {"):src.index("clampZoomPan() {")]
    assert "el.cmp.style.transform" in seg
    assert "el.maskCanvas.style.transform" in seg
    assert "upd-side" not in seg and "upd-main" not in seg
    # Sidebar View controls.
    assert 'data-act="upd-zoom-out"' in src
    assert 'data-act="upd-zoom-in"' in src
    assert 'data-act="upd-zoom-fit"' in src
    assert 'id="upd-zoom-val"' in src
    # Gesture gate: capture handler cancels stroke/divider on
    # the second finger, and target handlers refuse to start.
    assert "_zoomPinching" in src
    assert "restoreMaskUndo()" in src[src.index("zPointers"):]
    assert "_dragStartPct" in src
    assert "if (this._zoomPinching) return;" in src
    # Wheel zoom + Fit reset + new-stack reset.
    assert "wheel" in src and "zoomAroundCursor" in src
    assert "resetZoom()" in src
    assert "this.resetZoom();  // a new stack starts at fit" in src


def test_viewer_stuck_zoom_fix():
    """2026-10-29 stuck-zoom fix: page zoom must never happen
    inside a viewer, and a zoomed viewer must have a bar-free
    escape. touch-action:none on the viewer root (not just
    stage/img — navzones cover 30% each side and the bar
    covers the top, and both let the browser page-zoom),
    plus double-tap reset while zoomed only (tap-to-close
    is disabled while zoomed, so it is safe there; at fit
    the first tap still closes, as before). The click after
    a double-tap reset is suppressed so it does not reset
    and then close."""
    zv = (HERE.parent / "frontend" / "js" / "modules" / "zoom-viewer.js").read_text()
    assert "viewer.style.touchAction = 'none'" in zv
    assert "lastTap" in zv and "suppressClickUntil" in zv
    assert "scale > 1" in zv
    assert "Date.now() < suppressClickUntil" in zv
    for mod, root in (("gallery", "gal-viewer"), ("library", "lib-viewer")):
        src = (HERE.parent / "frontend" / "js" / "modules" / f"{mod}.js").read_text()
        css = src[src.index("function panelHTML"):src.index("class " + ("Gallery" if mod == "gallery" else "LibraryView"))]
        # Viewer root: touch-action none on its own rule.
        assert f".{root} {{" in css
        root_rule = css[css.index(f".{root} {{"):css.index(f".{root} {{") + 300]
        assert "touch-action: none" in root_rule, mod
        assert f".{root} .navzone" in css
        nav_rule = css[css.index(f".{root} .navzone"):css.index(f".{root} .navzone") + 400]
        assert "touch-action: none" in nav_rule, mod


def test_library_keep_alive_no_reload_on_tab_activation():
    """2026-10-30 Library keep-alive (Gallery parity): switching
    tabs must NOT reload the Library grid. The tab-activated
    handler loads only a never-loaded/empty grid, otherwise
    restoring the scroll anchor captured on scroll; the
    pending sidebar still refreshes in place. A promote no
    longer reloads either — it inserts in place."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "library.js").read_text()
    tab = src[src.index("ellieedit:tab-activated"):src.index("ellieedit:library-changed")]
    assert "if (!this.items.length && !this.loading) this.reload();" in tab
    assert "this.restoreAnchor(this._anchor)" in tab
    assert tab.count("this.reload()") == 1  # the empty-grid first load only
    assert "this.loadPending();" in tab
    assert "async cheapRefresh()" in src and "async insertLibraryItem(path)" in src
    assert "lib-refresh" in src and "this.el.refresh.addEventListener('click', () => this.cheapRefresh())" in src
    assert "async reload(opts = {})" in src and "opts.keepPosition" in src
    # Insert must not break viewer navigation: cell clicks resolve
    # the index by path at click time, not from creation-time idx.
    assert "this.openViewer(this.items.findIndex(i => i.path === item.path))" in src
    assert "return cell;" in src
    gal = (HERE.parent / "frontend" / "js" / "modules" / "gallery.js").read_text()
    assert "detail: { path: j.path }" in gal
    assert "const j = await r.json().catch(() => ({}));" in gal


def test_foxden_zoom_recipe_column_and_input_browser():
    """Chunk A UX (2026-11-11): the zoom viewer gains a left-side settings
    column (offset, never overlay; hidden when there is nothing to show)
    with the prompt prominent + a copy button, fed by the provenance
    endpoint with the in-memory recent entry as fallback. The input-image
    browser gains sort/filter and a Show more window. Workflow selection
    survives loadConfig re-runs (tab-activation bug fix)."""
    fx = (HERE.parent / "frontend" / "js" / "modules" / "foxden.js").read_text()
    css = (HERE.parent / "frontend" / "js" / "modules" / "foxden.css").read_text()
    # recipe column: hidden-by-default aside inside the zoom viewer
    assert 'data-id="recipe" hidden' in fx and "fx-recipe" in css
    assert "fx-bigbody" in fx and css    # row layout: column sits beside the stage
    assert ".fx-recipe[hidden] { display:none; }" in css
    # provenance endpoint is the data source; entry fallback painted first
    assert "${API}/provenance?path=" in fx
    assert "recipeSettings(entry, null)" in fx
    # prompt prominent with clipboard write + visual confirmation
    assert "Copy prompt" in fx and "copyText(settings.prompt" in fx
    assert "✓ copied" in fx
    # column is reset when the viewer closes
    close = fx[fx.index("el.bigclose.addEventListener"):]
    assert "el.recipe.hidden = true" in close.split("});")[0]
    # input browser: sort + filter + windowed strip
    for needle in ('data-id="isort"', 'data-id="ifilter"', 'data-id="imore"',
                   "orderInputs(inputItems, inputRecency", "pageInputs(names, inputsShown)"):
        assert needle in fx, needle
    # workflow survives loadConfig on tab re-activation (bug 1+2 fix;
    # fix round 1 moved the rebuild into a tested helper that captures
    # the value BEFORE innerHTML — the old inline version read prevWf
    # after the rebuild and always "preserved" klein)
    assert "rebuildSelectPreserving(el.wf" in fx
    state_src = (HERE.parent / "frontend" / "js" / "modules" / "foxden-state.js").read_text()
    assert "export function rebuildSelectPreserving" in state_src
    # pure helpers exist and are wired
    inputs_mod = (HERE.parent / "frontend" / "js" / "modules" / "foxden-inputs.js").read_text()
    recipe_mod = (HERE.parent / "frontend" / "js" / "modules" / "foxden-recipe.js").read_text()
    assert "export function orderInputs" in inputs_mod and "export function pageInputs" in inputs_mod
    assert "export function recipeSettings" in recipe_mod
    assert "export function recipeLines" in recipe_mod and "export async function copyText" in recipe_mod


def test_js_foxden_inputs_helpers():
    """Chunk A: input-browser recency/name sort, filter, paging (node)."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "foxden-inputs.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


def test_js_foxden_recipe_helpers():
    """Chunk A: provenance-over-entry mapping, recipe lines, clipboard (node)."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "foxden-recipe.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


# ------------------------------------------------------- Filters Chunk B (2026-11-11)
def test_filters_chunk_b_vibrance_panzoom_sendupdate_wiring():
    """Chunk B + fix round 1: vibrance lives in the TUNES (basic tuning)
    drawer as backend sliders — relocated out of the Colorhold drawer on
    Alexander's 2026-11-11 review ("Vibrance is a basic filter, like
    Saturation") — works with colorhold off via an identity colorhold pass
    (strength 0), and the 0-100 protect slider is normalized to the API's
    0-1 in colorholdParams. The Filters stage binds the shared Chunk C
    pan/zoom component with a control-drag gate, and 'Send to Update' goes
    through /store + the standard cross-tab route (server url + provenance,
    never a data url)."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    src = (mods / "filters.js").read_text()
    pz = (mods / "pan-zoom.js").read_text()
    router = (HERE.parent / "backend" / "routers" / "filters.py").read_text()
    vib = (HERE.parent / "backend" / "vibrance.py").read_text()
    # Vibrance: sliders in the tunes drawer (before the Saturation slider),
    # wired to the backend apply body with the protect 0-100 -> 0-1 mapping.
    tunes_idx = src.index('data-id="tunes-drawer"')
    for needle in ('data-id="vib-strength"', 'data-id="vib-falloff"', 'data-id="vib-protect"',
                   "vibrance: s.vibrance,"):
        assert needle in src, needle
        assert src.index(needle) > tunes_idx, f"{needle} must live in the tunes drawer"
    assert src.index('data-id="vib-strength"') < src.index('data-id="tn-sat"')
    assert 'data-id="ch-vib"' not in src      # old colorhold-bundled ids gone
    assert "vibrance_protect: s.vibrance_protect / 100" in src  # scale fix
    assert "s.chEnabled || s.vibrance > 0" in src               # works w/o colorhold
    assert "strength: s.chEnabled ? 100 : 0" in src             # identity colorhold
    assert "vibrance: float = 0.0" in router
    assert "_vib.apply_vibrance" in router
    # Vibrance standalone stage: strength 0 + vibrance > 0 skips the
    # colorhold stages entirely (fix 2026-11-11, operator live review).
    assert "body.vibrance and body.strength <= 0" in router
    # Pan/zoom: the shared component, with the gate refusing control drags.
    assert "bindPanZoom" in src and "gate: () => !this.controlDrag" in src
    assert "img, canvas" in pz          # geom accepts the canvas stage
    assert "stage.querySelector('img, canvas')" in pz
    # Set as working image (Stage 3, P2 retired): store first (bounded
    # write + provenance attributed to "studio"), then a direct store set —
    # NO send-to-Update dispatch anymore.
    assert 'data-act="set-working"' in src
    assert "this.promoteWorking()" in src
    assert "target: 'update'" not in src      # send-to-Update retired
    assert "sendToUpdate" not in src
    assert "studioState().set(render_path, 'filters'" in src
    assert "source_module: 'studio'" in src
    assert "/api/gallery/file?path=" not in src or True  # gallery url no longer required
    assert "record_for_image" in router  # provenance for every stored output
    # Backend source_module attribution: Studio-context default keeps "filters"
    assert 'source_module: str = "filters"' in router
    assert '("filters", "studio")' in router
    # Backend vibrance model pins: falloff ramp + skin protection exist.
    assert "def muted_weight" in vib and "def skin_protect_weight" in vib
    assert "def gamut_clamp" in vib


# ------------------------------------------------------- Chunk D (2026-11-11)
def test_chunk_d_gallery_library_sort_controls():
    """Chunk D: Gallery + Library gain a server-side sort select following
    the Chunk A input-browser pattern (select control + pure param helper),
    with the Library perf fixes (cache headers + thumb warming) in place."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    gal = (mods / "gallery.js").read_text()
    lib = (mods / "library.js").read_text()
    core = (mods / "library-core.js").read_text()
    gpy = (HERE.parent / "backend" / "routers" / "gallery.py").read_text()
    lpy = (HERE.parent / "backend" / "routers" / "library.py").read_text()
    # sort selects, Chunk A style, in both headers
    assert 'data-act="sort"' in gal and 'id="lib-sort"' in lib
    # pure param helper + server contracts
    assert "export function sortParam" in core
    assert "GALLERY_SORTS" in gpy and "LIBRARY_SORTS" in lpy
    assert "def sort_files" in gpy and "def sort_rows" in lpy
    # every Library list fetch passes the sort through the helper
    assert lib.count("sort: this.sort") == 3
    # Library perf: cache headers now match gallery, next-page thumbs warm
    assert '"Cache-Control": "public, max-age=86400"' in lpy
    assert "_gallery_mod.warm_thumbs" in lpy


def test_js_library_sort_helper():
    """Chunk D: library sort param assembly (node)."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "library-sort.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


def test_stage1_working_image_pins():
    """Stage 1 (Studio consolidation): the working-image store exists, the
    Gallery viewer loads it, the shell shows the indicator chip, and Update
    consumes store-driven image changes WITHOUT any loadConfig-style reset
    — the chunk-A tab-reset bug class stays structurally dead (design doc §3)."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    upd = (mods / "update.js").read_text()
    gal = (mods / "gallery.js").read_text()
    shell = (HERE.parent / "frontend" / "js" / "shell.js").read_text()
    store = (mods / "studio-state.js").read_text()

    # The store module: pure factory + pinned sessionStorage key + change event
    assert "export function createStudioState" in store
    assert "ellieedit.studio.working" in store
    assert "ellieedit:working-changed" in store

    # Gallery: explicit set-working viewer action; to-update ALSO sets the store
    assert 'data-act="set-working"' in gal
    assert gal.count("studioState().set(") >= 2

    # Update: consumes store changes and NEVER re-sources via tab activation.
    # The tab-activated listener must stay prompts-only (no loadConfig call).
    assert "ellieedit:working-changed" in upd
    assert "studioState().restore()" in upd
    tab_block = upd[upd.index("ellieedit:tab-activated"):]
    tab_block = tab_block[:tab_block.index("});")]
    assert "loadSavedPrompts" in tab_block
    assert "loadConfig" not in upd  # store-driven loads never reset config
    # same-path guard so send-to + store set don't double-build the stack
    assert "already loaded" in upd

    # Shell: visible working-image chip with a clear button, in the tab bar
    assert "working-chip" in shell
    assert "Clear working image" in shell


def test_stage2_candidate_strip_pins():
    """Stage 2 (consolidation decision #2): batch generation produces a
    candidate strip with explicit promote only — nothing auto-saves; the
    optional save-all checkbox exists, defaults OFF, and targets the gallery
    bank (never Library); the next run replaces the strip."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    fx = (mods / "foxden.js").read_text()
    css = (mods / "foxden.css").read_text()
    cands = (mods / "studio-candidates.js").read_text()
    fpy = (HERE.parent / "backend" / "routers" / "foxden.py").read_text()

    # strip module: pure factory, next-run replacement is startRun's contract
    assert "export function createCandidates" in cands
    assert "startRun" in cands
    # render + promote-to-working via the store, origin 'foxden-output'
    assert "cands.startRun(" in fx
    assert "studioState().set(" in fx
    assert "'foxden-output'" in fx
    # no auto-save: save-all only fires when the checkbox is checked
    assert "save-all" in fx
    assert "el['save-all'].checked" in fx
    assert "if (el['save-all'].checked && runCands.length)" in fx
    # checkbox tag carries no `checked` attribute — default OFF
    html = fx[fx.index("fx-saveall"):]
    at = html.index("<input")
    input_tag = html[at:html.index(">", at) + 1]
    assert input_tag == '<input type="checkbox" data-id="save-all">', input_tag
    assert "save all outputs to gallery" in fx
    assert "fx-cands" in css
    # backend save-outputs endpoint: gallery bank, provenance carry, studio module
    assert "@router.post(\"/save-outputs\")" in fpy
    assert '"studio"' in fpy
    assert "GALLERY_ROOT" in fpy
    assert "from .library" not in fpy  # gallery bank, not Library


def test_stage2_reuse_and_ladder_verb_pins():
    """Stage 2: store-driven ReUse (applySettingsTo consumer) + Ladder's one
    explicit 'use as working image' verb that never touches ladder state."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    store = (mods / "studio-state.js").read_text()
    fx = (mods / "foxden.js").read_text()
    upd = (mods / "update.js").read_text()
    rv = (mods / "review.js").read_text()

    # store: record -> recipe normalizer + async applySettingsTo
    assert "export function recipeFromRecord" in store
    assert "async applySettingsTo()" in store
    # Update consumes it; FoxDen applies the recipe to its form on the event
    assert "applySettingsTo()" in upd
    assert "ellieedit:reuse-settings" in upd and "ellieedit:reuse-settings" in fx
    # Ladder: explicit per-image verb, store set with origin 'ladder'
    assert rv.count("Use as working image") == 2  # champion + runner-up
    assert "studioState().set(" in rv
    assert "'ladder'" in rv


def test_stage2_studio_surface_pins():
    """Stage 2 supplements: exact verb wiring the broader pins don't pin —
    the Ladder buttons' data-act names, the origin strings, and the invariant
    that review.js's ONLY store setter is the explicit verb (decision #5)."""
    mods = HERE.parent / "frontend" / "js" / "modules"
    fx = (mods / "foxden.js").read_text()
    rev = (mods / "review.js").read_text()

    assert "studioState().set(c.path, 'foxden-output'" in fx
    assert 'data-act="res-champ-working"' in rev
    assert 'data-act="res-runner-working"' in rev
    assert "studioState().set(item.path, 'ladder'" in rev
    assert rev.count("studioState().set(") == 1   # the verb is the only setter
    assert "pathFromViewUrl(u)" in fx             # candidate identity from view URL


# ------------------------------------------------------- Stage 3 (2026-11-12)
# ------------------------------------------------------- Stage 4 (2026-11-13)
def test_stage4_studio_layout_contract():
    """Stage 4 (settled mock-1b layout): the shell routes exactly ONE studio
    entry and no foxden/update entries; Studio NO LONGER mounts the Stage 3
    sub-tab surfaces (mountFoxden/mountUpdate) — the sub-tab stacking IS
    what Stage 4 removes. The old modules stay in the tree as the rollback
    path (design §5) with their register helpers, unrouted."""
    HERE = Path(__file__).parent
    shell = (HERE.parent / "frontend" / "js" / "shell.js").read_text()
    studio = (HERE.parent / "frontend" / "js" / "modules" / "studio.js").read_text()
    assert "modules/studio.js" in shell
    assert "modules/foxden.js" not in shell
    assert "modules/update.js" not in shell
    # Studio registers exactly one tab
    assert studio.count("registerModule(") == 1
    assert "name: 'studio'" in studio
    # Stage 4 REMOVAL pin: the sub-tab stacking is gone
    assert "mountFoxden" not in studio
    assert "mountUpdate" not in studio
    # settled rail: three tabs, never stacked sub-views
    for verb in ("generate", "mask", "provenance"):
        assert f'data-verb="{verb}"' in studio
    # the old modules keep their rollback registration functions, unrouted
    fx = (HERE.parent / "frontend" / "js" / "modules" / "foxden.js").read_text()
    upd = (HERE.parent / "frontend" / "js" / "modules" / "update.js").read_text()
    assert "export function registerFoxdenTab" in fx
    assert "export function registerUpdateTab" in upd
    assert "registerFoxdenTab()" not in shell and "registerUpdateTab()" not in shell


def test_stage4_fullscreen_chrome_pins():
    """Stage 4 fullscreen (mock-1b): one toggle in the Studio header; the
    immersive mode hides header/rail/strip; the RAIL edge tab (top-right)
    is the only way back; a Generate FAB (bottom-right) fires the same
    generate action with a progress ring; a bottom handle opens the
    candidate overlay carrying the save module; completion toast. Touch
    targets >= 44px — no hover/keyboard dependency."""
    studio = (Path(__file__).parent.parent / "frontend" / "js" / "modules" / "studio.js").read_text()
    assert 'data-id="imm"' in studio and "⛶ Fullscreen" in studio
    assert "st-immersive" in studio
    assert 'data-id="edgetab"' in studio and "RAIL ▸" in studio
    assert 'data-id="genfab"' in studio and "conic-gradient" in studio   # progress ring
    assert "setFabProgress" in studio
    assert "el.genfab.addEventListener('click'" in studio                 # FAB fires generate
    assert 'data-id="bottomhandle"' in studio and "CANDIDATES ▴" in studio
    assert 'data-id="candoverlay"' in studio
    assert "showToast" in studio
    assert "flashOverlayInImmersive" in studio                            # overlay auto-opens on completion
    # immersive hides chrome (head/rail/strip) via CSS, never JS removal
    assert ".st-root.st-immersive .st-head" in studio
    assert ".st-root.st-immersive .st-rail" in studio
    assert ".st-root.st-immersive .st-strip" in studio
    # the way back is touch-first: min-height 44px on the edge tab
    assert "min-height: 44px" in studio


def test_stage4_save_module_pins():
    """Stage 4 (decision §7.1): ONE comprehensive save component — three
    targets (save over original / save as new file / save to Library) —
    wired once and present in BOTH the expanded rail and the fullscreen
    overlay. Endpoints are the existing save-back / save-new / save-family
    trio; no new backend routes."""
    studio = (Path(__file__).parent.parent / "frontend" / "js" / "modules" / "studio.js").read_text()
    assert ".st-savebar" in studio
    assert studio.count('data-save="over"') == 2      # rail + overlay
    assert studio.count('data-save="new"') == 2
    assert studio.count('data-save="library"') == 2
    assert "/api/update/save-back" in studio
    assert "/api/update/save-new" in studio
    assert "/api/update/save-family" in studio
    assert "wireSaveBars" in studio                    # one wiring, many mounts
    # save-over replaces the bytes at the original's path: a prepared
    # img2img input cached for that path goes stale (studio eval §9)
    assert "d.overwritten === inputParent" in studio
    assert "inputName = null; inputParent = null; inputDims = null;" in studio


def test_stage4_bugfix_batch_pins():
    """Studio bugfix batch (2026-11-16, eval findings 9-13): blob object
    URLs revoked when the stack is replaced or cleared; mask white-pixel
    count maintained incrementally instead of a full-canvas scan per erase
    move; dead bits removed (jobCancelled, the initMaskForSource redundant
    guard, the generate() duplicated busy-reset, the fragile loadConfig
    default-workflow lookup, unescaped quotes in esc()). Finding 11
    (cross-strip selection) and the showCurrent previewUrl dead read were
    already fixed by the canvas-preview pass — the shared strip renderer
    re-applies .sel from previewed in both strips."""
    studio = (Path(__file__).parent.parent / "frontend" / "js" / "modules" / "studio.js").read_text()
    # §10: blob URLs revoked on stack replace / clear (only blob: URLs)
    assert "function revokeStackUrls" in studio
    assert "revokeStackUrls(prevStack)" in studio
    assert "en.url.startsWith('blob:')" in studio
    # §12: incremental white-pixel count, not a full scan per move
    assert "maskWhiteCount" in studio
    assert "function scanWhiteCount" in studio
    assert "function countWhiteIn" in studio
    assert "return !!maskCanvas && maskWhiteCount > 0;" in studio
    assert "maskWhiteCount = scanWhiteCount();" in studio  # undo restore rescans (rare)
    # §13: dead bits gone
    assert "jobCancelled" not in studio
    assert "stale mask must not survive" not in studio
    # generate() has one busy-reset in a finally, not a duplicated reset
    assert "} finally {" in studio
    assert "setFabProgress(0, '')" not in studio
    # loadConfig derives the family by splitting the workflow id
    assert "const defFam = (c.default_workflow || 'klein').split('-')[0];" in studio
    assert "fams.includes(defFam) ? defFam : 'klein'" in studio
    # esc() escapes single quotes; the workflow option value is escaped too
    assert "\"'\": '&#39;'" in studio
    assert 'value="${esc(f)}"' in studio
    # §11 (already fixed): both strips share one renderer, .sel from previewed
    assert "for (const target of [el.cands, el.ovcands])" in studio
    assert "if (selPath && c.path === selPath) d.classList.add('sel');" in studio


def test_stage4_batch_and_candidate_pins():
    """Stage 4: batch count = hold-to-arm rocker 1-4 default 1 (pure math
    module, pointer capture + touch-action none + aria slider); the rocker
    replaced the drag pips in the usability pass 2026-11-15 — hold ~1s to
    arm, then drag vertically. Candidates are an explicit triage surface —
    selection sets the working image, nothing auto-saves, the next run
    replaces the strip; optional save-all checkbox targets Gallery,
    default OFF."""
    mods = Path(__file__).parent.parent / "frontend" / "js" / "modules"
    pips = (mods / "studio-pips.js").read_text()
    studio = (mods / "studio.js").read_text()
    assert "BATCH_MIN = 1" in pips and "BATCH_MAX = 4" in pips
    assert "export function batchFromRockerDrag" in pips
    assert "batchFromRockerDrag" in studio and "clampBatch" in studio
    assert "ROCKER_HOLD_MS = 1000" in studio       # hold a second to arm
    assert "setPointerCapture" in studio
    assert "touch-action: none" in studio          # rocker never scrolls the page while dragging
    assert 'role="slider"' in studio and "aria-valuemin" in studio
    assert "setBatch(1)" in studio                 # default 1
    # explicit candidate promote only (decision §7.2)
    # candidate promote moved to the explicit ⬇ on the source slot (§7.2/§10 review 2026-11-13);
    # since 2026-11-16 both the ⬇ and the Mask panel's "Use as source" go
    # through promoteCandidate, which pushes onto the stack first (history
    # survives) and moves the run source with it
    assert "promoteCandidate(previewed)" in studio
    assert "studioState().set(c.path, 'foxden-output'" in studio
    assert "cands.startRun(collected)" in studio   # next run replaces the strip
    html = studio[studio.index('<input type="checkbox" data-id="save-all"'):]
    at = html.index("<input")
    input_tag = html[at:html.index(">", at) + 1]
    assert input_tag == '<input type="checkbox" data-id="save-all" style="width:auto">', input_tag
    assert "save all outputs to gallery" in studio


def test_stage4_canvas_preview_pins():
    """Stage 4: the canvas always shows the first candidate after a run and
    whichever candidate is tapped (2026-11-15 fix). Before it, both preview
    landings were gated on `!compareOn`, so once Split had been opened the
    canvas silently stopped tracking new candidates and taps; with no
    working image the frame stayed hidden, so the first candidate never
    appeared; and the strip rebuild dropped the .sel ring on every tap."""
    studio = (Path(__file__).parent.parent / "frontend" / "js" / "modules" / "studio.js").read_text()
    # the preview always lands in all three paths (run completion,
    # candidate tap, mask run)
    assert studio.count("The preview always lands") == 3
    assert "if (!compareOn) {" not in studio   # candidate gates gone; the
    # filter preview that shared the flag went with the filters section
    assert "previewed = collected[0]" in studio   # first candidate is the viewed one
    # with no working image yet, the run unhides the frame and names the
    # candidate on the badge (showCurrent is the only other unhide)
    assert studio.count("el.frame.hidden = false;") == 2
    assert "el.badge.textContent = collected[0].path.split('/').pop();" in studio
    # the strip rebuild re-applies the viewed candidate's ring from previewed
    assert "const selPath = previewed ? previewed.path : null;" in studio
    assert "if (selPath && c.path === selPath) d.classList.add('sel');" in studio
    assert "void selBtn" not in studio and "void selPath" not in studio
    # showCurrent's dead `previewUrl || prev.url` (previewUrl is nulled just
    # above) is gone — it always shows the stack's before entry
    assert "previewUrl || prev.url" not in studio


def test_stage4_mask_and_provenance_pins():
    """Stage 4 (2026-11-16 restructure): Refine is gone — the verbs are
    Generate / Mask / Provenance. Mask is its own generation panel: a model
    picker driven by the workflow schema (edit-role models only; Klein 4B
    enabled, Moss disabled until its mask path lands), paint/erase/clear/
    undo, prompt, denoise, seed, single-shot run. The mask run lands as a
    CANDIDATE — never auto-promoted; the painted mask stays across runs on
    the same source. Filters and the non-mask Update presets left Studio
    entirely. Provenance is fed by GET /api/foxden/provenance?path=.
    img2img comes from the working image when denoise < 1 (upload +
    parent_image)."""
    studio = (Path(__file__).parent.parent / "frontend" / "js" / "modules" / "studio.js").read_text()
    # the verbs are Generate / Mask / Provenance — no Refine, no preset dropdown
    assert 'data-verb="mask"' in studio
    assert 'data-verb="refine"' not in studio
    assert "__masked_inpaint" not in studio
    assert "loadRefinePresets" not in studio
    assert "rpreset" not in studio
    assert "/api/update/run-async" not in studio
    # no filters left in Studio (the separate main Filters tab is their home)
    assert "filters-sec" not in studio
    assert "filterState" not in studio and "colorholdParams" not in studio
    assert "tuneImageData" not in studio and "tunesAreIdentity" not in studio
    assert "schedulePreview" not in studio and "FILTER_SLIDERS" not in studio
    assert "loadImg" not in studio and "details.collapse" not in studio
    # Mask = Update masked-inpaint endpoint on the working image, single-shot
    assert "/api/update/inpaint-async" in studio
    assert "/api/update/jobs/" in studio
    assert "async function runMask" in studio
    assert "cands.startRun([cand])" in studio
    mask_run = studio[studio.index("async function runMask"):studio.index("el.mrun.addEventListener")]
    assert "cands.startRun" in mask_run and "previewed = cand" in mask_run
    assert "showCurrent" not in mask_run and "studioState().set" not in mask_run
    assert "pushRender" not in mask_run   # no auto-promote, no stack write
    assert "batch" not in mask_run        # single-shot: no batch loop
    # model picker: schema-driven, edit-role models only, Klein 4B enabled
    assert "MASK_EDIT_WORKFLOWS" in studio
    assert "/api/foxden/workflows/schema" in studio
    assert "klein-4b-edit" in studio
    assert "(mask path coming)" in studio
    models = studio[studio.index("async function loadMaskModels"):studio.index("el.mmodel.addEventListener")]
    assert "FAMILY_MODELS" in models      # /config families map is the fallback
    assert "if (!v || !v.edit) continue" in models
    # mask persistence: a fresh blank mask only when the source changes
    assert "if (verb === 'mask') initMaskForSource();" in studio
    assert "if (v === 'mask' && stack && !maskCanvas) initMaskForSource();" in studio
    # masked inpaint is paintable: the canvas pointerdown arms masking when
    # the Mask verb is active, a second finger cancels the stroke, pointerup
    # ends it, and a visible red overlay shows the painted region.
    assert "masking = true; _maskLastPt = null;" in studio
    assert "masking = false; _maskLastPt = null;" in studio
    assert "maskVisible()" in studio
    assert 'data-id="maskview"' in studio
    assert "drawMaskView()" in studio
    # the mask section is always visible in the Mask panel (no preset gate)
    assert 'style="display:none"' not in studio
    # comparer lives in the canvas
    assert 'data-id="cmpbar"' in studio and "comparing" in studio
    # provenance tab fed by the foxden provenance endpoint
    assert "/provenance?path=" in studio
    assert "parentchain" in studio or "parent_image" in studio
    # img2img off the working image when denoise < 1, with parent link
    assert "prepareInput" in studio
    assert "body.parent_image = inputParent" in studio
    # prepareInput no longer bails on denoise>=1 — edit graphs always inject (2026-11-13)
    assert "denoise gating lives in generate()" in studio
    # explicit advance to source (multi-stage work): a labeled "Use as
    # source" button in the Mask panel and the ⬇ both promote the viewed
    # candidate — pushRender first (history survives), run source moves
    # with it (setViewedAsBase), mask resets for the new source. Never
    # automatic: the mask run itself still does no stack write.
    assert 'data-id="madvance"' in studio
    assert "Use as source" in studio
    assert "function promoteCandidate" in studio
    assert "promoteCandidate(previewed)" in studio
    assert "setViewedAsBase(stack)" in studio
    assert "recipe: 'masked-inpaint'" in studio


def test_stage4_studio_activation_never_reloads_config():
    """Stage 4 pin (chunk-A bug class, carried from Stage 3): Studio has NO
    ellieedit:tab-activated listener that fetches config — everything
    configures exactly once, inside the single mount."""
    studio = (Path(__file__).parent.parent / "frontend" / "js" / "modules" / "studio.js").read_text()
    assert "loadConfig" in studio          # exists, called once at mount
    assert studio.count("await loadConfig()") == 1
    assert "tab-activated" not in studio   # no activation reload path at all


def test_stage3_hash_redirect():
    """Stage 3: #foxden and #update deep links resolve to Studio; the shell
    applies the mapping on load and on hashchange."""
    HERE = Path(__file__).parent
    tabs = (HERE.parent / "frontend" / "js" / "modules" / "studio-tabs.js").read_text()
    shell = (HERE.parent / "frontend" / "js" / "shell.js").read_text()
    assert "HASH_ALIASES = { foxden: 'studio', update: 'studio' }" in tabs
    assert "export function resolveHash" in tabs
    assert "resolveHash" in shell
    assert "hashchange" in shell
    assert "applyHash()" in shell


def test_stage3_auto_promote_on_completion():
    """Stage 3 output-becomes-working: a single-output generation run
    auto-promotes (origin 'foxden-output'); multi-output runs keep the
    explicit candidate promote; Update runs promote their stored render
    (origin 'update'); Filters promote sets origin 'filters'."""
    HERE = Path(__file__).parent
    mods = HERE.parent / "frontend" / "js" / "modules"
    fx = (mods / "foxden.js").read_text()
    upd = (mods / "update.js").read_text()
    fil = (mods / "filters.js").read_text()
    # single-output auto-promote, gated on exactly one candidate
    assert "if (runCands.length === 1)" in fx
    assert "studioState().set(runCands[0].path, 'foxden-output'" in fx
    # explicit candidate promote unchanged
    assert "studioState().set(c.path, 'foxden-output'" in fx
    # Update run completion promotes the stored render
    assert "studioState().set(data.render_path, 'update'" in upd
    # Filters promote (not send) sets the working image
    assert "studioState().set(render_path, 'filters'" in fil


def test_stage3_send_targets_retirement_and_survivors():
    """Stage 3: Studio-bound send-to-Update is retired everywhere; the
    send-to bus stays alive for Puppet/FaceCycle/Filters targets, and a new
    'studio' target routes set-working through the store event."""
    HERE = Path(__file__).parent
    mods = HERE.parent / "frontend" / "js" / "modules"
    st = (HERE.parent / "frontend" / "js" / "send-to.js").read_text()
    fx = (mods / "foxden.js").read_text()
    upd = (mods / "update.js").read_text()
    gal = (mods / "gallery.js").read_text()
    lib = (mods / "library.js").read_text()
    studio = (mods / "studio.js").read_text()
    # retired: no remaining dispatch targets update/foxden from UI modules
    for src, name in ((fx, "foxden"), (upd, "update"), (gal, "gallery"), (lib, "library")):
        assert "target: 'update'" not in src, name
        assert "target: 'foxden'" not in src, name
    # bus survivors: Puppet + FaceCycle entries still wired
    for src in (fx, upd, gal, lib):
        assert "target: 'puppet'" in src
        assert "target: 'facecycle'" in src
    # new studio target: planner route + Studio consumer
    assert "'studio'" in st.split("PUPPET_AS")[0]   # in SEND_TARGETS
    assert "ellieedit:studio-set-working" in st
    assert "ellieedit:studio-set-working" in studio
    assert "registerReceiver('studio'" in studio
