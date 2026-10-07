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

from .routers import facecycle, gallery, review

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")

HERE = Path(__file__).resolve().parent
STATIC_DIR = HERE.parent / "frontend"

app = FastAPI(title="EllieEdit", version="0.1.0")

app.include_router(facecycle.router)
app.include_router(gallery.router)
app.include_router(review.router)


@app.get("/health")
def health():
    return {"ok": True, "app": "ellieedit"}


# Static shell last so API routes take precedence.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
