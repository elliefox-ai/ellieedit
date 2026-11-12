// Studio — the merged tab (Stage 3, design §4 + decisions §7). FoxDen's
// generation controls (candidate strip included) and Update's viewer share
// the single working image: the studio-state store drives everything.
//
// ONE tab, two sub-views. Switching sub-views flips ONLY `hidden` +
// aria state on the view wrappers — it never re-runs loadConfig or any
// config load. Both surfaces mount exactly once, at Studio mount; the
// store living outside every tab lifecycle is the structural fix for the
// chunk-A tab-activation reset bug class (pinned in tests/test_frontend.py).
//
// Rollback path (design §5): foxden.js / update.js keep
// registerFoxdenTab() / registerUpdateTab(); shell.js reverting to those
// imports restores the two-tab layout for one release.
import { registerModule, registerReceiver } from '../shell.js';
import { studioState } from './studio-state.js';
import { mountFoxden } from './foxden.js';
import { mountUpdate } from './update.js';

const SUBVIEWS = ['generate', 'refine'];
const VIEW_KEY = 'ellieedit.studio.subview';

export function mountStudio(panel, jobbar) {
  panel.innerHTML = `
  <style>
    .st-wrap { height: 100%; display: flex; flex-direction: column; min-height: 0; }
    .st-viewbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
      background: #12121f; border-bottom: 1px solid #2a2a44; flex: 0 0 auto; }
    .st-viewbar .st-viewbtn.active-toggle { background: #3a2a5a; border-color: #b39ae0; color: #fff; }
    .st-hint { font-size: 11px; color: #6c6c8e; margin-left: auto;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .st-view { flex: 1; min-height: 0; }
    .st-view[hidden] { display: none; }
  </style>
  <div class="st-wrap">
    <div class="st-viewbar" role="tablist" aria-label="Studio sub-views">
      <button class="ee-btn st-viewbtn" data-view="generate"
        aria-expanded="true" title="Generate — the FoxDen composition form, inputs, LoRAs, candidate strip">⚡ Generate</button>
      <button class="ee-btn st-viewbtn" data-view="refine"
        aria-expanded="false" title="Refine — the version-stack viewer: runs, mask inpaint, compare, save">✎ Refine</button>
      <span class="st-hint" title="Studio works on one working image — the 📌 chip in the tab bar shows it. Generation with denoise < 1 uses it as the img2img input; every finished output becomes the working image.">one working image · outputs auto-promote</span>
    </div>
    <section class="st-view" data-viewpanel="generate"></section>
    <section class="st-view" data-viewpanel="refine" hidden></section>
  </div>`;

  const genPanel = panel.querySelector('[data-viewpanel="generate"]');
  const refPanel = panel.querySelector('[data-viewpanel="refine"]');
  // Exactly ONE mount per surface, exactly once per page load. No config
  // fetch happens on a sub-view switch — both views stay constructed.
  mountFoxden(genPanel, jobbar);
  mountUpdate(refPanel);

  // Sub-view switch: hidden + aria-expanded + active-toggle only. No
  // fetch, no loadConfig, no store reset — the drawer-contract shape
  // (ellieedit-ui-layout skill) applied to tab sub-views.
  function showSubView(view) {
    const generateOn = view === 'generate';
    genPanel.hidden = !generateOn;
    refPanel.hidden = generateOn;
    for (const b of panel.querySelectorAll('.st-viewbtn')) {
      const on = b.dataset.view === view;
      b.classList.toggle('active-toggle', on);
      b.setAttribute('aria-expanded', String(on));
    }
    try { sessionStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ }
  }
  panel.querySelector('.st-viewbar').addEventListener('click', e => {
    const b = e.target.closest('.st-viewbtn');
    if (b) showSubView(b.dataset.view);
  });
  let savedView = 'generate';
  try { savedView = sessionStorage.getItem(VIEW_KEY) || 'generate'; } catch { /* private mode */ }
  showSubView(SUBVIEWS.includes(savedView) ? savedView : 'generate');

  // Send-to target (send-to.js routes 'studio' here): set the working
  // image and land on the refine view, which shows it via the store.
  registerReceiver('studio', { canAccept: () => ({ ok: true }) });
  window.addEventListener('ellieedit:studio-set-working', async e => {
    const d = e.detail || {};
    if (d.path) {
      studioState().set(d.path, String(d.source || 'send').toLowerCase(), { name: d.name });
      showSubView('refine');
      return;
    }
    // Path-less payload (e.g. Puppet composite export URL): bound it to a
    // gallery-addressable path first — one bounded /api/filters/store
    // write, source_module "studio" — then set the store. Never a blob
    // address in the store: the working image must survive reloads.
    if (!d.url) return;
    try {
      const blob = await (await fetch(d.url)).blob();
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result); fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      const r = await fetch('/api/filters/store', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: dataUrl, source_module: 'studio' }) });
      if (!r.ok) throw new Error(`store failed: ${r.status}`);
      const { render_path } = await r.json();
      studioState().set(render_path, String(d.source || 'send').toLowerCase(), { name: d.name });
      showSubView('refine');
    } catch (err) {
      import('../shell.js').then(({ toast }) => toast(`could not set working image: ${err.message}`, true));
    }
  });

  return { showSubView };
}

registerModule({
  name: 'studio',
  label: 'Studio',
  icon: '🎨',
  order: 0,
  mount: (panel, jobbar) => mountStudio(panel, jobbar),
});
