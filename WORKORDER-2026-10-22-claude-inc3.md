# WORKORDER — Increment 3 build: cluster engine v2 (Meld supplementary signal)

**Builder:** Claude (external) · **Author:** Ellie · **Date:** 2026-10-22
**Repo:** `github.com/elliefox-ai/ellieedit` (branch `master`) — clone/pull it; do NOT work from memory of earlier tasks.
**Base at authoring:** `b9d8911`, build `2026-10-22b`.
**Read first, in order:** `DESIGN-inc3-cluster-engine.md` (the authoritative spec — this work order delegates detail to it), `backend/dupe_scan.py`, `backend/routers/dupe.py`, `WORKORDER-2026-10-22-meld-integration.md` (context: inc.1/2 already landed).

## Scope

Build Increment 3 exactly as designed in `DESIGN-inc3-cluster-engine.md` rev.2. The design doc's rulings (marked RULED 2026-10-22), traps (§3), test gates (§5: T0–T7), and guess-flag resolutions (G1–G4) are binding. Summary, not a substitute:

1. **New module `backend/cluster_engine.py`** — Meld-style supplementary signal: DC-dropped 63-bit phash variant, 16×16 coarse style signature (float32, Pearson-r matching, ship threshold 0.7, exclusion band r > 0.999), chunked Hamming, dual edge sets (pair vs cluster — the d==0 trap §3a), greedy 1:1 pairing, union-find clustering. Existing `dupe_scan.py` stays primary; import/extend, don't fork its hashing. PIL/numpy only — **no new OpenCV dependency** (G3).
2. **Incremental scan** (§3c): never rewrites past reviews; writes only families + `index.json` rows under a distinct `source: "cluster-engine-v2"`; never touches the verdict ledger or computes family state — `_family_state()` remains the sole resolver (§3b, gate T5).
3. **Membership proposals** (§3c): a new file matching ≥1 member of exactly one existing family emits `proposed_merge` annotation instead of silently mutating the committed family. Multi-family match → no proposal. Named test T3.
4. **Cache**: extend the straggler cache with `phash63` + `coarse` fields; presence-check guard (missing ⇒ recompute, never fatal); schema version int in the store header (§4, gate T6).
5. **Frontend, minimal**: (a) unresolved families with a `proposed_merge` annotation render the "proposed merge into fam-xxxx" badge + side-by-side, resolvable by the existing verdict controls (merge/separate semantics per §3c.3); (b) **Families | Dates segmented toggle** in the dupe view header — dates is a pure frontend regrouping by member mtime, read-oriented, no verdict casting of its own (§7). Nothing else in the frontend.
6. **Full rebuild**: implement as CLI-only (`python -m backend.dupe_scan --rebuild` path) — resolves open question 1. It is never part of routine scans.

## Ground rules (verified every round)

- Verify every line number, symbol, and id against the current repo before editing; the specs are written from a read of the real code but HEAD moves.
- Tests: T0–T7 from design §5 as pytest in the existing `tests/test_dupe_scan.py` style. The synthetic-folder smoke (T0) is the cutover gate.
- Work in granular commits on a named branch (suggest `claude-inc3-cluster-engine`); final delivery as a **git bundle of that branch** (plus patch series as fallback). Repo is public — if you have fetch access, clone and push the branch instead of bundling.
- **No server restarts, no deploy-marker bumps** (do not touch `frontend/sw.js` / `shell.js` BUILD) — deploys stay with the verifier.
- Report anything in the design that turned out wrong or missing — deviation reports from previous rounds carried real findings and are checked, not punished.

## Handoff

Deliver: branch bundle (or pushed branch) + VERIFY checklist + report (what you built, test counts from your sandbox — expected partial — and every spec deviation with rationale). The verifier runs the full pytest suite operator-side, deploys, and live-probes the proposed-merge flow.
