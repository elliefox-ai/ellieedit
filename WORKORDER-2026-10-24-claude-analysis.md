# WORKORDER — Analysis & planning (no code): inpaint consolidation + library navigation

**Date:** 2026-10-24 · **Builder:** claude · **Type:** ANALYSIS ONLY — deliver a
written report + proposal per topic. Do not write code. Base: current `master`
plus a read of the existing surfaces named below.

## Topic 1 — simple-inpaint consolidation (Update vs FoxDen)
Alexander: "We still could use a comprehensive solution for simple inpaint
tasks. Currently we have Update and FoxDen. Possible consolidation into a more
comprehensive singular tool — needs real analysis."
Survey both surfaces (frontend/js/modules/update.js, foxden.js; backend
routers/update.py, foxden.py; the FoxDen workflow registry incl. qwen21) and
map: which inpaint-ish tasks each covers today (region edit, restyle,
full re-render, mask flows), where they overlap, what Update has that FoxDen
lacks and vice versa (presets, prompt library, mask painting, multi-image).
Deliver: a comparison matrix, a recommended target shape (consolidate? keep
both with clearer division? new surface?), a migration/compat stance for
existing presets and prompt libraries, and a phased plan. No code.

## Topic 2 — Library purpose & navigation
Alexander: "Library desperately needs improved navigation — filtering, paging,
any or all. Probably a serious analysis to evaluate its purpose and how we
want it to perform."
Survey the library surface (frontend/js/modules/library.js, backend
routers/library.py), its current size/shape, how it relates to Gallery and
promote flow. Deliver: a purpose statement (what the library is FOR in the
suite), current pain points, a recommended navigation model (filtering,
paging, tags — evaluate, don't just list), and a phased plan. No code.

## Delivery
One markdown report per topic (or one combined), via the usual zip/bundle
channel to /mnt/shared/_Outgoing. No build bumps, no restarts, no code edits.

---

## Answers to Claude's questions (Ellie per Alexander, 2026-10-24 15:11)

**Inpaint:** "simple inpaint" = REGION EDIT WITH A PROMPT ON ANY IMAGE — the
gap Claude identified. Not prompted whole-image edit (Update's plain transform
already covers that). So the recommendation stands: add an optional mask layer
+ masked-inpaint recipe to Update, with the shared ComfyUI engine layer.

**Library model:** YES on both — finals are the default view, originals are
reached through their family, and project is the main browse axis. Phase 0
(fix tag-bar bug, show families, add send-to, add timing) is approved as the
first slice. The five timing commands from Section 5 of the Library report
should be run operator-side before deciding cache-vs-UI ordering.

**Routing note:** Claude is unreachable until 19:30 PDT — any resulting build
work from these analyses may be handed to Echo instead, using this file plus
the reports as spec.
