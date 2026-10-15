# FoxDen Shell v1 Work Order — 2026-10-13 (for Claude, spec'd by Ellie)

## What this is
A tablet-first single page in the EllieEdit suite (`~/workspace/ellieedit`) that drives the local ComfyUI server for simple generation — no node graph, no Cozy. Alexander renders from a Surface over a remote stream; the full Comfy UI is heavy for that context.

## Ground rules
- Repo: `~/workspace/ellieedit`, FastAPI backend + vanilla JS frontend, pytest suite green (174+). Follow existing router/frontend conventions — study `backend/routers/dupe.py` and the existing frontend pages first.
- ComfyUI server: `http://100.115.117.53:8188` (Windows side; reachable from WSL — verified). Health: `GET /system_stats`. Submit: `POST /prompt`. Track: `GET /history/{prompt_id}`. Fetch image: `GET /view?filename=...&subfolder=...&type=output`. Upload: `POST /upload/image` (multipart `image` field).
- Workflow baselines: `/mnt/e/comfyui/user/default/workflows/` — `klein_gen_basic.json` (fast, default for v1), `krea2_gen_basic.json` (style-critical). Known slots for klein: prompt = node 668 (`YANC.MultilineString.string`), seed = node 730 (`RandomNoise.noise_seed`), width/height = inline literals in nodes 729 (`EmptyFlux2LatentImage`) AND 731 (`Flux2Scheduler`), LoRA splice point = between node 743 (`LoaderGGUF` model out) and node 735 (`CFGGuider` model in) via a `LoraLoaderModelOnly` node. Verify all node ids/paths against the actual JSON before coding — this spec is from memory.
- **Do NOT restart the EllieEdit server (systemd unit `ellieedit.service` on :8800), do NOT bump deploy markers (shell.js BUILD / sw.js CACHE), do NOT touch the ComfyUI install.** Code + tests only; Alexander/Ellie deploy.
- Silence is not success: a ComfyUI submission that "succeeds" with empty outputs is a known failure mode — always verify `/history` contains ≥1 output image.

## Feature spec — v1 (one page)

### Backend: new router `backend/routers/foxden.py`
1. `GET /api/foxden/config` — returns: list of LoRA files (scan the ComfyUI LoRAs dir — resolve the real path under `/mnt/e/...`/`E:\Projects\git\ComfyUI-dev\models\loras`, config or env override `ELLIEEDIT_COMFY_LORAS_DIR`), workflow choices (klein, krea2), ComfyUI reachability.
2. `POST /api/foxden/generate` — body: `{workflow, prompt, seed?, width?, height?, loras: [{name, strength_model}], steps?}`. Server-side: load the workflow JSON fresh from disk each request (no caching — stale-JSON class of bugs), apply edits:
   - inject prompt + seed into the known slots;
   - width/height: edit BOTH literal nodes (729/731) if provided;
   - loras: splice one `LoraLoaderModelOnly` node per requested LoRA into the model chain (chained: loader → lora1 → lora2 → ... → guider), rebuilding edge wiring;
   - steps override if provided.
   Submit to ComfyUI, return `prompt_id` immediately. Validate the `/prompt` response for `node_errors` and 400 loudly.
3. `GET /api/foxden/status/{prompt_id}` — proxy + normalize ComfyUI's status into `{queued | running | done | error, outputs: [view_urls]}`. Empty-outputs-on-done = `error` with the ComfyUI log tail attached (read `/mnt/e/comfyui/user/comfyui.log` last ~30 lines for the explanation).
4. `POST /api/foxden/upload` — multipart proxy to ComfyUI `/upload/image`; returns the name ComfyUI stored. (img2img wiring is v2 — just get upload + listing working, store nothing ourselves.)
5. Gallery: `GET /api/foxden/recent` — last N completed generations from this shell (keep a small JSONL log under `data/foxden/`: prompt, workflow, seed, output filenames, timestamp).

