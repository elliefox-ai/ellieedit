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

---

## Task 6 (added 2026-10-15 09:15, operator request) — FaceCycle image visibility: zoom + pan

Operator goal: more visibility of the working image. A tall portrait shrinks into whatever vertical space remains after the status bar + thumb strip. Design decision made by Ellie (operator deferred): **NO vertical/horizontal layout switch** — it doubles layout states and still letterboxes portraits. Instead:

1. **Zoom slider** on the canvas area: fit (default) ↔ 300%. Above fit, the container scrolls to pan (the .fc-canvas-wrap scroll now works correctly after the auto-margin centering fix, 2026-10-15c). A "Fit" button returns instantly. Zoom level persists in localStorage.
2. **CRITICAL INVARIANT — pointer math:** CanvasStack.eventToWorld() (canvas-stack.js ~line 115) normalizes via `canvas.width / rect.width` from getBoundingClientRect, so CSS scaling is safe ONLY if both this.canvas AND the absolutely-positioned overlayCanvas scale in exact lockstep (same computed CSS size; overlay has no maxWidth set — verify). Test this: mock a rect larger than canvas.width, assert world coords unchanged. Every stroke/mask/region must land identically at 300% as at fit.
3. Suggested mechanism: set canvas.style.maxWidth/maxHeight = 'none' when zoom > fit, drive explicit CSS px width/height = fitSize × zoom on both canvases; fit = current behavior (max 100%). Avoid transform:scale — it does not expand scrollable overflow, so panning breaks.
4. Touch: canvas has touch-action:none (paint priority). Panning while zoomed: container scroll via scrollbar/edges is poor on tablet — consider two-finger pan on the wrap (second non-primary pointer already ignored by the paint path) as the pan gesture; document the choice in the verify file.
5. Tests: pointer invariant test (above), zoom persistence, fit-button reset, overlay/canvas lockstep at zoom extremes.

### Task 7 (added 2026-10-15 09:23, operator request) — FaceCycle: Advanced controls submenu

Operator rarely uses: Diff sensitivity slider (threshold, line ~82), min region / max region inputs, and 🔍 Detect Faces (~line 85). Move them into a collapsed "⚙ Advanced" disclosure (details/summary or toggle button) so the main band carries only the everyday controls. Keep data-ids unchanged (tests/keys reference them), persist open/closed in localStorage, 44px touch targets, defaults closed. No behavior changes to the controls themselves. Tests: presence + toggle contract via existing frontend wrapper patterns.

### Task 7 revision (2026-10-15 09:32, operator + Ellie design session) — full FaceCycle menu segmentation
Task 7 grows from "one Advanced drawer" into a proper information architecture pass. Principle: **the canvas and its paint tools are the product; everything else is configuration and should live one level down.**

- **Main band (always visible):** draw box (B), mask brush, erase, undo, Generate. The everyday loop.
- **🖌 Repaint modal:** prompt box, saved prompts, repaint-specific options (prompt replace flow).
- **🔍 Detect modal:** auto face detection + its options + the "add to regions" box (operator says likely outdated — park it here, do not delete; removal is a later decision with usage evidence).
- **⚙ Advanced modal:** diff sensitivity slider, min/max region (operator: rarely used).
- Modals on tablet (bottom-sheet style preferred over centered dialogs), every control keeps its data-id and keyboard shortcut, modal open/close must not disturb canvas state or in-flight generations.
- Tests: each control's presence + reachability in its modal; canvas state survives open/close; existing data-id references untouched.

### Task 8 (added 2026-10-15 09:32) — FaceCycle: champion promote (supersedes the standalone-Meld work order)
Operator clarification: the standalone Meld app is NOT the going-forward blend surface — FaceCycle effectively IS the meld tool now (and the Ladder has its own meld option that should eventually be extracted into FaceCycle). So the champion button lives in FaceCycle:
1. A **👑 Champion** action on the current generation output. When the working set was handed off from a **Dupe family** (the handoff already tracks source), promoting sets that family's champion in the dupe-review ladder — same semantics as the Ladder promote — and offers to send the family's other candidates to the death row queue (existing endpoints; two-step confirm; never outright delete).
2. If the working set has no dupe-family provenance (handoff from Gallery, FoxDen, fresh upload), Champion promotes within FaceCycle only (marks the generation as the session champion in the gens strip) and the death-row offer is absent.
3. DISCOVERY STEP: find how the dupe→FaceCycle handoff records family/source (status bar says "handed off from Dupe family" — trace the payload), and the champion-set + death-row endpoints in the dupe router. If a champion-set endpoint doesn't exist, STOP and report — do not invent an API.
4. Tests: promote with family provenance hits the right endpoint with the right family id; no-provenance path is session-local; confirm-step contract.

### Task 7 revision 2 (2026-10-15 09:44, operator decision) — three surfaces, not four
The separate ⚙ Advanced modal is DROPPED. Final IA:
- **Main band:** draw box (B), mask brush, erase, undo, Generate (operator confirmed: quick-click regenerate on the main band is the hot loop; the Repaint modal may ALSO carry its own Generate for the modal flow — same handler, both are fine).
- **🖌 Repaint modal:** prompt, saved prompts, repaint options.
- **🔍 Detect modal:** face detection + add-to-regions (parked, do not delete) + diff sensitivity slider + min/max region (operator: intrinsically linked with detection — they tune the same diff engine).
All prior constraints hold: data-ids/shortcuts unchanged, bottom sheets on tablet, canvas state survives open/close.

