// FoxDen form-state helpers (Task 5 addendum 2, 2026-10-14). Pure — no DOM —
// so node can test them. One shape serves both named presets and the
// auto-remembered `_last` composition.

const ASPECTS = ['landscape', 'portrait', 'square'];

// Stepped output sizes (issue #3, 2026-11-01). Each aspect keeps its ratio
// exactly across steps; step 1 is the pre-existing default size for every
// aspect, so old presets and the `_last` state keep their old dimensions.
// Steps are standard 16:9 / 1:1 sizes, smallest to largest.
export const SIZES = {
  landscape: [[768, 432], [1024, 576], [1280, 720], [1536, 864]],
  portrait: [[432, 768], [576, 1024], [720, 1280], [864, 1536]],
  square: [[768, 768], [1024, 1024], [1280, 1280], [1536, 1536]],
};

export function sizeFor(aspect, idx) {
  const list = SIZES[ASPECTS.includes(aspect) ? aspect : 'landscape'];
  const i = Number.isFinite(Number(idx)) ? Math.min(list.length - 1, Math.max(0, Math.trunc(Number(idx)))) : 1;
  return list[i];
}

// Optional fields (steps, input_image, size_idx) pass through untouched as
// soon as the form emits them — presets never need a
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
    // ALWAYS present (interface law): default 1.0 = plain txt2img behavior.
    denoise: num(r.denoise) === null ? 1 : Math.min(1, Math.max(0, num(r.denoise))),
  };
  if (num(r.steps) !== null) out.steps = num(r.steps);
  if (num(r.size_idx) !== null) out.size_idx = Math.min(3, Math.max(0, Math.trunc(num(r.size_idx))));
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

// Seed-roll for Generate (2026-10-26, workorder fx-send-seed item 2).
// The lock checkbox beside the seed field governs generates:
//   locked   -> keep the typed seed across generates;
//   unlocked (default) -> a fresh random seed on EVERY generate.
// A locked-but-empty field rolls once — after that the field holds a
// value, so subsequent generates keep it. Non-numeric input never pins:
// it rolls, exactly as an empty field does. Range matches the dice
// button (0 .. 2^31), so locked and rolled seeds behave identically
// downstream.
export function nextSeed({ locked, current }) {
  const n = Number(current);
  if (locked && current !== '' && current !== null && current !== undefined
      && Number.isFinite(n)) return Math.trunc(n);
  return Math.floor(Math.random() * 2 ** 31);
}

// Trailing debounce with an immediate flush (used on tab-hide / page-hide so a
// sleeping tablet doesn't lose the last edit).
// 2026-10-17: wrap setTimeout/clearTimeout in arrow functions — storing them
// bare in the timers object unbinds them from Window, and calling
// timers.set(...) later throws "Can only call Window.setTimeout on instances
// of Window" (Safari) / "Illegal invocation" (Chrome).
export function debounce(fn, ms, timers = {
  set: (f, d) => setTimeout(f, d),
  clear: (t) => clearTimeout(t),
}) {
  let t = null;
  const run = (...a) => { if (t) timers.clear(t); t = timers.set(() => { t = null; fn(...a); }, ms); };
  run.flush = (...a) => { if (t) { timers.clear(t); t = null; } fn(...a); };
  run.pending = () => t !== null;
  return run;
}

export function cleanName(n) { return String(n || '').split(/\s+/).filter(Boolean).join(' ').slice(0, 60); }