### Frontend: one page, tablet-first
- Big touch targets, no hover-dependent anything, works in a remote-desktop window.
- Controls: workflow picker, prompt textarea, LoRA multi-toggle list with strength sliders (default 1.0), seed field + randomize, aspect preset buttons (landscape 1024×576 / portrait 576×1024), Generate button.
- On submit: poll status, show progress state, render outputs inline (tap to enlarge).
- Recent strip at the bottom from `/recent`.
- Keep it one JS file + one CSS file in the existing frontend structure; no frameworks, no build step.

### Tests (pytest)
- Workflow-editing functions: prompt/seed injection, dual width/height literals, single and chained multi-LoRA splicing (verify edges rebuilt correctly on the real klein JSON — check it still validates as JSON and every edge references existing nodes), steps override.
- Status normalization: done-with-outputs → done; done-empty → error (with log-tail behavior mocked); running/queued passthrough.
- Config endpoint: LoRA dir scan (use a tmp dir via env override), unreachable-ComfyUI handled gracefully.
- Upload proxy: mocked ComfyUI round-trip.
- Do not require a live ComfyUI in tests — mock HTTP.

### Out of scope (v2+, do not build)
img2img wiring (upload endpoint only), ERNIE/Z-Image workflows, batching UI, queue management, the dupe/meld integration.

## Done when
- Full pytest suite green including new tests; `git status` clean; granular commits.
- A one-page summary of what to verify live (Alexander will run: start shell, generate one klein render with one LoRA, confirm image appears).
- Report: files touched, test counts, anything in this spec that was wrong against the real workflow JSONs.

---

## Task 4 (added 2026-10-13) — Death-row retirement: rows must not outlive their files

Observed by the operator: after reviewing ALL open families (rejects deleted, keeps promoted), `/death-row` still lists 827 families — 821 of them with zero rejected files on disk (real residue: 60 files / 109MB). The rows never retire because `_death_row_rows()` rehydrates from the latest ledger verdict map, and commits record that same map — nothing marks a family "done".

Fix, minimal and consistent with existing patterns:

1. **Zero-file rows hidden by default**: `/death-row` (and any list view of it) skips rows whose `rejected_files == 0` unless a `include_archived=1`-style flag is passed (mirror the existing `/families` include_archived pattern at `backend/routers/dupe.py` ~line 627-680). Rows fully archived (all members gone from disk) are already flagged — keep that honest.
2. **Dismissal tombstone**: new `POST /death-row/dismiss` — body `{families: [...]}` (validate against `FAMILY_ID_RE` + death-row membership like commit does). Append one ledger entry per family (ledger is append-only JSONL, latest-wins — see `_verdicts()` ~line 315) with e.g. `{"family": fid, "death_row_dismissed": true, "signal": "dismissed", "ts": ...}`. The signal vocabulary `SIGNAL_EVENTS` (line 66) already includes "dismissed" — reuse that value if the field shape fits.
3. `_death_row_rows()` skips families whose latest ledger entry carries the dismissal flag.
4. Frontend: death-row view gets a per-row dismiss (small ✕) and a "dismiss all with no files" action; dismissed rows disappear without a page reload trick — refetch after the call.
5. Tests: dismissal hides rows (and survives rehydration), include_archived reveals them, dismiss validation (bad id, non-death-row id → 400), zero-file default hiding, ledger stays append-only (verify _verdicts latest-wins behavior with a dismissal after a commit).

Do NOT change `/death-row/commit` behavior, the Pending Delete manifest, or anything destructive. Nothing unlinks — dismissal is bookkeeping only.

Also note for Task 2's timing instrumentation: `/death-row` stats every rejected member on the first walk after a ledger/index change — that walk is a suspect for the load-wait variability; make sure its timing shows up.

### Task 4 amendment (2026-10-13, operator decision) — lifecycle views, not deletion
Design ruling: NOTHING in the dupe area gets cleared or deleted. The fix is views.

