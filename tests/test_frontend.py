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
    """Task 6: slider (fit..300%), Fit button, localStorage persistence,
    two-finger touch pan; zoom is CSS-width driven (never transform:scale)."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    for needle in ('data-id="zoom-slider"', 'min="100"', 'max="300"',
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
