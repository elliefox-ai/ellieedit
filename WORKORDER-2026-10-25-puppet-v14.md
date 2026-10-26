# WORKORDER-2026-10-25-puppet-v14 — Cutout Restore, Consolidate, Completion

Requested by Alexander, 2026-10-25. Builds on Puppet Theater v1.2/v1.3 (Klein-default engine, Fill Area).

## 1. Cutout as restorable mask

**Problem:** Cutout is destructive — once a region is cut from a puppet layer, it can't be brought back.

**Spec:**
- Cutout must not destroy pixels. Implement cutout as a non-destructive mask: the layer keeps full source pixels; the cut region is recorded as an erase-mask (or inverted keep-mask) on the layer.
- Rendering composites with the mask applied; editing tools treat masked-out area as absent, but "restore" can un-cut (fully or per-region).
- If current layer model stores a single flattened raster, add a per-layer mask channel (PNG alpha or sidecar mask) — follow the existing nondestructive mask-erase pattern from v1 (puppet fit tweaks) rather than inventing a second mechanism.

**Acceptance:** cut a region → restore returns the original pixels bit-exact; save/reload preserves the mask; render output unchanged vs today.

## 2. Consolidate layer button

**Problem:** after cutting out (say) just a head, the layer still spans the full source image — huge shape, awkward handles.

**Spec:**
- New per-layer button "Consolidate" (destructive, confirm not required but label it): crops the layer to its smallest bounding box that fully contains the visible (unmasked) area, with a small padding margin, updating offset/transform metadata so on-canvas position is unchanged.
- Consolidation is a commit point: masked-but-unconsolidated regions can still be restored; after consolidate, cut-away area outside the new bounds is truly gone.
- Show the effective layer bounds change in the UI (handles shrink to the new box).

**Acceptance:** head-only layer consolidates to a head-sized box; canvas position visually identical; restore after consolidate is bounded by the new crop.

## 3. Puppet completion — white-fill Klein method analysis

**Problem:** finishing an unfinished puppet (generating missing body/limbs on a partial cutout) is still weak.

**Investigation finding (Ellie, 2026-10-25):** our current graphs:
- `KLEIN_REPAINT_GRAPH` (edit/harmonize): ReferenceLatent + original pixels under mask, denoise 0.45 — context-preserving, prompt-weak by design.
- `KLEIN_INPAINT_GRAPH` (Fill Area): plain mask-fenced inpaint, prompt-direct, host-side composite. No LoRA, no white fill.

The community method Alexander references: fill the masked area with **solid white**, then prompt "replace the white area" (optionally with a completion LoRA). Klein sees an explicit region to replace rather than latent noise — this often produces more deliberate completion on edit-style models than SetLatentNoiseMask at partial denoise, and composes well with the host-side composite-back we already do (unmasked pixels stay exact).

**Builder to analyze/experiment (no deploy, no restarts):**
1. Variant A — `KLEIN_WHITEFILL_GRAPH` (simple): host-side pre-fill of mask with white; prompt "Replace the white area with: {user prompt}"; full denoise (0.9–1.0); same host-side composite-back.
2. Variant B — **split-reference topology (Alexander's recollection, 2026-10-25 — primary hypothesis):** original image → VAEEncode → latent base at PARTIAL denoise; white-filled image → separate VAEEncode → ReferenceLatent; prompt "Replace the white area with: {user prompt}". Rationale: our current KLEIN_REPAINT_GRAPH feeds the SAME image to latent and reference (nodes 202/117); splitting them puts edit-target evidence in the reference channel while the latent keeps true surrounding context. Sweep denoise ~0.5/0.65/0.8.
3. Variant C — best of A/B plus any available completion LoRA from models/loras (survey candidates by name, don't train).
4. Side-by-side harness: same puppet-completion cases (unfinished body, missing limb, background extension) through current KLEIN_INPAINT_GRAPH, A, B, C.
5. Deliverable: report with output images per method + recommendation. Include failure cases (thin masks, hairline edges).

## 4. Transparency for puppet layers (raised by Alexander, same day)

**Ask:** diff/LayerDiffuse-style native transparency for puppet pieces — cutout layers with real alpha rather than matte-hacked.

**Ellie's read:** Klein (Flux 2 Klein) outputs RGB only — no native alpha channel, and LayerDiffuse exists only for SD1.5/SDXL, not Flux-family. So native transparent generation isn't available in our engine.

**Practical path:** generate RGB, derive alpha host-side with a matting model (rmbg already in the stack for drop-cutouts; the WeVisOne-VL matting probe may give better promptable mattes). Composite with true alpha in the canvas. Builder should NOT implement this yet — pending WeVisOne probe verdict; spec to follow in v1.5 if the probe passes.

**Acceptance (deferred):** a puppet layer renders with real alpha edges (hair-level detail preserved), no halo on varied backgrounds.
