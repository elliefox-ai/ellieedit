"""Machine-readable workflow schema — the editor-facing manifest.

Derived from the backend's own registry maps so it cannot drift from
reality. Deliberately contains NO graph internals: no node ids, no
class_types, no filenames beyond the file-existence flag. An editor
(echo, a collaborator, a client UI) may know everything it needs to
DRIVE the workflows and nothing about what is inside them.

Human-readable companion: docs/workflow-contract.md.
Regenerate the committed manifest: python scripts/gen_workflow_manifest.py
"""
from __future__ import annotations

from .routers.foxden import (WORKFLOW_FILES, WORKFLOW_FAMILIES,
                             WORKFLOW_FAMILY_ALIASES, EDIT_WORKFLOWS,
                             workflows_dir)

GENERATE_ENDPOINT = "/api/foxden/generate"
STATUS_ENDPOINT = "/api/foxden/status/{prompt_id}"
UPLOAD_ENDPOINT = "/api/foxden/upload"

# The input contract of POST /api/foxden/generate, mirroring GenerateBody
# and the generate() validator. Every workflow accepts these; per-workflow
# entries only add the edit/graph-driven caveats.
COMMON_INPUTS = [
    {"name": "prompt", "type": "string", "required": True,
     "note": "non-empty; injected into the positive conditioning literal"},
    {"name": "seed", "type": "int", "required": False,
     "range": [0, 2**31 - 1],
     "note": "omit for a random seed; response carries the seed used"},
    {"name": "width", "type": "int", "required": False,
     "note": "graph may be size-link-driven and ignore it; snapped to /16"},
    {"name": "height", "type": "int", "required": False,
     "note": "graph may be size-link-driven and ignore it; snapped to /16"},
    {"name": "steps", "type": "int", "required": False, "range": [1, 150]},
    {"name": "denoise", "type": "float", "required": True, "range": [0.0, 1.0],
     "default": 1.0,
     "note": "always sent; whether the graph consumes it is wire_denoise's business"},
    {"name": "input_image", "type": "string", "required": False,
     "note": "name from /api/foxden/inputs or /upload; "
             "REQUIRED for edit workflows (see per-workflow edit flag)"},
    {"name": "parent_image", "type": "string", "required": False,
     "note": "optional provenance link (gallery/library path)"},
    {"name": "loras", "type": "array[{name,strength_model}]", "required": False,
     "note": "max 8; strength_model -4.0..4.0"},
    {"name": "suspended_loras", "type": "array[{name,strength_model}]",
     "required": False,
     "note": "never reach the graph; recorded for ReUse only"},
]


def _family_of(wid: str) -> str:
    plain = WORKFLOW_FAMILY_ALIASES.get(wid, wid)
    for fam, fd in WORKFLOW_FAMILIES.items():
        for model, variants in fd["models"].items():
            for role, cid in variants.items():
                if cid == plain:
                    return fam
    return wid


def _model_and_role(wid: str) -> tuple[str | None, str]:
    plain = WORKFLOW_FAMILY_ALIASES.get(wid, wid)
    for fam, fd in WORKFLOW_FAMILIES.items():
        for model, variants in fd["models"].items():
            for role, cid in variants.items():
                if cid == plain:
                    return model, role
    return None, ("edit" if wid in EDIT_WORKFLOWS else "gen")


def build_manifest() -> dict:
    workflows = {}
    for wid, fname in WORKFLOW_FILES.items():
        model, role = _model_and_role(wid)
        workflows[wid] = {
            "family": _family_of(wid),
            "model": model,
            "role": role,                       # "gen" | "edit" | legacy roles
            "edit": wid in EDIT_WORKFLOWS or role == "edit",  # requires input_image (denoise-gated klein: role=edit)
            "available": (workflows_dir() / fname).is_file(),
            "inputs": COMMON_INPUTS,
            "aliases": [k for k, v in WORKFLOW_FAMILY_ALIASES.items() if v == wid],
        }
    return {
        "schema_version": 1,
        "generated_by": "backend/workflow_schema.py (regenerate: scripts/gen_workflow_manifest.py)",
        "endpoints": {
            "generate": GENERATE_ENDPOINT,
            "status": STATUS_ENDPOINT,
            "upload": UPLOAD_ENDPOINT,
            "inputs": "/api/foxden/inputs",
            "view": "/api/foxden/view",
        },
        "families": WORKFLOW_FAMILIES,
        "workflows": workflows,
    }
