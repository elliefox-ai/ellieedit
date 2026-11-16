#!/usr/bin/env python
"""Regenerate workflows/manifest.json from the backend registry.

The manifest is what an editor-side tool may read to drive FoxDen
workflows without ever seeing a workflow graph. Re-run and commit after
any change to WORKFLOW_FILES / WORKFLOW_FAMILIES / GenerateBody:

    .venv/bin/python scripts/gen_workflow_manifest.py

tests/test_workflow_schema.py pins the committed file to this output.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.workflow_schema import build_manifest  # noqa: E402

out = Path(__file__).resolve().parents[1] / "workflows" / "manifest.json"
out.write_text(json.dumps(build_manifest(), indent=2, sort_keys=True) + "\n")
print(f"wrote {out}")
