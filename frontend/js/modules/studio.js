// Studio — Stage 4 (settled layout, mock-1b, design doc §10). ONE working
// image: a single canvas (pan/zoom via zoom-viewer math) + a right rail
// with tabs Generate | Refine | Provenance. The Stage 3 sub-tab stacking
// (Update/FoxDen mounted as side-by-side surfaces) is gone — this module
// IS the consolidation: it talks to the same endpoints directly and owns
// one canvas, one candidate strip, one comprehensive save module, and a
// fullscreen (immersive) mode with touch-first chrome.
//
// Mount-once semantics (chunk-A bug class, pinned in tests/test_frontend.py):
// everything is configured exactly once at mount. Tab activation never
// re-fetches config and never touches the store — the working-image store
// lives outside any tab lifecycle (studio-state.js).
//
// Rollback path (design §5): foxden.js / update.js keep their register
// helpers unrouted; shell.js reverting to the Stage 3 studio (git) restores
// the previous layout for one release.
import { registerModule, registerReceiver, toast } from '../shell.js';
import { studioState, galleryFileUrl } from './studio-state.js';
import { createCandidates, pathFromViewUrl } from './studio-candidates.js';
import {
  createStack, current, source, compareEntry, canRevert,
  pushRender, selectEntry, revert, revertToOriginal, setViewedAsBase, saveable,
} from './update-stack.js';
import { normalizeState, presetState, debounce, cleanName, nextSeed, sizeFor, rebuildSelectPreserving } from './foxden-state.js';
import { createPins } from './foxden-loras.js';
import { dist, pinchScale, clampPan, wheelScale } from './zoom-viewer.js';
import { tuneImageData, tunesAreIdentity } from './filters-tunes.js';
import { clampBatch, batchFromPointer, BATCH_MAX } from './studio-pips.js';

const API = '/api/foxden';
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Filters toolset (collapse section inside Refine): the /api/filters/apply
// parameter set + canvas tunes, exactly the params filters.js sends.
const FILTER_SLIDERS = [
  ['ch-dark', 'dark_t', parseFloat], ['ch-sat', 'sat_mul', parseFloat],
  ['ch-val', 'val_mul', parseFloat], ['ch-smooth', 'smooth', v => parseInt(v, 10) === 0 ? 0 : parseInt(v, 10) * 2 + 1],
  ['ch-sigma', 'line_sigma', parseFloat],
  ['gate-maxw', 'gate_maxw', v => parseInt(v, 10)], ['gate-bh', 'gate_bh_full', parseFloat],
  ['gate-strength', 'gate_strength', parseFloat],
  ['vib-strength', 'vibrance', parseFloat], ['vib-falloff', 'vibrance_falloff', parseFloat],
  ['vib-protect', 'vibrance_protect', parseFloat],
  ['tn-sat', 'satMul', parseFloat], ['tn-bri', 'brightness', parseFloat],
  ['tn-con', 'contrast', parseFloat], ['tn-lift', 'lift', parseFloat],
  ['tn-edge', 'edge', parseFloat], ['strength', 'strength', parseFloat],
];

