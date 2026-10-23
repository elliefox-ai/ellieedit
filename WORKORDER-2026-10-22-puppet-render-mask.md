# WORKORDER — Puppet Theater v1.1: "Fill Area" step (paintable render mask)

**Base:** current `master` (post puppet-theater-v1 landing, build 2026-10-22d).
**Branch:** `muse-puppet-render-mask`. Same delivery pipeline as v1: zip with
bundle + patches + handoff; no build bumps, no restarts.

## Goal
Today the final pass repaints the whole canvas (full-canvas white mask).
The common case is different: subjects are already final, and the user wants
to *fill in* specific regions (e.g. a body below a headshot). Make that an
explicit step in the stage flow.

## Spec
1. **New stage step: "Fill Area"** — a discrete step between placement and
   the final pass (matching the suite's explicit-apply step convention).
   In this mode the user paints, at canvas level, where generation should
   happen: white = fill/regenerate, black = locked pixels.
2. Brush controls as elsewhere (size, hard/soft), nondestructive: undo,
   clear; persisted as a `rendermask` asset kind in the project JSON.
   Subtle overlay tint on painted regions while in the step; tint off outside it.
3. **Flow:** after Fill Area (or skipping it), the final pass runs:
   - mask present → sent to `comfy_repaint` (painted regions regen at the
     fenced 0.4–0.5, rest of canvas locked);
   - no mask / "Render all" chosen → current full-canvas behavior.
   Both choices visible in the final-pass step; empty mask = white behavior.
4. **Tests:** mask asset round-trip; render endpoint passes the painted mask
   through (mocked comfy_repaint asserts mask bytes); empty-mask default
   unchanged; step mode doesn't interfere with per-layer mask erase.

## Delivery
Zip + bundle + patches + handoff as before. Full suites green (env skips ok).

## Amendments (Alexander, live-testing v1, 2026-10-22)

A. **Generation status indicators (all async paths).** No silent waits:
   - rmbg job on drop: inline spinner on the stage/drop zone ("cutting out…").
   - background generation: progress state on the background button.
   - final pass: progress indicator on the render button until preview returns.
   Every async action shows state within ~200ms; failure states visible too.

B. **Drop/add unresponsive after refresh (fixed itself after long delay).**
   Diagnosed as cold u2net first-load (30s+) blocking the drop path with zero
   feedback — see A. Additionally verify the drop handler isn't blocked while
   a previous rmbg job is pending (queue or parallel jobs, not a locked UI).

C. **Reload bug: layers listed with right sizes but puppet pixels missing.**
   After project reload, layers appeared in the panel at correct transforms
   but images were not rendered on stage (background was fine). Investigate
   asset fetch/decode ordering on session restore — likely layers render
   before their asset bytes arrive (or a failed fetch that isn't retried).
   Add a test: reload restores stage pixels, not just layer metadata.

## Operator-side hotfix already landed (build on top of this)
`cf676a7` — rembg session is now cached (`_rmbg_session` singleton in
`backend/routers/puppet.py`); `remove()` alone rebuilt the onnx session per
call (~30s every drop). Amendment B is partially addressed by this; the
no-UI-lock and status-indicator parts of A/B are still yours.

## Amendment D — rmbg as a discrete, nondestructive choice (Alexander)
Currently drop → automatic rmbg. Change to:
1. Drop/bAdd places the **original image** as the layer immediately (no
   server round-trip on the drop path — this also removes the drop-freeze
   class of bugs entirely).
2. Per-layer discrete action: **"Cut Out"** runs rmbg; result stored as the
   layer's alpha **mask** — the original pixels are never modified
   (same discipline as mask-erase).
3. Per-layer **"Restore"** drops the generated mask and returns the full
   original image, at any time, reversibly.
4. Status spinner moves to the Cut Out button; job-based as today.
