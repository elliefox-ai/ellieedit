"""Pins for the editor-facing workflow schema (backend/workflow_schema.py).

- the committed workflows/manifest.json must equal the regenerated output
  (drift pin — regenerate with scripts/gen_workflow_manifest.py after any
  registry change);
- the manifest must never leak graph internals (class_type, node ids,
  filenames) — it is the editor-side contract, not the workflows;
- the schema endpoint returns the same manifest.
"""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.workflow_schema import build_manifest

MANIFEST = Path(__file__).resolve().parents[1] / "workflows" / "manifest.json"

LEAK_TOKENS = ("class_type", "node_id", "_gen_basic")


def test_manifest_matches_regeneration():
    committed = json.loads(MANIFEST.read_text())
    assert committed == build_manifest(), (
        "workflows/manifest.json drifted from the registry — "
        "run scripts/gen_workflow_manifest.py and commit")


def test_manifest_has_no_graph_internals():
    raw = MANIFEST.read_text()
    for token in LEAK_TOKENS:
        assert token not in raw, f"manifest leaks graph internals: {token!r}"
    m = build_manifest()
    for wid, entry in m["workflows"].items():
        assert set(entry) == {"family", "model", "role", "edit",
                              "available", "inputs", "aliases"}
        # edit = legacy EDIT_WORKFLOWS membership OR any family role maps
        # to this wid as "edit" (denoise-gated klein gen/edit share one id).
        legacy = __import__("backend.routers.foxden",
                            fromlist=["EDIT_WORKFLOWS"]).EDIT_WORKFLOWS
        role_edit = any(r == "edit"
                        for fd in build_manifest()["families"].values()
                        for variants in fd["models"].values()
                        for r, cid in variants.items() if cid == wid)
        assert entry["edit"] == (wid in legacy or role_edit)


def test_manifest_registry_complete():
    from backend.routers.foxden import WORKFLOW_FILES, WORKFLOW_FAMILY_ALIASES
    m = build_manifest()
    assert set(m["workflows"]) == set(WORKFLOW_FILES)
    # every registered alias resolves to an existing workflow entry
    for alias, target in WORKFLOW_FAMILY_ALIASES.items():
        assert target in m["workflows"]
        assert alias in m["workflows"][target]["aliases"]


@pytest.mark.usefixtures()
def test_schema_endpoint_serves_manifest():
    with TestClient(app) as client:
        r = client.get("/api/foxden/workflows/schema")
        assert r.status_code == 200
        assert r.json() == build_manifest()
