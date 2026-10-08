"""EllieEdit — unified ComfyUI image-tools PWA suite.

One FastAPI service: serves the PWA shell + static modules and hosts one
router per module. Module-shell principle: the shell stays dumb; adding a
tool = dropping in a module file + a FastAPI router.
"""

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .routers import facecycle, gallery, pending, review
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")

HERE = Path(__file__).resolve().parent
STATIC_DIR = HERE.parent / "frontend"

app = FastAPI(title="EllieEdit", version="0.1.0")

app.include_router(facecycle.router)
app.include_router(gallery.router)
app.include_router(pending.router)
app.include_router(review.router)


@app.on_event("startup")
def _tmp_sweep():
    # Startup hygiene: migrate legacy repaint files out of the output root and
    # sweep stale intermediates (>24h) that a missed unlink left behind.
    removed = gallery.cleanup_tmp_dir()
    if removed:
        logging.getLogger("ellieedit").info(
            "startup tmp sweep: removed %d file(s)", removed)


@app.get("/health")
def health():
    return {"ok": True, "app": "ellieedit"}


# Static shell last so API routes take precedence.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
