// EllieEdit shell — module registry + tab bar + job bar.
// The shell stays dumb: modules self-register a descriptor
// { name, label, icon, mount(panelEl, jobbar) } and the shell composes them.
// Adding a tool = a module file in js/modules/ + a FastAPI router.
// Cross-tab image transfer: sending surfaces dispatch 'ellieedit:send-to'
// (see send-to.js); the shell routes it to the target tab (v1.4).

// Bump on every deploy — shown in the job bar so a stale-cache client is
// instantly visible.
const BUILD = '2026-11-17h';

import { planSend } from './send-to.js';
import { studioState } from './modules/studio-state.js';
import { resolveHash } from './modules/studio-tabs.js';

const registry = [];
const mounted = new Map(); // name -> { panelEl }
const receivers = new Map(); // target name -> { canAccept(route) -> { ok, reason? } }


export function registerModule(desc) {
  registry.push(desc);
  registry.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// A module that can receive 'send to' transfers registers a gate so the
// shell can refuse BEFORE switching tabs (e.g. Puppet mid-render).
export function registerReceiver(name, rx) { receivers.set(name, rx || {}); }

export function toast(msg, isErr) {
  const t = document.createElement('div');
  t.setAttribute('role', 'status');
  t.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);' +
    'background:' + (isErr ? '#7a2a2a' : '#2a5a3a') + ';color:#fff;padding:10px 18px;' +
    'border-radius:8px;font-size:13px;z-index:200;max-width:80vw';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

const tabbar = document.getElementById('tabbar');
const host = document.getElementById('module-host');
const jobbar = document.getElementById('jobbar');

function activate(name) {
  for (const { name: n } of registry) {
    const m = mounted.get(n);
    if (m) m.panelEl.classList.toggle('active', n === name);
  }
  for (const btn of tabbar.children) {
    btn.classList.toggle('active', btn.dataset.name === name);
  }
  // Modules re-sync on activation (e.g. Gallery re-reads the pending manifest
  // so marked/badge state can never go stale after a Ladder round).
  window.dispatchEvent(new CustomEvent('ellieedit:tab-activated', { detail: { name } }));
}

function buildTabs() {
  tabbar.innerHTML = '';
  // Tabs first, then the build marker and working chip: the marker used to
  // sit first with margin-left:auto, so on a narrow screen it pushed the
  // tabs off the right edge (usability pass 2026-11-15). The tabbar now
  // scrolls horizontally, so every tab stays reachable.
  for (const desc of registry) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.name = desc.name;
    btn.innerHTML = `<span class="icon">${desc.icon}</span><span>${desc.label}</span>`;
    btn.addEventListener('click', () => activate(desc.name));
    tabbar.appendChild(btn);
  }
  const marker = document.createElement('span');
  marker.style.cssText = 'margin-left:auto;align-self:center;font-size:10px;color:#5a5a7a;padding-right:8px;flex-shrink:0';
  marker.textContent = `build ${BUILD}`;
  tabbar.appendChild(marker);
  // Working-image chip (decision #3): a visible indicator of what's loaded,
  // living in the shell — outside every tab, so it survives tab switches.
  // The × clears the store; switching tabs never does.
  const chip = document.createElement('span');
  chip.id = 'working-chip';
  chip.style.cssText = 'display:none;align-self:center;margin-right:8px;padding:2px 8px;' +
    'background:#2d2d44;border:1px solid #5a5a7a;border-radius:12px;font-size:11px;color:#cfcfe8;' +
    'max-width:24vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  const chipLabel = document.createElement('span');
  chipLabel.style.cssText = 'overflow:hidden;text-overflow:ellipsis';
  const chipClear = document.createElement('button');
  chipClear.setAttribute('aria-label', 'Clear working image');
  chipClear.title = 'Clear the working image';
  chipClear.textContent = '✕';
  chipClear.style.cssText = 'border:none;background:none;color:#8a8ab0;font-size:11px;cursor:pointer;padding:0 0 0 6px';
  chipClear.addEventListener('click', () => studioState().clear());
  chip.appendChild(chipLabel);
  chip.appendChild(chipClear);
  tabbar.appendChild(chip);
  const syncChip = d => {
    if (d.path) {
      chip.style.display = 'inline-flex';
      chip.title = `Working image: ${d.name} (${d.origin})`;
      chipLabel.textContent = `📌 ${d.name}`;
    } else {
      chip.style.display = 'none';
      if (d.reason === 'missing') toast('working image no longer exists — cleared', true);
    }
  };
  studioState().subscribe(syncChip);
  syncChip(studioState().restore());
}

function mountAll() {
  for (const desc of registry) {
    if (mounted.has(desc.name)) continue;
    const panel = document.createElement('section');
    panel.className = 'module-panel';
    panel.id = `module-${desc.name}`;
    host.appendChild(panel);
    mounted.set(desc.name, { panelEl: panel });
    // Module fills its panel; jobbar shared for job status.
    desc.mount(panel, jobbar);
  }
  if (registry.length) activate(registry[0].name);
  // Deep-link compatibility (Stage 3): #foxden / #update bookmarks land
  // on Studio; a live #tab-name hash still opens that tab. Re-applied on
  // every hashchange so pasted links work mid-session.
  applyHash();
}

function applyHash() {
  const target = resolveHash(location.hash, registry.map(d => d.name));
  if (target) activate(target);
}
window.addEventListener('hashchange', applyHash);

// Cross-module tab activation (Gallery → Ladder handoff).
window.addEventListener('ellieedit:activate', e => {
  if (registry.some(d => d.name === e.detail?.name)) activate(e.detail.name);
});

// Uniform "send to": validate → ask the target → activate → forward the
// target's own event. A refusal stays on the SOURCE tab with a toast —
// never a silent drop, never a tab switch for nothing.
window.addEventListener('ellieedit:send-to', e => {
  const plan = planSend(e.detail, { available: registry.map(d => d.name), receivers });
  if (plan.error) { toast(plan.error, true); return; }
  activate(plan.route.target);
  for (const ev of plan.route.events) window.dispatchEvent(new CustomEvent(ev.type, { detail: ev.detail }));
});

// Import modules (self-registering) then build.
// ?v=${BUILD} stamps every module import so served code can never be a
// different version than the badge — mixed-version caches are impossible.
Promise.all([
  import(`./modules/gallery.js?v=${BUILD}`),
  import(`./modules/facecycle.js?v=${BUILD}`),
  import(`./modules/review.js?v=${BUILD}`),
  import(`./modules/dupe.js?v=${BUILD}`),
  import(`./modules/puppet.js?v=${BUILD}`),
  import(`./modules/library.js?v=${BUILD}`),
  import(`./modules/filters.js?v=${BUILD}`),
  // Stage 3: the merged Studio tab (FoxDen + Update surfaces mounted as
  // sub-views). foxden.js/update.js stay in the tree unrouted for one
  // release as the rollback path (design §5) — their exported register
  // helpers restore the old tabs if ever re-imported.
  import(`./modules/studio.js?v=${BUILD}`),
]).then(() => {
  buildTabs();
  mountAll();
}).catch(err => {
  jobbar.innerHTML = `<span class="badge err">Module load failed: ${String(err.message || err)}</span>`;
  console.error(err);
});
