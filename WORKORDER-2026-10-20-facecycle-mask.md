# Work Order — FaceCycle Review Layout + Mask/Layer Pass
**For:** Claude (external builder)
**Date:** 2026-10-20 · **Repo:** elliefox-ai/ellieedit (master, `fae8757`)
**Suite:** FaceCycle module lives almost entirely in `frontend/js/modules/facecycle.js` (~2275 lines). There are no separate repaint.js/detect.js modules — the TODO names below map to sections inside facecycle.js. Tests: `frontend/js/facecycle-sheets.test.mjs`, `facecycle-sequence.test.mjs`, `facecycle-handoff.test.mjs`, `syntax-check.test.mjs`, `test_frontend.py`.

## RULINGS on audit decisions D1–D5 (2026-10-21 01:15, Alexander approved via Ellie's recommendation)
- **D1: (a)** layers stay per-region alternatives — FaceCycle is regions/objects, not a collage editor.
- **D2: (b)+(c)** mask per layer, with a shared paint-once/target-active workflow on top. Paint targets the active layer; switching target while painting must be possible.
- **D3: re-maskable** — store raw unmasked gen output + mask snapshot (~2× memory accepted). Baked masks are the dead-end being fixed.
- **D4: (c) explicit per-run choice** for Repaint's source, defaulting to the **current composite** so generations chain. Label it in the UI; results differ per choice.
- **D5: gens follow region moves/resizes.** Also fixes finding 3.
- **Tidies approved:** remove vestigial "Edit layer" control; make the hidden Generate fallback explicit (status line saying what will be repainted); mask-edit undo if cheap.
- **Sequence:** F1 first (layer-list refactor, no visible change, existing tests pin behavior), then F2 (paint-target workflow). D2/D3 are settled — proceed.
- **Deliver as before:** patch + note; Alexander browser-checks live behavior.

## REVISION 2026-10-20 23:25 — Alexander's live check of A/B/C
1. **Tools drawer still scrolls** — the 11:00 wrap revision was slated for Patch B, but B (death-row teardown) never touched facecycle.js, so the nowrap/scrollbar from A is still live. Owed: `.fc-row.oneline` → `flex-wrap: wrap` (2-line allowance, no horizontal scrollbar) + update the nowrap test contract.
2. **Repaint drawer border** — Repaint works but lacks the clean border the Tools bar has; give the repaint drawer the same border treatment for visual consistency. Small, cosmetic.

## NOTE for Patch C (2026-10-20 13:05)
The 4 currently-red `test_dupe.py` tests (`test_deathrow_rehydration_appended_sorted`,
`test_deathrow_latest_verdict_wins`, `test_deathrow_ghost_states_resolved`,
`test_rehydrated_rows_reported_separately_from_unresolved_count`) encode the RETIRED
rehydration design (backend `5a0973a` / earlier). They are intentionally red pending your
Patch C — replace them with queue-invariant tests per work order item 6.

## REVISION 2026-10-20 11:00 — fold into Patch B (Alexander, after live use of Patch A)
The one-line Tools drawer works, but when narrow it shows a horizontal scrollbar — Alexander prefers **more vertical space over a scrollbar**: allow the row to wrap to 2 lines instead of scrolling sideways. Concretely: `.fc-row.oneline` should drop `overflow-x: auto`/`nowrap` in favor of `flex-wrap: wrap` (2-line allowance), keeping the compact single-line default on wide screens. The test asserting `flex-wrap: nowrap` (`test_task7_every_control_keeps_its_id_and_lives_in_the_right_surface`) must be updated to encode the new contract: wraps allowed, no horizontal scrollbar. Note: Patch A's `test_detect_method_fully_removed` stays valid.

## 1. Move the repaint button next to the Tools drawer
**Current:** Repaint button sits apart from the Tools drawer in the FaceCycle control area.
**Wanted:** Repaint button placed immediately adjacent to the Tools drawer, so the primary actions group together.

## 2. Remove the detect method; Tools drawer to one line
**Current:** Face detection (face-api.js, lazily loaded) lives at facecycle.js ~line 1328; wired via `detectBtn`, `detectFaceAtPoint` (~line 961), and "detect" strings in the status bar (~line 693). It is unused in practice.
**Wanted:** Delete the detect method, its button, model-loading path, and status-bar references. With detect gone, collapse the Tools drawer to a single line.

## 3. Reorganize the repaint drawer
**Current:** Repaint drawer contents stack in a column; the drawer overlays the canvas so its result can't be peeked at while open.
**Wanted:** Rebalance the elements into a more even arrangement (not one long column), and replace the overlay presentation with something that keeps the working image visible (e.g. docked/below, per the suite's offset-not-overlay layout preference).

## 4. Mask/layer workflow review + tidy (new, exploratory)
**Goal:** Alexander wants to paint a mask and cycle between different layers — including generated layers — to choose what the mask applies to. Exact UX is his call; Claude should first **review the current mask and layer approach/logic** in facecycle.js and tidy it up: how masks are stored/applied per layer, how generated layers stack, and whether cycling/selection between layers is coherent. Deliver a cleaned-up structure where mask ↔ layer relationships are explicit, then the paint-mask + cycle-layers capability on top. Flag anything that needs a product decision rather than guessing.

## 5. Death-row UI teardown (backend retired 2026-10-19, `fae8757`)
**Current:** Backend no longer populates death row (rehydration block disabled in `backend/routers/dupe.py`), but the frontend still carries the dead UI: `.dupe-deathbar`, dismiss buttons, ghost chips, "Dismiss all with no files" in `frontend/js/modules/dupe.js`.
**Wanted:** Strip or hide the dead death-row UI and its module imports (`death-row.js` queue counts if now unused). Keep `/death-row/dismiss` endpoint and ledger intact.

## 6. Queue-hardening invariant (defensive)
**Current:** Resolved state and queue membership are computed by separate filters; last night a family could show as Unresolved(0) while lingering in another list.
**Wanted:** One invariant: a family with a resolved record (or dismiss tombstone) appears in no actionable queue. Add a test that resolves a family and asserts absence from every listing state.

## Verification
- All JS node tests + `test_frontend.py` green; suite build bump per deploy convention (`sw.js` CACHE + `shell.js` BUILD) if frontend files change.
- Manual check: FaceCycle opens with one-line Tools drawer, repaint button beside it, drawer non-overlay; dupe view shows no death-row UI.
