# WORKORDER — Puppet Theater v1.2: iterative compositing fixes

**Author:** Ellie · **Builder:** Echo · **Date:** 2026-10-22 (evening, live-test feedback)
**Base:** current `master` (`da52587`+ fence-test fix, build 2026-10-22f).
**Branch:** `echo-puppet-v12`. Same delivery: zipped bundle + patches + SHA,
no build bumps, no restarts.

## 1. Drop-hint overlay bug
The "drop puppet images here" hint renders on top of the canvas/background
when it shouldn't. It must show ONLY when the stage has no background AND no
layers (empty stage), or during an active drag-over. Fix the visibility
condition; add a node test for the pure predicate if one exists.

## 2. Fill Area targeting: layer-scoped when a layer is selected
Currently Fill Area paints only at canvas level. Change: when a layer is
selected, the Fill Area brush should apply to that layer's footprint
(painting fill *associated with* that puppet — e.g. "fill the body below
this headshot"); when no layer is selected, behavior stays as today
(whole-canvas fill region). Keep masks/undo nondestructive per current
discipline. Builder proposes the exact interaction (e.g. clipped to layer
alpha ∪ previous fill strokes) in the handoff before finalizing.

## 3. Render accept → new layer, not background stamp (the big one)
Today "Keep" flattens the render into the stage/background. Change: accepting
a render places the result as a **new puppet layer** on top of the stack —
draggable, resizable, rotatable like any puppet — so rendering becomes
iterative compositing. Background stays untouched. Discard path unchanged.
This also implies: subsequent Fill Area / renders composite on top of
previously accepted render layers. Verify session save/reload round-trips
render layers like any other layer. Node/pytest coverage for the new layer
creation path.

## Out of scope
Denoise fence (already widened to 0.2–0.8, deployed 2026-10-22f), FaceCycle,
dupe. No ledger changes.

## 4. Final-pass model: Klein default, Krea2 as option (Alexander)
The final pass currently routes through `comfy_repaint` (Krea2). Alexander:
"Klein preserves existing context better" — and for Puppet Theater that's
the priority; the placed pixels ARE the design, the model's only job is
harmonization. Change:
- **Default engine: Klein.** Inventory the existing Klein ComfyUI workflows
  (`klein_basic_gen.json` etc., see `comfy_generate.py` wiring) for an
  img2img/repaint-capable graph at canvas resolution; if none exists yet,
  build the graph by adapting the basic one (img2img input + mask input,
  cfg 1, ~6 steps, same sampler family). If a masked variant isn't feasible
  cleanly, a full-canvas img2img at the requested denoise is acceptable v1 —
  flag the limitation in the handoff.
- **Engine becomes a per-render selection** in the final-pass step:
  "Klein (preserves more)" default / "Krea2 (repaints more)" option.
  Server-side default must be Klein even if the client omits the field.
- Denoise fence (0.2–0.8, server-clamped) applies to BOTH engines.
- Tests: engine selection passes the right workflow through (mocked), default
  = Klein when unspecified, fence holds on both paths.
