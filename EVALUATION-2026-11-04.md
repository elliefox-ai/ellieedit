# EllieEdit — Evaluation & Direction (Ellie, 2026-11-04 evening)

## What the suite is (my honest read)

EllieEdit is a **personal image studio organized around a curation loop**:
generate (FoxDen) → edit (Update) → review/curate (Review/Dupe) → archive
(Gallery/Library) → reuse (input images, Send To, LoRAs, Meld). Nine backend
routers, ~14K lines of frontend modules, ~7.2K lines of backend. The identity
that has emerged — not by top-down design but by accretion — is *the loop*:
nothing is a dead end; images flow between modules. That is the suite's real
strength and it should drive the next direction, not feature patches.

## Strengths (keep and lean in)

1. **The flow between modules is genuine.** Send To (shared payload), the
   gallery/library roots, FoxDen input images, Update's promote-to-library —
   the loop closes. Very few personal tools have this.
2. **Engineering discipline.** Build-marker staleness guard, per-module pure-JS
   test files (~30 suites), pytest at 434+, deploy gates, the workflow slot
   discovery design (no UI node graph). The suite is maintainable — rare.
3. **Curation as a first-class act.** Dupe review with reversible marks,
   keep/reject staging, Library separate from Gallery. The suite treats
   "deciding what's good" as a feature, not an afterthought.

## Weaknesses (the honest list)

1. **Provenance is not a system.** PR #12 already admitted "provenance is
   dropped by the existing router for Puppet/FoxDen." Some images carry
   prompt/workflow/seed; some don't; Library metadata is partial (that's
   Echo's PR #13 / issue #6 in flight). There is no unified "where did this
   image come from and how do I get that look again" capability.
2. **No way to reproduce or search the past.** You cannot ask "find every
   image generated with workflow krea2 and prompt containing 'lantern'" —
   the data mostly exists but is not indexed or queryable.
3. **Generation is one-at-a-time.** No batch/queue: no "give me 8 variants of
   this prompt while I curate the last batch." For a curation-centric suite,
   this is the biggest single workflow gap. `pending.py` exists (272 lines)
   but is plumbing, not a user-facing queue.
4. **Mobile is broken (issue #2)** and the suite is increasingly used on the
   iPad. This is now a usage blocker, not a nicety.
5. **Small papercuts:** input picker unsorted/unlarge (issue #5); Library
   finals overwrite 409 open question; rotating backup unimplemented;
   Meld awaits its first real folder.

## Ranked directions

**A. Provenance & search layer (recommended foundation).** Every image,
everywhere, carries: prompt, workflow, seed, steps, size, loras, source
module, timestamp, parent (for edits/transforms). Stored once in a single
index; Gallery/Library/FoxDen all read from it. Then a global search box:
"all lantern prompts, krea2, landscape." This is the prerequisite for
everything else — without it, batch and style-reuse features sit on sand.
Echo's PR #13 is a step on this path; extend it into the system, don't
stop at viewer details lines.

**B. Batch queue + curation loop (recommended headline feature).**
"Generate N" with a visible queue and a triage surface (grid, keyboard
keep/reject, auto-route keepers to Gallery). This converts the suite from
a toolbox into a *studio* — and it directly exercises the curation strength.
Design note: reuse `pending.py`; keep the queue resumable across restarts.

**C. Style reuse / "make me more like this."** The loop's missing edge:
pick a keeper image → "use as style/input reference" in FoxDen (img2img
strength control, or multi-reference where the model supports it). Turns
curation output into generation input — the loop eats its own tail, in a
good way. Depends on A (the reference needs to carry its recipe).

**D. Mobile/iPad pass (issue #2).** Real fix, not just responsive CSS:
touch targets, panel layout on narrow screens, zoom-viewer gestures. Do it
after A/B — doing it first means re-doing surfaces that B will change.

**E. Small set (can ride along any PR):** input picker MRU sort + larger
picker (#5), Library overwrite/index-refresh decision from PR #12, rotating
backup, Meld's first real folder.

## What I would NOT do

- No new generation modules. Nine surfaces is already at the coherence limit;
  the value now is depth in the loop, not breadth of tools.
- No workflow editor UI. The backend slot-discovery design is better than a
  node graph for this scale; don't replace it.

## Suggested sequence

A1: unified provenance record on write paths (small, Echo-sized)
A2: index + global search (medium)
B: batch queue + triage (large, best done by Echo with Ellie landing)
C: style-reference edge (medium, after A)
D: mobile pass (medium, after B settles surfaces)

## Appendix: first-time-user walkthrough findings (2026-11-04)
Structured browser walkthrough of all 9 tabs, one live generation (576x1024, exact dims, 63s — confirms the krea2/qwen workflow wiring fix end-to-end), 390px mobile pass. Full per-module friction/missing/delight report held in session notes; headline findings:

- Suite identity confirmed by fresh eyes: "safety-first, documentation-dense personal pipeline... The Send-to graph between modules is the real product; the weakness is discoverability."
- Deletion semantics split across three UI places with no unified view.
- FoxDen LoRA panel = 40+ raw Windows paths, no search. Worst wall in the suite.
- FoxDen results don't visibly land anywhere (Gallery starts at root; jobbar empty during generation).
- Gallery: ~75 flat folder tiles, no thumbnails/search/breadcrumbs.
- Ladder unreachable without Gallery multiselect. Tab order doesn't match workflow order.
- Mobile tabbar overflows/clips (982px content on 390px viewport).

Top-10 ranked fixes filed as GitHub issue "UX pass: first-time walkthrough findings".
