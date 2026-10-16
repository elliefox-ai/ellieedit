// FoxDen form-state helpers (Task 5 addendum 2, 2026-10-14). Pure — no DOM —
// so node can test them. One shape serves both named presets and the
// auto-remembered `_last` composition.

const ASPECTS = ['landscape', 'portrait'];

// Optional fields pass through untouched so img2img (input_image/denoise) and
// steps ride along as soon as the form emits them — presets never need a
// migration when the form grows.
export function normalizeState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const lora = l => ({ name: String(l.name), strength_model: Number.isFinite(Number(l.strength_model)) ? Number(l.strength_model) : 1 });
  const out = {
    workflow: typeof r.workflow === 'string' ? r.workflow : '',
    prompt: typeof r.prompt === 'string' ? r.prompt : '',
    aspect: ASPECTS.includes(r.aspect) ? r.aspect : 'landscape',
    seed: num(r.seed),
    loras: Array.isArray(r.loras) ? r.loras.filter(l => l && l.name).map(lora) : [],
    suspended_loras: Array.isArray(r.suspended_loras) ? r.suspended_loras.filter(l => l && l.name).map(lora) : [],
  };
  if (num(r.steps) !== null) out.steps = num(r.steps);
  if (num(r.denoise) !== null) out.denoise = num(r.denoise);
  if (typeof r.input_image === 'string' && r.input_image) out.input_image = r.input_image;
  return out;
}

// A named preset saves the seed only when "lock seed" is ticked; otherwise the
// seed is left random (null) so applying the preset never pins an old seed.
export function presetState(state, lockSeed) {
  const s = normalizeState(state);
  if (!lockSeed) s.seed = null;
  return s;
}

// Trailing debounce with an immediate flush (used on tab-hide / page-hide so a
// sleeping tablet doesn't lose the last edit).
export function debounce(fn, ms, timers = { set: setTimeout, clear: clearTimeout }) {
  let t = null;
  const run = (...a) => { if (t) timers.clear(t); t = timers.set(() => { t = null; fn(...a); }, ms); };
  run.flush = (...a) => { if (t) { timers.clear(t); t = null; } fn(...a); };
  run.pending = () => t !== null;
  return run;
}

export function cleanName(n) { return String(n || '').split(/\s+/).filter(Boolean).join(' ').slice(0, 60); }
