"""Runs the headless JS tests for the Gallery's place-keeping logic (node)."""

import subprocess
from pathlib import Path

HERE = Path(__file__).parent


def test_js_gallery_scroll_helpers():
    """Manifest-change plan + scroll-anchor helpers: marking rejects in Ladder
    no longer wipes and refetches the grid, and the user keeps their place
    (2026-10-15)."""
    r = subprocess.run(
        ["node", str(HERE / "js" / "gallery-scroll.test.mjs")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"node test failed:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout
