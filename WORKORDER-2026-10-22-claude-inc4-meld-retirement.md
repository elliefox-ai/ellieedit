# WORKORDER — Increment 4: retire the standalone Meld app

**Author:** Ellie (verifier) · **Builder:** Claude · **Date:** 2026-10-22
**Base:** current `master` (post puppet-theater v1.1, `0661001`, build 2026-10-22e).
**Branch:** `claude-inc4-meld-retirement`. Verify all ids/line numbers against
current HEAD before editing.
**Context:** Alexander's direction — the standalone Meld app
(`~/workspace/meld`, FastAPI + static canvas app) has minimal live use cases,
and they are covered elsewhere. Target shape: **dupe view = deciding
relationships; FaceCycle = combining images; one app (EllieEdit), not two.**

## First: inventory, don't assume
Survey `~/workspace/meld` (meld.py, SALVAGE.md, static/) and enumerate every
user-facing behavior that is NOT already in EllieEdit. EllieEdit already has:
- the meld surface in dupe (`dupe.js`, `dupe-view.js`, `meld-divergence.js` —
  inc.1 divergence pre-seed "Pre-seed Δ" button lives in FaceCycle);
- FaceCycle's mask tooling: Draw Mask, box/mask repaint, pending-preview
  Keep/Discard/Undo, apply-mask-to-layer cycling;
- the salvage contract ported client-side (see `meld-divergence.js` header —
  SALVAGE.md §3 algorithm already ported exactly).
List what remains Meld-only and map each item to: **port / drop / defer**,
with a one-line justification. Include this inventory in the handoff.

## Expected port targets (confirm via inventory)
1. **Mask swapping** — Alexander's named use case: take a mask (or masked
   region) from one image and apply it to another (swap heads/regions between
   pair members). Port into FaceCycle as a natural extension of the existing
   apply-mask-to-layer cycle (the `[ ]` cycle + ✓ Apply pattern already
   generalizes to this — two images, mask travels between them).
2. **Edge-filter candidate pairs** (SALVAGE.md §2, `compute_edge` +
   `aspect_mask`) — if still used as a *candidate selection* aid, port the
   algorithm into `dupe_scan`/`dupe` as an optional pre-filter producing
   proposals; if unused in practice, propose dropping (ask, don't decide).
3. **seam_match LAB transfer** (SALVAGE.md C2) — check whether FaceCycle's
   repaint path covers the same need; if yes, propose drop; if no, scope the
   port explicitly (this one is nontrivial — LAB float32, raw-mask statistics).

## Constraints
- **Read SALVAGE.md fully** before porting anything. It encodes hard-won
  corrections (the alpha-tint incident §5, keyed-by-pair vs family §1.4).
  Preserve those lessons verbatim where the ported code survives.
- The dupe **ledger is append-only**: no changes to verdict vocabulary or
  existing records. New verbs only if a port genuinely needs one (flag it).
- No new standalone surfaces. Everything lands in existing tabs.
- Ported algorithms port **exactly** first (like meld-divergence.js did),
  then adapt. Tuning-surface comments in the header, same convention.
- Tests: each ported behavior gets a node or pytest test proving parity with
  the Meld original (fixed-input → expected-output pairs from meld.py tests
  where they exist). Suites green at handoff (env skips ok).

## Non-goals
- No changes to Puppet Theater (Echo's active territory).
- No dupe scan/engine changes beyond an optional candidate pre-filter.
- No Gallery/entry-point work (separate future increment).

## Delivery
Same pipeline: git bundle on `claude-inc4-meld-retirement` + git-am patch
series, **zipped** (bundle text-mangles in transit — learned twice today).
SHA-256 both. No `sw.js`/`shell.js` bumps, no restarts — operator lands.
The handoff must include the inventory table (behavior → port/drop/defer →
where it lands) so Alexander can veto drops before they happen.
