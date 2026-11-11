// FoxDen recipe helpers (Chunk A UX, 2026-11-11). Pure — no DOM, no shell
// imports — so node can test them. These power the zoom viewer's settings
// column: what "Reuse settings" would apply to the open recent image.
//
// Data source is the provenance record (backend/provenance.py, PR #18)
// fetched by path; the in-memory recent entry is the fallback for images
// older than the provenance log. A field the sources don't know stays
// absent — never invented.

const RECIPE_FIELDS = ['prompt', 'workflow', 'seed', 'steps', 'width', 'height',
  'loras', 'denoise', 'input_image'];

function keep(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length ? v : null;
  return v;
}

// Merge a provenance record over a recent-entry: record wins where it
// knows a field, entry fills the gaps. Returns null when NEITHER source
// knows anything (nothing to show, nothing invented).
export function recipeSettings(entry, rec) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const r = rec && typeof rec === 'object' ? rec : {};
  const out = {};
  let any = false;
  for (const k of RECIPE_FIELDS) {
    const v = keep(k in r ? r[k] : undefined) ?? keep(e[k]);
    if (v !== null) { out[k] = v; any = true; }
  }
  return any ? out : null;
}

// Compact display lines, one per known field. Prompt is deliberately NOT
// here — it renders prominently with its own copy button; this is the
// short facts column. Unknown fields produce no line.
export function recipeLines(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const lines = [];
  if (s.workflow) lines.push(`workflow: ${s.workflow}`);
  if (s.seed !== null && s.seed !== undefined) lines.push(`seed: ${s.seed}`);
  if (s.steps !== null && s.steps !== undefined) lines.push(`steps: ${s.steps}`);
  if (s.width && s.height) lines.push(`size: ${s.width}×${s.height}`);
  if (Array.isArray(s.loras) && s.loras.length) {
    lines.push('loras: ' + s.loras.map(l =>
      `${l && l.name}${Number.isFinite(Number(l && l.strength_model)) ? ` @${Number(l.strength_model).toFixed(2)}` : ''}`).join(', '));
  }
  if (s.denoise !== null && s.denoise !== undefined && Number.isFinite(Number(s.denoise))) {
    lines.push(`denoise: ${Number(s.denoise).toFixed(2)}`);
  }
  if (s.input_image) lines.push(`input: ${s.input_image}`);
  return lines;
}

// Clipboard write with a legacy fallback (execCommand) for non-secure
// contexts / missing navigator.clipboard. Resolves true when the text is
// (best-effort) on the clipboard, false when every path failed — the
// caller owns the visual confirmation.
export async function copyText(text, nav = typeof navigator !== 'undefined' ? navigator : null) {
  const value = String(text ?? '');
  if (!value) return false;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try { await nav.clipboard.writeText(value); return true; } catch (e) { /* fall through */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
