# EllieEdit

Unified ComfyUI image-tools PWA suite, served from Megatron over the tailnet.
See `/home/zengonzo/clawd/04_project_notes/suite-app-plan.md` for the plan.

**Phase 0**: PWA shell + FaceCycle migration (as-is behavior).

## Run

```bash
cd /home/zengonzo/workspace/ellieedit
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8800
```

Open `http://100.98.8.113:8800/` (tailnet only, plain HTTP — Safari-tab mode
until the HTTPS decision is revisited).

Environment: `COMFY_URL` overrides the ComfyUI endpoint
(default `http://100.115.117.53:8188`, same as facecycle).

## Layout

- `backend/comfy.py` — REPAINT_GRAPH + upload/repaint relay, ported
  near-verbatim from `facecycle/face_merge.py` (BasicScheduler denoise fix
  preserved — do not "upgrade" to Flux2Scheduler).
- `backend/routers/facecycle.py` — `POST /api/facecycle/repaint`, same JSON
  contract as the old `/repaint` relay.
- `frontend/` — PWA shell: tab bar + module registry (`js/shell.js`); shared
  components (`canvas-stack.js` layers + pointer input with coalesced events
  and dirty-rect overlay, `pending.js` Keep/Discard/Undo model, `jobpanel.js`
  job status); modules in `js/modules/`.
- `tests/` — pytest: graph builders + endpoint smoke tests with mocked ComfyUI.

## Tests

```bash
.venv/bin/python -m pytest tests/ -q
```

## Rollback

`/home/zengonzo/workspace/facecycle/face_merge.py --serve` (port 8793) is
untouched and stays runnable; EllieEdit is additive.
