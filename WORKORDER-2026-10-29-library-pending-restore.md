# WORKORDER — Library pending-deletions panel + Restore

**Date:** 2026-10-29 · **Builder:** echo · **Type:** BUILD (backend + frontend)
**Base:** `master` @ `ac13ef9` (build `2026-10-29f`). Work on a branch off that,
ship as a patch bundle like the last four. No build-marker bump, no restart —
landing stays Ellie's side.

---

## Why (the incident this answers)

Alexander edited an image, saved it to the Library, then opened the viewer,
cycled to the version **original** with the ⧉ toggle, and pressed Delete. The
**final** was removed instead of the original, and the deletion queue appeared
empty, so there was no way to undo it from the UI.

Two separate causes:

1. **Fixed already** (`ac13ef9`): `deleteFromViewer()` sent `item.path`
   unconditionally, ignoring the ⧉ toggle. Delete now targets the displayed
   variant and the confirm label names it ("Really delete the ORIGINAL?").
   Do not re-fix this; it is deployed.
2. **Still open, this workorder:** the Library has **no pending-deletions UI**.
   The file sat in `LIBRARY_ROOT/.pending-delete/` the whole time and
   `GET /api/library/pending` listed it — but nothing in the frontend ever
   calls `/pending` or `/pending/confirm`. The operator had no door to their
   own recovery. Their words: *"that's not a workflow, that's me being your
   undo button."*

Goal: the operator can see what is queued for deletion and restore it
themselves, without asking anyone.

---

## Facts about the current implementation (verified 2026-10-29)

- `LIBRARY_ROOT` = `os.environ.get("ELLIEEDIT_LIBRARY_ROOT", "/mnt/shared/_Library")`
  (`backend/routers/library.py:50`).
- Pending area: `LIBRARY_ROOT/.pending-delete/` (`pending_dir()`, `library.py:60`).
- `POST /api/library/pending-delete` `{path: <library-relative>}`
  (`library.py:846`): **moves** the file into the pending area and appends an
  index record `{path, tags, promoted_from: "", ts, sha256: "", deleted_soon: true}`.
  Never unlinks.
- `GET /api/library/pending` (`library.py:873`): returns
  `{"items": [{"name": <bare filename>, "size": <bytes>}]}` — **no path, no
  timestamp, no restorable flag**.
- `POST /api/library/pending/confirm` (`library.py:892`): the only destructive
  step — unlinks the pending area.
- Index: `LIBRARY_ROOT/.library-index.jsonl`, append-only, **latest record per
  path wins**. `deleted_soon_paths()` (`library.py:306`) treats a path as gone
  when its *latest* record carries `deleted_soon: true`; `/list` filters those
  out, and the dot-dir is never listed.
- Consequence that matters for restore: the `deleted_soon` record **still holds
  the original library-relative path**. Restoring is therefore exact — no need
  to guess a destination from the filename — but `GET /pending` must be
  extended to expose it.
- Family records are separate from the delete record. Example from the real
  Library, the record that had to be re-appended during manual recovery:
  `{"path":"colorhold/inpaint-3796aa994a.png","tags":["colorhold"],"kind":"version-family","family_id":"ef92723102e1","original":"colorhold/inpaint-3796aa994a-original.png","final":"colorhold/inpaint-3796aa994a.png","intermediates":[...],"recipe":"masked-inpaint","masked":true,"ts":...}`
- **Manual recovery that worked** (reproduce it as the endpoint):
  1. `shutil.move(pending_path, LIBRARY_ROOT/<path from the deleted_soon record>)`
  2. re-append the **last non-deleted record for that path** — not a synthetic
     one — so `tags`, `kind`, `family_id`, `original`, `intermediates`,
     `recipe`, `masked` all survive, with a fresh `ts` and no `deleted_soon`.
- Pending area currently holds ~10 legacy items (Oct 9–24) whose files predate
  this discipline; some may have no `deleted_soon` record at all. The UI must
  cope with unattributed items instead of crashing or hiding them.

---

## Build — backend

1. **Enrich `GET /api/library/pending`** without breaking its current keys:
   each item gains `path` (library-relative, resolved from the latest
   `deleted_soon` record whose basename matches), `mtime`, `tags`, and
   `restorable: true|false`. For unattributed items: `path: null`,
   `tags: []`, `restorable: false`, plus a short `note`.
2. **`POST /api/library/pending/restore`** `{name}` (prefer `name`; accept
   `path` too):
   - resolve the pending file and its `deleted_soon` record;
   - `404` if the pending file is absent, `409` if it is unattributed
     (no record to restore to) — never guess a destination;
   - if the destination path is already occupied (e.g. restored twice, or a
     different file now lives there), do **not** overwrite: `409` with a
     message naming the conflict;
   - otherwise move the file back, re-append the last non-deleted record with
     a fresh `ts`, and drop `deleted_soon`;
   - return `{ok, path, family_id?, tags}`.
3. **Keep `/pending/confirm` exactly as destructive as it is.** Consider
   requiring an explicit `{"confirm": true}` or a list of names, so a future
   UI cannot purge by accident. If you change its shape, pin it with a test.
4. No other endpoint changes. Do not alter promote/retag/meta/sets behaviour.

---

## Build — frontend (`frontend/js/modules/library.js`)

- A **"Pending deletions (N)"** section in the existing 280px Library sidebar
  (below Filters/Meta, collapsible, badge count in the header). Hidden or
  greyed when empty ("Nothing queued").
- Each row: filename, size, age ("3 days ago"), and a **Restore** button.
  Unattributed rows show a muted "no original path — purge only" and no
  Restore.
- After a successful restore: remove the row, decrement the count, and
  re-surface the item **without a full grid reload if that is cheap** — the
  flicker regression guards in `test_library.py` exist because full reloads
  were visible. A single `reload()` here is acceptable only if unavoidable,
  and must not fire on selection or chip actions.
- **Confirm purge** must be a separate, deliberate action — arm-then-confirm
  like the viewer Delete, naming the count ("Really purge N files? ✓"). Never
  a bare button next to Restore.
- iPad/≤900px: the sidebar stacks above the grid (max-height 42%) exactly as
  it does now; the section must remain reachable without hover-only affordances.
- Toast + status line feedback consistent with existing patterns.

---

## Tests

- Round-trip: promote → `pending-delete` → appears in `/pending` with `path`
  and `restorable: true` → `restore` → file back at the original path, sha
  unchanged, listing shows it again, latest index record has no `deleted_soon`
  and **preserves `kind`/`family_id`/`intermediates`**.
- `restore` on a name with no `deleted_soon` record → `409`, file untouched.
- `restore` when the destination is occupied → `409`, both files intact.
- `restore` of a missing name → `404`.
- `confirm` still purges, and only when explicitly called.
- One frontend needle test: the panel exists, calls `/pending` and
  `/pending/restore`, and has an armed confirm for purge.
- Full suite must stay green (current master: 408 passed, 0 failed).

---

## Non-goals

- No changes to how delete is triggered, no new delete affordances.
- No "trash bin" with expiry/auto-purge — this is a review queue, not storage.
- No touching the Gallery/Dupe pending queue; this is the Library's own pool.
- No build-marker bump or restart from you; Ellie lands and deploys.

---

## Acceptance

Alexander can, on the iPad: open Library → see "Pending deletions (N)" →
recognise his own mistake by filename/age → tap Restore → the image is back in
the grid with its tags and family intact. And confirm-purge remains a
two-step, obviously destructive action.
