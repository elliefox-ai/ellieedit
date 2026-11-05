// Cross-tab image transfer ("send to") — pure routing logic, no DOM.
//
// Sending surfaces dispatch ONE event:
//   'ellieedit:send-to' { detail: { target, urls, names, as?, source?, provenance? } }
// shell.js validates it with routeSend(), asks the target whether it can
// accept right now, activates the target tab and forwards a target-specific
// event. Receivers load the payload the way a local upload would.
//
// Data rule: urls are SERVER urls (existing asset endpoints) — never data
// urls or base64. The receiver's own fetch-and-decode path does the work.
//
// Back-compat: facecycle and update keep their original events (and
// payload shapes); this module only maps onto them.

export const SEND_TARGETS = ['facecycle', 'update', 'puppet', 'foxden', 'filters'];

// Puppet accepts a new puppet layer or the stage background.
export const PUPPET_AS = ['layer', 'background'];

export const FACECYCLE_MAX = 8;       // mirrors handoff.js (thumb strip cap)

const isServerUrl = u => typeof u === 'string' && u.length > 0 && !/^(data|blob|javascript):/i.test(u);

export function nameFromUrl(url) {
  try {
    const u = new URL(url, 'http://x.invalid');
    const fn = u.searchParams.get('filename');
    if (fn) return fn;
    const p = u.searchParams.get('path');
    if (p) return p.split('/').pop() || 'image.png';
    return decodeURIComponent(u.pathname.split('/').pop() || '') || 'image.png';
  } catch (e) { return 'image.png'; }
}

// Issue #14 A1: a recipe is the A1 record fields of the sent image
// (prompt/workflow/seed/steps/size/loras/denoise/input_image/path).
// Only known fields survive, with their plain JSON types — anything
// else is dropped, never invented. Absent recipe stays null, so old
// senders (no recipe) keep their exact old shapes.
const RECIPE_KEYS = ['prompt', 'workflow', 'seed', 'steps', 'width',
  'height', 'loras', 'denoise', 'input_image', 'parent_image', 'path'];

export function cleanRecipe(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  const NUMERIC = ['seed', 'steps', 'width', 'height', 'denoise'];
  for (const k of RECIPE_KEYS) {
    const v = r[k];
    if (k === 'loras') {
      if (Array.isArray(v)) out[k] = v;
    } else if (NUMERIC.includes(k)) {
      // numbers, or numeric strings (a seed from a form field): coerce.
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (Number.isFinite(n)) out[k] = n;
    } else if (typeof v === 'string' && v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Normalise a raw detail into { target, urls, names, as, source } or
// { error }. Junk urls are dropped; names are padded from the url.
export function normalizeSend(detail) {
  const d = detail || {};
  const target = typeof d.target === 'string' ? d.target : '';
  if (!SEND_TARGETS.includes(target)) return { error: `Unknown send target “${target || '?'}”.` };
  const rawUrls = Array.isArray(d.urls) ? d.urls : [];
  const urls = [], names = [];
  rawUrls.forEach((u, i) => {
    if (!isServerUrl(u)) return;
    urls.push(u);
    const n = Array.isArray(d.names) ? d.names[i] : null;
    names.push(typeof n === 'string' && n ? n : nameFromUrl(u));
  });
  if (!urls.length) return { error: 'Nothing to send — no image address.' };
  const as = target === 'puppet' ? (PUPPET_AS.includes(d.as) ? d.as : 'layer') : null;
  const source = typeof d.source === 'string' && d.source ? d.source : '';
  return { target, urls, names, as, source, provenance: d.provenance || null,
           recipe: cleanRecipe(d.recipe) };
}

// Returns { target, events: [{type, detail}], label } or { error }.
// `events` are what the shell dispatches AFTER activating the tab.
export function routeSend(detail) {
  const n = normalizeSend(detail);
  if (n.error) return n;
  const { target, urls, names, as, source, provenance, recipe } = n;
  const label = source || 'another tab';
  // Issue #14 A1: the recipe travels with the image to every target
  // (previously only the source-path provenance did, and only to some
  // targets — PR #12's dropped-provenance note). Receivers that do not
  // use it yet simply ignore the field; FoxDen stores it as the input's
  // parent (see foxden.js), the rest are listed as not-done in the A1 note.
  if (target === 'facecycle') {
    if (urls.length > FACECYCLE_MAX) {
      return { error: `FaceCycle accepts at most ${FACECYCLE_MAX} images (got ${urls.length}).` };
    }
    const d = { urls, names, source: source || 'Gallery' };
    if (provenance) d.provenance = provenance;
    if (recipe) d.recipe = recipe;
    return { target, label, events: [{ type: 'ellieedit:facecycle-handoff', detail: d }] };
  }
  if (target === 'filters') {
    // Filters holds one source image: first url wins (same as Update).
    const d = { url: urls[0], name: names[0] };
    if (provenance && Array.isArray(provenance.paths) && provenance.paths[0]) d.path = provenance.paths[0];
    if (recipe) d.recipe = recipe;
    const detail = { urls, names, path: d.path, source: source || 'Gallery' };
    if (recipe) detail.recipe = recipe;
    return { target, label, events: [{ type: 'ellieedit:filters-receive', detail }] };
  }
  if (target === 'update') {
    // Update holds one source image: first url wins (same as its own handoff).
    const d = { url: urls[0], name: names[0] };
    if (provenance && Array.isArray(provenance.paths) && provenance.paths[0]) d.path = provenance.paths[0];
    if (recipe) d.recipe = recipe;
    return { target, label, events: [{ type: 'ellieedit:open-in-update', detail: d }] };
  }
  if (target === 'puppet') {
    const d = { urls, names, as, source };
    if (recipe) d.recipe = recipe;
    return { target, label, as, events: [{ type: 'ellieedit:puppet-receive', detail: d }] };
  }
  const d = { urls, names, source };
  if (recipe) d.recipe = recipe;
  return { target, label, events: [{ type: 'ellieedit:foxden-receive', detail: d }] };
}

// Receipt text shared by badges ("→ 2 images from Gallery").
export function receiptText(count, source, as) {
  const src = source || 'another tab';
  if (as === 'background') return `→ background from ${src}`;
  return `→ ${count} image${count !== 1 ? 's' : ''} from ${src}`;
}

// Gate helper for receivers: busy → { ok:false, reason }.
export function gate(busyReason) {
  return busyReason ? { ok: false, reason: busyReason } : { ok: true };
}

// The shell's whole decision, DOM-free so it is testable: validate the
// payload, check the target tab exists, ask the target's gate. Returns
// { error } (toast it, stay on the source tab) or { route } (activate the
// target, then dispatch route.events). `receivers` is a Map of
// name → { canAccept(route) → { ok, reason? } }.
export function planSend(detail, { available = [], receivers = new Map() } = {}) {
  const route = routeSend(detail);
  if (route.error) return { error: route.error };
  if (!available.includes(route.target)) return { error: `The ${route.target} tab isn't available.` };
  const rx = receivers.get(route.target);
  const verdict = rx && typeof rx.canAccept === 'function' ? rx.canAccept(route) : { ok: true };
  if (verdict && verdict.ok === false) {
    return { error: verdict.reason || 'That tab cannot accept right now.' };
  }
  return { route };
}
