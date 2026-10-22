# DESIGN — Increment 3: cluster engine adoption (Meld → EllieEdit)

**Status:** design rev.2 — revised per Alexander's rulings of 2026-10-22
(blend engines, incremental scan, aspect gate dropped, dual views).
Design only, no code. 2026-10-22, HEAD 42cee02.
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

### Where Meld's pipeline slots in: **augment, not replace** (RULED 2026-10-22)

The natural seam is `backend/dupe_scan.py`, which is already an in-process
Python scan engine writing to the same family tree. Ruling: the existing
dupe_scan engine **stays primary** — nothing is replaced or retired.

- **`dupe_scan.py` keeps its T1/T2 union-find scan as the primary
  clustering engine.** Meld's refinements are **added as supplementary
  signal** on top: the coarse/style channel (catches
  same-composition-different-style pairs that T1/T2 hashes structurally
  cannot), Meld's DC-dropped phash variant for Meld-mode pairing, and the
  greedy 1:1 pair view. Implemented in a new module
  `backend/cluster_engine.py` imported by `dupe_scan.py`, keeping the
  straggler scan's provenance/jail/cache behavior. The router
  (`routers/dupe.py`) stays the thin HTTP surface it is.
- **The external dupelib tool is not retired.** `POST /api/dupe/scan`
  remains the bulk/initial indexing path indefinitely. All three scan
  paths (dupelib, straggler scan, supplementary Meld signal) coexist by
  `source` rows in the same `index.json`.

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
| coarse style signature (16×16 blurred, mean-centered, L2-norm; dot = Pearson r; min_corr 0.55) | **Reimplement (new)** | No equivalent exists in EllieEdit. Needs float32 storage (256 floats/file). Base64 in the cache blob like Meld's `files.json`. This is the only genuinely new capability. Style pairs with r > 0.999 are excluded (SALVAGE §5.7) — near-identical structure is dhash's job. **Ships conservative: threshold 0.7+ (not Meld's 0.55), calibrated later against signals/override telemetry (RULED 2026-10-22).** |
| Chunked Hamming distance (CH=512, unpackbits) | **Reuse pattern as-is** | Direct numpy port; dupe_scan already has the same idea with bitwise_count. 512-chunk budget kept for memory on the 6k-file pool. |
| Edge filter `(d<=tol) & (d>=1) & i<j` | **Adopt with the d≥1 trap designed around** — see §3a | Meld defaults: dhash tol 6/64, phash tol 10/63. |
| Log-space aspect gate | **Considered and dropped from scope (Alexander, 2026-10-22).** Rationale: the corpus is restyles of the same scene — mixed orientations are not a concern; the gate's cost (a stored `ar` per file, a new cache field, a new test dimension) buys nothing on this pool. Revisit only if the pool ever mixes genuinely different scenes at different crops. |
| Greedy 1:1 pairing (sort by distance, take if both endpoints free) | **Adopt** as the *pair-review surface* | Families remain the review unit; greedy pairs become `edges` entries with `mode` recorded (`exact/phash/style`), matching Meld's pair record shape. One pair per member keeps the meld canvas 1:1 (meld already caps at MELD_MAX=8). |
| Connected-component clustering via union-find over the filtered edges | **Adopt, replacing nothing** | dupe_scan already union-finds; the change is the edge predicate (adds the style channel) and the d==0 inclusion rule — see §3a. Components map to family ids as in §3. |

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
  - `pair_edges`: `(d <= tol) & (d >= 1) & i<j` (+ style
    channel `0.7 <= r <= 0.999` at ship, calibrated later) → greedy 1:1 → family `edges`.
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

### (c) Scan mode: incremental, past reviews untouched (RULED 2026-10-22)

The engine runs **incrementally**: it scans only files not already
covered by a family whose id is content-stable, and it **never rewrites
past reviews**. Existing verdict-era and committed families are untouched
on disk and in the ledger. A full rebuild exists as an explicit, opt-in
command for the day the clustering logic itself changes — never as part
of routine scans.

#### New image meets an existing family

The designed answer to "how does a NEW image whose near-duplicate
partners already live in an EXISTING family get integrated?":

1. **Hash-match against existing family members.** For each new file,
   the engine computes its hashes, then looks them up against the
   family tree: every existing family's member hashes are already in
   the family JSONs (and the cache), and the engine checks the new
   file's distance to each family's members under the same T1/T2 (+
   supplementary style) predicate used for clustering.
2. **Propose family membership, don't merge silently.** If the new file
   matches ≥1 member of exactly one existing family, the engine emits a
   **membership proposal**: a family JSON for the new file annotated
   with `proposed_merge: {family_id, matched_member, distance}` — the
   new file appears in the queue as its own (trivial) family pointing
   at the established one. It is **not** appended to the existing
   family's member list automatically: that would change the existing
   family's content-derived id, silently re-opening a committed review
   (the accepted cost from §3b — membership change = re-review). A
   proposal preserves the committed family exactly as reviewed.
3. **What the user sees.** The new image shows up in the unresolved
   queue with a visible "proposed merge into fam-xxxx" badge and a
   side-by-side with the matched member. One verdict resolves it:
   *merge* (engine appends the member, writes the new-family id, and
   the ledger records the supersession) or *separate* (it stays its own
   family; the ledger records the refusal and the same proposal never
   re-fires for that pair).
4. **Queue invariant respected.** The engine still only writes family
   JSONs + index rows and never touches the ledger or computes state;
   `_family_state()` remains the sole resolver. A proposal family is
   just another unresolved row until the user rules on it.
5. **Ambiguity rule.** If the new file matches members of *multiple*
   existing families, no proposal is emitted — it enters as a plain
   new family (letting the reviewer see all neighbors naturally) rather
   than guessing which family it belongs to.

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
  columns/keys for `phash63` and `coarse` (float32 blob). (The aspect gate is
  dropped, so no `ar` field.) Adopt Meld's
  presence-check guard verbatim (SALVAGE §1.1 / §5.9): **a cache entry is
  valid only if `key` matches AND the new fields are present** — missing
  `phash63`/`coarse` ⇒ recompute that file, not fatal. Add a schema
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
- **T3 membership proposal (new-image integration, §3c):** a new file
  near-duplicating a member of exactly one existing family produces a
  proposal row (`proposed_merge` populated) and does NOT modify the
  existing family's JSON or id; a file matching members of two families
  produces no proposal; a resolved proposal does not re-fire on rescan.
- **T4 greedy 1:1:** chain a–b (d=2), b–c (d=1) yields pair (b,c) not
  (a,b); no member appears in two pairs.
- **T5 queue invariant (trap b, named test):** after an engine rescan that
  replaces its own families, `/families?state=unresolved` contains zero
  families whose `_family_state` is resolved; a family id unchanged across
  the rescan keeps its committed state; a family that gained a member
  re-enters unresolved with a new id while the old id's ledger entry is
  untouched.
- **T6 cache guard:** entry with matching key but missing `phash63`/`coarse`
  is recomputed (SALVAGE §5.9), not trusted; store schema bump retires old
  rows.
- **T7 idempotence:** engine run twice → same ids, same index rows, ledger
  byte-identical (untouched). Incremental run over an already-scanned pool
  touches zero existing families.

---

## 6. Open questions — RULED (Alexander, 2026-10-22)

1. **Re-scan vs incremental?** **RULED: incremental.** Past reviews are
   never rewritten; full rebuild is an explicit opt-in command only.
2. **Is this THE scan engine?** **RULED: no.** The existing dupe_scan
   engine stays primary; Meld's refinements are added as supplementary
   signal; the external dupelib tool is not retired.
3. **Aspect gate defaults?** **RULED: dropped from scope entirely.** The
   corpus is restyles of the same scene; mixed orientations are not a
   concern (see §2 disposition table).
4. **Style-channel threshold?** **RULED: keep the channel, ship
   conservative** (0.7+ rather than Meld's 0.55) and calibrate later
   against signals/override telemetry.
5. **Where do style-only families surface?** **RULED: dual views (§7)** —
   families and dates are browsing views over the same queue; style-only
   results stay reachable but are not the main queue.

Remaining genuinely open (new, small):

- Where does the opt-in full-rebuild command live — a router endpoint
  with a confirm flag, or CLI-only (`python -m backend.dupe_scan
  --rebuild`)?
- Does the dates view need a dedicated index (mtime → family ids) or is
  regrouping family JSONs at request time fast enough at 6k files?

## 7. Views: families AND dates (frontend)

Alexander wants multiple **groupings as views** over the same dupe
queue — neither is the main queue; both are lenses on the unresolved
set produced by `_family_state()`.

- **Families view** (exists today): the current dupe view — family
  cards, greedy pairs on the meld-style canvas, verdict controls. This
  remains the review surface where verdicts are cast.
- **Dates view** (new idea): a date-grouped browsing view. Families are
  bucketed by member mtime (family JSONs already carry `mtime` per
  member); the UI shows a collapsible day-grouped timeline — "what did
  I scan/review on Oct 14" — each group linking into the family cards.
  Read-oriented: good for "what's new since my last session" and for
  spotting scan batches; it casts no verdicts of its own (expanded
  cards can reuse the existing controls).
- Implementation-wise both views consume the same `/families` payload;
  dates view is a pure frontend regrouping (group by max/median member
  mtime) with no backend change unless the mtime scan proves slow (open
  question above). Toggle lives in the existing dupe view header as a
  Families | Dates segmented control.

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
