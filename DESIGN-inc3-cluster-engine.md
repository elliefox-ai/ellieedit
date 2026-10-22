# DESIGN — Increment 3: cluster engine adoption (Meld → EllieEdit)

**Status:** design only, no code. 2026-10-22, build 2026-10-22b, HEAD 5e868ca.
**Sources:** SALVAGE.md §1/§5 (meld repo), WORKORDER-2026-10-22 (inc.3 scope),
`backend/routers/dupe.py`, `backend/dupe_scan.py` (straggler engine),
`frontend/js/modules/dupe.js` / `dupe-view.js` / `dupe-signals.js`.

---

## 1. Current EllieEdit family creation — and where Meld slots in

### How families form today (two engines, one surface)

1. **Canonical dupelib scan** (external, Windows-side):
   `POST /api/dupe/scan` shells out to `python3 -m dupelib.cli analyze
   <DUPE_ROOT>` from `~/workspace/dupe-review-v2` (subprocess, log at
   `/tmp/ellieedit-dupescan.log`). It writes `<DUPE_ROOT>/.dupes/index.json`
   and `.dupes/families/fam-<12hex>.json`. EllieEdit's router is purely a
   *reader* of that tree.
2. **In-process straggler scan** (`backend/dupe_scan.py`, wired at
   `POST /api/dupe/scan-stragglers`): walks DupeReview + gather staging,
   hashes with PIL (dhash-B 64-bit, DCT phash 64-bit incl. DC), clusters
   with union-find over T1/T2 edges, and writes **new family JSONs in the
   same `.dupes/` tree** with `source: "straggler-scan"`. Family id =
   `fam-` + sha256(sorted member abs paths joined with `|`)[:12] —
   content-derived and therefore idempotent across rescans.
3. **Verdicts** never touch the family tree: append-only JSONL ledger
   (`.dupe-verdicts.jsonl`), latest entry wins; `_family_state()` (dupe.py)
   is the single source of truth for resolved-vs-unresolved.

Family file shape: `{format: "dupe-analyzer.family", version: 1, id, root,
source, tiers, members: [{path, dhash, phash, size, mtime, (library_match)}],
edges, related}`. Members carry both hex hashes already — the dupe surface
has been hash-native from the start.

### Where Meld's pipeline slots in: **augment, not replace**

The natural seam is `backend/dupe_scan.py`, which is already an in-process
Python scan engine writing to the same family tree. Recommendation:

- **Extend `dupe_scan.py` into a v2 cluster engine** (new module
  `backend/cluster_engine.py` imported by it, keeping the straggler
  scan's provenance/jail/cache behavior), rather than touching
  `routers/dupe.py`'s scan endpoints' contract or the external dupelib
  path. The router stays the thin HTTP surface it is.
- The Meld additions (coarse/style channel, log-space aspect gate,
  greedy 1:1 pair view) become *additional signals* layered on the existing
  family model — the style channel catches same-composition-different-style
  pairs that T1/T2 hashes structurally cannot.
- Keep the dupelib external scan for bulk/initial indexing; the new engine
  handles incremental adoption and the style channel.

### Server-side vs client-side — resolved: **server-side, in Python**

The workorder floated `frontend/js/modules/dupe-signals.js`; that guess is
wrong and the code settles it: `dupe.py` is a Python FastAPI router,
`dupe_scan.py` already does the exact dhash/phash/union-find work
server-side with numpy (including a vectorized `np.bitwise_count` path), and
Meld's engine is numpy/OpenCV. A JS reimplementation would be a third copy of
hashing code with new precision semantics to keep in lockstep for zero gain —
scans are already background jobs with status polling. **The hash engine
lives in the backend.** `dupe-signals.js` remains (as today) presentation
only.

---

## 2. Meld pipeline stage-by-stage → EllieEdit disposition

| Meld stage | Disposition | Detail |
|---|---|---|
| dhash 64-bit (gray, 9×8, INTER_AREA, packbits) | **Reimplement** in `cluster_engine.py`, aligned to existing hashes | Note: `dupe_scan.py` already has a dhash; Meld's differs only in interpolation (cv2 INTER_AREA vs PIL BILINEAR). Keep ONE implementation (PIL-based, as today) — don't fork. Distances/tolerances unchanged. |
| phash 63-bit (DCT 32×32, drop DC, median bits) | **Reimplement as an additive signal** | ⚠️ **FLAG (code/SALVAGE disagreement):** dupelib/dupe_scan phash is **64-bit incl. DC**; Meld's is **63-bit dropping DC and thresholding at median**. These are *different hashes* — distances are not comparable. Design: compute Meld's DC-dropped variant alongside the existing one; keep the existing 64-bit hash as the T1/T2 tier source (families/edges/library cache depend on it) and use the 63-bit variant only for Meld-mode pairing. Never mix the two in one distance. |
| coarse style signature (16×16 blurred, mean-centered, L2-norm; dot = Pearson r; min_corr 0.55) | **Reimplement (new)** | No equivalent exists in EllieEdit. Needs float32 storage (256 floats/file). Base64 in the cache blob like Meld's `files.json`. This is the only genuinely new capability. Style pairs with r > 0.999 are excluded (SALVAGE §5.7) — near-identical structure is dhash's job. |
| Chunked Hamming distance (CH=512, unpackbits) | **Reuse pattern as-is** | Direct numpy port; dupe_scan already has the same idea with bitwise_count. 512-chunk budget kept for memory on the 6k-file pool. |
| Edge filter `(d<=tol) & (d>=1) & i<j & aspect` | **Adopt with the d≥1 trap designed around** — see §3a | Meld defaults: dhash tol 6/64, phash tol 10/63, ar_tol 0.15. |
| Log-space aspect gate `|log ari − log arj| <= log1p(ar_tol)` | **Adopt (new)** | EllieEdit has no aspect gate at all today; 4:5 vs 5:4 twins currently cluster together. Requires storing `ar` per file (Meld's `IMREAD_REDUCED_COLOR_4` preserves w/h; PIL resize to square patches must use the *original* dims — compute ar before any resize). `ar_tol <= 0` disables. |
| Greedy 1:1 pairing (sort by distance, take if both endpoints free) | **Adopt** as the *pair-review surface* | Families remain the review unit; greedy pairs become `edges` entries with `mode` recorded (`exact/phash/style`), matching Meld's pair record shape. One pair per member keeps the meld canvas 1:1 (meld already caps at MELD_MAX=8). |
| Connected-component clustering via union-find over the filtered edges | **Adopt, replacing nothing** | dupe_scan already union-finds; the change is the edge predicate (adds aspect gate, style channel) and the d==0 inclusion rule — see §3a. Components map to family ids as in §3. |

**Dropped:** Meld's `.meld/` state/cache files, `done_map` pair-keyed
bookkeeping (`a|||b`), recycle pass, thumbnails-in-scan (dupe view has its own
thumb pipeline via `get_thumbnail`). Verdict bookkeeping stays 100% ledger.

---

## 3. The two traps, designed around

### (a) d==0 exact duplicates: excluded from pairs, included in clusters

Meld's edge mask excludes `d == 0` from *pairs* because merging identical
images is a no-op — but the *cluster* union-find must run on edges that
include d==0, or identical twins land in different families (SALVAGE §5.6).
Concretely:

- **Two edge sets from one distance computation:**
  - `pair_edges`: `(d <= tol) & (d >= 1) & i<j & aspect_pass` (+ style
    channel `0.55 <= r <= 0.999`) → greedy 1:1 → family `edges`.
  - `cluster_edges`: same predicate **minus `d >= 1`** → union-find →
    family membership.
- Note the *existing* straggler engine gets this right by accident
  (`exact | t1 | t2` all feed union-find) but has no pair-level exclusion;
  the new engine makes both rules explicit and tested.
- **Family-id mapping preserving this:** the existing id scheme is
  content-derived: `fam-sha256("|".join(sorted(abs_paths)))[:12]`. Cluster
  membership determines the sorted member list, therefore the id — d==0
  twins are *members*, so they are inside the id anchor and can never be
  orphaned. Greedy pairs (d≥1) affect only the `edges`/`tiers` fields, never
  the id. A pair whose endpoints end up in the same family by the cluster
  edge set still records its edge; a d==0 member contributes "exact" to
  `tiers` but never appears as a greedy pair endpoint when a shorter edge
  takes it first.

### (b) The queue invariant — never re-derive resolved-vs-unresolved

`_family_state()` (dupe.py, "queue-hardening invariant, 2026-10-20") is the
only resolver; `/families` additionally re-filters the unresolved queue
through it post-construction. The cluster engine must not create a second
opinion. Rules for the new engine and any migration:

- The engine **only writes**: family JSONs + `index.json` (atomic replace of
  only its own `source`-marked rows, exactly as dupe_scan does today). It
  **never reads or writes the ledger**, never computes state, never filters
  by verdict. All listing/count/state flow keeps going through
  `_family_state()` — the engine's output changes *which families exist*,
  never *what state they're in*.
- **Id stability carries verdicts across rescans:** because
  `fam-<sha256(sorted members)[:12]>` is a pure function of membership,
  an incremental rescan that finds the same members regenerates the *same*
  id, and the ledger's latest verdict for that id still applies. A cluster
  that *gained* a member gets a new id — the old id stays resolved in the
  ledger (untouched, append-only), the new family enters as unresolved.
  This is the accepted cost: membership change = re-review, which is also
  what the straggler replace-on-rescan semantics imply today.
- The queue-invariant guard (`rows = [r for r in rows if _family_state(...)
  == "unresolved"]`) needs no change because the engine adds no new row
  source to `/families` — it only mutates `index.json`.

---

## 4. Migration & coexistence

### Existing families and verdicts

- Verdict-era families are **never rewritten** (same rule dupe_scan already
  follows: "verdict-era families never are" replaced). The v2 engine writes
  under a distinct provenance `source: "cluster-engine-v2"` (or extends the
  straggler replace-only-own-source pattern).
- Ledgers are append-only and keyed by family id — nothing to migrate there
  as long as ids stay content-derived (§3b).
- Coexistence is by-index-row: dupelib rows, straggler rows, and v2 rows sit
  in the same `index.json` with distinct `source` values; the existing
  `/families?source=` filter already supports this.

### Cache schema versioning

- Extend the straggler cache (`hashes` table keyed path+size+mtime) with new
  columns/keys for `phash63`, `coarse` (float32 blob), `ar`. Adopt Meld's
  presence-check guard verbatim (SALVAGE §1.1 / §5.9): **a cache entry is
  valid only if `key` matches AND the new fields are present** — missing
  `phash63`/`coarse`/`ar` ⇒ recompute that file, not fatal. Add a schema
  version int to the store header so future field additions retire rows
  wholesale instead of per-field probing.
- Coexisting hash dialects (64-bit incl-DC tier hash vs 63-bit Meld-mode
  hash) are stored under distinct names and never compared to each other —
  the version field plus field names make a cross-dialect comparison a
  programming error, not silent data.

---

## 5. Test plan

Named gates; all in existing pytest dupe style (`tests/test_dupe_scan.py`
pattern). The workorder's synthetic-folder smoke test is gate 0.

- **T0 smoke-synthetic-folder** (SALVAGE §1.5 guard, blocks cutover):
  generated corpus of near-twins (recompression, brightness, crop), a
  3-way exact-triplet, same-composition-different-style pair, and unrelated
  images. Assert: exact triplet lands in ONE family despite d==0 (trap a);
  style pair clusters only via the style channel; unrelated images stay
  singletons.
- **T1 hash parity:** dhash/phash distances vs hardcoded vectors; 63-bit vs
  64-bit hashes are never comparable (assert a mixed-distance lookup raises
  or returns None).
- **T2 pair-exclusion:** two identical images produce **no** greedy pair but
  **one** family (trap a, named test).
- **T3 aspect gate:** 4:5 vs 5:4 twins at equal distance are gated apart;
  `ar_tol=0` disables the gate (log-space symmetry asserted both directions).
- **T4 greedy 1:1:** chain a–b (d=2), b–c (d=1) yields pair (b,c) not
  (a,b); no member appears in two pairs.
- **T5 queue invariant (trap b, named test):** after an engine rescan that
  replaces its own families, `/families?state=unresolved` contains zero
  families whose `_family_state` is resolved; a family id unchanged across
  the rescan keeps its committed state; a family that gained a member
  re-enters unresolved with a new id while the old id's ledger entry is
  untouched.
- **T6 cache guard:** entry with matching key but missing `phash63`/`ar`
  is recomputed (SALVAGE §5.9), not trusted; store schema bump retires old
  rows.
- **T7 idempotence:** engine run twice → same ids, same index rows, ledger
  byte-identical (untouched).

---

## 6. Open questions for Alexander

1. **Re-scan vs incremental?** Does the v2 engine re-cluster the *whole*
   pool (correct global clusters, but new ids for any family that changes ⇒
   re-review of some committed families), or run incrementally (only new
   files, stable old ids, but clusters frozen at first-scan membership)?
   Recommendation: incremental with an opt-in full rebuild command.
2. **Is this THE scan engine?** If the dupe cluster engine becomes the
   canonical scanner for both dupe review and future scene/meld use, do we
   retire the external dupelib subprocess path (`/api/dupe/scan`), or keep
   both indefinitely? Keeping both means three hash dialects in one cache
   (dupelib, straggler, v2) — a real complexity cost.
3. **Aspect gate defaults:** Meld's ar_tol=0.15 was tuned on art renders.
   Acceptable for the photo-heavy DupeReview pool, or should the gate ship
   disabled (ar_tol=0) until we see what it does to the 627 existing
   families?
4. **Style-channel threshold:** min_corr 0.55 (Meld's default) on a pool
   this size will generate style families that may be mostly noise. Ship at
   0.55, or start conservative (0.7+) and calibrate against the
   signals/override telemetry?
5. **Where do style-only families surface?** A new `source` means a new
   filter chip in the dupe UI. Fold them into the main unresolved queue, or
   keep them behind the source filter until calibrated (my recommendation)?

---

## Guess flags (code disagreed with SALVAGE/workorder — resolved here)

- **G1:** Workorder proposed `frontend/js/modules/dupe-signals.js` for
  hash work; the backend already does all hashing/clustering in Python
  (`dupe_scan.py`). Resolved: server-side (§1).
- **G2:** SALVAGE's phash is 63-bit DC-dropped; EllieEdit's existing phash
  is 64-bit including DC — different hashes, incomparable distances.
  Resolved: dual storage, never mixed (§2, §4).
- **G3:** SALVAGE assumes cv2/OpenCV; `dupe_scan.py` is PIL/numpy. Keeping
  PIL (one implementation), matching Meld's *semantics* (INTER_AREA ≈
  PIL `Image.LANCZOS`/`BILINEAR` differences must be covered by T1
  tolerance vectors), not adding an OpenCV dependency for scans.
- **G4:** Meld's `done_map` is pair-keyed; EllieEdit's verdicts are
  family-keyed with a richer lifecycle (reopen, tombstones, death row).
  No port of `done_map` — the ledger model supersedes it (§3b).