function panelHTML() {
  return `
  <style>
    .st-root { height: 100%; display: flex; flex-direction: column; min-height: 0; background: #0f0f1a; }
    .st-root button { font: inherit; color: #d4d4e0; background: #1d1d33; border: 1px solid #4a4a6c;
      border-radius: 6px; padding: 8px 14px; cursor: pointer; min-height: 36px; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
    .st-root button:hover:not(:disabled) { background: #4a4a6c; }
    .st-root button.primary { background: #5b4a8a; border-color: #7a6aaa; color: #fff; }
    .st-root button:disabled { opacity: .4; cursor: default; }
    .st-root label { font-size: 11px; color: #8a8aaa; text-transform: uppercase; letter-spacing: .06em; display: block; margin: 10px 0 4px; }
    .st-root input, .st-root textarea, .st-root select { font: inherit; background: #161628; color: #d4d4e0;
      border: 1px solid #4a4a6c; border-radius: 6px; padding: 8px; width: 100%; box-sizing: border-box; }
    .st-root textarea { resize: vertical; }
    .st-head { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: #12121f;
      border-bottom: 1px solid #2a2a44; flex: 0 0 auto; }
    .st-head h1 { font-size: 15px; font-weight: 600; margin: 0; }
    .st-provchip { display: flex; align-items: center; gap: 8px; background: #161628; border: 1px solid #4a4a6c;
      border-radius: 20px; padding: 4px 12px 4px 6px; font-size: 12px; color: #8a8aaa; max-width: 40vw; min-width: 0; overflow: hidden; }
    .st-provchip .dot { width: 22px; height: 22px; border-radius: 50%; flex: 0 0 auto;
      background: linear-gradient(135deg,#5b4a8a,#b39ae0); display: grid; place-items: center; font-size: 12px; }
    .st-provchip b { color: #d4d4e0; font-weight: 500; }
    .st-provchain { color: #6c6c8e; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .st-head .spacer { flex: 1; }
    .st-main { flex: 1; display: flex; min-height: 0; }
    /* ---- canvas column ---- */
    .st-stagecol { flex: 1; display: flex; flex-direction: column; min-width: 0; background: #0a0a12; position: relative; }
    .st-canvasarea { flex: 1; display: grid; place-items: center; padding: 20px; min-height: 0; overflow: hidden; touch-action: none; }
    .st-frame { position: relative; border: 1px solid #4a4a6c; border-radius: 8px; overflow: hidden;
      box-shadow: 0 8px 40px rgba(0,0,0,.5); touch-action: none; user-select: none; -webkit-user-select: none; transform-origin: center; }
    .st-frame img { display: block; max-width: min(100%, 1100px); max-height: 60vh; object-fit: contain; pointer-events: none; }
    .st-frame .st-imgb { position: absolute; inset: 0; overflow: hidden; }
    .st-frame .st-imgb img { max-width: none; max-height: none; width: 100%; height: 100%; position: absolute; inset: 0; }
    .st-badge { position: absolute; top: 10px; left: 10px; z-index: 6; background: rgba(15,15,26,.85);
      border: 1px solid #4a4a6c; border-radius: 5px; padding: 3px 10px; font-size: 11px; color: #b39ae0; pointer-events: none; }
    .st-cmpbar { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 6; display: none;
      gap: 0; background: rgba(15,15,26,.9); border: 1px solid #4a4a6c; border-radius: 8px; overflow: hidden; }
    .st-frame.comparing .st-cmpbar { display: flex; }
    .st-cmpbar button { border: 0; border-radius: 0; background: transparent; min-height: 44px; font-size: 12px; color: #8a8aaa; }
    .st-cmpbar button.on { background: #5b4a8a; color: #fff; }
    .st-frame.comparing .st-imgb { clip-path: inset(0 var(--cmp, 50%) 0 0); }
    .st-emptymsg { color: #6c6c8e; font-size: 13px; text-align: center; max-width: 420px; padding: 20px; }
    .st-canvasarea.has-image .st-emptymsg { display: none; }
    /* ---- candidate strip ---- */
    .st-strip { flex: 0 0 auto; padding: 10px 20px 12px; border-top: 1px solid #2a2a44; background: #12121f; }
    .st-strip.st-running .st-cands { opacity: .55; }
    .st-striphead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
    .st-striphead h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8a8aaa; margin: 0; }
    .st-striphead .note { font-size: 11px; color: #6c6c8e; }
    .st-striphead .note em { color: #b39ae0; font-style: normal; }
    .st-cands { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; min-height: 90px; align-items: center; }
    .st-cand { flex: 0 0 128px; border: 2px solid transparent; border-radius: 8px; overflow: hidden;
      position: relative; cursor: pointer; background: #161628; padding: 0; min-height: 0 !important; }
    .st-cand img { display: block; width: 100%; height: 86px; object-fit: cover; }
    .st-cand .tag { position: absolute; top: 4px; left: 4px; font-size: 10px; background: rgba(15,15,26,.85);
      border-radius: 4px; padding: 1px 6px; color: #b39ae0; }
    .st-cand.sel { border-color: #b39ae0; }
    .st-cand .pick { position: absolute; bottom: 4px; right: 4px; font-size: 10px; background: #5b4a8a;
      color: #fff; border-radius: 4px; padding: 2px 7px; opacity: 0; }
    .st-cand.sel .pick { opacity: 1; }
    .st-cand.empty { display: grid; place-items: center; height: 86px; color: #6c6c8e; font-size: 11px;
      border: 2px dashed #2a2a44; background: transparent; cursor: default; }
    /* ---- right rail ---- */
    .st-rail { flex: 0 0 330px; background: #12121f; border-left: 1px solid #2a2a44; display: flex; flex-direction: column; min-height: 0; }
    .st-verbswitch { display: flex; margin: 12px; background: #161628; border: 1px solid #4a4a6c; border-radius: 8px; overflow: hidden; }
    .st-verbswitch button { flex: 1; border: 0; border-radius: 0; background: transparent; color: #8a8aaa; min-height: 44px; font-size: 13px; }
    .st-verbswitch button.on { background: #5b4a8a; color: #fff; }
    .st-railbody { flex: 1; overflow-y: auto; padding: 0 16px 16px; min-height: 0; }
    .st-verbpanel[hidden] { display: none; }
    .st-railactions { flex: 0 0 auto; padding: 12px 16px; border-top: 1px solid #2a2a44; background: #161628; }
    .st-railactions .row { display: flex; gap: 8px; }
    .st-railactions .row + .row { margin-top: 8px; }
    .st-railactions button { flex: 1; font-size: 12.5px; }
    .st-savenote { font-size: 11px; color: #6c6c8e; margin-top: 8px; text-align: center; }
    .st-row2 { display: flex; gap: 8px; }
    .st-row2 > * { flex: 1; min-width: 0; }
    .st-hintline { font-size: 11px; color: #6c6c8e; margin-top: 4px; }
    .st-hintline b { color: #b39ae0; font-weight: 600; }
    .st-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .st-chip { font-size: 11px; padding: 6px 9px; border-radius: 12px; border: 1px solid #4a4a6c;
      color: #8a8aaa; cursor: pointer; background: #161628; min-height: 32px; }
    .st-chip.on { background: #5b4a8a; border-color: #7a6aaa; color: #fff; }
    /* ---- batch drag pips ---- */
    .st-pips { display: flex; gap: 8px; align-items: center; padding: 10px 4px; min-height: 44px;
      touch-action: none; cursor: ew-resize; user-select: none; -webkit-user-select: none; }
    .st-pip { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #4a4a6c; background: #161628;
      display: grid; place-items: center; font-size: 11px; color: #6c6c8e; flex: 0 0 auto; transition: all .15s; padding: 0; min-height: 0; }
    .st-pip.on { background: #5b4a8a; border-color: #b39ae0; color: #fff; }
    .st-pip.cursor { border-color: #b39ae0; box-shadow: 0 0 0 3px rgba(179,154,224,.25); }
    /* ---- collapsible Filters section inside Refine ---- */
    .st-root details.collapse { margin-top: 14px; border: 1px solid #2a2a44; border-radius: 8px; background: #161628; }
    .st-root details.collapse summary { cursor: pointer; list-style: none; padding: 12px 14px; font-size: 12px;
      text-transform: uppercase; letter-spacing: .06em; color: #8a8aaa; min-height: 44px; display: flex; align-items: center; }
    .st-root details.collapse summary::-webkit-details-marker { display: none; }
    .st-root details.collapse summary::after { content: '▾'; margin-left: auto; color: #6c6c8e; }
    .st-root details.collapse[open] summary::after { content: '▴'; }
    .st-root details.collapse .inside { padding: 4px 14px 14px; }
    .st-root details.collapse input[type=range] { padding: 0; }
    /* ---- provenance panel ---- */
    .st-provtable { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 6px; }
    .st-provtable td { padding: 7px 6px; border-bottom: 1px solid #2a2a44; vertical-align: top; }
    .st-provtable td:first-child { color: #8a8aaa; font-size: 11px; text-transform: uppercase;
      letter-spacing: .05em; width: 38%; padding-top: 9px; }
    .st-provtable td b { color: #d4d4e0; font-weight: 500; }
    .st-provtable .mono { font-family: ui-monospace, monospace; color: #b39ae0; font-size: 12px; }
    .st-parentchain { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
    .st-parentchain .node { display: flex; align-items: center; gap: 8px; background: #161628;
      border: 1px solid #4a4a6c; border-radius: 6px; padding: 6px 10px; font-size: 12px; }
    .st-parentchain .node small { color: #6c6c8e; display: block; font-size: 10.5px; }
    .st-parentchain .arrow { text-align: center; color: #6c6c8e; font-size: 11px; line-height: 1; }
    .st-parentchain .node.cur { border-color: #b39ae0; }
    /* ---- fullscreen (immersive) mode ---- */
    .st-root.st-immersive { position: fixed; inset: 0; z-index: 90; background: #000; }
    .st-root.st-immersive .st-head,
    .st-root.st-immersive .st-rail,
    .st-root.st-immersive .st-strip { display: none; }
    .st-root.st-immersive .st-main { display: block; }
    .st-root.st-immersive .st-stagecol { height: 100%; }
    .st-root.st-immersive .st-canvasarea { padding: 0; height: 100%; }
    .st-root.st-immersive .st-frame { border: 0; border-radius: 0; box-shadow: none; background: #000;
      max-width: 100vw; max-height: 100vh; display: grid; place-items: center; }
    .st-root.st-immersive .st-frame img { max-width: 100vw; max-height: 100vh; width: auto; height: auto; }
    .st-root.st-immersive .st-frame .st-imgb img { width: 100%; height: 100%; }
    .st-edgetab { position: fixed; right: 0; top: 0; z-index: 96; display: none; background: #161628;
      border: 1px solid #4a4a6c; border-right: 0; border-radius: 10px 0 0 10px; color: #b39ae0;
      font-size: 12px; letter-spacing: .12em; padding: 10px 14px; min-height: 44px; min-width: 72px;
      box-shadow: 2px 2px 12px rgba(0,0,0,.5); }
    .st-root.st-immersive .st-edgetab { display: block; }
    .st-genfab { position: fixed; right: 24px; bottom: 24px; z-index: 96; width: 76px; height: 76px;
      border-radius: 50%; display: none; place-items: center; background: #5b4a8a; border: 2px solid #7a6aaa;
      color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.6); padding: 0; overflow: hidden; }
    .st-root.st-immersive .st-genfab { display: grid; }
    .st-genfab .ring { position: absolute; inset: 0; border-radius: 50%;
      background: conic-gradient(#b39ae0 var(--p, 0%), transparent 0); opacity: .9; }
    .st-genfab .inner { position: relative; width: 62px; height: 62px; border-radius: 50%; background: #5b4a8a;
      display: grid; place-items: center; font-size: 11.5px; line-height: 1.2; text-align: center; }
    .st-genfab.running .inner { background: #3a2a5a; }
    .st-bottomhandle { position: fixed; left: 50%; bottom: 0; transform: translateX(-50%); z-index: 96; display: none;
      background: rgba(22,22,40,.9); border: 1px solid #4a4a6c; border-bottom: 0; border-radius: 12px 12px 0 0;
      color: #8a8aaa; font-size: 11px; padding: 6px 26px 8px; min-height: 44px; letter-spacing: .08em; }
    .st-root.st-immersive .st-bottomhandle { display: block; }
    .st-bottomhandle .grip { display: block; width: 44px; height: 4px; border-radius: 2px; background: #4a4a6c; margin: 0 auto 5px; }
    .st-candoverlay { position: fixed; left: 0; right: 0; bottom: 0; z-index: 95; background: rgba(18,18,31,.97);
      border-top: 1px solid #4a4a6c; padding: 14px 20px 18px; transform: translateY(105%); transition: transform .25s ease;
      max-height: 45vh; overflow-y: auto; }
    .st-candoverlay.open { transform: translateY(0); }
    .st-candoverlay .ov-actions { display: flex; gap: 8px; margin-top: 12px; }
    .st-candoverlay .ov-actions button { flex: 1; font-size: 12.5px; min-height: 44px; }
    .st-toast { position: fixed; top: 18px; left: 50%; transform: translate(-50%, -140%); z-index: 99;
      background: rgba(22,22,40,.95); border: 1px solid #b39ae0; border-radius: 10px; padding: 10px 18px;
      font-size: 13px; color: #d4d4e0; display: flex; align-items: center; gap: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,.6); transition: transform .3s ease; }
    .st-toast.show { transform: translate(-50%, 0); }
    .st-toast .tick { width: 20px; height: 20px; border-radius: 50%; background: #7de08a; color: #0f0f1a;
      display: grid; place-items: center; font-size: 12px; font-weight: 700; }
    /* ---- iPad / mobile ---- */
    @media (max-width: 900px) {
      .st-main { flex-direction: column; }
      .st-stagecol { order: 1; }
      .st-rail { order: 2; flex: 0 0 auto; border-left: 0; border-top: 1px solid #2a2a44; max-height: 52vh; }
      .st-frame img { max-height: 44vh; }
      .st-verbswitch { position: sticky; top: 0; z-index: 5; margin: 0; border-radius: 0;
        border-left: 0; border-right: 0; background: #12121f; }
      .st-root button { min-height: 44px; }
      .st-cand { flex-basis: 110px; }
      .st-cand img { height: 72px; }
      .st-provchip { max-width: 34vw; }
    }
  </style>
  <div class="st-root">
    <header class="st-head">
      <h1>Studio</h1>
      <span class="st-provchip" title="Working image provenance" data-id="chip" hidden>
        <span class="dot">📌</span>
        <span><b data-id="chip-name">—</b><span class="st-provchain" data-id="chip-chain"></span></span>
      </span>
      <span class="spacer"></span>
      <button class="st-clear" data-id="clear" title="Clear working image" hidden>✕ clear</button>
      <button data-id="imm" title="Hide chrome; image fills screen">⛶ Fullscreen</button>
    </header>

    <div class="st-main">
      <section class="st-stagecol">
        <div class="st-canvasarea" data-id="canvasarea">
          <div class="st-emptymsg">No working image yet.<br>
            Set one from the Gallery (📌 Set as working image), the Ladder verb, or a candidate below.
            Generate lands here too — every finished output becomes the working image.</div>
          <div class="st-frame" data-id="frame" hidden>
            <span class="st-badge" data-id="badge"></span>
            <img data-id="img-a" alt="working image">
            <span class="st-imgb" data-id="wrap-b"><img data-id="img-b" alt="current render"></span>
            <div class="st-cmpbar" data-id="cmpbar">
              <button class="on" data-c="after">Result</button>
              <button data-c="before">Before</button>
              <button data-c="split">Split</button>
            </div>
          </div>
        </div>
        <div class="st-strip" data-id="strip">
          <div class="st-striphead">
            <h2>Candidates</h2>
            <span class="note">nothing auto-saves — <em>next run overwrites unretrieved candidates</em></span>
          </div>
          <div class="st-cands" data-id="cands" aria-label="Candidate outputs of this generation run"></div>
        </div>
      </section>

      <aside class="st-rail">
        <div class="st-verbswitch" role="tablist" aria-label="Studio rail tabs">
          <button class="on" data-verb="generate" role="tab" aria-selected="true">⚡ Generate</button>
          <button data-verb="refine" role="tab" aria-selected="false">✎ Refine</button>
          <button data-verb="provenance" role="tab" aria-selected="false">🧬 Provenance</button>
        </div>

        <div class="st-railbody">
          <!-- GENERATE -->
          <div class="st-verbpanel" data-panel="generate">
            <label>Workflow</label><select data-id="wf"></select>
            <label>Prompt</label><textarea data-id="prompt" rows="3" placeholder="describe the image…"></textarea>
            <div class="st-row2">
              <div><label>Aspect</label>
                <div class="st-chips" data-id="aspects">
                  <button class="st-chip on" data-a="landscape">▭ Landscape</button>
                  <button class="st-chip" data-a="portrait">▯ Portrait</button>
                  <button class="st-chip" data-a="square">■ Square</button>
                </div>
                <label>Size <span data-id="sizeval">1024×576</span></label>
                <input type="range" data-id="size" min="0" max="3" step="1" value="1" aria-label="Output size step">
              </div>
            </div>
            <div class="st-row2">
              <div><label>Seed</label><input type="number" data-id="seed" placeholder="random"></div>
              <div style="display:flex;align-items:end;gap:6px">
                <label style="margin:0 0 8px"><input type="checkbox" data-id="lock" style="width:auto"> 🔒 lock</label>
                <button data-id="dice" title="Random seed">🎲</button>
              </div>
            </div>
            <label>Denoise <span data-id="dval">1.00</span></label>
            <input type="range" data-id="denoise" min="0.1" max="1" step="0.05" value="1" aria-label="Denoise">
            <span class="st-hintline">&lt;1 uses the working image as the img2img input</span>
            <label style="margin-top:14px">Batch count</label>
            <div class="st-pips" data-id="pips" role="slider" aria-label="Batch count 1 to 4"
              aria-valuemin="1" aria-valuemax="${BATCH_MAX}" aria-valuenow="1" tabindex="0">
              <button class="st-pip on cursor" data-v="1" aria-label="batch 1">1</button>
              <button class="st-pip" data-v="2" aria-label="batch 2">2</button>
              <button class="st-pip" data-v="3" aria-label="batch 3">3</button>
              <button class="st-pip" data-v="4" aria-label="batch 4">4</button>
            </div>
            <span class="st-hintline">drag across the pips · batch = <b data-id="batchval">1</b></span>
            <label>LoRAs <span data-id="lcount"></span></label>
            <div class="st-chips" data-id="pins"></div>
            <input type="text" data-id="lfilter" placeholder="filter loras…" style="margin-top:6px">
            <div class="st-chips" data-id="loras"></div>
            <label>Presets</label>
            <select data-id="preset-pick"><option value="">Presets…</option></select>
            <div class="st-row2" style="margin-top:6px">
              <button data-id="preset-save" title="Save current form as a preset">💾 Save preset</button>
              <button data-id="preset-del" title="Delete the selected preset">🗑 Delete</button>
            </div>
            <label style="margin-top:14px">Composition</label>
            <button data-id="reuse" style="width:100%" title="Apply the working image's generation settings to this form">↺ Load settings from working image</button>
            <label style="margin-top:14px"><input type="checkbox" data-id="save-all" style="width:auto"> save all outputs to gallery</label>
            <span class="st-hintline">Default off. When on, finished outputs are copied into the gallery bank automatically (Gallery, not Library).</span>
          </div>

          <!-- REFINE -->
          <div class="st-verbpanel" data-panel="refine" hidden>
            <label>Preset</label>
            <select data-id="rpreset"><option value="">loading…</option></select>
            <label>Prompt</label>
            <textarea data-id="rprompt" rows="3" placeholder="prompt for the transform…"></textarea>
            <div class="st-row2">
              <div><label>Seed</label><input type="number" data-id="rseed" value="0"></div>
              <div style="display:flex;align-items:end"><label style="margin:0 0 8px"><input type="checkbox" data-id="rrandom" checked style="width:auto"> random</label></div>
            </div>
            <label data-id="rdenoise-lbl" style="display:none">Denoise
              <input type="range" data-id="rdenoise" min="0.2" max="0.8" step="0.05" value="0.45">
              <span data-id="rdenoise-val">0.45</span></label>
            <div class="st-mask" data-id="mask" style="display:none">
              <label>Mask — paint on the canvas</label>
              <div class="st-row2">
                <button data-id="mask-paint">🖌 Paint</button>
                <button data-id="mask-erase">🧽 Erase</button>
              </div>
              <label>Brush <input type="range" data-id="brush" min="4" max="120" value="40"></label>
              <div class="st-row2">
                <button data-id="mask-clear">Clear</button>
                <button data-id="mask-undo" disabled>↩ Undo</button>
              </div>
              <span class="st-hintline">White = regenerate; everything else stays pixel-exact.</span>
            </div>
            <div class="st-row2" style="margin-top:14px">
              <button class="primary" data-id="rrun">✎ Run preset</button>
            </div>
            <span class="st-hintline" data-id="rstatus">Runs on the working image; the result promotes with fresh provenance.</span>

            <details class="collapse" data-id="filters-sec">
              <summary>🎛 Filters</summary>
              <div class="inside">
                <label><input type="checkbox" data-id="ch-enabled" checked style="width:auto"> Enable colorhold</label>
                <label>Dark threshold <input type="range" data-id="ch-dark" min="0.1" max="0.9" step="0.01" value="0.45"></label>
                <label>Line saturation <input type="range" data-id="ch-sat" min="0.5" max="2" step="0.05" value="1.45"></label>
                <label>Line darkness <input type="range" data-id="ch-val" min="0.3" max="1" step="0.01" value="0.72"></label>
                <label>Fill smoothing <input type="range" data-id="ch-smooth" min="0" max="5" step="1" value="3"></label>
                <label>Line smoothing <input type="range" data-id="ch-sigma" min="0" max="2" step="0.1" value="0"></label>
                <label>Max stroke width <input type="range" data-id="gate-maxw" min="1" max="12" step="1" value="6"></label>
                <label>Gate sensitivity <input type="range" data-id="gate-bh" min="0.02" max="0.2" step="0.01" value="0.06"></label>
                <label>Gate strength <input type="range" data-id="gate-strength" min="0" max="100" step="1" value="100"></label>
                <label>Vibrance <input type="range" data-id="vib-strength" min="0" max="100" step="1" value="0"></label>
                <label>Vibrance falloff <input type="range" data-id="vib-falloff" min="0.05" max="0.6" step="0.01" value="0.25"></label>
                <label>Skin protection <input type="range" data-id="vib-protect" min="0" max="100" step="1" value="50"></label>
                <label>Saturation <input type="range" data-id="tn-sat" min="0" max="2" step="0.05" value="1"></label>
                <label>Brightness <input type="range" data-id="tn-bri" min="-0.5" max="0.5" step="0.01" value="0"></label>
                <label>Contrast <input type="range" data-id="tn-con" min="0" max="2" step="0.05" value="1"></label>
                <label>Lift blacks <input type="range" data-id="tn-lift" min="0" max="0.3" step="0.01" value="0"></label>
                <label>Lift edge <input type="range" data-id="tn-edge" min="0" max="0.5" step="0.01" value="0"></label>
                <label>Effect strength <input type="range" data-id="strength" min="0" max="100" step="1" value="100"></label>
                <span class="st-hintline">Preview renders here on the canvas; Filters act on the working image, and the applied output re-promotes with fresh provenance.</span>
                <button class="primary" style="width:100%;margin-top:14px" data-id="fapply">Apply filter stack</button>
                <span class="st-hintline" data-id="fstatus"></span>
              </div>
            </details>
          </div>

          <!-- PROVENANCE -->
          <div class="st-verbpanel" data-panel="provenance" hidden>
            <label style="margin-top:2px">Working image</label>
            <div data-id="provtable"><span class="st-hintline">no working image</span></div>
            <label style="margin-top:14px">Parent chain</label>
            <div class="st-parentchain" data-id="parentchain"><span class="st-hintline">no working image</span></div>
            <span class="st-hintline">Full lineage is write-once: every promote/refine appends here.</span>
          </div>
        </div>

        <div class="st-railactions">
          <div class="row"><button class="primary" data-id="runbtn">⚡ Generate · batch 1</button></div>
          <div class="row st-savebar">
            <button data-save="over" title="Save over the original file">Save over</button>
            <button data-save="new" title="Save as a new file">Save new</button>
            <button data-save="library" title="Save to Library">📚 Library</button>
          </div>
          <div class="st-savenote">explicit save only — candidates die on the next run unless saved</div>
        </div>
      </aside>
    </div>

    <!-- fullscreen chrome (touch-first: no hover/keyboard dependencies) -->
    <button class="st-edgetab" data-id="edgetab">RAIL ▸</button>
    <button class="st-genfab" data-id="genfab" aria-label="Generate">
      <span class="ring" data-id="fabring"></span><span class="inner" data-id="fabinner">⚡<br>Gen</span>
    </button>
    <button class="st-bottomhandle" data-id="bottomhandle"><span class="grip"></span>CANDIDATES ▴</button>
    <div class="st-candoverlay" data-id="candoverlay">
      <div class="st-striphead">
        <h2>Candidates</h2>
        <span class="note">nothing auto-saves — <em>next run overwrites unretrieved candidates</em></span>
      </div>
      <div class="st-cands" data-id="ovcands"></div>
      <div class="ov-actions st-savebar">
        <button data-save="over" title="Save over the original file">Save over</button>
        <button data-save="new" title="Save as a new file">Save new</button>
        <button data-save="library" title="Save to Library">📚 Library</button>
      </div>
    </div>
    <div class="st-toast" data-id="toast"><span class="tick">✓</span><span data-id="toasttext"></span></div>
  </div>`;
}

