"""Unified provenance record (issue #14, A1).

A provenance record is the recipe that travelled with an image: prompt,
workflow, seed, steps, size, LoRAs, source module, timestamp, and the
parent image it was made from. One record is written once per
generated/saved image — never invented: a field the write path does not
know is recorded as ``None`` (absent), never guessed.

Storage (follows the repo's existing patterns — Library's append-only
``.library-index.jsonl`` and FoxDen's ``data/foxden/recent.jsonl``):
a central append-only JSONL log, ``data/provenance.jsonl`` (env
``ELLIEEDIT_PROVENANCE_PATH``), one line per written image, keyed by
the image's path as the writing module addresses it. A2 (a single
index + global search over these records) is deliberately NOT built
here; it reads this log.

Why a central log instead of a sidecar JSON next to each image:
  - the write paths that create images (FoxDen's ComfyUI outputs,
    Update's gallery-tmp renders, FaceCycle's next-to-base saves) live
    in roots this server does not own exclusively, and a sidecar would
    not survive the moves/copies those paths already do (Library
    promote is a MOVE; Update save-back/save-new are copies) unless
    every one of them was taught to move the sidecar too;
  - the log survives all of those: each write appends a record for the
    NEW path with ``parent_image`` pointing at the old one, so the
    recipe follows the image through copies and promotes instead of
    being tied to one filename;
  - it matches how the repo already keeps per-image facts (Library
    index, FoxDen recents, saved prompts): append-only JSONL, latest
    record per path wins.

Writes are best-effort by design: a failed provenance append is logged
and swallowed, never allowed to break a generation or a save. The
record itself is still returned so a caller that embeds it elsewhere
(e.g. the Library index record) can use it even if the log write
failed.
"""

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("ellieedit.provenance")

REPO = Path(__file__).resolve().parents[1]
PROVENANCE_VERSION = 1

# Canonical field order, so records read the same everywhere.
_FIELDS = ("prompt", "workflow", "seed", "steps", "width", "height",
           "loras", "denoise", "input_image", "parent_image", "sha256")


def provenance_path() -> Path:
    return Path(os.environ.get(
        "ELLIEEDIT_PROVENANCE_PATH",
        str(REPO / "data" / "provenance.jsonl")))


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _clean_text(v):
    if isinstance(v, str) and v.strip():
        return v
    return None


def _clean_int(v):
    if isinstance(v, bool) or v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _clean_float(v):
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _clean_loras(v):
    """-> [{name, strength_model}]; anything unparseable is dropped, never invented."""
    out = []
    if not isinstance(v, (list, tuple)):
        return out
    for lo in v:
        if isinstance(lo, dict):
            name = lo.get("name")
            if isinstance(name, str) and name:
                out.append({"name": name,
                            "strength_model": _clean_float(lo.get("strength_model"))
                                            if lo.get("strength_model") is not None else 1.0})
        else:
            name = getattr(lo, "name", None)
            if isinstance(name, str) and name:
                out.append({"name": name,
                            "strength_model": _clean_float(getattr(lo, "strength_model", 1.0)) or 1.0})
    return out


def build_record(path: str, source_module: str, prompt=None, workflow=None,
                 seed=None, steps=None, width=None, height=None, loras=None,
                 denoise=None, input_image=None, parent_image=None,
                 sha256=None, ts: str | None = None, extra: dict | None = None) -> dict:
    """Build one canonical record. Unknown fields stay ``None`` — absent, never invented."""
    rec = {"version": PROVENANCE_VERSION,
           "path": str(path) if path is not None else None,
           "source_module": str(source_module),
           "prompt": _clean_text(prompt),
           "workflow": _clean_text(workflow),
           "seed": _clean_int(seed),
           "steps": _clean_int(steps),
           "width": _clean_int(width),
           "height": _clean_int(height),
           "loras": _clean_loras(loras),
           "denoise": _clean_float(denoise),
           "input_image": _clean_text(input_image),
           "parent_image": _clean_text(parent_image),
           "sha256": _clean_text(sha256),
           "ts": ts or _now_iso()}
    if isinstance(extra, dict):
        for k, v in extra.items():
            if k not in rec:
                try:
                    json.dumps(v)
                except (TypeError, ValueError):
                    continue
                rec[k] = v
    return rec


def append_record(record: dict) -> bool:
    """Append one record to the log. Best-effort: never raises."""
    try:
        p = provenance_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False,
                                separators=(",", ":")) + "\n")
        return True
    except OSError:
        log.warning("provenance append failed for %s",
                    (record or {}).get("path"), exc_info=True)
        return False


def read_records() -> list[dict]:
    """All records, oldest first; corrupt lines are skipped, never fatal."""
    p = provenance_path()
    if not p.is_file():
        return []
    out = []
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and rec.get("path"):
            out.append(rec)
    return out


def latest_for_path(path: str) -> dict | None:
    """Latest record for an exact path string, or None."""
    if not path:
        return None
    for rec in reversed(read_records()):
        if rec.get("path") == str(path):
            return rec
    return None


def lookup_parent(paths) -> dict | None:
    """First latest record found under any of the candidate path strings."""
    if isinstance(paths, str):
        paths = [paths]
    for p in paths or []:
        rec = latest_for_path(p)
        if rec is not None:
            return rec
    return None


def recipe_fields(record: dict | None) -> dict:
    """The A1 recipe fields of a record, without path/ts/source — the
    part that travels when an image is copied, promoted, or saved on.
    Empty when there is no record (nothing to carry, nothing invented)."""
    if not isinstance(record, dict):
        return {}
    fields = {k: record.get(k) for k in
              ("prompt", "workflow", "seed", "steps", "width", "height",
               "denoise", "input_image")}
    fields["loras"] = _clean_loras(record.get("loras"))
    return fields


def record_for_image(path: str, source_module: str, **fields) -> dict:
    """Build + append a record for one written image; returns the record
    (even if the append failed — callers embedding it elsewhere still
    get the recipe)."""
    rec = build_record(path, source_module, **fields)
    append_record(rec)
    return rec


def carry(parent_paths, new_path: str, source_module: str,
          **overrides) -> dict:
    """Record for a copy/move/promote of an existing image: the parent's
    recipe fields travel, ``parent_image`` points at the parent, and
    ``overrides`` (non-None values only) win. No parent record found
    means a record with the parent link and everything else absent —
    never invented. ``input_image`` does not travel: it described the
    parent's generation, not this file's."""
    parent = lookup_parent(parent_paths)
    fields: dict = {}
    if parent is not None:
        for k in ("prompt", "workflow", "seed", "steps", "width",
                  "height", "loras", "denoise"):
            fields[k] = parent.get(k)
    for k, v in overrides.items():
        if v is not None:
            fields[k] = v
    parent_image = None
    if isinstance(parent_paths, str):
        parent_image = parent_paths
    elif parent_paths:
        parent_image = str(parent_paths[0])
    return record_for_image(new_path, source_module,
                            parent_image=parent_image, **fields)
