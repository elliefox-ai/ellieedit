"""Shared test setup."""

import pytest


@pytest.fixture(autouse=True)
def _no_background_thumb_warming(monkeypatch):
    """The gallery warms thumbnails in a background pool after each listing.
    Off by default in tests so unrelated tests never spawn work (or write into
    the real thumb cache); tests that exercise warming opt back in."""
    from backend.routers import gallery
    monkeypatch.setattr(gallery, "THUMB_WARM", False)