### Task 9 (added 2026-10-15 09:44, operator: MOST CRITICAL) — save result back to source folder + sources to delete queue
When the working set has provenance (handed off from Gallery folder or Dupe family), FaceCycle needs a **"Save & retire"** action:
1. Saves the current final output (kept generation / current stack render) back to the ORIGINAL folder of the base image — the folder the handoff came from, not a scratch dir. Filename: base name of the primary source with a distinguishing suffix (avoid clobber; exact scheme = discovery: see how Gallery promote names things and match that convention).
2. Offers (two-step confirm) to send the component/source images to the delete queue — death row for dupe families, pending/deletion view for gallery items (existing endpoints only).
3. No provenance → action hidden or disabled with a hint (nowhere to save back to).
4. DISCOVERY: trace the handoff payload — does it record source folder paths and/or family id? The status bar already prints provenance ("handed off from Dupe family"), so the data exists client-side; verify what survives server-side.
5. Tests: save lands in source folder with non-clobbering name; death-row/pending offers hit existing endpoints; no-provenance path disabled.

### Task 10 (added 2026-10-15 09:50, operator request) — kept gens share the layers row
A kept repaint generation currently adds its own bar below the canvas, compressing the main image's vertical space further. Change: kept-gen actions join the EXISTING layers row (the keep/discard/undo/layer-toggle band), right-aligned — no new bar, zero added height. Same data-ids/handlers, layout-only change. Tests: presence in the row; no additional block element; canvas-wrap height unchanged when a gen is kept (wrapper geometry assertion).

### Task 8/9 revision (2026-10-15 11:15, operator clarification) — supersedes champion/replace wording above
- **The Ladder is NOT touched.** Champion-in-Ladder stays as-is; it's the preferred interface for pure image-to-image tests. This revision removes the champion framing entirely.
- FaceCycle gets **one new method: "Replace sources"** (exact label TBD, something unambiguous):
  1. Writes the current final output image into **the directory of the selected base image** (the working set may contain images from MULTIPLE folders — the base image designation decides where the result lands; make the base-image selection explicit in the UI so multi-folder sets are unambiguous).
  2. Sends the source images to the appropriate deletion queue (existing endpoints only — death row for dupe-family provenance, pending/deletion view for gallery provenance).
  3. **NO two-step confirm** — operator decision: the deletion queue itself is the safety mechanism; don't complicate the flow.
  4. **Workflow metadata transfer is best-effort, not critical:** if embedding generation metadata into the output PNG is cheap (e.g., tEXt chunk with the handoff source + generation params), do it; if it turns out to need new plumbing, skip and note in the verify file.
  5. No dupe-family/gallery provenance at all → method hidden or disabled with a hint (nowhere to return the result).
- Tests: result lands in base image's folder with non-clobbering name; sources hit the correct queue per provenance type; multi-folder set uses base image's folder; no-confirm contract; metadata presence if implemented.

### Task 6 revision (2026-10-15 22:34, operator live feedback) — slider inverted, fit is the baseline
Operator's actual need is the OPPOSITE of the built default: he wants to shrink the working image below fit (overview/margin in the workspace), not enlarge it. Changes:
1. **Invert the slider range**: fit (100%) is the DEFAULT and the slider's rest position; the useful travel is DOWNWARD (fit → 25%, smaller than fit). If keeping zoom-in is cheap, allow the full 25%–300% range with 100% at its default position and the scale clearly oriented small-left/big-right — but the operator's stated need is shrink; do not let zoom-in complicate the default experience.
2. Fit button stays; zoom persistence stays.
3. This pairs with Task 7 (menu segmentation): the row is more crowded than ever — Task 7's modal pass is the actual decongestion fix and should be treated as higher priority now. When Task 7 lands, evaluate whether zoom + Fit stay in the row or move into it.
4. Tests: default = fit on fresh load; slider range covers sub-fit; persistence unchanged; row layout unchanged from 15i.

### img2img ruling (2026-10-15 23:22, operator suggestion evaluated) — KSampler swap REJECTED as primary path
Operator asked whether we could just switch to the regular KSampler (which has native denoise). Verified on our install: `KSampler` exists WITH denoise (cfg/denoise/latent_image/model/negative/positive/sampler_name/scheduler/seed/steps); `KSamplerAdvanced` has NO denoise. Ruling: **stay with SplitSigmasDenoise.** The klein graph is the Flux2-native advanced pipeline: `CFGGuider` exists because Flux2 does not respond to classic CFG, and `Flux2Scheduler` provides its own sigma schedule. Routing through regular KSampler forfeits both — quality risk at every denoise level, and it breaks the hard guarantee that denoise 1.0 reproduces current txt2img byte-for-byte. (Note: the graph is essentially a decomposed KSamplerAdvanced — and KSamplerAdvanced has no denoise input, confirming the advanced pipeline intentionally puts denoise in the sigmas. SplitSigmasDenoise restores exactly that missing knob.) The KSampler swap may later be an A/B experiment; it is not the img2img foundation.
