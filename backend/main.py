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

from .routers import dupe, facecycle, foxden, gallery, library, pending, puppet, review, update
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")

HERE = Path(__file__).resolve().parent
STATIC_DIR = HERE.parent / "frontend"

app = FastAPI(title="EllieEdit", version="0.1.0")

app.include_router(dupe.router)
app.include_router(facecycle.router)
app.include_router(foxden.router)
app.include_router(gallery.router)
app.include_router(library.router)
app.include_router(pending.router)
app.include_router(puppet.router)
app.include_router(review.router)
app.include_router(update.router)


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


class NoCacheStaticFiles(StaticFiles):
    """Static JS/CSS must revalidate every load. No Cache-Control header means
    Safari applies heuristic caching (10% of file age) and skips revalidation
    entirely on module imports — stale-module mixups on iPad Safari twice
    (fx-send-seed deploy 2026-10-26). ETag revalidation keeps 304s cheap."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        if resp.headers.get("content-type", "").startswith(("text/javascript", "text/css")):
            resp.headers["Cache-Control"] = "no-cache"
        return resp


# Static shell last so API routes take precedence.
app.mount("/", NoCacheStaticFiles(directory=STATIC_DIR, html=True), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
