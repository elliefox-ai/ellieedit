# Comfy Workflow Contract

The live workflow JSONs are **runtime config**, not code: they live in
ComfyUI's user workflow dir (`/mnt/e/comfyui/user/default/workflows`, override
with `ELLIEEDIT_COMFY_WORKFLOWS_DIR`) and are edited in the Comfy editor.
This document is the contract they must satisfy. If a workflow stops working
in Studio, check it against this page first.

**Rule for developers:** workflows live outside the repo. If you change one,
change only the live file — but keep it inside this contract, or the backend's
injection will fail at runtime (or worse, silently mis-inject).

## Format

API/prompt format only: a flat dict of node-id → `{class_type, inputs}`.
UI-format exports (with a `"nodes"` array) are rejected by `load_workflow()`.

## Graph families

A valid Studio workflow has **exactly one** of:

- **CFG family** (Klein gen/edit, Qwen, Moss): exactly one `CFGGuider` node
  whose `model` and `positive` inputs are links.
- **KSampler family** (Krea2, Z-Image, classic graphs): exactly one `KSampler`
  node.

Anything with zero or multiple of both is rejected.

## Injection slots (how the backend finds what to patch)

The backend discovers slots by structure, not hardcoded node ids — but the
structure is strict:

| Slot | CFG family | KSampler family |
|---|---|---|
| Prompt | walk upstream from `CFGGuider.positive` to the first node with a non-empty literal `string`/`text`/`prompt` input; empty-string literals are skipped | same walk from `KSampler.positive` |
| Seed | the single `RandomNoise` node | `KSampler.seed` — may be a literal int or a link to a Seed (rgthree) node |
| Size (w/h) | any node with literal int `width`+`height` inputs (e.g. EmptySD3LatentImage) | literal ints; if size is link-driven (e.g. ResolutionSelector), it is left alone |
| Steps | on the latent/size node pair | on the `KSampler` |

**Requirement:** exactly one prompt literal must be reachable upstream; a
graph whose prompt is built only from concatenated empty strings fails.

## Edit workflows

Registered edit ids (`klein-edit`, `klein-4b-edit`, `moss-edit`) are
reference-image graphs — they must always receive the working image:

- **Graph has no `LoadImage`:** the backend injects a fresh `LoadImage` node
  carrying the upload (t2i baseline graphs).
- **Graph has exactly one `LoadImage`:** the backend adopts it and repoints
  its `image` input at the upload, so every downstream consumer follows.

**Requirement:** an edit graph must have zero or one `LoadImage` — never
two. A second loader is how "wrong image" bugs happen (see troll→cat,
2026-11).

## Model registry (backend side)

`WORKFLOW_FILES` maps concrete workflow id → filename;
`WORKFLOW_FAMILIES` composes UI selections into ids:

- Klein: 9b gen → `klein`, 4b gen → `klein-4b`, 4b edit → `klein-4b-edit`
- Moss: gen → `moss`, edit → `moss-edit` (patch adapter)
- Krea2, ZengoRestyle (F2K 4B), Qwen 2.1: single graphs each

Adding a model = add the JSON to Comfy's dir + one entry in each map
(`backend/routers/foxden.py`). The frontend derives family/model/edit from
these maps — no frontend change needed for a plain new graph.

## Validation checklist for a new/edited workflow

1. API format, flat dict, every node has `class_type`
2. Exactly one CFGGuider **or** one KSampler
3. One non-empty literal prompt node upstream of the positive conditioning
4. Seed discoverable (RandomNoise, or KSampler seed literal/Seed-node link)
5. Literal width/height somewhere (unless intentionally link-driven)
6. Edit graphs: at most one LoadImage
7. Every edge references an existing node (`validate_graph`)

## Snapshot policy

The live JSONs are intentionally NOT in git (config, single source of truth).
A cold snapshot with date suffix may be committed under `workflows/` as
backup only — never wired into the runtime path.
