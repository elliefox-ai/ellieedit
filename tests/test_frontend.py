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


def test_sw_cache_version_matches_build_marker():
    """The SW cache name and the UI build marker must move together on deploy —
    this is the stale-cache guard (blank-canvas incident 2026-10-07)."""
    sw = (HERE.parent / "frontend" / "sw.js").read_text()
    shell = (HERE.parent / "frontend" / "js" / "shell.js").read_text()
    import re
    cache = re.search(r"const CACHE = '([^']+)'", sw).group(1)
    build = re.search(r"const BUILD = '([^']+)'", shell).group(1)
    # Both must carry the same deploy stamp (e.g. 20261007b)
    stamp = re.search(r"(\d{8}[a-z])", cache)
    assert stamp, f"SW cache name lacks a deploy stamp: {cache}"
    assert stamp.group(1) in build or build.endswith(stamp.group(1)[-1]) or stamp.group(1)[:-1] in build, \
        f"build marker {build} does not correspond to SW cache {cache}"


def test_no_invalid_star_class_in_module():
    """Regression: `.*** {` / class="***" is an invalid CSS class (rule silently
    dropped) left over from an editing artifact."""
    src = (HERE.parent / "frontend" / "js" / "modules" / "facecycle.js").read_text()
    assert 'class="***"' not in src
    assert ".*** {" not in src
    assert 'fc-canvas-wrap' in src