1. **State filter on the families/review list**: `all | unresolved | committed` — default `unresolved`, so the review queue empties visibly when work is done. Unresolved = latest ledger entry missing or all-deferred; committed = latest entry has kept/rejected members; dismissed = death-row-dismissed (from Task 4's tombstone). The building blocks exist: `_family_state()` (~line 334) and the include_archived pattern.
2. **Committed families stay fully browsable, read-only**: family view renders frozen verdict badges (kept ✓ / rejected ✗) on member thumbs — verdict source = latest ledger entry, same as death-row rehydration already reads. No editing of history.
3. **"Re-open for review" button on committed families**: appends a NEW ledger draft entry (latest-wins, ledger stays append-only — never rewrite old entries). Re-opened families reappear as unresolved.
4. Death-row dismissed tombstone (from Task 4) is independent of this filter — dismissal only retires the death-row row; family history remains under `all`/`committed`.
5. Tests: filter states (unresolved/committed counts match ledger truth), re-open flips state back to unresolved without mutating prior entries, committed view renders frozen badges from ledger, default view = unresolved.

Revised done-state: operator opens dupe tab after a full review session → sees an empty (or near-empty) unresolved queue, can switch to `committed` to browse all 1,3xx resolved families with frozen verdicts, death row shows only rows with live files.

### Task 4 addendum (2026-10-13 20:13, operator-found) — rehydration shadow queue
After dismissal deployed, operator found: death-row rehydrated families still rendered as cards in the Unresolved list while the count read "Unresolved (0)". Cause: /families injects rehydrated rows into the unresolved list (pre-marked-draft flow, dupe.py ~line 684) but /status counts exclude them — list and count disagree. Fix: make them agree. Either counts include rehydrated (and label them), or rehydrated rows render in a distinct labeled section / only after an explicit filter. Rehydrated rows should never silently inflate the unresolved queue. Deployed interim state: all 827 ghosts dismissed via zero_file bulk, so the queue is genuinely empty — this addendum prevents the next graveyard from recreating the mismatch.

### FoxDen spec amendment (2026-10-13 20:35) — node IDs VERIFIED against the real klein_gen_basic.json
The JSON is **API/prompt format**: a flat dict keyed by node-id string, each node `{"class_type", "inputs"}`. There is NO nodes/edges array — edit `inputs` fields directly (simpler than UI-graph splicing).
- Prompt: node `"668"` `YANC.MultilineString`, inputs key `string` ✓
- Seed: node `"730"` `RandomNoise`, inputs key **`noise_seed`** (not `seed`) ✓
- Width/height literals in TWO places: `"729"` `EmptyFlux2LatentImage` (`width`,`height`) and `"731"` `Flux2Scheduler` (`width`,`height`, also `steps`) ✓
- LoRA splice: `"735"` `CFGGuider` inputs `model: ["743", 0]`; insert LoraLoaderModelOnly chain between 743's model output and 735's model input ✓
- CORRECTION to the original spec: 743 `LoaderGGUF` currently loads `flux-2-klein-9b-Q8_0.gguf` (9B, not 4B as memory claimed). Pass `gguf_name` through untouched; never hardcode a model name. Optional v1.1: a model-picker that lists `_Flux*` ggufs.
- 744 `ClipLoaderGGUF` = `Qwen3-8B-Q8_0.gguf` ✓ — leave alone.
- Batch size lives in 729 (`batch_size`).
The staged copy in _Outgoing matches /mnt/e/comfyui/user/default/workflows/klein_gen_basic.json (verified 2026-10-13 20:31).

---

## Task 5 (added 2026-10-14, operator-found during first real couch session) — FoxDen recent integrity + delivery

Operator's first personal render never appeared in the recent strip. Root cause: recent.jsonl writes only happen as a side effect of `/status/{id}` polling — if no client is polling at the exact moment ComfyUI finishes (tab navigated away, device slept), the completion is never observed and the render is orphaned. A one-off backfill rescued the render; make it structural:

1. **Reconcile in `/recent`** (or a `/recent/reconcile` the frontend calls on load): fetch ComfyUI `/history`, find entries whose outputs contain `filename_prefix == "foxden"` (or filename starting `foxden_`) with `type=="output"` not yet in recent.jsonl, append them (metadata best-effort: unknown fields null, prompt "(reconciled)"). Must be tolerant of LARGE history JSON (ours is 50MB+ — stream or fetch with a long timeout; do not parse per-request on every /recent call — reconcile on tab activation or explicit refresh only).
2. **Frontend refresh button** at the left of the recent strip (⟳ icon, 44px touch target): calls reconcile + reloads strip.
3. **Collapsible recent strip**: chevron/tap-to-collapse; remembers state (localStorage); collapsed shows just a thin bar with count.
4. **Delivery folder**: on reconcile AND on normal done, copy output images to `/mnt/shared/_FoxDen/` (create if missing; config override `ELLIEEDIT_FOXDEN_DELIVERY_DIR`). Copy, never move — ComfyUI's output dir stays authoritative. Filename: keep ComfyUI's, prefix collisions fine. This makes couch renders visible on the Windows/TV side automatically.
5. Tests: reconcile picks up orphaned history entries and skips known ones; delivery copy lands (tmp-dir based); refresh endpoint contract; reconcile survives huge-history mocking (chunked/body ≥ mock size).

Context: the one-off backfill (2026-10-14) worked — render `foxden_00002_.png` rescued. This task makes that automatic.

### Task 5 addendum (2026-10-14 14:39, operator requests from first couch session)

5. **Input images + denoise (this IS the deferred v2 img2img — now in scope):**
   - The FoxDen page gets an input-image section: pick from the existing `/inputs` listing and/or upload via the existing `/upload` (thumbnail chips, tap to select/deselect, multiple allowed = last-selected wins for v1 unless trivially multi).
   - Backend `/generate` accepts `input_image` (name from upload/inputs). When present, edit the graph: LoadImage (or reuse the upstream chain feeding the existing workflow if it has one — klein does NOT, so inject: LoadImage → VAEEncode → SamplerCustomAdvanced's `latent_image` input, replacing the EmptyFlux2LatentImage link). Width/height literals are ignored in img2img (image is the latent source) — disable/gray the aspect buttons client-side when an input is set.
   - **Denoise control**: `Flux2Scheduler` may not expose a `denoise` input — verify against the real node defs (`/object_info/Flux2Scheduler`, `/object_info/BasicScheduler`). If absent, the standard approach: compute the step subset that corresponds to the denoise strength (skip the first ceil(steps × (1−denoise)) sigma entries) or swap to a denoise-capable scheduler node. Whichever path, denoise slider 0.1–1.0, default 1.0 (= current txt2img behavior).
   - Tests: img2img graph edits (LoadImage+VAEEncode injected, latent rewired), denoise step-trim math, txt2img unchanged when no input, input+loras compose.
6. **LoRA pinned-chips UX:** active LoRAs render as compact pinned chips JUST ABOVE the scrollable list (name + strength + two buttons: ✕ remove, ⏸ suspend). Suspend parks the chip in a collapsed "suspended (N)" tray — restore by tap — so you can A/B a render with/without without losing the strength value. Filter box filters the list, never the pins. `Reuse settings` restores pins+suspended state faithfully.

### Task 5 addendum 2 (2026-10-14 14:44, operator request) — workspace save/restore presets

7. **Named presets**: save the complete FoxDen form state under a user-chosen name — prompt, workflow, aspect (or input image), seed (optional: save seed or leave random — checkbox "lock seed"), steps, denoise, LoRA pins + suspended tray with strengths, input image reference. Server-backed: `GET/POST/DELETE /api/foxden/presets` storing JSON at `data/foxden/presets.json` (same dir as recent.jsonl). Frontend: preset picker (dropdown or chip row) + 💾 save button prompting for name; applying a preset restores the full form; delete with confirm. Tablet-first: no hover, 44px targets.
8. **Auto-remember last state**: the form persists itself (server-side same store, key `_last`, or localStorage with server sync) — reload/sleep/crash restores the in-progress composition instead of a blank form. Recent's `Reuse settings` remains the per-render shortcut; presets are the deliberate bookmarks.
9. Tests: preset CRUD round-trip, apply restores every field incl. suspended tray and input image ref, auto-remember survives a fresh client, delete-with-confirm contract.
