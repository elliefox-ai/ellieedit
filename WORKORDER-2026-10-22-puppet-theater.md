# WORKORDER — Puppet Theater (multi-subject compose stage)

**Date:** 2026-10-22 · **Author:** Ellie (with Alexander) · **Builder:** muse
**Status:** Ready for build. Base: current `master` (ec8ce1d, build 2026-10-22c).
**Increment label:** `puppet-theater-v1`

## Why

Klein two-reference edits keep "correcting" subject poses (e.g. a turned head) —
the model's portrait prior beats the reference. The fix is architectural: take
pose authority away from the model. The human places cutouts manually; the
model's only job is the final harmonization pass (light/shadow/seams), which is
a much smaller failure surface. Poses are baked pixels, not prompt-wishes.

## Scope

A new suite surface ("Puppet Theater") in EllieEdit:

1. **Canvas / stage** — pick or create a background:
   - blank / transparent,
   - upload an image,
   - or generate one via the existing Comfy generation path (same as FoxDen)
     with a plain prompt.
   - Resolution: freeform with sensible presets (1:1, 3:2, 16:9, last-used).

2. **Place puppets** — drop images onto the stage:
   - On drop: automatic background removal server-side (rmbg), result becomes a
     draggable/resizable layer.
   - **Resize handles** at layer corners (aspect-locked by default; shift to
     free-stretch), plus rotate.
   - Z-order controls (raise/lower/send-to-front/back).
   - Layer list panel with visibility/eye toggles.

3. **Nondestructive mask erase** — per puppet:
   - Brush and eraser on the layer's *alpha mask*, not its pixels.
   - Original image + mask stored separately; erase is fully recoverable
     (undo/reset restores any region).
   - Brush size adjustable; hard/soft edge control.

4. **Nondestructive session** — the composite is derived, never committed:
   - Layer stack (source images, transforms, masks) persisted as JSON per
     theater project; user can reopen and keep editing.
   - Export produces (a) flattened composite PNG at canvas resolution, (b) the
     layer stack JSON.

