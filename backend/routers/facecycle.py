"""FaceCycle module router — ported from face_merge.py's /repaint relay.

Contract kept 1:1 with the original: JSON in {image_b64, mask_b64, prompt,
denoise, seed} → JSON out {image_b64}. Multiple variants are requested as
parallel calls from the client, exactly like the original UI does.
"""

import base64
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import comfy

log = logging.getLogger("ellieedit.facecycle")

router = APIRouter(prefix="/api/facecycle", tags=["facecycle"])


class RepaintRequest(BaseModel):
    image_b64: str
    mask_b64: str
    prompt: str = ""
    denoise: float = Field(0.5, ge=0.0, le=1.0)
    seed: int = 0


@router.post("/repaint")
def repaint(req: RepaintRequest):
    """Run one Krea2 inpaint via ComfyUI. Blocking (long); runs in a worker thread."""
    try:
        png = comfy.comfy_repaint(
            req.image_b64, req.mask_b64, req.prompt,
            denoise=req.denoise, seed=req.seed)
    except Exception as e:
        log.error("[repaint] ERROR: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    return {"image_b64": base64.b64encode(png).decode()}