export function mountStudio(panel, jobbar) {
  panel.innerHTML = panelHTML();
  const root = panel.querySelector('.st-root');
  const $ = id => panel.querySelector(`[data-id="${id}"]`);
  const el = Object.fromEntries(['chip', 'chip-name', 'chip-chain', 'clear', 'imm',
    'canvasarea', 'frame', 'badge', 'img-a', 'wrap-b', 'img-b', 'cmpbar',
    'strip', 'cands', 'wf', 'prompt', 'aspects', 'size', 'sizeval', 'seed', 'lock', 'dice',
    'denoise', 'dval', 'pips', 'batchval', 'lcount', 'lfilter', 'pins', 'loras',
    'preset-pick', 'preset-save', 'preset-del', 'reuse', 'save-all',
    'rpreset', 'rprompt', 'rseed', 'rrandom', 'rdenoise-lbl', 'rdenoise', 'rdenoise-val',
    'mask', 'mask-paint', 'mask-erase', 'brush', 'mask-clear', 'mask-undo',
    'rrun', 'rstatus', 'filters-sec', 'ch-enabled', 'fapply', 'fstatus',
    'provtable', 'parentchain', 'runbtn', 'edgetab', 'genfab', 'fabring', 'fabinner',
    'bottomhandle', 'candoverlay', 'ovcands', 'toast', 'toasttext'].map(k => [k, $(k)]));

  let verb = 'generate';
  let stack = null;            // update-stack state: original = working image at load
  let compareOn = false, cmpPct = 100;
  let zoomScale = 1, zoomTx = 0, zoomTy = 0;
  let batch = 1;
  let busy = false;
  let aspect = 'landscape', sizeIdx = 1;
  let allLoras = [];
  let wfDefs = [];            // config workflow entries ({id, available, edit})
  const pins = createPins();
  const cands = createCandidates();
  let restored = false;
  let previewUrl = null;       // filters live-preview overrides the canvas display
  let maskCanvas = null, maskMode = 'paint', maskPainted = false, maskUndoStack = [];
  let _maskLastPt = null;

  const say = (msg, isErr) => { if (jobbar) jobbar.innerHTML = `<span class="badge${isErr ? ' err' : ''}">${esc(msg)}</span>`; };
  async function api(path, opts) {
    const r = await fetch(API + path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    return j;
  }

  // ── working-image display: one canvas ──
  function fitFrame() {
    const img = el['img-a'];
    const natW = img.naturalWidth, natH = img.naturalHeight;
    if (!natW || !natH || el.frame.hidden) return;
    const availW = Math.max(60, el.canvasarea.clientWidth - 24);
    const availH = Math.max(60, el.canvasarea.clientHeight - 24);
    const scale = Math.min(availW / natW, availH / natH, root.classList.contains('st-immersive') ? 10 : 1.6);
    el.frame.style.width = Math.round(natW * scale) + 'px';
    el.frame.style.height = Math.round(natH * scale) + 'px';
    clampZoomPan(); applyZoom();
  }
  window.addEventListener('resize', fitFrame);

  function applyZoom() {
    const t = zoomScale === 1 ? '' : `translate(${zoomTx}px, ${zoomTy}px) scale(${zoomScale})`;
    el.frame.style.transform = t;
  }
  function clampZoomPan() {
    const c = clampPan(zoomTx, zoomTy, el.canvasarea.clientWidth, el.canvasarea.clientHeight,
      el.frame.clientWidth, el.frame.clientHeight, zoomScale);
    zoomTx = c.tx; zoomTy = c.ty;
  }
  function stepZoom(factor) {
    const old = zoomScale;
    zoomScale = Math.min(4, Math.max(1, zoomScale * factor));
    if (zoomScale === 1) { zoomTx = 0; zoomTy = 0; }
    else if (zoomScale !== old) clampZoomPan();
    applyZoom();
  }
  function zoomAroundCursor(clientX, clientY, newScale) {
    const old = zoomScale;
    if (newScale === old) return;
    const r = el.frame.getBoundingClientRect();
    const cx = clientX - (r.left + r.width / 2), cy = clientY - (r.top + r.height / 2);
    const k = newScale / old;
    zoomTx += cx * (1 - k); zoomTy += cy * (1 - k);
    zoomScale = newScale;
    if (zoomScale <= 1) { zoomScale = 1; zoomTx = 0; zoomTy = 0; }
    else clampZoomPan();
    applyZoom();
  }

  function showCurrent() {
    const s = stack;
    previewUrl = null;
    if (!s) {
      el.frame.hidden = true;
      el.canvasarea.classList.remove('has-image');
      return;
    }
    const cur = current(s), prev = compareEntry(s);
    if (s.idx === 0) compareOn = false;
    el.frame.hidden = false;
    el.canvasarea.classList.add('has-image');
    el['img-a'].src = previewUrl || prev.url;
    el['img-b'].src = cur.url;
    const prov = studioState().get().provenance;
    el.badge.textContent = `${cur.name}` +
      (prov && prov.width ? ` · ${prov.width}×${prov.height}` : '') +
      (prov && prov.seed != null ? ` · seed ${prov.seed}` : '');
    syncComparer(); fitFrame(); updateSaveButtons();
  }
  function syncComparer() {
    const s = stack;
    const compare = !!(compareOn && s && s.idx > 0);
    el.frame.classList.toggle('comparing', compare);
    el['wrap-b'].style.clipPath = compare ? `inset(0 ${100 - cmpPct}% 0 0)` : 'inset(0 0 0 0)';
    for (const b of el.cmpbar.querySelectorAll('button')) {
      const mode = b.dataset.c;
      const on = (mode === 'after' && !compare) || (mode === 'split' && compare && cmpPct < 100) || (mode === 'before' && compare && cmpPct <= 0);
      b.classList.toggle('on', mode === 'after' ? !compare : false);
    }
    el.cmpbar.style.display = s && s.idx > 0 ? '' : 'none';
  }
  el.cmpbar.addEventListener('click', e => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'after') { compareOn = false; }
    else { compareOn = true; cmpPct = b.dataset.c === 'before' ? 0 : 100; }
    syncComparer();
  });

  // Load a working image as the stack original. Same-path guard: the
  // store event, send-to, and our own promote must not rebuild a stack
  // that already contains this path (version history survives).
  async function openWorking(path, name) {
    if (!path) return;
    if (stack && stack.entries.some(en => en.path === path)) return;
    try {
      const r0 = await fetch(galleryFileUrl(path));
      // foxden outputs live outside the gallery jail — fall back to the
      // candidate's own view URL (strip thumbnails prove it serves fine)
      const r = r0.ok ? r0 : await (cands.find(path)
        ? fetch(cands.find(path).url) : Promise.resolve(r0));
      if (!r.ok) throw new Error(r.status);
      const blob = await r.blob();
      stack = createStack({ url: URL.createObjectURL(blob), name: name || path.split('/').pop(), path });
      compareOn = false; cmpPct = 100;
      zoomScale = 1; zoomTx = 0; zoomTy = 0;
      maskCanvas = null; maskPainted = false; maskUndoStack = [];
      clearPreview();
      showCurrent();
    } catch (err) {
      say(`failed to load working image: ${err.message}`, true);
    }
  }
  studioState().subscribe(d => {
    syncChip(d);
    if (!d.path) return;
    openWorking(d.path, d.name);
    if (verb === 'provenance') renderProvenance();
  });
  el.clear.addEventListener('click', () => studioState().clear());
  function syncChip(d) {
    el.chip.hidden = !d.path;
    el.clear.hidden = !d.path;
    if (d.path) {
      el['chip-name'].textContent = d.name || d.path.split('/').pop();
      const p = d.provenance;
      el['chip-chain'].textContent = p ? `${p.source_module || ''}${p.workflow ? ' · ' + p.workflow : ''}` : '';
    }
  }

  // ── canvas gestures: wheel zoom + pointer pinch/pan (zoom-viewer math) ──
  const zPointers = new Map();
  let zPinch = null;
  el.canvasarea.addEventListener('pointerdown', e => {
    zPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zPointers.size >= 2) {
      const [a, b] = [...zPointers.values()];
      zPinch = { d0: dist(a, b), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                 scale0: zoomScale, tx0: zoomTx, ty0: zoomTy };
    }
  });
  el.canvasarea.addEventListener('pointermove', e => {
    const p = zPointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (zPointers.size >= 2 && zPinch) {
      const [a, b] = [...zPointers.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomScale = pinchScale(zPinch.scale0, zPinch.d0, dist(a, b));
      zoomTx = zPinch.tx0 + (m.x - zPinch.mid0.x);
      zoomTy = zPinch.ty0 + (m.y - zPinch.mid0.y);
      clampZoomPan(); applyZoom();
    } else if (zPointers.size === 1 && zoomScale > 1 && !masking) {
      zoomTx += dx; zoomTy += dy;
      clampZoomPan(); applyZoom();
    } else if (zPointers.size === 1 && masking) {
      maskStroke(e);
    }
  });
  const zUp = e => {
    zPointers.delete(e.pointerId);
    if (zPointers.size < 2) { zPinch = null; if (zoomScale <= 1.05) { zoomScale = 1; zoomTx = 0; zoomTy = 0; applyZoom(); } }
  };
  el.canvasarea.addEventListener('pointerup', zUp);
  el.canvasarea.addEventListener('pointercancel', zUp);
  el.canvasarea.addEventListener('wheel', e => {
    if (!stack) return;
    e.preventDefault();
    zoomAroundCursor(e.clientX, e.clientY, wheelScale(zoomScale, e.deltaY));
  }, { passive: false });

  // ── mask painting (masked-inpaint recipe) ──
  let masking = false;
  function initMaskForSource() {
    const srcEntry = stack && source(stack);
    if (!srcEntry) return;
    if (maskCanvas && maskPainted) {
      maskUndoStack = [];  // new base: stale mask must not survive
    }
    maskPainted = false; maskUndoStack = []; maskCanvas = null;
    const img = new Image();
    img.onload = () => {
      const mc = document.createElement('canvas');
      mc.width = img.naturalWidth; mc.height = img.naturalHeight;
      const ctx = mc.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, mc.width, mc.height);
      maskCanvas = mc;
    };
    img.src = srcEntry.url;
  }
  function maskHasWhite() {
    if (!maskCanvas) return false;
    const data = maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  }
  function maskStroke(e) {
    if (!maskCanvas) return;
    const fr = el.frame.getBoundingClientRect();
    const sx = maskCanvas.width / fr.width, sy = maskCanvas.height / fr.height;
    const x = (e.clientX - fr.left) * sx, y = (e.clientY - fr.top) * sy;
    const ctx = maskCanvas.getContext('2d');
    ctx.strokeStyle = maskMode === 'paint' ? '#fff' : '#000';
    ctx.lineWidth = (parseInt(el.brush.value, 10) || 40) * sx;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (_maskLastPt) ctx.moveTo(_maskLastPt.x, _maskLastPt.y); else ctx.moveTo(x, y);
    ctx.lineTo(x, y); ctx.stroke();
    _maskLastPt = { x, y };
    maskPainted = maskMode === 'paint' ? true : maskHasWhite();
  }
  el['mask-paint'].addEventListener('click', () => { maskMode = 'paint'; });
  el['mask-erase'].addEventListener('click', () => { maskMode = 'erase'; });
  el['mask-clear'].addEventListener('click', () => {
    if (!maskCanvas) return;
    pushMaskUndo();
    const ctx = maskCanvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskPainted = false;
  });
  function pushMaskUndo() {
    if (!maskCanvas) return;
    maskUndoStack.push(maskCanvas.toDataURL('image/png'));
    if (maskUndoStack.length > 20) maskUndoStack.shift();
    el['mask-undo'].disabled = false;
  }
  el['mask-undo'].addEventListener('click', () => {
    const url = maskUndoStack.pop();
    if (!url || !maskCanvas) return;
    const img = new Image();
    img.onload = () => {
      const ctx = maskCanvas.getContext('2d');
      ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      ctx.drawImage(img, 0, 0);
      maskPainted = maskHasWhite();
      el['mask-undo'].disabled = maskUndoStack.length === 0;
    };
    img.src = url;
  });

  // ── rail verb switching: hidden + aria only; never a fetch, never a
  // store touch (chunk-A pin contract) ──
  function showVerb(v) {
    verb = v;
    for (const b of panel.querySelectorAll('.st-verbswitch button')) {
      const on = b.dataset.verb === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const p of panel.querySelectorAll('.st-verbpanel')) p.hidden = p.dataset.panel !== v;
    setRunLabel();
  }
  function setRunLabel() {
    el.runbtn.textContent =
      verb === 'generate' ? `⚡ Generate · batch ${batch}` :
      verb === 'refine' ? '✎ Run preset' : '🧬 Info only';
  }
  panel.querySelector('.st-verbswitch').addEventListener('click', e => {
    const b = e.target.closest('[data-verb]');
    if (b) showVerb(b.dataset.verb);
  });
  el.runbtn.addEventListener('click', () => {
    if (verb === 'generate') generate();
    else if (verb === 'refine') runRefine();
    else showVerb('provenance');
  });

  // ── comprehensive save module (decision §7.1): one wiring, three
  // targets, present in the expanded rail AND the fullscreen overlay.
  // save-over / save-new act on the viewed stack entry vs the stack
  // original (the working image at load); Library promotes via
  // save-family — the same endpoints Update used, now one component.
  function wireSaveBars() {
    for (const bar of panel.querySelectorAll('.st-savebar')) {
      bar.addEventListener('click', e => {
        const b = e.target.closest('[data-save]');
        if (b) saveAs(b.dataset.save);
      });
    }
  }
  function updateSaveButtons() {
    const ok = !!(stack && saveable(stack) && stack.entries[0].path);
    for (const bar of panel.querySelectorAll('.st-savebar')) {
      for (const b of bar.querySelectorAll('[data-save]')) b.disabled = !ok;
    }
  }
  async function saveAs(kind) {
    const s = stack;
    if (!s || !saveable(s)) { say('nothing saveable on the canvas — run or promote first', true); return; }
    const entry = current(s), orig = s.entries[0];
    if (!orig.path) { say('original source has no server path', true); return; }
    try {
      if (kind === 'over') {
        if (!confirm(`Overwrite the original source in place?\n${orig.name}\nNo new file will be created.`)) return;
        const r = await fetch('/api/update/save-back', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ render_path: entry.path, source_path: orig.path }) });
        if (!r.ok) throw new Error((await r.json()).detail || r.status);
        const d = await r.json();
        showToast(`Saved over ${d.overwritten}`);
        say(`saved over ${d.overwritten} (${d.bytes} bytes)`);
      } else if (kind === 'new') {
        const r = await fetch('/api/update/save-new', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ render_path: entry.path, source_path: orig.path }) });
        if (!r.ok) throw new Error((await r.json()).detail || r.status);
        const d = await r.json();
        showToast('Saved as new file');
        say(`saved as new file — ${d.new_path}`);
      } else {
        const tag = cleanName(prompt('Library tag:', 'zengosoft')) || 'zengosoft';
        const r = await fetch('/api/update/save-family', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            render_path: entry.path, original_path: orig.path, tag,
            intermediates: s.entries.slice(1, s.idx).map(e2 => e2.path).filter(Boolean),
            recipe: entry.recipe || null, masked: !!entry.masked,
          }) });
        if (!r.ok) throw new Error((await r.json()).detail || r.status);
        const d = await r.json();
        showToast('Saved to Library');
        say(`saved — final ${d.final} · original ${d.original} (family ${d.family_id})`);
      }
    } catch (err) {
      say(`save failed: ${err.message}`, true);
    }
  }
  wireSaveBars();

  // ── candidate strip: docked + fullscreen overlay share one renderer ──
  function renderCandidates() {
    const list = cands.get();
    let selPath = null;
    const selBtn = panel.querySelector('.st-cand.sel');
    void selBtn;
    for (const target of [el.cands, el.ovcands]) {
      target.innerHTML = '';
      list.forEach((c, i) => {
        const d = document.createElement('button');
        d.className = 'st-cand';
        d.title = 'Use as working image';
        const tag = document.createElement('span');
        tag.className = 'tag'; tag.textContent = `c${i + 1}`;
        const im = document.createElement('img');
        im.src = c.url; im.alt = `candidate ${i + 1}`;
        const pick = document.createElement('span');
        pick.className = 'pick'; pick.textContent = 'promote';
        d.append(tag, im, pick);
        d.addEventListener('click', () => {
          for (const x of panel.querySelectorAll('.st-cand')) x.classList.remove('sel');
          for (const t of panel.querySelectorAll('.st-cands')) {
            [...t.children].forEach(x2 => x2.classList.toggle('sel', x2.querySelector('img')?.src === c.url));
          }
          d.classList.add('sel');
          // Explicit selection ONLY (decision §7.2): the candidate becomes
          // the working image; nothing auto-saves.
          studioState().set(c.path, 'foxden-output', { name: c.path.split('/').pop() });
          say(`working image: ${c.path.split('/').pop()}`);
        });
        target.appendChild(d);
      });
      for (let i = list.length; i < Math.max(0, 4 - list.length); i++) {
        const d = document.createElement('span');
        d.className = 'st-cand empty';
        d.textContent = `slot ${i + 1}`;
        target.appendChild(d);
      }
    }
    el.strip.classList.toggle('st-running', busy);
    void selPath;
  }

  // ── generate: batch N = N sequential runs, one candidate set ──
  let inputName = null, inputParent = null, inputDims = null;
  async function prepareInput() {
    const st = studioState().get();
    const denoise = parseFloat(el.denoise.value) || 1;
    if (!st.path || denoise >= 1) { inputName = null; inputParent = null; return null; }
    if (inputParent === st.path && inputName) return inputName;   // cached per working image
    say('preparing working image as img2img input…');
    const r0 = await fetch(galleryFileUrl(st.path));
    if (!r0.ok) throw new Error(`working image fetch failed: ${r0.status}`);
    const blob = await r0.blob();
    const fname = st.name || st.path.split('/').pop();
    const fd = new FormData();
    fd.append('image', new File([blob], fname, { type: blob.type || 'image/png' }));
    const j = await api('/upload', { method: 'POST', body: fd });
    inputName = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
    inputParent = st.path;   // provenance parent chain: generation links back
    const probe = new Image();
    await new Promise(res => { probe.onload = res; probe.onerror = res; probe.src = galleryFileUrl(st.path); });
    inputDims = [probe.naturalWidth, probe.naturalHeight];
    return inputName;
  }

  async function generate() {
    if (busy) return;
    const promptText = el.prompt.value.trim();
    if (!promptText) { say('type a prompt first', true); return; }
    busy = true;
    el.runbtn.disabled = true; el.genfab.disabled = true;
    el.strip.classList.add('st-running');
    setFabProgress(0, '0%');
    const collected = [];
    try {
      const denoise = parseFloat(el.denoise.value) || 1;
      const wfDef = wfDefs.find(w => w.id === el.wf.value);
      const isEdit = !!(wfDef && wfDef.edit);
      const st0 = studioState().get();
      if (isEdit && !st0.path) {
        say('edit workflows need a working image — set one from Gallery or a candidate first', true);
        busy = false; el.runbtn.disabled = false; el.genfab.disabled = false;
        el.strip.classList.remove('st-running'); setFabProgress(0, '');
        return;
      }
      // edit graphs consume the reference at any denoise — always inject
      const useInput = (denoise < 1 || isEdit) ? await prepareInput() : null;
      let seed = nextSeed({ locked: el.lock.checked, current: el.seed.value });
      for (let i = 0; i < batch; i++) {
        if (i > 0 && !el.lock.checked) seed = String(Math.floor(Math.random() * 2 ** 31));
        el.seed.value = seed;
        let [width, height] = sizeFor(aspect, sizeIdx);
        if (useInput && inputDims) [width, height] = inputDims;
        const body = {
          workflow: el.wf.value, prompt: promptText, width, height,
          loras: pins.payload(), suspended_loras: pins.suspendedPayload(),
          denoise, seed,
        };
        if (useInput) { body.input_image = useInput; body.parent_image = inputParent; }
        say(`generating candidate ${i + 1}/${batch}…`);
        setFabProgress(i / batch, `${Math.round((i / batch) * 100)}%`);
        const j = await api('/generate', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        el.seed.value = j.seed;
        const outs = await poll(j.prompt_id, i);
        for (const u of outs) {
          const p = pathFromViewUrl(u);
          if (p) collected.push({ url: u, path: p });
        }
      }
      // cleanup rule (decision §7.2): the NEXT run replaces the strip
      cands.startRun(collected);
      renderCandidates();
      showToast(`Run complete — ${collected.length} candidate${collected.length === 1 ? '' : 's'}`);
      if (collected.length === 1) {
        studioState().set(collected[0].path, 'foxden-output', { name: collected[0].path.split('/').pop() });
      }
      if (el['save-all'].checked && collected.length) await saveAllOutputs(collected.map(c => c.path));
      flashOverlayInImmersive();
      say(`done — ${collected.length} candidate${collected.length === 1 ? '' : 's'}`);
    } catch (err) {
      say(`generate failed: ${err.message}`, true);
      showToast('Run failed');
    }
    busy = false;
    el.runbtn.disabled = false; el.genfab.disabled = false;
    el.strip.classList.remove('st-running');
    setFabProgress(0, null);
    renderCandidates();
  }

  async function poll(pid, candIdx) {
    const t0 = Date.now();
    while (Date.now() - t0 < 15 * 60 * 1000) {
      const s = await api('/status/' + pid);
      if (s.state === 'done') return s.outputs || [];
      if (s.state === 'error') {
        throw new Error((s.error || 'generation failed') +
          ((s.log_tail || []).length ? '\n\n' + s.log_tail.slice(-8).join('\n') : ''));
      }
      // Progress ring: candidate index + sub-progress within this poll cycle.
      const frac = Math.min(0.99, (Date.now() - t0) / 120000);
      setFabProgress(candIdx + frac, `${candIdx + 1}/${batch}`);
      say(`${s.state}… ${Math.round((Date.now() - t0) / 1000)}s`);
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error('timed out waiting for ComfyUI');
  }

  async function saveAllOutputs(paths) {
    try {
      const r = await fetch(`${API}/save-outputs`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      say(`saved ${j.saved.length} output${j.saved.length === 1 ? '' : 's'} to gallery`);
    } catch (e) { say(`save all failed: ${e.message}`, true); }
  }

  // ── batch pips (studio-pips.js math; pointer capture, touch-action:none,
  // aria slider — no keyboard dependency) ──
  function setBatch(v) {
    batch = clampBatch(v);
    for (const p of el.pips.querySelectorAll('.st-pip')) {
      p.classList.toggle('on', +p.dataset.v <= batch);
      p.classList.toggle('cursor', +p.dataset.v === batch);
    }
    el.pips.setAttribute('aria-valuenow', String(batch));
    el.batchval.textContent = String(batch);
    setRunLabel();
  }
  el.pips.addEventListener('pointerdown', e => {
    el.pips.setPointerCapture(e.pointerId);
    setBatch(batchFromPointer(e.clientX, el.pips.getBoundingClientRect()));
  });
  el.pips.addEventListener('pointermove', e => {
    if (e.buttons > 0 || e.pressure > 0) setBatch(batchFromPointer(e.clientX, el.pips.getBoundingClientRect()));
  });
  el.pips.querySelectorAll('.st-pip').forEach(p =>
    p.addEventListener('click', e => { e.stopPropagation(); setBatch(+p.dataset.v); }));
  setBatch(1);

  // ── generate form: config / loras / aspects / presets / _last ──
  async function loadConfig() {
    try {
      const c = await api('/config');
      rebuildSelectPreserving(el.wf, c.workflows.map(w =>
        `<option value="${w.id}" ${w.available ? '' : 'disabled'}>${esc(w.id)}${w.available ? '' : ' (file missing)'}</option>`).join(''),
        c.default_workflow);
      allLoras = c.loras;
      wfDefs = c.workflows || [];
      renderLoras();
    } catch (e) { say('config failed: ' + e.message, true); }
  }
  function chip(n, strength, parked) {
    const c = document.createElement('span');
    c.className = 'st-chip' + (parked ? '' : ' on');
    c.title = parked ? 'suspended — tap to restore' : 'tap to remove';
    c.textContent = `${parked ? '▶ ' : '✕ '}${n} ×${Number(strength).toFixed(2)}`;
    c.addEventListener('click', () => {
      if (parked) pins.restore(n); else pins.remove(n);
      renderLoras();
    });
    return c;
  }
  function renderLoras() {
    el.lcount.textContent = pins.count() ? `(${pins.count()} on)` : '';
    el.pins.innerHTML = '';
    for (const [n, st] of pins.active) el.pins.appendChild(chip(n, st, false));
    for (const [n, st] of pins.suspended) el.pins.appendChild(chip(n, st, true));
    el.loras.innerHTML = '';
    const q = el.lfilter.value.trim().toLowerCase();
    for (const n of allLoras.filter(n => !q || n.toLowerCase().includes(q)).slice(0, 24)) {
      const b = document.createElement('button');
      b.className = 'st-chip'; b.textContent = `＋ ${n}`;
      b.addEventListener('click', () => { pins.pin(n, 1.0); renderLoras(); });
      el.loras.appendChild(b);
    }
    if (!el.loras.children.length) el.loras.innerHTML = '<span class="st-hintline">no LoRAs found</span>';
  }
  el.lfilter.addEventListener('input', renderLoras);
  el.aspects.addEventListener('click', e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    aspect = b.dataset.a;
    el.aspects.querySelectorAll('[data-a]').forEach(x => x.classList.toggle('on', x === b));
    paintSize();
  });
  function paintSize() {
    const [w, h] = sizeFor(aspect, sizeIdx);
    el.size.value = String(sizeIdx);
    el.sizeval.textContent = `${w}×${h}`;
  }
  el.size.addEventListener('input', () => {
    sizeIdx = Math.min(3, Math.max(0, parseInt(el.size.value, 10) || 0));
    paintSize();
  });
  el.dice.addEventListener('click', () => { el.seed.value = Math.floor(Math.random() * 2 ** 31); });
  function setDenoise(v) {
    const d = Math.min(1, Math.max(0.1, Number.isFinite(Number(v)) ? Number(v) : 1));
    el.denoise.value = String(d); el.dval.textContent = d.toFixed(2);
  }
  el.denoise.addEventListener('input', () => setDenoise(el.denoise.value));

  function collectState() {
    return normalizeState({
      workflow: el.wf.value, prompt: el.prompt.value, aspect, size_idx: sizeIdx,
      seed: el.seed.value === '' ? null : parseInt(el.seed.value),
      loras: pins.payload(), suspended_loras: pins.suspendedPayload(),
      denoise: parseFloat(el.denoise.value),
    });
  }
  function applyState(raw) {
    const st = normalizeState(raw);
    if (st.workflow && [...el.wf.options].some(o => o.value === st.workflow && !o.disabled)) el.wf.value = st.workflow;
    el.prompt.value = st.prompt;
    aspect = st.aspect;
    el.aspects.querySelectorAll('[data-a]').forEach(x => x.classList.toggle('on', x.dataset.a === aspect));
    sizeIdx = st.size_idx ?? 1;
    paintSize();
    el.seed.value = st.seed === null ? '' : st.seed;
    pins.restoreFrom(st.loras, st.suspended_loras);
    renderLoras();
    setDenoise(st.denoise);
  }
  let savedPresets = [];
  async function loadPresets() {
    try {
      const d = await api('/presets');
      savedPresets = d.presets || [];
      const cur = el['preset-pick'].value;
      el['preset-pick'].innerHTML = '<option value="">Presets…</option>' +
        savedPresets.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
      if (savedPresets.some(p => p.name === cur)) el['preset-pick'].value = cur;
      return d.last;
    } catch { return null; }
  }
  el['preset-pick'].addEventListener('change', () => {
    const p = savedPresets.find(x => x.name === el['preset-pick'].value);
    if (p) { applyState(p.state); say(`applied preset “${p.name}”`); }
  });
  el['preset-save'].addEventListener('click', async () => {
    const name = cleanName(prompt('Preset name:', el['preset-pick'].value || ''));
    if (!name) return;
    try {
      await api('/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, state: presetState(collectState(), el.lock.checked) }) });
      await loadPresets();
      el['preset-pick'].value = name;
      say(`saved preset “${name}”`);
    } catch (e) { say(e.message, true); }
  });
  el['preset-del'].addEventListener('click', async () => {
    const name = el['preset-pick'].value;
    if (!name) { say('pick a preset to delete', true); return; }
    if (!confirm(`Delete preset “${name}”?`)) return;
    try {
      await api('/presets/' + encodeURIComponent(name), { method: 'DELETE' });
      await loadPresets();
      say(`deleted preset “${name}”`);
    } catch (e) { say(e.message, true); }
  });
  const saveLast = () => {
    if (!restored) return;
    fetch(API + '/last', { method: 'PUT', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: collectState() }) }).catch(() => {});
  };
  const scheduleSave = debounce(saveLast, 800);
  for (const ev of ['input', 'change', 'click']) {
    panel.addEventListener(ev, e => {
      if (!e.target.closest('[data-panel="generate"]')) return;
      if (e.target.closest('.st-verbswitch, [data-id="pips"], [data-id="lfilter"]')) return;
      scheduleSave();
    });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && scheduleSave.pending()) scheduleSave.flush(); });

  el.reuse.addEventListener('click', async () => {
    const recipe = await studioState().applySettingsTo();
    const st = studioState().get();
    if (!recipe) {
      say(st.path ? 'working image has no usable provenance record' : 'no working image — set one from Gallery, Ladder, or a candidate', true);
      return;
    }
    applyState(recipe);
    say(`applied settings from ${st.name || st.path}`);
  });

  // ── refine: Update's preset runner on the working image ──
  let refinePresets = [];
  async function loadRefinePresets() {
    try {
      const r = await fetch('/api/update/presets');
      const data = await r.json();
      refinePresets = data.presets || [];
      const sel = el.rpreset;
      sel.innerHTML = '';
      for (const p of refinePresets) {
        const o = document.createElement('option');
        o.value = p.file; o.textContent = p.name; o.title = p.description;
        sel.appendChild(o);
      }
      const mi = document.createElement('option');
      mi.value = '__masked_inpaint'; mi.textContent = '🎭 Masked inpaint (Klein)';
      sel.appendChild(mi);
    } catch (e) { el.rstatus.textContent = 'preset load failed: ' + e.message; }
  }
  el.rpreset.addEventListener('change', () => {
    const masked = el.rpreset.value === '__masked_inpaint';
    el.mask.style.display = masked ? '' : 'none';
    el['rdenoise-lbl'].style.display = masked ? '' : 'none';
    if (masked) initMaskForSource();
  });
  el['rdenoise'].addEventListener('input', () => {
    el['rdenoise-val'].textContent = (+el['rdenoise'].value).toFixed(2);
  });

  let jobCancelled = false, refineRunning = false;
  async function runRefine() {
    if (refineRunning || !stack) { if (!stack) say('no working image — set one first', true); return; }
    const preset = el.rpreset.value;
    if (!preset) { say('pick a preset first', true); return; }
    const srcEntry = source(stack);
    if (!srcEntry.path) { say('working image has no server path', true); return; }
    const useRandom = el.rrandom.checked;
    const seed = useRandom ? null : (parseInt(el.rseed.value, 10) || 0);
    refineRunning = true; jobCancelled = false;
    el.rrun.disabled = true;
    busy = true;
    setFabProgress(0.05, '…');
    try {
      let url, body;
      if (preset === '__masked_inpaint') {
        if (!maskCanvas || !maskHasWhite()) throw new Error('paint a region to regenerate first');
        url = '/api/update/inpaint-async';
        body = { path: srcEntry.path, prompt: el.rprompt.value,
          mask_b64: maskCanvas.toDataURL('image/png'),
          denoise: parseFloat(el['rdenoise'].value) || 0.45,
          seed, random: useRandom };
      } else {
        url = '/api/update/run-async';
        body = { preset, path: srcEntry.path, prompt: el.rprompt.value, seed, random: useRandom };
      }
      const r = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).detail || r.status);
      const { job_id } = await r.json();
      const data = await pollJob(job_id);
      el.rseed.value = String(data.seed);
      stack = pushRender(stack, {
        url: data.image, name: `render seed=${data.seed}`,
        path: data.render_path || '',
        recipe: data.recipe || preset, masked: preset === '__masked_inpaint',
      });
      compareOn = false; cmpPct = 100;
      showCurrent();
      // Output-becomes-working (Stage 3 contract, kept): the stored render
      // promotes; the stack already contains it so no rebuild happens.
      if (data.render_path) {
        studioState().set(data.render_path, 'update', { name: `render seed=${data.seed}` });
      }
      showToast(`Refine complete — seed ${data.seed}`);
      flashOverlayInImmersive();
      say(`render done (seed ${data.seed})`);
    } catch (err) {
      say('run failed: ' + err.message, true);
    }
    refineRunning = false; busy = false;
    el.rrun.disabled = false;
    setFabProgress(0, null);
  }
  el.rrun.addEventListener('click', runRefine);
  async function pollJob(jobId) {
    const started = Date.now();
    for (;;) {
      if (jobCancelled) throw new Error('job cancelled');
      if (Date.now() - started > 15 * 60 * 1000) throw new Error('job timed out after 15 minutes');
      await new Promise(res => setTimeout(res, 2000));
      const r = await fetch(`/api/update/jobs/${jobId}`);
      if (!r.ok) throw new Error((await r.json()).detail || r.status);
      const job = await r.json();
      if (job.status === 'done') return job.result;
      if (job.status === 'error') throw new Error(job.error || 'job failed');
      el.rstatus.textContent = `ComfyUI ${job.status}…`;
      setFabProgress(Math.min(0.9, (Date.now() - started) / 300000), '⏳');
    }
  }

  // ── filters toolset (collapsible section inside Refine) ──
  function filterState() {
    const s = { chEnabled: el['ch-enabled'].checked };
    for (const [id, key, parse] of FILTER_SLIDERS) s[key] = parse($(id).value);
    return s;
  }
  function colorholdParams() {
    const s = filterState();
    return { chEnabled: s.chEnabled, dark_t: s.dark_t, sat_mul: s.sat_mul,
      val_mul: s.val_mul, smooth: s.smooth, line_sigma: s.line_sigma,
      vibrance: s.vibrance, vibrance_falloff: s.vibrance_falloff,
      vibrance_protect: s.vibrance_protect / 100 };
  }
  function clearPreview() {
    if (!previewUrl) return;
    previewUrl = null;
    if (stack) { const cur = current(stack); el['img-b'].src = cur.url; el['img-a'].src = compareEntry(stack).url; }
  }
  const schedulePreview = debounce(async () => {
    const s = stack;
    if (!s || !el['filters-sec'].open) return;
    const st = filterState();
    const tunes = { satMul: st.satMul, brightness: st.brightness, contrast: st.contrast, lift: st.lift, edge: st.edge };
    const backendActive = st.chEnabled || st.vibrance > 0;
    if (!backendActive && tunesAreIdentity(tunes) && st.strength >= 100) { clearPreview(); return; }
    try {
      el.fstatus.textContent = 'previewing…';
      let baseImg;
      if (backendActive) {
        const body = { ...colorholdParams(),
          strength: st.chEnabled ? 100 : 0,
          preview_max_side: 1024, path: source(s).path };
        const r = await fetch('/api/filters/apply', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`filter preview failed: ${r.status}`);
        const data = await r.json();
        baseImg = await loadImg(data.image);
      } else {
        baseImg = await loadImg(galleryFileUrl(source(s).path));
      }
      const scale = Math.min(1, 1024 / Math.max(baseImg.naturalWidth, baseImg.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(baseImg.naturalWidth * scale));
      cv.height = Math.max(1, Math.round(baseImg.naturalHeight * scale));
      const ctx = cv.getContext('2d');
      ctx.drawImage(baseImg, 0, 0, cv.width, cv.height);
      if (!tunesAreIdentity(tunes)) {
        const data = ctx.getImageData(0, 0, cv.width, cv.height);
        tuneImageData(data, tunes);
        ctx.putImageData(data, 0, 0);
      }
      if (st.strength < 100) {
        const orig = await loadImg(galleryFileUrl(source(s).path));
        ctx.globalAlpha = 1 - st.strength / 100;
        ctx.drawImage(orig, 0, 0, cv.width, cv.height);
        ctx.globalAlpha = 1;
      }
      previewUrl = cv.toDataURL('image/png');
      el['img-b'].src = previewUrl;
      if (!compareOn) el['img-a'].src = previewUrl;
      el.fstatus.textContent = 'live preview — Apply filter stack to commit at full res';
    } catch (e) {
      el.fstatus.textContent = e.message;
    }
  }, 350);
  function loadImg(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('image failed to load'));
      img.src = src;
    });
  }
  for (const [id] of FILTER_SLIDERS) $(id).addEventListener('input', schedulePreview);
  el['ch-enabled'].addEventListener('change', schedulePreview);
  el['filters-sec'].addEventListener('toggle', () => { if (!el['filters-sec'].open) clearPreview(); });
  el.fapply.addEventListener('click', async () => {
    const s = stack;
    if (!s) { el.fstatus.textContent = 'no working image'; return; }
    el.fstatus.textContent = 'running full-res filter…';
    busy = true;
    try {
      const st = filterState();
      const tunes = { satMul: st.satMul, brightness: st.brightness, contrast: st.contrast, lift: st.lift, edge: st.edge };
      const backendActive = st.chEnabled || st.vibrance > 0;
      let baseImg;
      if (backendActive) {
        const body = { ...colorholdParams(), strength: st.chEnabled ? 100 : 0, path: source(s).path };
        const r = await fetch('/api/filters/apply', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`filter apply failed: ${r.status}`);
        const data = await r.json();
        baseImg = await loadImg(data.image);
      } else {
        baseImg = await loadImg(galleryFileUrl(source(s).path));
      }
      const cv = document.createElement('canvas');
      cv.width = baseImg.naturalWidth; cv.height = baseImg.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(baseImg, 0, 0);
      if (!tunesAreIdentity(tunes)) {
        const data = ctx.getImageData(0, 0, cv.width, cv.height);
        tuneImageData(data, tunes);
        ctx.putImageData(data, 0, 0);
      }
      if (st.strength < 100) {
        const orig = await loadImg(galleryFileUrl(source(s).path));
        ctx.globalAlpha = 1 - st.strength / 100;
        ctx.drawImage(orig, 0, 0, cv.width, cv.height);
        ctx.globalAlpha = 1;
      }
      const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result); fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      const r2 = await fetch('/api/filters/store', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: dataUrl, source_module: 'studio' }) });
      if (!r2.ok) throw new Error(`store failed: ${r2.status}`);
      const { render_path } = await r2.json();
      clearPreview();
      // Output-becomes-working: the filtered result re-promotes with
      // fresh provenance (origin 'filters').
      studioState().set(render_path, 'filters', { name: `filtered ${current(s).name}` });
      showToast('Filter stack applied');
      el.fstatus.textContent = 'applied — output is the working image';
    } catch (e) {
      el.fstatus.textContent = e.message;
    }
    busy = false;
  });

  // ── provenance panel ──
  async function renderProvenance() {
    const st = studioState().get();
    if (!st.path) {
      el.provtable.innerHTML = '<span class="st-hintline">no working image</span>';
      el.parentchain.innerHTML = '<span class="st-hintline">no working image</span>';
      return;
    }
    let rec = st.provenance;
    if (!rec || st.dirty.provenance) rec = await studioState().refreshProvenance();
    if (!rec) {
      el.provtable.innerHTML = '<span class="st-hintline">no provenance record (pre-provenance image)</span>';
      el.parentchain.innerHTML = '';
      return;
    }
    const rows = [
      ['Filename', `<b>${esc(rec.path.split('/').pop())}</b>`],
      ['Workflow', esc(rec.workflow || '—')],
      ['Seed', `<span class="mono">${rec.seed ?? '—'}</span>`],
      ['Steps', esc(rec.steps ?? '—')],
      ['Size', rec.width ? `${rec.width} × ${rec.height}` : '—'],
      ['LoRAs', (rec.loras || []).map(l => `<span class="mono">${esc(l.name)} ${l.strength_model}</span>`).join('<br>') || '—'],
      ['Denoise', rec.denoise != null ? rec.denoise : '—'],
      ['Prompt', esc(rec.prompt || '—')],
    ];
    el.provtable.innerHTML = `<table class="st-provtable">${rows.map(([k, v]) =>
      `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    // Parent chain: walk parent_image upward (bounded), current highlighted.
    const chain = [{ rec }];
    let p = rec.parent_image, guard = 0;
    while (p && guard < 8) {
      try {
        const r = await fetch(`${API}/provenance?path=${encodeURIComponent(p)}`);
        if (!r.ok) { chain.push({ path: p, rec: null }); break; }
        const pr = await r.json();
        chain.push({ rec: pr });
        p = pr.parent_image;
      } catch { chain.push({ path: p, rec: null }); break; }
      guard++;
    }
    chain.reverse();   // oldest first
    el.parentchain.innerHTML = chain.map((n, i) => {
      const isCur = i === chain.length - 1;
      const nm = n.rec ? n.rec.path.split('/').pop() : (n.path || '?').split('/').pop();
      const sub = n.rec ? `${n.rec.source_module || ''}${n.rec.workflow ? ' · ' + n.rec.workflow : ''}${n.rec.seed != null ? ' · seed ' + n.rec.seed : ''}` : 'record missing';
      return `${i > 0 ? '<span class="arrow">▼</span>' : ''}` +
        `<div class="node${isCur ? ' cur' : ''}"><div><b>${esc(nm)}</b>${isCur ? ' — current' : ''}<small>${esc(sub)}</small></div></div>`;
    }).join('');
  }

  // ── fullscreen (immersive) mode ──
  function setImmersive(on) {
    root.classList.toggle('st-immersive', on);
    el.imm.textContent = on ? '⧉ Expanded' : '⛶ Fullscreen';
    if (!on) el.candoverlay.classList.remove('open');
    else fitFrame();
  }
  el.imm.addEventListener('click', () => setImmersive(!root.classList.contains('st-immersive')));
  el.edgetab.addEventListener('click', () => setImmersive(false));   // the ONLY way back — always visible
  el.bottomhandle.addEventListener('click', () => el.candoverlay.classList.toggle('open'));
  el.candoverlay.addEventListener('click', e => {
    if (e.target === el.candoverlay) el.candoverlay.classList.remove('open');
  });
  el.genfab.addEventListener('click', () => {
    if (busy) return;
    showVerb('generate');
    generate();
  });
  let toastTimer;
  function showToast(msg) {
    el.toasttext.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }
  function flashOverlayInImmersive() {
    if (!root.classList.contains('st-immersive')) return;
    el.candoverlay.classList.add('open');
    setTimeout(() => el.candoverlay.classList.remove('open'), 3500);
  }
  function setFabProgress(frac, label) {
    el.fabring.style.setProperty('--p', frac > 0 ? `${Math.round(frac * 100)}%` : '0%');
    el.genfab.classList.toggle('running', frac > 0 && frac < 1);
    el.fabinner.innerHTML = label != null ? label : '⚡<br>Gen';
  }

  // ── send-to receive (Studio target): set the working image ──
  registerReceiver('studio', { canAccept: () => ({ ok: true }) });
  window.addEventListener('ellieedit:studio-set-working', async e => {
    const d = e.detail || {};
    if (d.path) {
      studioState().set(d.path, String(d.source || 'send').toLowerCase(), { name: d.name });
      return;
    }
    if (!d.url) return;
    // Path-less payload (Puppet composite export URL): bound it to a
    // gallery-addressable path first — one bounded /api/filters/store
    // write, source_module "studio" — then set the store.
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
    } catch (err) {
      toast(`could not set working image: ${err.message}`, true);
    }
  });

  // ── first paint: everything configures exactly ONCE, at mount. No
  // activation-event config reload — the store + session state survive
  // tab switches (chunk-A structural fix). ──
  (async () => {
    await loadConfig();
    const last = await loadPresets();
    if (last) applyState(last);
    restored = true;
  })();
  loadRefinePresets();
  studioState().restore();
  showVerb('generate');
  renderCandidates();
  void revert; void revertToOriginal; void selectEntry; void setViewedAsBase; void canRevert;   // stack API surface (kept for the version contract)

  return { showVerb, setBatch, saveAs, setImmersive };
}

registerModule({
  name: 'studio',
  label: 'Studio',
  icon: '🎨',
  order: 0,
  mount: (panel, jobbar) => mountStudio(panel, jobbar),
});
