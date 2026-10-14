# EllieEdit Work Order — 2026-10-12 (for Claude, spec'd by Ellie)

Repo: `~/workspace/ellieedit` (FastAPI backend + vanilla JS frontend, pytest suite — 174 green at `7c06230`). Live server on port 8800; **do NOT restart the server or bump deploy markers** — deploys are Ellie's/Alexander's job. Write code + tests; leave the tree clean on a branch or commit granularly, Alexander will relay.

---

## Task 1 — Dupe cleanup script hardening (well-specified, do first)

The one-off cleanup script that pruned dead members from `.dupes/families/*.json` (2026-10-10 run) had three bugs we fixed by hand afterward. Bake the fixes into the script so the next run can't reintroduce them.

Bugs it must never repeat:
1. **Husks**: dissolved families were "deleted" by truncating JSON to 0 bytes → app warned "family unreadable". A dissolved family must be a real file **deletion** (its content already saved as `.bak` + journal entry), never a truncate-to-empty.
2. **Index not maintained**: the script never touched `.dupes/index.json`, which still listed all 2,111 families (752 now-deleted) → 404 toasts. The script must rewrite `index.json` to exactly the surviving family set, and update each entry's cached `size` to the live member count.
3. **Stale counts**: after pruning dead members, the index `size` still showed scan-time counts (5 vs actual 4). Covered by (2) — index counts always resync from live JSON.

Also required:
- Skip-and-warn (don't crash) on unreadable/zero-byte family JSONs.
- Preserve all existing safety: backup tarball first, `.bak` per touched file, JSONL journal, live runs require typed `yes` confirm.
- If the script lives outside the repo (check `/mnt/shared/_Incoming/DupeReview/.dupes/` and `~/workspace/` for its current copy), move it into the repo under `scripts/` and add pytest coverage for: prune, dissolve, husk-free deletion, index resync (count + membership), unreadable-file skip.

**Done when**: a dry-run against a synthetic `.dupes` fixture (families + index, some with missing members, one zero-byte JSON) produces: no zero-byte files after, index counts match live JSONs, deleted families absent from index, journal written; full pytest suite green.

## Task 2 — Load-wait instrumentation (measure, don't fix)

Dupe-tab page loads have variable, sometimes long waits. Do NOT optimize anything. Add timing instrumentation only:
- Backend: log (or expose via a `/api/dupe/status`-style timing field) per-request durations for `/families`, `/thumb`, `/file`, and inside `_index()` — the index.json parse — plus thumbnail-generation time (cache hit vs miss) inside `get_thumbnail`.
- Frontend: `console.time`/`console.timeEnd` (or a perf log) around the dupe tab's fetch sequence: families list → first N thumbs. A summary line like `dupe-load: families=812ms thumbs(24)=5300ms (14 misses)` is the deliverable.
- Aggregate backend timings into a small rolling log file so we can see distribution, not just last request.

**Done when**: a dupe tab reload produces one frontend summary line + backend per-request timings covering list, thumbs (hit/miss separated), and index parse; tests still green; no behavior change.

## Task 3 — Meld + post-dupe family management (design brief — propose, don't build yet)

Current state: meld exists in `backend/routers/dupe.py` (search `MeldSaveBody`, `_latest_meld`, `MELD_MAX = 8`) — a best-of-both blend bench that scans a family, lets you pair/paint/blend, and saves the result. The dupe review flow ends with keep/resolve per member; families then effectively disappear from the app's attention.

Goal state Alexander wants: **after a family is resolved, the family — or its surviving/melded results — should remain browsable from the Library**, e.g. surfaced in the individual image's detail section ("this image was part of family X, here are its siblings/melds").

Deliverable for this task: a **written design proposal** (markdown, in the repo, e.g. `docs/design/post-dupe-family-browsing.md`), covering:
- How family membership can be looked up from an arbitrary library image (reverse index? family JSON scan? `.dupes` query endpoint — note there's already `/api/dupe/families`; assess reuse vs a new `/api/dupe/family-for-image?path=`).
- What the image detail section should show: sibling thumbnails, verdicts, meld lineage (which members were inputs to a saved meld), links that open the dupe tab focused on that family.
- What happens after resolve/dissolve: does a dissolved family keep a browsable trace? Propose a lightweight "resolved family" record or tombstone if needed — but argue for the minimal version.
- How meld outputs (saved blend files) relate to the family afterward — they're new images, not members; propose how they're marked/linked.
- A phased implementation plan: smallest useful increment first.

Do not implement — this is for Ellie + Alexander to review.

---

## Ground rules (all tasks)
- Verify exact line numbers/signatures against current HEAD before editing; this spec was written from memory.
- Tests for everything behavior-changing; full suite green at handoff.
- Granular commits, clear messages; `git status` clean at the end.
- Report back: what changed, test counts, and anything in this spec that turned out to be wrong or impossible as written.