5. **Final pass (the render)** — send the composite to the existing
   low-denoise inpaint path:
   - Fence the model: full-canvas context, denoise 0.4–0.5
     (see memory/2026-09-08.md low-denoise finding — d0.8 transplants Klein's
     medium and re-conceives faces; do not allow d0.8 defaults).
   - Optional prompt box for atmosphere direction ("golden hour, soft rim
     light" etc.).
   - Result lands back on the stage as a *preview* the user can accept or
     discard (discard returns to the live composite; nothing is lost).

## Non-goals (v1)

- No puppet posing/skeletal animation — placement only.
- No generative fill inside the stage (that's the final pass's job).
- No new image model integrations — use the existing Comfy/Klein path.
- No meld/FaceCycle changes.

## Architecture guidance

- **Backend (new router `backend/routers/puppet.py`):**
  - `POST /api/puppet/rmbg` — image in → PNG with alpha out. Implement with
    `rembg` (onnxruntime, u2net). Run in a background task; return a job id if
    processing exceeds a few seconds. Verify against current HEAD before
    editing; follow existing router conventions (see `gallery.py` style).
  - Theater project storage: a JSON + source PNGs under a `puppet/` subtree of
    the existing per-project storage layout (inspect `library.py` for where
    project files live; match its conventions).
  - Final pass: reuse the existing Comfy submit/poll plumbing that FoxDen uses
    (`backend/routers/foxden.py`), NOT a new pipeline.
- **Frontend (new module `frontend/js/modules/puppet.js` + `puppet.css`):**
  - Follow the suite's module conventions; register in `shell.js` navigation.
  - Canvas interactions: pointer events; layers absolutely positioned DOM
    elements or a single `<canvas>` — builder's choice, but DOM layers make the
    nondestructive mask UI simpler.
  - History: client-side undo stack for transforms and mask strokes.
- **Tests:**
  - Node tests for pure logic (transform math, z-order ops, mask compositing)
    under `tests/js/`, in the style of `tests/js/dupe-proposal.test.mjs`.
  - Python tests for the rmbg endpoint (fixture image with known background;
    assert alpha exists and corners are transparent for a simple case) and
    project save/load round-trip. Mark GPU/model-dependent tests so they skip
    when rembg model files are absent — do NOT let the suite depend on a
    model download.

## Delivery

- Branch `muse-puppet-theater` off current `master`. Git bundle + patch series
  (git-am fallback), same as previous deliveries.
- Verify line numbers/ids against current HEAD before editing.
- **Do not** bump `sw.js`/`shell.js` build markers, do not restart services —
  the operator side (Ellie) handles landing, build bump, and deploy.
- Full test suites must be green at handoff (node + pytest; environment-skipped
  tests may skip).

## Acceptance checklist (operator-side, after land)

1. Drop two subject photos → both appear as cutouts with real alpha.
2. Reposition/scale/rotate; a turned head stays exactly as the source pixels.
3. Mask-erase part of a puppet; undo restores it.
4. Save, reload, session intact.
5. Final pass renders at low denoise; faces unchanged; accept/discard works.
6. Full suite green; build bump deployed; served marker verified.

---

## v1.2.1 addendum (Alexander, 2026-10-22 22:44)

**Split the Klein graphs per mode** — already half-landed:
- Final pass (mode 'all' / default): reference graph — ReferenceLatent + ColorMatchV2, DEPLOYED 22:16 (commit "klein repaint: ReferenceLatent + ColorMatchV2"), context holds pixel-exact even at denoise 1.0. Prompt steering is intentionally weak here; that is correct for harmonization.
- Fill Area (mode 'fill'): masked INPAINT graph — needs the mask-fence behavior BACK (ReferenceLatent dominates the prompt at cfg 1.0, so "paint X here" reads weak). Restore BasicScheduler-denoise path or a separate graph id, plus composite-back/ImageComposite outside the mask so unmasked pixels are pixel-exact.

**Layer-handling alterations** (Alexander wants to discuss — DESIGN SESSION, don't build yet):
- "some alterations in how we handle layers and stuff" — unspecified; ask him tomorrow before writing any spec.

---

# INCREMENT 2 — v1.3: layer interaction + per-mode graphs

**Date:** 2026-10-23 · **Builder:** echo · **Status:** Ready for build.
**Base:** current `master` (post 1a16574). Branch off master, same delivery
discipline as increment 1 (git bundle / patch series, no build bumps, no
restarts, suites green at handoff).

## Design decisions (Alexander, 2026-10-23 — do not revisit)

- **Fill target by selection:** no layer selected → fill applies to the
  background; a layer selected → fill applies to that layer. The layer's
  canvas may need extending to cover the mask region (grow to full project
  bounds; extension is permanent).
- **Fill on layer sees the SUBJECT, not the scene:** the layer's own pixels
  are the inpaint input. Subject matching is what matters at this stage;
  lighting/style coherence is the final pass's job. No stack-below reference.
- **No stamping:** accepting a fill on a layer must keep the result ON that
  layer. Current behavior stamps the layer onto the background — defect, fix.
- **Merge down:** a layer merges into the layer below it (background if it is
  the lowest). The erase masks of BOTH layers are consolidated into the
  merged result; the source layer is removed. Straight alpha-over at current
  opacity.
- **Focus stickiness:** when a layer is selected, a pointer-down anywhere
  inside its bounds (including fully transparent/erased pixels) keeps it
  selected. Hit-test fallback to underlying layers only for clicks outside
  the selected layer's bounds.

## Also in scope: per-mode Klein graphs (from v1.2.1 addendum)

- Final pass (mode 'all'): reference graph — ReferenceLatent + ColorMatchV2.
  Already implemented and deployed 2026-10-22 (commit 2b37c48, backend/comfy.py).
  Do not regress; tests/test_comfy.py pins the wiring.
- Fill Area (mode 'fill'): dedicated masked-inpaint graph — mask-fenced, no
  ReferenceLatent on the positive (it dominates the prompt at cfg 1.0), plus
  ImageComposite-back so unmasked pixels stay pixel-exact. Prompt must obey.

## Acceptance checklist (operator-side, after land)

1. Fill with nothing selected changes only the background; layers untouched.
2. Select a puppet, paint a mask, fill → new pixels appear on the layer only;
   background and other layers unchanged; no stamp-to-background on accept.
3. Fill on a layer works even when the mask region extends past the layer's
   current bounds (canvas auto-extends; result stays on the layer).
4. Merge down: top layer disappears, its visible pixels + erase mask
   consolidated into the layer below (or background); merged layer remains
   individually erasable/restorable.
5. With a layer selected, drag/paint starting on a transparent region of that
   layer keeps the selection on it.
6. Final pass unchanged (reference graph, context pixel-exact); Fill Area now
   obeys prompt inside the mask while locked pixels stay exact.
7. Full pytest + tests/js suites green; prior acceptance items 1–6 of
   increment 1 still pass.
