# WORKORDER — Meld integration into EllieEdit dupe surface (2026-10-22)

Source spec: `/home/zengonzo/workspace/meld/SALVAGE.md` (organ-donor map from the
decommissioned Meld standalone). Direction decided: **no new tab** — everything
folds into the dupe view's existing meld surface (dupe family → meld select →
FaceCycle paint canvas).

## Increment 1 — divergence-mask pre-seed (SALVAGE §3)

**Scope.** One client-side button on the existing mask-paint surface (FaceCycle
draw-mask mode, where dupe meld batches land). Computes the "where do the twins
disagree" suggestion mask entirely client-side and paints it into the working
mask canvas as an editable starting state.

- Port exactly: gray float32 → `|A−B|` → Gaussian blur σ=2 → threshold
  `max(8.0, 6·MAD)` (MAD = median(diff) + 1e-6, floor absolute) → 9×9 dilate.
  Cite the contract in a comment at the implementation.
- Working space = FaceCycle canvas space (`state.width×state.height`), consistent
  with C1's "work where the preview is" (images are already normalized there).
- Base/donor pair = current base variant vs the first other loaded image;
  disabled with a title hint when fewer than 2 images are loaded.
- Undo: pushes a working-canvas snapshot as a new undo entry type; fully
  editable afterward with the normal brush/erase.

**Files.** `frontend/js/modules/meld-divergence.js` (new, pure CV, exported for
tests); `frontend/js/modules/facecycle.js` (button + `preseedMask()` + undo
entry); build bump in `frontend/sw.js` + `frontend/js/shell.js`.

**Gates.** `node --test tests/js/` (all files) and `.venv/bin/python -m pytest
tests/ -q` pass; a small algorithm+wiring test in the existing dupe/facecycle
test style. No deploy/restart.

## Increment 2 — blend contracts C1–C7 audit (SALVAGE §2)

**Scope.** Audit the current dupe meld blend path (FaceCycle composite +
`/api/dupe/.../meld-save`) against Meld's C1–C7 invariants; produce a gap list
and fix what is cheap: C1 resolution parity (downscale-only, smaller member
wins), C3 cap-before-feather ordering wherever an edge-stop cap meets feather,
C4 invert semantics, C5 mask decode tolerances. C2 (exact LAB seam match), C6
(containment), C7 (retouch) are design notes unless the audit finds the dupe
blend already needs them.

**Files.** Read-first: `frontend/js/modules/facecycle.js` (composite/export),
`tests/test_dupe.py` + server meld-save route. Fixes land beside what they
touch; each contract gets a citing comment.

**Gates.** Full JS+pytest suites pass; audit notes appended to this file with
per-contract verdicts (satisfied / gap / not-applicable-to-dupe).

## Increment 3 — cluster engine adoption (SALVAGE §1, design-first)

**Scope.** Adopt the signature trio (dhash 64-bit / phash 63-bit / coarse
16×16 Pearson), the `d>=1`-excluding-but-clusters-including-d==0 edge set, the
log-space aspect gate, greedy 1:1 pairing, and union-find family ids — aligned
with the existing dupe scan engine rather than replacing it. Interacts with the
queue invariant (dupe scan/straggler machinery) — **design document first**,
implementation only after the alignment is agreed. Cache schema must carry the
`phash`/`ar` validity guard (§1.1/§5.9).

**Files (design doc proposes final list).** Likely `frontend/js/modules/dupe-signals.js`,
server dupe scan (`tests/test_dupe_scan.py` covers it), cache layout.

**Gates.** Design doc reviewed before code; synthetic-folder smoke test
(near-twins + unrelated images, SALVAGE §1.5 guard) against ported
hash/cluster functions before any cutover; full suites pass.

---
*Order: 1 → 2 → 3. Increment 1 landed 2026-10-22 (commit `dupe: meld integration inc.1`).*
