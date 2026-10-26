# WORKORDER-2026-10-26-echo-fx-send-seed — Gallery/Library FaceCycle send + FoxDen seed/row UX

Requested by Alexander, 2026-10-26. Two items, both frontend-only. No backend changes expected. Build bump + deploy per the standard suite deploy procedure (BUILD + CACHE in sw.js/shell.js, gates, restart, verify served bytes).

## 1. Send a single image to FaceCycle from Gallery and Library

**Problem:** FaceCycle redo-faces only reachable by awkward routes — from Gallery you must multi-select two images and delete one; from Library there is no path at all.

**Existing machinery (verified 2026-10-26):** the v1.5.1 send-to framework already supports it. `frontend/js/send-to.js` registers `SEND_TARGETS = ['facecycle', 'update', 'puppet', 'foxden']`, maps `facecycle` to the `ellieedit:facecycle-handoff` event, and `FACECYCLE_MAX = 8` (thumb strip cap). Receivers are done. The gap is that Gallery and Library never dispatch it:

- `frontend/js/modules/gallery.js` (~line 707): its multi-select send-to is hardwired to Puppet only.
- `frontend/js/modules/library.js` (viewer bar, ~line 7): has ✎ send-to-update only.

**Spec:**
- Gallery: add FaceCycle to the send-to menu. Must work for a single selected image (today's flow requires ≥2). Route through the standard `ellieedit:send-to` dispatch with server urls — no data urls.
- Library: add a send-to-FaceCycle action in the viewer bar next to the existing send-to-update, same event pattern.
- No backend work; FaceCycle already accepts 1–8 images via handoff.

**Acceptance:** from Gallery, select one image → send-to → FaceCycle → FaceCycle tab activates with the image in its thumb strip. Same from the Library viewer. Multi-select up to 8 works from both. Puppet/Update sends unchanged.

## 2. FoxDen seed lock + compact Generate row

**Problem:** FoxDen has a lock-icon checkbox labeled "seed" that does nothing observable (seed never auto-changes; there is no lock logic behind it). The Generate button wastes a whole row.

**Spec:**
- Implement real seed-lock semantics: lock **checked** = keep the typed seed across generates; lock **unchecked** (default) = a fresh random seed on every generate. The seed field should visibly update to the new random value after each generate so the behavior is legible.
- Restyle the control as a compact lock checkbox placed directly beside the seed field (icon-only checkbox with a lock glyph — coherent because it sits next to the seed it locks).
- Move Generate onto the same row as seed + lock, sized down to fit. Keep the generate/async-state feedback (progress/errors) unchanged elsewhere.
- Default state on load: unchecked (random).

**Acceptance:** with lock unchecked, three consecutive generates consume three different seeds (seed field updates each time); checking the lock pins the seed — same seed reproduces the same output; layout is one row, no orphaned full-width button. Existing foxden tests (57) stay green; add coverage for the seed-roll logic where the module is testable headless.

## Constraints

- Standard gates: full pytest suite green; extend any pinned assertions if touched.
- No restarts outside the documented deploy step; verify badge/BUILD markers after.
- FoxDen backend untouched this order (today's `moss` registry work is separate and already deployed).
