// Studio — Stage 4 (settled layout, mock-1b, design doc §10). ONE working
// image: a single canvas (pan/zoom via zoom-viewer math) + a right rail
// with tabs Generate | Mask | Provenance. The Stage 3 sub-tab stacking
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
  stepBack, ancestry, lineage,
} from './update-stack.js';
import { importImageAsWorking, copyImageToClipboard } from './image-clipboard.js';
import { normalizeState, presetState, debounce, cleanName, nextSeed, sizeFor, rebuildSelectPreserving } from './foxden-state.js';
import { createPins } from './foxden-loras.js';
import { dist, pinchScale, clampPan, wheelScale } from './zoom-viewer.js';
import { clampBatch, batchFromRockerDrag, BATCH_MAX } from './studio-pips.js';

const API = '/api/foxden';
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      border-bottom: 1px solid #2a2a44; flex: 0 0 auto; flex-wrap: wrap; }
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
    /* img-a is explicitly sized to the primary layer's displayed scale
    (syncLayerScale), so it is absolutely positioned with no max clamps
    — the 60vh cap above and the 44vh mobile cap would distort it. */
    .st-frame img[data-id="img-a"] { position: absolute; max-width: none; max-height: none; }
    .st-frame .st-imgb img { object-fit: contain; }
    .st-frame .st-imgb { position: absolute; inset: 0; overflow: hidden; }
    .st-frame .st-imgb img { max-width: none; max-height: none; width: 100%; height: 100%; object-fit: contain; position: absolute; inset: 0; }
    .st-maskview { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    /* Compare bar lives in the header now, not over the image: static,
    no bottom/transform; syncComparer still owns its visibility via
    inline display flex/none. */
    .st-cmpbar { position: static; transform: none; display: none;
      gap: 0; background: rgba(15,15,26,.9); border: 1px solid #4a4a6c; border-radius: 8px; overflow: hidden; }
    .st-cmpbar button { border: 0; border-radius: 0; background: transparent; min-height: 44px; font-size: 12px; color: #8a8aaa; }
    .st-cmpbar button.on { background: #5b4a8a; color: #fff; }
    .st-frame.comparing .st-imgb { clip-path: inset(0 var(--cmp, 50%) 0 0); }
    .st-cmpdiv { position: absolute; top: 0; bottom: 64px; left: 50%; width: 28px; margin-left: -14px; z-index: 7; display: none; cursor: ew-resize; touch-action: none; }
    .st-frame.comparing .st-cmpdiv { display: block; }
    .st-cmpdiv::before { content: ''; position: absolute; top: 0; bottom: 0; left: 13px; width: 2px; background: #b39ae0; box-shadow: 0 0 6px rgba(0,0,0,.6); }
    .st-cmpdiv::after { content: '‹ ›'; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(15,15,26,.9); border: 1px solid #b39ae0; color: #b39ae0; border-radius: 14px; padding: 4px 6px; font-size: 11px; line-height: 1; pointer-events: none; }
    .st-emptymsg { color: #6c6c8e; font-size: 13px; text-align: center; max-width: 420px; padding: 20px; }
    .st-canvasarea.has-image .st-emptymsg { display: none; }
    /* ---- candidate strip ---- */
    .st-strip { flex: 0 0 auto; padding: 10px 20px 12px; border-top: 1px solid #2a2a44; background: #12121f; }
    .st-strip.st-running .st-cands { opacity: .55; }
    .st-striphead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
    .st-striphead h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8a8aaa; margin: 0; }
    .st-striphead .note { font-size: 11px; color: #6c6c8e; }
    .st-striphead .note em { color: #b39ae0; font-style: normal; }
    /* Save-all candidates (2026-11-18): on-demand, same endpoint as the
       checkbox flow; right-aligned in the striphead. */
    .st-striphead .st-saveall { margin-left: auto; min-height: 44px; font-size: 12px; }
    .st-loraui { display: flex; flex-direction: column; gap: 8px; }
    .st-lsec { border: 1px solid #2a2a44; border-radius: 8px; background: #12121f; overflow: hidden; }
    .st-lsec-h { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer;
      font-size: 11px; letter-spacing: .1em; color: #8a8aaa; user-select: none; }
    .st-lsec-h .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .st-lsec-h .n { color: #d8d8ee; }
    .st-lsec-b { display: none; border-top: 1px solid #1c1c30; max-height: 40vh; overflow-y: auto; }
    .st-lsec.open .st-lsec-b { display: block; }
    .st-lrow { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border-bottom: 1px solid #1c1c30;
      /* Row weight is hold-and-drag (2026-11-16): touch-action pan-y lets
         the browser own vertical scrolling while horizontal drags reach
         the page; user-select off so a hold doesn't select text. */
      touch-action: pan-y; user-select: none; -webkit-user-select: none; }
    .st-lrow:last-child { border-bottom: 0; }
    /* Armed while a hold-and-drag tunes the weight — same treatment as
       the batch rocker's .armed. */
    .st-lrow.armed { border-color: #b39ae0; background: #1d1d33; }
    .st-lrow .rn { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .st-lrow.parked .rn { color: #c9b97a; }
    .st-lrow .str { font-size: 11px; color: #b39ae0; background: #161628; border-radius: 4px; padding: 2px 6px; }
    .st-lrow button { background: none; border: 1px solid #4a4a6c; color: #8a8aaa; border-radius: 6px;
      font-size: 12px; min-width: 38px; min-height: 34px; cursor: pointer; }
    .st-lorahead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .st-lorahead button { background: none; border: 1px solid #4a4a6c; color: #b39ae0; border-radius: 6px;
      font-size: 12px; padding: 4px 10px; min-height: 30px; cursor: pointer; white-space: nowrap; }
    .st-lroots { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
    .st-lroots button { background: none; border: 1px solid #4a4a6c; color: #8a8aaa; border-radius: 14px;
      font-size: 11px; padding: 4px 10px; min-height: 30px; cursor: pointer; white-space: nowrap; }
    .st-lroots button.on { background: #b39ae033; color: #e6dbff; border-color: #b39ae0; }
    .st-lsubs { display: flex; gap: 6px; flex-wrap: wrap; }
    .st-lsubs button { background: none; border: 1px solid #4a4a6c; color: #8a8aaa; border-radius: 14px;
      font-size: 11px; padding: 4px 10px; min-height: 30px; cursor: pointer; }
    .st-lsubs button.on { background: #b39ae033; color: #e6dbff; border-color: #b39ae0; }
    .st-lq { width: 100%; box-sizing: border-box; background: #12121f; border: 1px solid #2a2a44; color: #d8d8ee;
      border-radius: 8px; padding: 9px 12px; font-size: 16px; }
    .st-lwarn { font-size: 11px; padding: 6px 10px; border-radius: 6px; }
    .st-lwarn.amber { color: #e0b34d; background: #2a2410; }
    .st-lwarn.red { color: #e05a5a; background: #2a1414; }
    .st-segrow { display: flex; align-items: center; gap: 8px; margin: 6px 0 10px; flex-wrap: wrap; }
    .st-seglab { font-size: 11px; color: #8a8aaa; letter-spacing: .08em; }
    .st-seg { display: inline-flex; border: 1px solid #4a4a6c; border-radius: 8px; overflow: hidden; }
    .st-seg button { border: 0; border-radius: 0; background: transparent; min-height: 40px; min-width: 48px;
      font-size: 12px; color: #8a8aaa; padding: 0 12px; }
    .st-seg button.on { background: #b39ae033; color: #e6dbff; }
    .st-seg button:disabled { opacity: .35; }
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
    .st-src{position:relative;flex:0 0 auto;display:grid;place-items:center;min-height:88px;min-width:88px;border:1px dashed #4a4a6c;border-radius:8px;color:#8a8aaa;font-size:12px;cursor:pointer;overflow:hidden}
    .st-src.has{border-style:solid}
    .st-src.has img{width:88px;height:88px;object-fit:cover;display:block}
    /* Source group (2026-11-18): pinned to the row's right edge; the
       promote control is a full-height button LEFT of the thumbnail —
       the overlaid 44px circle was too small to target. */
    .st-srcgroup{display:flex;gap:8px;align-items:stretch;margin-left:auto}
    .st-src-promote{min-width:60px;font-size:22px;background:#161628;border:1px solid #4a4a6c;border-radius:8px;color:#b39ae0}
    .st-src-up{position:absolute;top:2px;left:2px;width:44px;height:44px;display:grid;place-items:center;background:#161628cc;border-radius:50%;font-size:16px;color:#b39ae0}
    .st-src-x{position:absolute;top:2px;right:2px;width:44px;height:44px;display:grid;place-items:center;background:#161628cc;border-radius:50%;font-size:14px;color:#fff}
    /* ---- right rail ---- */
    .st-rail { flex: 0 0 330px; min-width: 0; overflow: hidden; background: #12121f; border-left: 1px solid #2a2a44; display: flex; flex-direction: column; min-height: 0; }
    .st-verbswitch { display: flex; margin: 12px; background: #161628; border: 1px solid #4a4a6c; border-radius: 8px; overflow: hidden; }
    .st-verbswitch button { flex: 1; border: 0; border-radius: 0; background: transparent; color: #8a8aaa; min-height: 44px; font-size: 13px; }
    .st-verbswitch button.on { background: #5b4a8a; color: #fff; }
    .st-railbody { flex: 1; overflow-y: auto; padding: 0 16px 16px; min-height: 0; }
    .st-verbpanel[hidden] { display: none; }
    /* Range inputs fill the panel: the four sliders (Generate size /
    denoise, Mask brush / denoise) sat at the browser's intrinsic ~130px
    in a ~298px panel with nothing beside them. Labels are already
    display: block, so this resolves cleanly, including the label-wrapped
    Brush / Mask-denoise inputs. (LoRA inspector sliders live outside
    the verb panels and are untouched.) */
    .st-verbpanel input[type=range] { width: 100%; box-sizing: border-box; }
    .st-railactions { flex: 0 0 auto; padding: 12px 16px; border-top: 1px solid #2a2a44; background: #161628; }
    .st-railactions .row { display: flex; gap: 8px; }
    .st-railactions .row + .row { margin-top: 8px; }
    .st-railactions button { flex: 1; font-size: 12.5px; min-width: 0; }
    .st-savenote { font-size: 11px; color: #6c6c8e; margin-top: 8px; text-align: center; }
    .st-row2 { display: flex; gap: 8px; }
    .st-row2 > * { flex: 1; min-width: 0; }
    .st-hintline { font-size: 11px; color: #6c6c8e; margin-top: 4px; }
    .st-hintline b { color: #b39ae0; font-weight: 600; }
    .st-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .st-chip { font-size: 11px; padding: 6px 9px; border-radius: 12px; border: 1px solid #4a4a6c;
      color: #8a8aaa; cursor: pointer; background: #161628; min-height: 32px; }
    .st-chip.on { background: #5b4a8a; border-color: #7a6aaa; color: #fff; }
    /* ---- batch rocker (usability pass 2026-11-15: replaces the drag pips) ---- */
    .st-pips { display: flex; align-items: center; gap: 10px; border: 1px solid #4a4a6c; border-radius: 8px;
      background: #161628; padding: 8px 12px; min-height: 52px; touch-action: none; cursor: ns-resize;
      user-select: none; -webkit-user-select: none; }
    .st-pips .st-rock-val { font-size: 22px; color: #d4d4e0; line-height: 1; }
    .st-pips .st-rock-val b { font-weight: 600; }
    .st-pips .st-rock-of { font-size: 12px; color: #6c6c8e; }
    .st-pips .st-rock-hint { font-size: 11px; color: #6c6c8e; margin-left: auto; }
    .st-pips .st-rock-chevs { display: flex; flex-direction: column; line-height: 1.1; color: #8a8aaa; font-size: 11px; }
    .st-pips.armed { border-color: #b39ae0; background: #1d1d33; }
    .st-pips.armed .st-rock-hint { color: #b39ae0; }
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
    .st-edgetab { position: fixed; right: env(safe-area-inset-right, 0px); top: env(safe-area-inset-top, 0px); z-index: 96; display: none; background: #161628;
      border: 1px solid #4a4a6c; border-right: 0; border-radius: 10px 0 0 10px; color: #b39ae0;
      font-size: 12px; letter-spacing: .12em; padding: 10px 14px; min-height: 44px; min-width: 72px;
      box-shadow: 2px 2px 12px rgba(0,0,0,.5); }
    .st-root.st-immersive .st-edgetab { display: block; }
    .st-genfab { position: fixed; right: calc(24px + env(safe-area-inset-right, 0px)); bottom: calc(24px + env(safe-area-inset-bottom, 0px)); z-index: 96; width: 76px; height: 76px;
      border-radius: 50%; display: none; place-items: center; background: #5b4a8a; border: 2px solid #7a6aaa;
      color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.6); padding: 0; overflow: hidden; }
    .st-root.st-immersive .st-genfab { display: grid; }
    .st-genfab .ring { position: absolute; inset: 0; border-radius: 50%;
      background: conic-gradient(#b39ae0 var(--p, 0%), transparent 0); opacity: .9; }
    .st-genfab .inner { position: relative; width: 62px; height: 62px; border-radius: 50%; background: #5b4a8a;
      display: grid; place-items: center; font-size: 11.5px; line-height: 1.2; text-align: center; }
    .st-genfab.running .inner { background: #3a2a5a; }
    .st-bottomhandle { position: fixed; left: 50%; bottom: env(safe-area-inset-bottom, 0px); transform: translateX(-50%); z-index: 96; display: none;
      background: rgba(22,22,40,.9); border: 1px solid #4a4a6c; border-bottom: 0; border-radius: 12px 12px 0 0;
      color: #8a8aaa; font-size: 11px; padding: 6px 26px 8px; min-height: 44px; letter-spacing: .08em; }
    .st-root.st-immersive .st-bottomhandle { display: block; }
    .st-bottomhandle .grip { display: block; width: 44px; height: 4px; border-radius: 2px; background: #4a4a6c; margin: 0 auto 5px; }
    /* Immersive prompt drawer (2026-11-18): the rail — and its prompt
       fields — is hidden in fullscreen, so the prompt lives in a
       bottom-left pop-out. Toggle and drawer exist only in immersive. */
    .st-promptfab { position: fixed; left: calc(24px + env(safe-area-inset-left, 0px)); bottom: calc(24px + env(safe-area-inset-bottom, 0px)); z-index: 96; display: none;
      background: rgba(22,22,40,.9); border: 1px solid #4a4a6c; border-radius: 12px; color: #b39ae0;
      font-size: 12.5px; padding: 10px 16px; min-height: 44px; box-shadow: 0 6px 24px rgba(0,0,0,.6); }
    .st-root.st-immersive .st-promptfab { display: block; }
    .st-promptdrawer { position: fixed; left: calc(12px + env(safe-area-inset-left, 0px)); bottom: calc(84px + env(safe-area-inset-bottom, 0px)); z-index: 95; width: min(320px, calc(100vw - 24px));
      max-height: 50vh; display: none; flex-direction: column; gap: 8px; background: rgba(18,18,31,.97);
      border: 1px solid #4a4a6c; border-radius: 10px; padding: 12px; box-shadow: 0 8px 40px rgba(0,0,0,.6); }
    .st-root.st-immersive .st-promptdrawer.open { display: flex; }
    .st-promptdrawer textarea { width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical; }
    .st-promptdrawer .st-pd-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: #8a8aaa; }
    .st-promptdrawer .st-pd-head button { min-height: 44px; min-width: 44px; }
    .st-candoverlay { position: fixed; left: 0; right: 0; bottom: 0; z-index: 95; background: rgba(18,18,31,.97);
      border-top: 1px solid #4a4a6c; padding: 14px 20px 18px; transform: translateY(105%); transition: transform .25s ease;
      max-height: 45vh; overflow-y: auto; }
    .st-candoverlay.open { transform: translateY(0); }
    .st-candoverlay .ov-actions { display: flex; gap: 8px; margin-top: 12px; }
    .st-candoverlay .ov-actions button { flex: 1; font-size: 12.5px; min-height: 44px; min-width: 0; }
    /* LoRA inspector overlay (2026-11-16): the same bottom-sheet pattern
       as the candidates overlay, taller — full filenames, full paths and
       big weight sliders, for complicated setups. */
    .st-loraoverlay { position: fixed; left: 0; right: 0; bottom: 0; z-index: 95; background: rgba(18,18,31,.97);
      border-top: 1px solid #4a4a6c; padding: 14px 20px 18px; transform: translateY(105%); transition: transform .25s ease;
      max-height: 75vh; overflow-y: auto; }
    .st-loraoverlay.open { transform: translateY(0); }
    /* Generation history overlay (2026-11-27): the same bottom-sheet
       pattern as the LoRA inspector — the stack as a list, oldest
       first, with per-row View / Make base and one ↩ Back step. */
    .st-historyoverlay { position: fixed; left: 0; right: 0; bottom: 0; z-index: 95; background: rgba(18,18,31,.97);
      border-top: 1px solid #4a4a6c; padding: 14px 20px 18px; transform: translateY(105%); transition: transform .25s ease;
      max-height: 75vh; overflow-y: auto; }
    .st-historyoverlay.open { transform: translateY(0); }
    .st-histrow { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #1c1c30; }
    .st-histrow:last-child { border-bottom: 0; }
    .st-histrow.cur { background: #1d1d33; border-radius: 6px; }
    .st-histrow img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; flex: 0 0 auto; }
    .st-histrow .meta { flex: 1; min-width: 0; }
    .st-histrow .nm { font-size: 13px; color: #d8d8ee; overflow-wrap: anywhere; }
    .st-histrow .sub { font-size: 11px; color: #6c6c8e; }
    .st-histrow .mark { font-size: 11px; color: #b39ae0; letter-spacing: .08em; }
    .st-histrow button { min-height: 44px; min-width: 44px; }
    .st-lovsec { font-size: 11px; letter-spacing: .1em; color: #8a8aaa; margin: 14px 0 2px; }
    .st-lovrow { padding: 10px 0; border-bottom: 1px solid #1c1c30; }
    .st-lovrow:last-child { border-bottom: 0; }
    .st-lovrow .fn { font-size: 13px; color: #d8d8ee; overflow-wrap: anywhere; }
    .st-lovrow .fp { font-size: 11px; color: #6c6c8e; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
    .st-lovrow .ctl { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
    .st-lovslider { flex: 1; min-width: 0; }
    .st-lovrow .str { font-size: 12px; color: #b39ae0; background: #161628; border-radius: 4px; padding: 2px 8px; min-width: 52px; text-align: center; }
    .st-lovrow button { background: none; border: 1px solid #4a4a6c; color: #8a8aaa; border-radius: 6px;
      font-size: 12px; min-width: 38px; min-height: 34px; cursor: pointer; }
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
      /* Generate reachable on mobile (2026-11-18): the rail's run button
         sits below the canvas in a scrollable rail, so the floating
         button shows in normal mode too — not just immersive. */
      .st-genfab { display: grid; }
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
      <div class="st-cmpbar" data-id="cmpbar">
        <button class="on" data-c="after">Result</button>
        <button data-c="before">Before</button>
        <button data-c="split">Split</button>
      </div>
      <button data-id="history" title="Generation history — view, re-base, or step back through the stack">🕘 History</button>
      <button data-id="paste" title="Paste an image from the clipboard as the working image">📋 Paste</button>
      <button data-id="copy" title="Copy the working image to the clipboard (downloads if clipboard is unavailable)">⧉ Copy</button>
      <button class="st-clear" data-id="clear" title="Clear working image" hidden>✕ clear</button>
      <button data-id="fit" title="Reset zoom to fit" hidden>⤢ Fit</button>
      <button data-id="imm" title="Hide chrome; image fills screen">⛶ Fullscreen</button>
    </header>

    <div class="st-main">
      <section class="st-stagecol">
        <div class="st-canvasarea" data-id="canvasarea">
          <div class="st-emptymsg">No working image yet.<br>
            Set one from the Gallery (📌 Set as working image), the Ladder verb, or a candidate below.</div>
          <div class="st-frame" data-id="frame" hidden>
            <img data-id="img-a" alt="working image">
            <span class="st-imgb" data-id="wrap-b"><img data-id="img-b" alt="current render"></span>
            <canvas class="st-maskview" data-id="maskview" hidden></canvas>
            <div class="st-cmpdiv" data-id="cmpdiv" title="Drag to compare"></div>
          </div>
        </div>
        <div class="st-strip" data-id="strip">
          <div class="st-striphead">
            <h2>Candidates</h2>
            <span class="note">nothing auto-saves — <em>next run overwrites unretrieved candidates</em></span>
            <button data-id="saveall" class="st-saveall" title="Save all candidates to the gallery">⬇ Save all</button>
          </div>
          <div class="st-cands" data-id="cands" aria-label="Candidate outputs of this generation run"></div>
        </div>
      </section>

      <aside class="st-rail">
        <div class="st-verbswitch" role="tablist" aria-label="Studio rail tabs">
          <button class="on" data-verb="generate" role="tab" aria-selected="true">⚡ Generate</button>
          <button data-verb="mask" role="tab" aria-selected="false">🎭 Mask</button>
          <button data-verb="provenance" role="tab" aria-selected="false">🧬 Provenance</button>
        </div>

        <div class="st-railbody">
          <!-- GENERATE -->
          <div class="st-verbpanel" data-panel="generate">
            <label>Workflow</label><select data-id="wf"></select>
            <div class="st-segrow" data-id="segrow" hidden>
              <span class="st-seglab" data-id="seg-model-lab">Model</span>
              <span class="st-seg" data-id="seg-model">
                <button type="button" data-m="9b">9B</button>
                <button type="button" data-m="4b">4B</button>
              </span>
              <span class="st-seglab">Mode</span>
              <span class="st-seg" data-id="seg-edit">
                <button type="button" data-e="0">Generate</button>
                <button type="button" data-e="1">Edit</button>
              </span>
            </div>
            <label>Prompt</label><textarea data-id="prompt" rows="6" placeholder="describe the image…"></textarea>
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
              <div style="display:flex;align-items:end;gap:6px;flex-wrap:wrap;min-width:0">
                <label style="margin:0 0 8px"><input type="checkbox" data-id="lock" style="width:auto"> 🔒 lock</label>
                <button data-id="dice" title="Random seed">🎲</button>
              </div>
            </div>
            <label>Denoise <span data-id="dval">1.00</span></label>
            <input type="range" data-id="denoise" min="0.1" max="1" step="0.05" value="1" aria-label="Denoise">
            <span class="st-hintline">&lt;1 uses the working image as the img2img input</span>
            <label style="margin-top:14px">Batch count</label>
            <div class="st-pips" data-id="pips" role="slider" aria-label="Batch count 1 to 4"
              aria-valuemin="1" aria-valuemax="${BATCH_MAX}" aria-valuenow="1" tabindex="0"
              title="Hold 1 second, then drag up or down">
              <span class="st-rock-val"><b data-id="batchval">1</b><span class="st-rock-of"> / 4</span></span>
              <span class="st-rock-chevs" aria-hidden="true"><span>▲</span><span>▼</span></span>
              <span class="st-rock-hint">hold 1s, drag ↕</span>
            </div>
            <div class="st-lorahead"><label>LoRAs <span data-id="lcount"></span></label><button data-id="lorapop" title="Open the LoRA inspector — full names, paths and big sliders">⤢ Inspect</button></div>
            <div class="st-loraui" data-id="loraui"></div>
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

          <!-- MASK -->
          <div class="st-verbpanel" data-panel="mask" hidden>
            <label>Model</label>
            <select data-id="mmodel"><option value="">loading…</option></select>
            <span class="st-hintline">The mask uses this model's inpaint version — more arrive as their mask paths land.</span>
            <div class="st-mask" data-id="mask">
              <label>Mask — paint on the canvas</label>
              <div class="st-row2">
                <button data-id="mask-paint">🖌 Paint</button>
                <button data-id="mask-erase">🧽 Erase</button>
              </div>
              <label>Brush <input type="range" data-id="brush" min="4" max="120" value="40"></label>
              <div class="st-row2">
                <button data-id="mask-clear">Clear</button>
                <button data-id="mask-undo" disabled>↩ Undo</button>
                <button data-id="mask-hide" aria-pressed="false">👁 Hide mask</button>
              </div>
              <span class="st-hintline">White = regenerate; everything else stays pixel-exact.</span>
            </div>
            <label>Prompt</label>
            <textarea data-id="mprompt" rows="6" placeholder="prompt for the masked region…"></textarea>
            <label>Denoise
              <input type="range" data-id="mdenoise" min="0.2" max="0.8" step="0.05" value="0.45">
              <span data-id="mdenoise-val">0.45</span></label>
            <div class="st-row2">
              <div><label>Seed</label><input type="number" data-id="mseed" value="0"></div>
              <div style="display:flex;align-items:end;flex-wrap:wrap;min-width:0"><label style="margin:0 0 8px"><input type="checkbox" data-id="mrandom" checked style="width:auto"> random</label></div>
            </div>
            <div class="st-row2" style="margin-top:14px">
              <button data-id="madvance" disabled>⬇ Use as source</button>
            </div>
            <span class="st-hintline">Run from the button below — on the Mask tab it runs the mask edit.</span>
            <span class="st-hintline">Use as source advances the viewed result to the working image, so the next mask edit starts from it. Never automatic — make as many attempts as you like first.</span>
            <span class="st-hintline" data-id="mstatus"></span>
          </div>

          <!-- PROVENANCE -->
          <div class="st-verbpanel" data-panel="provenance" hidden>
            <label style="margin-top:2px">Working image</label>
            <div data-id="provtable"><span class="st-hintline">no working image</span></div>
            <label style="margin-top:14px">Parent chain</label>
            <div class="st-parentchain" data-id="parentchain"><span class="st-hintline">no working image</span></div>
            <label style="margin-top:14px">Session history</label>
            <div class="st-parentchain" data-id="historyline"><span class="st-hintline">no working image</span></div>
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
    <button class="st-promptfab" data-id="promptfab" title="Edit the prompt in fullscreen">✎ Prompt</button>
    <div class="st-promptdrawer" data-id="promptdrawer">
      <div class="st-pd-head"><span>Prompt</span><button data-id="promptdrawer-close" title="Close prompt drawer">✕</button></div>
      <textarea data-id="promptdrawer-text" rows="4" placeholder="describe the image…"></textarea>
    </div>
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
    <div class="st-loraoverlay" data-id="loraoverlay">
      <div class="st-striphead">
        <h2>LoRA inspector</h2>
        <button class="ee-btn" data-id="loraclose">✕ Close</button>
      </div>
      <span class="st-hintline">Full names, full paths, big sliders — for complicated setups. These are the same pins as in the tray.</span>
      <div data-id="loraovbody"></div>
    </div>
    <div class="st-historyoverlay" data-id="historyoverlay">
      <div class="st-striphead">
        <h2>Generation history</h2>
        <button class="ee-btn" data-id="histback" title="Step back one entry and make it the base">↩ Back</button>
        <button class="ee-btn" data-id="histclose">✕ Close</button>
      </div>
      <span class="st-hintline">The stack, oldest first — every render stays reachable. View jumps to an entry; Make base makes it the next run's source; Back steps to the previous entry and re-bases to it in one move.</span>
      <span class="st-hintline">Viewing restores pixels only — the seed, prompt and LoRA settings stay as they are, so generating from an old entry uses today's settings.</span>
      <div data-id="histbody"></div>
    </div>
    <div class="st-toast" data-id="toast"><span class="tick">✓</span><span data-id="toasttext"></span></div>
  </div>`;
}

export function mountStudio(panel, jobbar) {
  panel.innerHTML = panelHTML();
  const root = panel.querySelector('.st-root');
  const $ = id => panel.querySelector(`[data-id="${id}"]`);
  const el = Object.fromEntries(['chip', 'chip-name', 'chip-chain', 'clear', 'fit', 'imm',
    'history', 'paste', 'copy', 'historyoverlay', 'histbody', 'histback', 'histclose', 'historyline',
    'canvasarea', 'frame', 'img-a', 'wrap-b', 'img-b', 'maskview', 'cmpbar', 'cmpdiv',
    'strip', 'cands', 'wf', 'segrow', 'seg-model', 'seg-model-lab', 'seg-edit', 'prompt', 'aspects', 'size', 'sizeval', 'seed', 'lock', 'dice',
    'denoise', 'dval', 'pips', 'batchval', 'lcount', 'loraui', 'lorapop',
    'preset-pick', 'preset-save', 'preset-del', 'reuse', 'save-all', 'saveall',
    'mmodel', 'mprompt', 'mdenoise', 'mdenoise-val', 'mseed', 'mrandom',
    'mask', 'mask-paint', 'mask-erase', 'brush', 'mask-clear', 'mask-undo', 'mask-hide',
    'madvance', 'mstatus',
    'provtable', 'parentchain', 'runbtn', 'edgetab', 'genfab', 'fabring', 'fabinner',
    'bottomhandle', 'candoverlay', 'ovcands', 'loraoverlay', 'loraovbody', 'loraclose',
    'promptfab', 'promptdrawer', 'promptdrawer-text', 'promptdrawer-close',
    'toast', 'toasttext'].map(k => [k, $(k)]));

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
  let previewUrl = null;       // candidate preview URL shown on the canvas
  let previewed = null;        // candidate currently viewed (⬇ promotes it)
  let maskCanvas = null, maskMode = 'paint', maskPainted = false, maskUndoStack = [], maskWhiteCount = 0;
  // Hide-mask toggle state: session-persistent — never reset on verb
  // switch or source change (a fresh mask is all black, i.e. invisible
  // anyway, so keeping the state is harmless).
  let maskHidden = false;
  let _maskLastPt = null;

  const say = (msg, isErr) => { if (jobbar) jobbar.innerHTML = `<span class="badge${isErr ? ' err' : ''}">${esc(msg)}</span>`; };
  async function api(path, opts) {
    const r = await fetch(API + path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    return j;
  }

  // ── working-image display: one canvas ──
  // The frame is sized from the PRIMARY layer: the output (img-b) in
  // stack mode, the candidate preview (img-a) while a preview is up.
  // Sizing from img-b unconditionally would break previews — in
  // particular the no-working-image run flow, where img-b is unset and
  // the frame would never size. (PR #31 fitted from img-a for the same
  // reason; the primary is whichever layer is on display.)
  function fitFrame() {
    const primary = previewUrl ? el['img-a'] : el['img-b'];
    const natW = primary.naturalWidth, natH = primary.naturalHeight;
    if (!natW || !natH || el.frame.hidden) return;
    const availW = Math.max(60, el.canvasarea.clientWidth - 24);
    const availH = Math.max(60, el.canvasarea.clientHeight - 24);
    const scale = Math.min(availW / natW, availH / natH, root.classList.contains('st-immersive') ? 10 : 1.6);
    el.frame.style.width = Math.round(natW * scale) + 'px';
    el.frame.style.height = Math.round(natH * scale) + 'px';
    clampZoomPan(); applyZoom();
    syncLayerScale();
  }
  // Scale the SECONDARY layer to the primary's displayed scale, so
  // Before/Split compares at one scale instead of two: source and
  // output aspects differ slightly, and img-a used to drive the frame
  // while img-b merely contained itself in it. Both layers are
  // explicitly sized and centered in the frame; the frame clips the
  // overflow. Runs once both images' natural dims are known — fitFrame
  // calls it, and each layer's load calls fitFrame, so whichever loads
  // last sizes it. At idx 0 both layers hold the same image, so the
  // two sizes coincide exactly. The layer assignment is unchanged
  // (img-a stays the source/before, img-b the output/after); the Split
  // left/right flip between stack and preview modes stays as-is.
  // Mask note: the mask canvas is sized to source(stack) and painting
  // maps frame-fraction → mask pixels, so alignment needs the frame
  // aspect to equal the mask source's aspect. In the normal Mask flow
  // (viewing the run source) current == source, so img-b IS the mask
  // source and the frame now always matches it — this fixes the
  // idx > 0 different-aspect sub-case, which was misaligned before.
  // (In a flow where the viewed entry isn't the run source, the mask
  // already belonged to an undisplayed image; that is unchanged.)
  function syncLayerScale() {
    const primary = previewUrl ? el['img-a'] : el['img-b'];
    const secondary = previewUrl ? el['img-b'] : el['img-a'];
    const pW = primary.naturalWidth, pH = primary.naturalHeight;
    const fW = el.frame.clientWidth, fH = el.frame.clientHeight;
    if (!pW || !pH || !fW || !fH) return;
    const scale = fW / pW;
    const sizeLayer = (img, w, h) => {
      img.style.width = Math.round(w) + 'px';
      img.style.height = Math.round(h) + 'px';
      img.style.left = '50%';
      img.style.top = '50%';
      img.style.transform = 'translate(-50%, -50%)';
    };
    sizeLayer(primary, pW * scale, pH * scale);
    const sW = secondary.naturalWidth, sH = secondary.naturalHeight;
    if (sW && sH) sizeLayer(secondary, sW * scale, sH * scale);
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
  // Fit button: the dead stepZoom finally has a caller — reset to 1:1.
  el.fit.addEventListener('click', () => { if (zoomScale !== 1) stepZoom(1 / zoomScale); });
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
      updateSaveButtons();
      return;
    }
    const cur = current(s), prev = compareEntry(s);
    if (s.idx === 0) compareOn = false;
    el.frame.hidden = false;
    el.canvasarea.classList.add('has-image');
    el['img-a'].src = prev.url;
    el['img-b'].src = cur.url;
    // Fit after load: fitting synchronously here reads the previous
    // image's dimensions (or nothing — the new image hasn't loaded),
    // so a portrait→landscape switch kept the portrait-tall frame and
    // img-a/img-b rendered the same image twice at idx 0. The once
    // load listeners mirror the candidate-tap / run-completion pattern;
    // both layers get one (each layer's load re-fits, so whichever
    // loads last sizes both); the complete guard covers the same-URL
    // re-select, whose dims are already correct. showCurrent always
    // runs in stack mode (previewUrl is nulled above), so the primary
    // here is img-b.
    syncComparer(); updateSaveButtons();
    el['img-a'].addEventListener('load', () => fitFrame(), { once: true });
    el['img-b'].addEventListener('load', () => fitFrame(), { once: true });
    if (el['img-b'].complete) fitFrame();
  }
  function syncComparer() {
    const s = stack;
    // Compare engages in stack mode (viewing a render, idx > 0) or while
    // a candidate preview is up. The bar was a dead end before: it was
    // display: none unless .comparing was on, and .comparing needed
    // compareOn, which only a click on the hidden bar could set.
    const compare = !!(compareOn && (previewUrl || (s && s.idx > 0)));
    el.frame.classList.toggle('comparing', compare);
    el.cmpdiv.style.left = cmpPct + '%';
    // img-b paints over img-a: while a candidate preview is up, clip it
    // away entirely so the preview is visible (§10 review 12:34)
    el['wrap-b'].style.clipPath = compare ? `inset(0 ${100 - cmpPct}% 0 0)`
      : (previewUrl ? 'inset(0 100% 0 0)' : 'inset(0 0 0 0)');
    for (const b of el.cmpbar.querySelectorAll('button')) {
      const mode = b.dataset.c;
      // Before shows the older image: in stack mode that's the previous
      // entry (img-a, cmpPct 0 clips img-b away); in preview mode the
      // layers are swapped — img-a is the candidate, img-b the source —
      // so Before needs img-b fully visible (cmpPct 100).
      const on = (mode === 'after' && !compare) || (mode === 'split' && compare && cmpPct < 100) || (mode === 'before' && compare && (previewUrl ? cmpPct >= 100 : cmpPct <= 0));
      b.classList.toggle('on', on);
    }
    // The bar is visible whenever there is something to compare — a
    // render in the stack, or a candidate preview against the source.
    // A preview with no working image has no source to compare against,
    // so the preview term needs a stack too.
    // Result stays active by default (compareOn false); .comparing still
    // gates the divider and the clip.
    el.cmpbar.style.display = ((s && s.idx > 0) || (previewUrl && s)) ? 'flex' : 'none';
  }
  el.cmpbar.addEventListener('click', e => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'after') { compareOn = false; }
    // Split opens at the middle — 100 left it indistinguishable from
    // Result (studio wishlist §2). Before is preview-aware: in stack
    // mode 0 clips img-b away (img-a is the older image); in preview
    // mode img-a is the candidate, so 100 shows img-b, the source.
    else { compareOn = true; cmpPct = b.dataset.c === 'before' ? (previewUrl ? 100 : 0) : 50; }
    syncComparer();
  });

  // Compare divider: drag it to move the split (studio wishlist §2).
  // The handle owns its own pointer capture — the frame's drags stay
  // pan/zoom, so the divider must be grabbed, not the frame.
  let cmpDrag = null;
  el.cmpdiv.addEventListener('pointerdown', e => {
    // Preview mode compares the candidate against the source with no
    // stack entry to step back to, so the idx > 0 gate is waived there.
    if (!compareOn || (!previewUrl && (!stack || stack.idx <= 0))) return;
    cmpDrag = e.pointerId;
    el.cmpdiv.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.cmpdiv.addEventListener('pointermove', e => {
    if (cmpDrag !== e.pointerId) return;
    const r = el.frame.getBoundingClientRect();
    if (!r.width) return;
    cmpPct = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    syncComparer();
  });
  const endCmpDrag = e => { if (cmpDrag === e.pointerId) cmpDrag = null; };
  el.cmpdiv.addEventListener('pointerup', endCmpDrag);
  el.cmpdiv.addEventListener('pointercancel', endCmpDrag);

  // Revoke blob URLs minted for a replaced stack (studio eval §10): every
  // openWorking mints fresh object URLs, so the previous stack's are
  // orphaned unless revoked. Only blob: URLs are revoked — view/data URLs
  // belong to the server or the candidate and must be left alone. Call
  // only after the canvas has swapped to the new stack (showCurrent), so
  // nothing displayed is ever revoked.
  function revokeStackUrls(s) {
    if (!s) return;
    for (const en of s.entries) {
      if (en.url && en.url.startsWith('blob:')) URL.revokeObjectURL(en.url);
    }
  }
  // Fetch a working image's bytes (foxden outputs live outside the
  // gallery jail — fall back to the candidate's own view URL; strip
  // thumbnails prove it serves fine).
  async function fetchWorkingBlob(path) {
    const r0 = await fetch(galleryFileUrl(path));
    const r = r0.ok ? r0 : await (cands.find(path)
      ? fetch(cands.find(path).url) : Promise.resolve(r0));
    if (!r.ok) throw new Error(r.status);
    return r.blob();
  }
  // Load a working image as the stack original. Same-path guard: the
  // store event, send-to, and our own promote must not rebuild a stack
  // that already contains this path (version history survives). But a
  // re-send of the same path may mean the file was overwritten in place
  // since the stack was built (stale-source bug 2026-11-16) — so a
  // same-path set refreshes that entry's bytes in place instead of
  // returning early: the canvas shows the current file, history intact.
  // (The painted mask is kept: it belongs to the entry, and a same-path
  // re-send is usually a re-select, not new bytes.)
  async function openWorking(path, name) {
    if (!path) return;
    const existing = stack && stack.entries.find(en => en.path === path);
    if (existing) {
      try {
        const blob = await fetchWorkingBlob(path);
        if (existing.url && existing.url.startsWith('blob:')) URL.revokeObjectURL(existing.url);
        existing.url = URL.createObjectURL(blob);
        showCurrent();
      } catch { /* keep the old bytes on fetch failure */ }
      return;
    }
    try {
      const blob = await fetchWorkingBlob(path);
      const outEntry = { url: URL.createObjectURL(blob), name: name || path.split('/').pop(), path };
      // An input image makes the compare real (studio wishlist §2): when
      // the working image's provenance names one, seed the stack with it
      // as entry 0 so Before/Split compare input vs output. Best-effort —
      // any failure falls back to the single-entry stack.
      let seeded = null;
      try {
        const pr = await fetch(`/api/foxden/provenance?path=${encodeURIComponent(path)}`);
        const rec = pr.ok ? await pr.json() : null;
        const input = rec && typeof rec.input_image === 'string' && rec.input_image && rec.input_image !== path
          ? rec.input_image : null;
        if (input) {
          const i0 = await fetch(galleryFileUrl(input));
          const ir = i0.ok ? i0 : await (cands.find(input)
            ? fetch(cands.find(input).url) : Promise.resolve(i0));
          if (ir.ok) {
            const ib = await ir.blob();
            seeded = pushRender(
              createStack({ url: URL.createObjectURL(ib), name: input.split('/').pop(), path: input }),
              outEntry);
            seeded = setViewedAsBase(seeded); // next run renders from the output, not the input
          }
        }
      } catch { /* fall through to the single-entry stack */ }
      const prevStack = stack;
      stack = seeded || createStack(outEntry);
      compareOn = false; cmpPct = 100;
      zoomScale = 1; zoomTx = 0; zoomTy = 0;
      maskCanvas = null; maskPainted = false; maskUndoStack = [];
      clearPreview();
      showCurrent();
      revokeStackUrls(prevStack);
      // The painted mask belongs to the source: a new working image gets a
      // fresh blank mask (only when the Mask verb is showing, so entering
      // it later still builds one — see showVerb).
      if (verb === 'mask') initMaskForSource();
    } catch (err) {
      say(`failed to load working image: ${err.message}`, true);
    }
  }
  studioState().subscribe(d => {
    syncChip(d);
    renderCandidates();
    if (!d.path) {
      // Clearing the store must clear the canvas too (studio eval §3):
      // otherwise the old image and save buttons linger.
      const prevStack = stack;
      stack = null; previewed = null; previewUrl = null;
      maskCanvas = null; maskPainted = false; maskUndoStack = [];
      showCurrent();
      revokeStackUrls(prevStack);
      return;
    }
    // Provenance/settings emits carry no path change — the working image
    // is the same one openWorking already loaded; re-running it would
    // re-fetch the bytes on every provenance refresh.
    if (d.reason === 'provenance' || d.reason === 'provenance-failed' || d.reason === 'settings') return;
    openWorking(d.path, d.name);
    if (verb === 'provenance') renderProvenance();
  });
  el.clear.addEventListener('click', () => studioState().clear());
  function syncChip(d) {
    el.chip.hidden = !d.path;
    el.clear.hidden = !d.path;
    el.fit.hidden = !d.path;
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
      // Second finger: this is a pinch, never a stroke — cancel any stroke
      // in progress so the second finger doesn't paint a dot (update.js).
      masking = false; _maskLastPt = null;
      const [a, b] = [...zPointers.values()];
      zPinch = { d0: dist(a, b), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                 scale0: zoomScale, tx0: zoomTx, ty0: zoomTy };
    } else if (maskVisible()) {
      // Mask arming, ported from update.js: one pointer, mask section open.
      masking = true; _maskLastPt = null;
      pushMaskUndo();
      el.canvasarea.setPointerCapture(e.pointerId);
      maskStroke(e);
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
    // A stroke ends when its pointer lifts (update.js endMask).
    masking = false; _maskLastPt = null;
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
  // The mask is paintable only while the Mask verb is active, a mask
  // canvas exists for the current source, and the overlay is not hidden
  // (can't paint what you can't see).
  function maskVisible() {
    return verb === 'mask' && !!maskCanvas && !maskHidden;
  }
  // Visible overlay: the mask itself is an offscreen canvas, so without
  // this the user would paint blind. Red tint, alpha = mask brightness,
  // drawn at low res (it's a guide) and stretched over the frame by CSS;
  // it lives inside the frame, so the zoom transform moves it for free.
  let maskViewTmp = null;
  function drawMaskView() {
    const mv = el.maskview;
    if (!mv) return;
    const show = verb === 'mask' && !!maskCanvas && !!stack && !maskHidden;
    mv.hidden = !show;
    if (!show) return;
    const OW = 320, OH = Math.max(1, Math.round(320 * maskCanvas.height / maskCanvas.width));
    if (!maskViewTmp) maskViewTmp = document.createElement('canvas');
    maskViewTmp.width = OW; maskViewTmp.height = OH;
    const tctx = maskViewTmp.getContext('2d');
    tctx.drawImage(maskCanvas, 0, 0, OW, OH);
    const src = tctx.getImageData(0, 0, OW, OH);
    mv.width = OW; mv.height = OH;
    const ctx = mv.getContext('2d');
    const out = ctx.createImageData(OW, OH);
    for (let i = 0; i < src.data.length; i += 4) {
      out.data[i] = 255; out.data[i + 1] = 64; out.data[i + 2] = 64;
      out.data[i + 3] = Math.round(src.data[i] * 0.6);
    }
    ctx.putImageData(out, 0, 0);
  }
  function initMaskForSource() {
    const srcEntry = stack && source(stack);
    if (!srcEntry) return;
    maskPainted = false; maskUndoStack = []; maskCanvas = null;
    const img = new Image();
    img.onload = () => {
      const mc = document.createElement('canvas');
      mc.width = img.naturalWidth; mc.height = img.naturalHeight;
      const ctx = mc.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, mc.width, mc.height);
      maskWhiteCount = 0;
      maskCanvas = mc;
      drawMaskView();
    };
    img.src = srcEntry.url;
  }
  // White-pixel count, maintained incrementally (studio eval §12): the old
  // maskHasWhite() re-scanned the whole canvas (O(W×H)) on every erase
  // move. The count is exact — every mutation goes through maskStroke
  // (bbox delta), mask-clear (zero), undo restore (full rescan, rare), or
  // initMaskForSource (blank canvas, zero) — so "any white" is just count > 0.
  function scanWhiteCount() {
    if (!maskCanvas) return 0;
    const data = maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  }
  function maskHasWhite() {
    return !!maskCanvas && maskWhiteCount > 0;
  }
  function countWhiteIn(box) {
    if (!maskCanvas || box.w <= 0 || box.h <= 0) return 0;
    const data = maskCanvas.getContext('2d').getImageData(box.x, box.y, box.w, box.h).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  }
  function maskStroke(e) {
    if (!maskCanvas) return;
    // No new mapping needed while zoomed: the frame's bounding rect already
    // includes the scale, so the pointer → rect → natural-size ratio
    // accounts for zoom for free (update.js applyZoom comment).
    const fr = el.frame.getBoundingClientRect();
    const sx = maskCanvas.width / fr.width, sy = maskCanvas.height / fr.height;
    const x = (e.clientX - fr.left) * sx, y = (e.clientY - fr.top) * sy;
    const ctx = maskCanvas.getContext('2d');
    const brush = parseInt(el.brush.value, 10) || 40;
    const lw = brush * sx;
    // Only the stroke's bounding box can change: count the white pixels
    // there before and after the draw, and adjust the running count by the
    // delta — O(brush²) per move instead of O(canvas). The box is expanded
    // by half the line width in both axes (plus 1px for antialiasing) so
    // it covers the round caps and the stroke fringe — the stroke is a
    // disc of radius lw/2 in canvas space, whatever the x/y scale ratio.
    const p0 = _maskLastPt || { x, y };
    const half = lw / 2 + 1;
    const bx = Math.max(0, Math.floor(Math.min(p0.x, x) - half));
    const by = Math.max(0, Math.floor(Math.min(p0.y, y) - half));
    const bx2 = Math.min(maskCanvas.width, Math.ceil(Math.max(p0.x, x) + half));
    const by2 = Math.min(maskCanvas.height, Math.ceil(Math.max(p0.y, y) + half));
    const box = { x: bx, y: by, w: bx2 - bx, h: by2 - by };
    const before = countWhiteIn(box);
    ctx.strokeStyle = maskMode === 'paint' ? '#fff' : '#000';
    ctx.lineWidth = lw;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (_maskLastPt) ctx.moveTo(_maskLastPt.x, _maskLastPt.y); else ctx.moveTo(x, y);
    ctx.lineTo(x, y); ctx.stroke();
    maskWhiteCount = Math.max(0, maskWhiteCount + countWhiteIn(box) - before);
    _maskLastPt = { x, y };
    maskPainted = maskMode === 'paint' ? true : maskHasWhite();
    drawMaskView();
  }
  el['mask-paint'].addEventListener('click', () => { maskMode = 'paint'; });
  el['mask-erase'].addEventListener('click', () => { maskMode = 'erase'; });
  // Hide-mask toggle: hides only the overlay canvas — the mask data is
  // never cleared. Paint/Erase are disabled while hidden (clear
  // feedback); maskVisible() blocks strokes too.
  function syncMaskHide() {
    el['mask-hide'].textContent = maskHidden ? '👁 Show mask' : '👁 Hide mask';
    el['mask-hide'].setAttribute('aria-pressed', String(maskHidden));
    el['mask-paint'].disabled = maskHidden;
    el['mask-erase'].disabled = maskHidden;
    drawMaskView();
  }
  el['mask-hide'].addEventListener('click', () => { maskHidden = !maskHidden; syncMaskHide(); });
  el['mask-clear'].addEventListener('click', () => {
    if (!maskCanvas) return;
    pushMaskUndo();
    const ctx = maskCanvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskPainted = false;
    maskWhiteCount = 0;
    drawMaskView();
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
      maskWhiteCount = scanWhiteCount();
      maskPainted = maskHasWhite();
      el['mask-undo'].disabled = maskUndoStack.length === 0;
      drawMaskView();
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
    // The Provenance panel reads the store lazily — render it on open, or
    // it shows whatever was last rendered (studio eval §2).
    if (v === 'provenance') renderProvenance();
    // Entering Mask with a working image and no mask yet builds a fresh
    // blank one for the source; an existing painted mask is kept — the
    // mask only resets when the source changes (see openWorking).
    if (v === 'mask' && stack && !maskCanvas) initMaskForSource();
    // The mask overlay only shows on the Mask verb; hide it when leaving,
    // show it when returning.
    drawMaskView();
  }
  function setRunLabel() {
    el.runbtn.textContent =
      verb === 'generate' ? `⚡ Generate · batch ${batch}` :
      verb === 'mask' ? '🎭 Run mask edit' : '🧬 Info only';
  }
  panel.querySelector('.st-verbswitch').addEventListener('click', e => {
    const b = e.target.closest('[data-verb]');
    if (b) showVerb(b.dataset.verb);
  });
  el.runbtn.addEventListener('click', () => {
    if (verb === 'generate') generate();
    else if (verb === 'mask') runMask();
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
    // Save acts on what the canvas shows (§10 review 12:34): a viewed
    // candidate if one is up, else the stack top. A viewed candidate with
    // no server path (a mask run whose render failed to store) can't save.
    const entry = (previewed && previewed.path) ? { path: previewed.path, name: previewed.path.split('/').pop() } : current(s);
    const orig = s.entries[0];
    if (!orig.path) { say('original source has no server path', true); return; }
    try {
      if (kind === 'over') {
        // Two-named confirm (2026-11-27): the old text named only the
        // file being overwritten — while viewing an older entry (e.g.
        // Before) it was easy to save over the wrong one. Name both.
        if (!confirm(`Overwrite ${orig.name} with ${entry.name}?\nNo new file will be created.`)) return;
        const r = await fetch('/api/update/save-back', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ render_path: entry.path, source_path: orig.path }) });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).detail || r.status));
        const d = await r.json();
        // Save-over replaces the bytes at the original's path — if the
        // prepared img2img input was cached for that path, it is stale
        // (studio eval §9): drop it so the next run re-prepares.
        if (d.overwritten === inputParent) { inputName = null; inputParent = null; inputDims = null; inputTs = null; }
        showToast(`Saved over ${d.overwritten}`);
        say(`saved over ${d.overwritten} (${d.bytes} bytes)`);
      } else if (kind === 'new') {
        const r = await fetch('/api/update/save-new', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ render_path: entry.path, source_path: orig.path }) });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).detail || r.status));
        const d = await r.json();
        showToast('Saved as new file');
        say(`saved as new file — ${d.new_path}`);
      } else {
        const tag = cleanName(prompt('Library tag:', 'zengosoft')) || 'zengosoft';
        const r = await fetch('/api/update/save-family', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            render_path: entry.path, original_path: orig.path, tag,
            // Intermediates are the viewed entry's ANCESTRY (parent
            // walk), not the flat slice(1, idx): a render branched from
            // B lists B only — the old slice wrongly listed a sibling
            // branch (e.g. C) as an intermediate of D.
            intermediates: ancestry(s, s.idx).map(e2 => e2.path).filter(Boolean),
            recipe: entry.recipe || null, masked: !!entry.masked,
          }) });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).detail || r.status));
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
  // File picker → the shared import (image-clipboard.js): the upload→
  // set flow lives in exactly one place — paste and Claude's candidate
  // behavior call the same function.
  let filePick = null;
  function pickSource() {
    if (!filePick) {
      filePick = document.createElement('input');
      filePick.type = 'file'; filePick.accept = 'image/*';
      filePick.style.display = 'none';
      filePick.addEventListener('change', async () => {
        const f = filePick.files && filePick.files[0];
        // Clear up front: every exit (busy, error) leaves the picker
        // re-pickable, including picking the same file again.
        filePick.value = '';
        if (!f) return;
        // Same busy guard as the paste paths (2026-11-27): a mid-run file
        // pick replaces the stack under the completion handler.
        if (busy) return;
        say('uploading source…');
        try {
          const p = await importImageAsWorking(f, { name: f.name, origin: 'gallery-upload' });
          say(`working image: ${p}`);
        } catch (err) { say(`upload failed: ${err.message}`, true); }
      });
      panel.appendChild(filePick);
    }
    filePick.click();
  }
  // Advance the viewed candidate to the working image (multi-stage work):
  // the result becomes the source for the next mask edit. Explicit only —
  // never automatic — so several attempts at one fix stay possible.
  // History-preserving: the candidate is pushed onto the stack FIRST, so
  // openWorking's same-path guard keeps the version history (the comparer
  // keeps its before; earlier stages stay reachable) instead of rebuilding
  // a fresh single-entry stack. And the run source moves with it
  // (setViewedAsBase) — without that, the next run would still render
  // from the original. The painted mask belongs to the source, so it is
  // reset for the new working image.
  function promoteCandidate(c) {
    if (!c || !c.path) { say('nothing to use as source', true); return; }
    const entry = { url: c.url, name: c.path.split('/').pop(), path: c.path,
      recipe: c.recipe || null, masked: !!c.masked };
    let prevStack = null;
    if (!stack) stack = createStack(entry);
    else if (stack.entries.some(en => en.path === c.path)) {
      stack = selectEntry(stack, stack.entries.findIndex(en => en.path === c.path));
    } else {
      prevStack = stack;
      stack = pushRender(stack, entry);
    }
    stack = setViewedAsBase(stack);
    compareOn = false; cmpPct = 100;
    showCurrent();
    // Ring cap (2026-11-27): pushRender trims the oldest renders past
    // 50 entries — revoke their blob URLs so they don't leak for the
    // session. Entries are shared by reference, so dropped = in prev,
    // not in new; the canvas has already swapped to the new entry, so
    // nothing displayed is ever revoked.
    if (prevStack) revokeStackUrls({ entries: prevStack.entries.filter(en => !stack.entries.includes(en)) });
    maskCanvas = null; maskPainted = false; maskUndoStack = [];
    studioState().set(c.path, 'foxden-output', { name: entry.name });
    if (verb === 'mask') initMaskForSource();
    say(`working image: ${entry.name}`);
  }
  function syncAdvance() {
    if (el.madvance) el.madvance.disabled = !(previewed && previewed.path);
  }
  function renderCandidates() {
    const list = cands.get();
    // The viewed candidate keeps its ring across the rebuild: the strips
    // are recreated from scratch, so re-apply .sel from previewed (the
    // old selBtn/selPath read was voided and never did this).
    const selPath = previewed ? previewed.path : null;
    for (const target of [el.cands, el.ovcands]) {
      target.innerHTML = '';
      list.forEach((c, i) => {
        const d = document.createElement('button');
        d.className = 'st-cand';
        if (selPath && c.path === selPath) d.classList.add('sel');
        d.title = 'Use as working image';
        const tag = document.createElement('span');
        tag.className = 'tag'; tag.textContent = `c${i + 1}`;
        const im = document.createElement('img');
        im.src = c.url; im.alt = `candidate ${i + 1}`;
        const pick = document.createElement('span');
        pick.className = 'pick'; pick.textContent = 'promote';
        d.append(tag, im, pick);
        d.addEventListener('click', () => {
          // Viewing ONLY (§7.2/§10 review 12:23): a candidate tap previews it
          // on the canvas; becoming the working image is the explicit
          // down-arrow beside the source slot.
          previewed = c;
          previewUrl = c.url;
          // The preview always lands, comparer or not: compare yields so the
          // canvas shows the selected candidate (same pattern as generate()'s
          // completion, which resets compareOn on a new output). The .sel
          // ring is re-applied by renderCandidates() from previewed.
          compareOn = false; cmpPct = 100;
          el['img-a'].src = previewUrl;
          // Cleared canvas (2026-11-18): after ✕ the frame is hidden, so a
          // tap would set the src but fitFrame would early-return — unhide
          // here so the preview lands. Preview only: becoming the working
          // image is still the explicit ⬇ beside the source slot.
          if (el.frame.hidden) {
            el.frame.hidden = false;
            el.canvasarea.classList.add('has-image');
          }
          el['img-a'].addEventListener('load', () => fitFrame(), { once: true });
          syncComparer();
          renderCandidates();
          say(`viewing ${c.path.split('/').pop()} — tap ⬇ beside the source to use it`);
        });
        target.appendChild(d);
      });
      for (let i = list.length; i < 4; i++) {
        const d = document.createElement('span');
        d.className = 'st-cand empty';
        d.textContent = `slot ${i + 1}`;
        target.appendChild(d);
      }
      // Source group: pinned to the row's right edge, visually separate
      // from candidates (§10 review 12:23). The promote control is a
      // full-height button LEFT of the thumbnail (2026-11-18) — the
      // overlaid 44px circle was too small to target. ✕ clears; upload
      // when empty.
      const st = studioState().get();
      const group = document.createElement('span');
      group.className = 'st-srcgroup';
      const src = document.createElement('span');
      src.className = 'st-src' + (st.path ? ' has' : '');
      // Promote is offered only when the viewed candidate has a server
      // path — a mask run whose render failed to store still previews (its
      // image is a data URL) but cannot become the working image.
      if (previewed && previewed.path) {
        const dn = document.createElement('button');
        dn.className = 'st-src-promote'; dn.textContent = '⬇';
        dn.title = `Use viewed image (${previewed.path.split('/').pop()}) as source`;
        dn.setAttribute('aria-label', 'Use viewed image as source');
        dn.addEventListener('click', (e) => {
          e.stopPropagation();
          promoteCandidate(previewed);
        });
        group.appendChild(dn);
      }
      if (st.path) {
        const im = document.createElement('img');
        im.src = galleryFileUrl(st.path); im.alt = 'source image';
        im.title = `source: ${st.path.split('/').pop()}`;
        const x = document.createElement('span');
        x.className = 'st-src-x'; x.textContent = '✕';
        x.title = 'Clear working image';
        x.addEventListener('click', (e) => {
          e.stopPropagation(); studioState().clear(); say('working image cleared');
        });
        src.appendChild(im); src.appendChild(x);
      } else {
        const up = document.createElement('span');
        up.className = 'st-src-up'; up.textContent = '＋';
        up.title = 'Upload an image as the working image';
        up.addEventListener('click', (e) => { e.stopPropagation(); pickSource(); });
        src.appendChild(up);
      }
      group.appendChild(src);
      target.appendChild(group);
    }
    el.strip.classList.toggle('st-running', busy);
    // Save-all button: disabled while no candidate has a server path.
    el.saveall.disabled = !list.some(c => c.path);
    syncAdvance();
  }

  // ── generate: batch N = N sequential runs, one candidate set ──
  // Prepared-input cache (stale-source bug 2026-11-16): keyed on the
  // working-image path AND the store timestamp. set() refreshes ts on
  // every set — even the same path — so a re-send of an overwritten
  // file re-prepares instead of returning the old upload.
  let inputName = null, inputParent = null, inputDims = null, inputTs = null;
  async function prepareInput() {
    const st = studioState().get();
    const denoise = parseFloat(el.denoise.value) || 1;
    if (!st.path) { inputName = null; inputParent = null; inputTs = null; return null; }   // denoise gating lives in generate(); edit workflows always inject
    if (inputParent === st.path && inputTs === st.ts && inputName) return inputName;   // cached per working image
    say('preparing working image as img2img input…');
    const r0 = await fetch(galleryFileUrl(st.path));
    if (!r0.ok) throw new Error(`working image fetch failed: ${r0.status}`);
    const blob = await r0.blob();
    const fname = st.name || st.path.split('/').pop();
    const fd = new FormData();
    fd.append('image', new File([blob], fname, { type: blob.type || 'image/png' }));
    // ComfyUI /upload/image keeps the first file's bytes under a
    // colliding name unless overwrite is sent (backend/comfy.py
    // _comfy_upload passes overwrite=true for the same reason) — two
    // different images sharing a basename would otherwise silently
    // generate from the first one's bytes.
    fd.append('overwrite', 'true');
    const j = await api('/upload', { method: 'POST', body: fd });
    inputName = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
    inputParent = st.path;   // provenance parent chain: generation links back
    inputTs = st.ts;
    return inputName;  }

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
      const wfId = composeWorkflow();
      const wfDef = wfDefs.find(w => w.id === wfId);
      const isEdit = !!(wfDef && wfDef.edit);
      const st0 = studioState().get();
      // guard only for the Edit toggle's always-feed graphs: the klein
      // family shares gen/edit ids, so isEdit alone is true in Generate
      // mode and would refuse t2i without a working image (2026-11-21).
      if (isEdit && wfEdit && !st0.path) {
        say('edit workflows need a working image — set one from Gallery or a candidate first', true);
        return;
      }
      // edit graphs consume the reference at any denoise — always inject.
      // BUT "edit" in the config means the id is reachable as an edit role,
      // and the klein family shares ONE id for gen+edit (denoise-gated
      // self-edit). Only the Edit toggle (wfEdit) selects an always-feed
      // graph; in Generate mode the denoise slider alone gates i2i —
      // otherwise a shared gen/edit id poisons Generate into always
      // injecting the working image even at denoise 1.0 (2026-11-21 bug:
      // workflow=klein denoise=1.0 input_image=<set>).
      const useInput = (denoise < 1 || (isEdit && wfEdit)) ? await prepareInput() : null;
      let seed = nextSeed({ locked: el.lock.checked, current: el.seed.value });
      for (let i = 0; i < batch; i++) {
        if (i > 0 && !el.lock.checked) seed = String(Math.floor(Math.random() * 2 ** 31));
        el.seed.value = seed;
        let [width, height] = sizeFor(aspect, sizeIdx);
        // i2i sizing (2026-11-21): the SIZE PICKER wins — its long side
        // bounds the render and the input image contributes only its
        // aspect (backend snaps the long side into the workflow's size
        // constant; the resize node keeps the input ratio). Never send
        // the input's raw pixel dims — a 2896px source used to drag the
        // render up to its own resolution (the slow-render bug).
        // (inputDims retained only for cache invalidation.)
        const body = {
          workflow: wfId, prompt: promptText, width, height,
          loras: pins.payload(), suspended_loras: pins.suspendedPayload(),
          denoise, seed,
          // reference conditioning is EDIT machinery (2026-11-21): Generate
          // may use an image as latent start (i2i) but never as reference.
          reference: isEdit && wfEdit,
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
      // Canvas previews the leading candidate without promoting (§7.2/§10
      // review: see results without changing the working image). Cleared by
      // showCurrent() on the next working-image change or run.
      if (collected.length) {
        previewed = collected[0];
        previewUrl = collected[0].url;
        // The preview always lands, comparer or not (see the candidate tap):
        // compare yields, and with no working image yet the frame is still
        // hidden, so unhide it.
        compareOn = false; cmpPct = 100;
        if (!stack) {
          el.frame.hidden = false;
          el.canvasarea.classList.add('has-image');
        }
        el['img-a'].src = previewUrl;
        el['img-a'].addEventListener('load', () => fitFrame(), { once: true });
        syncComparer();
      }
      // No auto-promote (decision §7.2/§10): outputs become the working
      // image only on explicit candidate selection — otherwise edit chains
      // silently drift off the user's chosen source image.
      if (el['save-all'].checked && collected.length) await saveAllOutputs(collected.map(c => c.path));
      openOverlayInImmersive();
      say(`done — ${collected.length} candidate${collected.length === 1 ? '' : 's'}`);
    } catch (err) {
      say(`generate failed: ${err.message}`, true);
      showToast('Run failed');
    } finally {
      // One reset for every exit (studio eval §13): the early return used
      // to duplicate this, so a future early return could leave Generate
      // permanently disabled. Resting label is ⚡Gen (null), not blank.
      busy = false;
      el.runbtn.disabled = false; el.genfab.disabled = false;
      el.strip.classList.remove('st-running');
      setFabProgress(0, null);
    }
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
      // Progress ring: candidate index + sub-progress within this poll cycle,
      // as a 0..1 fraction of the whole batch (studio eval §7).
      const frac = Math.min(0.99, (Date.now() - t0) / 120000);
      setFabProgress((candIdx + frac) / batch, `${candIdx + 1}/${batch}`);
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

  // Save-all candidates button (2026-11-18): same endpoint/toast as the
  // checkbox flow, but on demand for the current strip. Wired once at
  // mount — the striphead is static markup. Disabled while no candidate
  // has a server path; renderCandidates() refreshes that state.
  el.saveall.addEventListener('click', async () => {
    const paths = cands.get().filter(c => c.path).map(c => c.path);
    if (!paths.length) return;
    await saveAllOutputs(paths);
  });

  // ── batch rocker (usability pass 2026-11-15, replaces the drag pips):
  // hold ~1s to arm, then drag vertically — up adds, down subtracts, 1..4.
  // The hold stops accidental bumps; the armed state is visible on the
  // control. Arrow keys step it without the hold (keyboard is deliberate).
  const ROCKER_HOLD_MS = 1000, ROCKER_STEP_PX = 28;
  let rockerArmTimer = null, rockerArmed = false, rockerStartY = 0, rockerStartBatch = 1;
  function setBatch(v) {
    batch = clampBatch(v);
    el.pips.setAttribute('aria-valuenow', String(batch));
    el.batchval.textContent = String(batch);
    setRunLabel();
  }
  const disarmRocker = () => {
    if (rockerArmTimer) { clearTimeout(rockerArmTimer); rockerArmTimer = null; }
    rockerArmed = false;
    el.pips.classList.remove('armed');
  };
  el.pips.addEventListener('pointerdown', e => {
    el.pips.setPointerCapture(e.pointerId);
    if (rockerArmTimer || rockerArmed) return;
    rockerStartY = e.clientY; rockerStartBatch = batch;
    rockerArmTimer = setTimeout(() => {
      rockerArmTimer = null; rockerArmed = true;
      el.pips.classList.add('armed');
    }, ROCKER_HOLD_MS);
  });
  el.pips.addEventListener('pointerup', disarmRocker);
  el.pips.addEventListener('pointercancel', disarmRocker);
  el.pips.addEventListener('pointermove', e => {
    if (!rockerArmed) return;
    setBatch(batchFromRockerDrag(rockerStartBatch, rockerStartY, e.clientY, ROCKER_STEP_PX));
  });
  el.pips.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { e.preventDefault(); setBatch(batch + 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setBatch(batch - 1); }
  });
  setBatch(1);

  // ── generate form: config / loras / aspects / presets / _last ──
  // Model+mode toggles (§10 review 12:44): families with variants offer a
  // model segmented control and an edit toggle; the concrete workflow id is
  // composed from the selection so the backend registry stays flat.
  // family → model → {gen, edit}; populated from /config families so any
  // family with variants gets the toggles (klein 9b/4b, moss turbo, …)
  let FAMILY_MODELS = {};
  // Per-family model/mode memory: switching families (or a config reload)
  // restores each family's last selection instead of resetting it.
  const FAMILY_STATE = {};
  let wfModel = null, wfEdit = false;
  const familyVariants = () => (FAMILY_MODELS[el.wf.value] || {}).models || null;
  function restoreFamilyState() {
    const s = FAMILY_STATE[el.wf.value];
    wfModel = s ? s.model : null;
    wfEdit = s ? !!s.edit : false;
  }
  function saveFamilyState() {
    FAMILY_STATE[el.wf.value] = { model: wfModel, edit: wfEdit };
  }
  function composeWorkflow() {
    const v = familyVariants();
    if (!v) return el.wf.value;
    const m = v[wfModel] || Object.values(v)[0];
    return (wfEdit && m.edit) ? m.edit : m.gen;
  }
  function renderVariants() {
    const v = familyVariants();
    el.segrow.hidden = !v;
    if (!v) { saveFamilyState(); return; }
    if (!v[wfModel]) wfModel = Object.keys(v)[0];
    // Per-model visibility: the variant picker (e.g. klein 9b/4b) only
    // renders when the family actually has more than one model — a single-
    // model family like moss doesn't get a redundant "TURBO" button.
    const multiModel = Object.keys(v).length > 1;
    el['seg-model'].hidden = !multiModel;
    el['seg-model-lab'].hidden = !multiModel;
    // rebuild model buttons for this family
    el['seg-model'].innerHTML = '';
    for (const key of Object.keys(v)) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.m = key;
      b.textContent = key.toUpperCase();
      if (key === wfModel) b.classList.add('on');
      el['seg-model'].appendChild(b);
    }
    const editId = v[wfModel] && v[wfModel].edit;
    const editOk = !!editId && wfDefs.some(w => w.id === editId && w.available);
    for (const b of el['seg-edit'].querySelectorAll('button')) {
      b.disabled = !editOk && b.dataset.e === '1';
      b.title = editOk ? '' : 'no edit graph for this model';
      b.classList.toggle('on', wfEdit === (b.dataset.e === '1'));
    }
    if (!editOk) wfEdit = false;
    saveFamilyState();
  }
  el['seg-model'].addEventListener('click', e => {
    const b = e.target.closest('button[data-m]');
    if (!b) return;
    wfModel = b.dataset.m;
    const v = familyVariants();
    const editId = v && v[wfModel] && v[wfModel].edit;
    if (!editId || !wfDefs.some(w => w.id === editId && w.available)) wfEdit = false;
    renderVariants();
  });
  el['seg-edit'].addEventListener('click', e => {
    const b = e.target.closest('button[data-e]');
    if (!b || b.disabled) return;
    wfEdit = b.dataset.e === '1';
    renderVariants();
    say(wfEdit ? 'edit mode — working image will be used as the source'
               : 'generate mode — fresh t2i');
  });
  async function loadConfig() {
    try {
      const c = await api('/config');
      const fams = [...new Set(c.workflows.map(w => w.family || w.id))];
      // default_workflow may be a family name ("klein") or a concrete
      // workflow id ("moss-edit") — the family is the first segment, never
      // a families-map lookup (a concrete id is not a family key; the old
      // lookup silently fell back to klein for any concrete id).
      const defFam = (c.default_workflow || 'klein').split('-')[0];
      rebuildSelectPreserving(el.wf, fams.map(f => {
        const anyAvail = c.workflows.some(w => (w.family || w.id) === f && w.available);
        return `<option value="${esc(f)}" ${anyAvail ? '' : 'disabled'}>${esc(f)}${anyAvail ? '' : ' (file missing)'}</option>`;
      }).join(''), fams.includes(defFam) ? defFam : 'klein');
      allLoras = c.loras;
      wfDefs = c.workflows || [];
      FAMILY_MODELS = c.families || {};
      restoreFamilyState();          // keep each family's last model/mode across reloads
      renderVariants();
      renderLoras();
    } catch (e) { say('config failed: ' + e.message, true); }
  }
  // ── LoRA section (§10 review 13:51): ACTIVE / PAUSED accordion drawers
  // plus a folder-accordion library. Folders ARE the tags (real tree:
  // _Flux2Klein/Style/…). Workflow sets the default folder; pins stay in
  // place in the library marked 📌/⏸. pins API unchanged (payload same).
  const LORA_WF_FOLDER = { klein: '_Flux2Klein', krea2: '_Krea2', qwen21: '_Qwen21',
                           moss: 'moss', zengorestyle: '_Flux2Klein' };
  const loraUI = { q: '', auto: true, root: null, sub: null, openRoot: null,
                   openActive: true, openPaused: false, ovQ: '' };
  const loraRootOf = n => (/[\\/]/.test(n) ? n.replace(/\\/g, '/').split('/')[0] : '(root)');
  const loraSubOf = n => { const p = n.replace(/\\/g, '/').split('/'); return p.length > 2 ? p[1] : null; };
  const loraDefFolder = () => LORA_WF_FOLDER[el.wf.value] || null;

  // LoRA row weight by hold-and-drag (2026-11-16, replaces the
  // click-to-expand slider): press-and-hold ~300ms arms the row, then
  // drag left/right to tune strength (120px = 1.0, range -1..2, step
  // 0.05). A quick tap does nothing; a scroll starts moving before the
  // hold completes, so it never arms — same hold-to-arm guard as the
  // batch rocker. Works on active AND paused rows (suspended pins keep
  // their strength); unpinned rows have nothing to tune.
  const LORA_DRAG_PX_PER_UNIT = 120, LORA_HOLD_MS = 300, LORA_DRAG_CANCEL_PX = 8;
  function wireLoraRowDrag(row, name) {
    let armTimer = null, armed = false, startX = 0, startY = 0, startVal = 0;
    const cur = () => pins.active.has(name) ? pins.active.get(name)
      : pins.suspended.has(name) ? pins.suspended.get(name) : null;
    const disarm = (commit) => {
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      if (armed) {
        armed = false; row.classList.remove('armed');
        if (commit) renderLoras();
      }
    };
    row.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;  // suspend/unpin keep working
      if (cur() === null) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY; startVal = cur();
      armTimer = setTimeout(() => {
        armTimer = null; armed = true;
        row.classList.add('armed');
        try { row.setPointerCapture(e.pointerId); } catch (_) {}
      }, LORA_HOLD_MS);
    });
    row.addEventListener('pointermove', e => {
      if (armTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > LORA_DRAG_CANCEL_PX) {
        // Moved before the hold completed: a scroll or a flick, not an arm.
        clearTimeout(armTimer); armTimer = null;
      }
      if (!armed) return;
      const v = Math.min(2, Math.max(-1,
        Math.round((startVal + (e.clientX - startX) / LORA_DRAG_PX_PER_UNIT) / 0.05) * 0.05));
      pins.setStrength(name, v);
      const tag = row.querySelector('.str');
      if (tag) tag.textContent = '×' + v.toFixed(2);
    });
    row.addEventListener('pointerup', () => disarm(true));
    row.addEventListener('pointercancel', () => disarm(false));
  }

  function loraRow(name, st, parked, box) {
    const row = document.createElement('div');
    row.className = 'st-lrow' + (parked ? ' parked' : '');
    // The name shows the beginning of the filename (ellipsis cuts the
    // tail); the directory no longer takes up to 40% of the row — the
    // full path stays in the title tooltip and the inspector.
    const rn = document.createElement('span');
    rn.className = 'rn';
    rn.textContent = name.split('/').pop().replace(/\.safetensors$/i, '');
    rn.title = name;
    row.appendChild(rn);
    // The strength tag is the live readout for the hold-and-drag, on
    // active AND paused rows (suspended pins keep their strength).
    const tag = document.createElement('span');
    tag.className = 'str'; tag.textContent = '×' + st.toFixed(2);
    row.appendChild(tag);
    const tog = document.createElement('button');
    tog.textContent = parked ? '▶' : '⏸';
    tog.title = parked ? 'restore' : 'suspend';
    tog.addEventListener('click', () => {
      if (parked) pins.restore(name); else pins.suspend(name);
      renderLoras();
    });
    const del = document.createElement('button');
    del.textContent = '✕'; del.title = 'unpin';
    del.addEventListener('click', () => { pins.remove(name); renderLoras(); });
    row.append(tog, del);
    wireLoraRowDrag(row, name);
    box.appendChild(row);
  }

  function loraSection(label, dotColor, open, onToggle, fill) {
    const sec = document.createElement('div');
    sec.className = 'st-lsec' + (open ? ' open' : '');
    const h = document.createElement('div');
    h.className = 'st-lsec-h';
    h.innerHTML = `<span class="dot" style="background:${dotColor}"></span>${label}`;
    h.addEventListener('click', onToggle);
    const b = document.createElement('div');
    b.className = 'st-lsec-b';
    fill(b);
    sec.append(h, b);
    return sec;
  }

  function renderLoras() {
    el.lcount.textContent = pins.count() ? `(${pins.count()} on)` : '';
    el.loraui.innerHTML = '';
    const act = [...pins.active], pau = [...pins.suspended];

    // weight warning
    const heavy = [...act].filter(([, v]) => v > 0.8).length;
    const total = act.reduce((a, [, v]) => a + v, 0);
    if (heavy >= 3 || total > 4) {
      const w = document.createElement('div');
      w.className = 'st-lwarn red';
      w.textContent = `heavy stack: ${heavy} strong / total ×${total.toFixed(2)}`;
      el.loraui.appendChild(w);
    } else if (heavy >= 2 || total > 2.5) {
      const w = document.createElement('div');
      w.className = 'st-lwarn amber';
      w.textContent = `getting heavy: ${heavy} strong / total ×${total.toFixed(2)}`;
      el.loraui.appendChild(w);
    }

    // Row weight is hold-and-drag: hold a row ~300ms, then drag ↔.
    const hint = document.createElement('div');
    hint.className = 'st-hintline';
    hint.textContent = 'hold a row, drag ↔ to tune strength';
    el.loraui.appendChild(hint);

    el.loraui.appendChild(loraSection(
      `ACTIVE (${act.length})`, '#7ee0a0', loraUI.openActive,
      () => { loraUI.openActive = !loraUI.openActive; renderLoras(); },
      b => {
        if (!act.length) { b.innerHTML = '<div class="st-hintline" style="padding:8px 12px">nothing pinned — ＋ in the library</div>'; return; }
        for (const [n, v] of act) loraRow(n, v, false, b);
      }));

    el.loraui.appendChild(loraSection(
      `PAUSED (${pau.length})`, '#e0b34d', loraUI.openPaused,
      () => { loraUI.openPaused = !loraUI.openPaused; renderLoras(); },
      b => {
        if (!pau.length) { b.innerHTML = '<div class="st-hintline" style="padding:8px 12px">nothing paused — ⏸ parks a pin</div>'; return; }
        for (const [n, v] of pau) loraRow(n, v, true, b);
      }));

    const q = document.createElement('input');
    q.className = 'st-lq'; q.placeholder = 'search all loras…'; q.value = loraUI.q;
    // 16px keeps iOS from auto-zooming on focus; the attrs keep the
    // keyboard in search mode without autocorrect (usability pass).
    q.setAttribute('inputmode', 'search');
    q.setAttribute('autocomplete', 'off');
    q.setAttribute('autocapitalize', 'off');
    q.addEventListener('input', () => {
      loraUI.q = q.value;
      const pos = q.selectionStart;
      renderLoras();
      // renderLoras rebuilds the tray, including this input — restore
      // focus and caret, or typing stops after one character (studio
      // eval §1).
      const nq = el.loraui.querySelector('.st-lq');
      if (nq) { nq.focus(); try { nq.setSelectionRange(pos, pos); } catch { /* ignore */ } }
    });
    el.loraui.appendChild(q);

    // folder chips: auto (workflow default) + every root present
    const roots = [...new Set(allLoras.map(loraRootOf))];
    const defF = loraDefFolder();
    const chips = document.createElement('div');
    chips.className = 'st-lroots';
    const autoBtn = document.createElement('button');
    autoBtn.textContent = defF ? `auto: ${defF}` : 'all';
    autoBtn.className = loraUI.auto ? 'on' : '';
    autoBtn.title = 'follow the selected workflow';
    autoBtn.addEventListener('click', () => { loraUI.auto = true; loraUI.root = null; loraUI.sub = null; renderLoras(); });
    chips.appendChild(autoBtn);
    for (const r of roots.filter(r => r !== defF)) {
      const b = document.createElement('button');
      const cnt = allLoras.filter(n => loraRootOf(n) === r).length;
      b.textContent = `${r} (${cnt})`;
      b.className = (!loraUI.auto && loraUI.root === r) ? 'on' : '';
      b.addEventListener('click', () => { loraUI.auto = false; loraUI.root = r; loraUI.sub = null; loraUI.openRoot = r; renderLoras(); });
      chips.appendChild(b);
    }
    el.loraui.appendChild(chips);

    // library accordion: folders of the focused root (auto → default folder)
    const focus = loraUI.auto ? defF : loraUI.root;
    const folders = focus ? [focus] : roots;
    for (const f of folders) {
      const inF = allLoras.filter(n => loraRootOf(n) === f &&
        (!loraUI.q || n.toLowerCase().includes(loraUI.q.toLowerCase())));
      const pinsInF = inF.filter(n => pins.active.has(n) || pins.suspended.has(n)).length;
      const sec = document.createElement('div');
      sec.className = 'st-lsec' + (loraUI.openRoot === f ? ' open' : '');
      const h = document.createElement('div');
      h.className = 'st-lsec-h';
      h.innerHTML = `<span class="dot" style="background:#4a4a6c"></span><span class="n">${f}</span>` +
        `<span style="color:#6c6c8e">${inF.length} loras</span>` +
        (pinsInF ? `<span style="margin-left:auto;color:#b39ae0">📌 ${pinsInF}</span>` : '');
      h.addEventListener('click', () => { loraUI.openRoot = loraUI.openRoot === f ? null : f; renderLoras(); });
      sec.appendChild(h);
      const body = document.createElement('div');
      body.className = 'st-lsec-b';
      // sub-chips (second-level folders)
      const subs = [...new Set(inF.map(loraSubOf).filter(Boolean))].sort();
      if (subs.length) {
        const subRow = document.createElement('div');
        subRow.className = 'st-lsubs';
        const all = document.createElement('button');
        all.textContent = `all (${inF.length})`;
        all.className = !loraUI.sub ? 'on' : '';
        all.addEventListener('click', () => { loraUI.sub = null; renderLoras(); });
        subRow.appendChild(all);
        for (const s of subs) {
          const b = document.createElement('button');
          const cnt = inF.filter(n => loraSubOf(n) === s).length;
          b.textContent = `${s} (${cnt})`;
          b.className = loraUI.sub === s ? 'on' : '';
          b.addEventListener('click', () => { loraUI.sub = loraUI.sub === s ? null : s; renderLoras(); });
          subRow.appendChild(b);
        }
        body.appendChild(subRow);
      }
      const list = inF.filter(n => !loraUI.sub || loraSubOf(n) === loraUI.sub);
      for (const n of list.slice(0, 60)) {
        const row = document.createElement('div');
        row.className = 'st-lrow';
        const pinnedA = pins.active.get(n), pinnedS = pins.suspended.has(n);
        const rn = document.createElement('span');
        rn.className = 'rn';
        rn.textContent = (pinnedA !== undefined ? '📌 ' : pinnedS ? '⏸ ' : '') +
          n.replace(/\\/g, '/').split('/').slice(1).join('/') || n;
        rn.title = n;
        row.appendChild(rn);
        if (pinnedA !== undefined || pinnedS) {
          const tag = document.createElement('span');
          tag.className = 'str';
          tag.textContent = '×' + (pinnedA !== undefined ? pinnedA : pins.suspended.get(n)).toFixed(2);
          row.appendChild(tag);
        }
        const btn = document.createElement('button');
        btn.textContent = pinnedA !== undefined || pinnedS ? (pinnedS ? '▶' : '⏸') : '＋';
        btn.title = pinnedA !== undefined ? 'suspend' : pinnedS ? 'restore' : 'pin at 1.0';
        btn.addEventListener('click', () => {
          if (pinnedA !== undefined) pins.suspend(n);
          else if (pinnedS) pins.restore(n);
          else pins.pin(n, 1.0);
          renderLoras();
        });
        row.appendChild(btn);
        wireLoraRowDrag(row, n);
        body.appendChild(row);
      }
      if (list.length > 60) {
        const more = document.createElement('div');
        more.className = 'st-hintline'; more.style.padding = '8px 12px';
        more.textContent = `+${list.length - 60} more — use search or sub-filters`;
        body.appendChild(more);
      }
      if (!list.length) body.innerHTML = '<div class="st-hintline" style="padding:8px 12px">no LoRAs match</div>';
      sec.appendChild(body);
      el.loraui.appendChild(sec);
    }
  }
  // LoRA inspector overlay (2026-11-16): full filenames, full paths and
  // big sliders, for complicated setups — the same bottom-sheet pattern
  // as the candidates overlay. Same pins as the tray; the tray
  // re-renders behind it on every change. Grouped by workflow folder
  // (all roots, default folder first); search narrows the list.
  function renderLoraOverlay() {
    const body = el.loraovbody;
    body.innerHTML = '';
    const q = document.createElement('input');
    q.className = 'st-lq'; q.placeholder = 'search loras…'; q.value = loraUI.ovQ;
    q.setAttribute('inputmode', 'search');
    q.setAttribute('autocomplete', 'off');
    q.setAttribute('autocapitalize', 'off');
    q.addEventListener('input', () => {
      loraUI.ovQ = q.value;
      const pos = q.selectionStart;
      renderLoraOverlay();
      // renderLoraOverlay rebuilds the overlay, including this input —
      // restore focus and caret, or typing stops after one character.
      const nq = el.loraovbody.querySelector('.st-lq');
      if (nq) { nq.focus(); try { nq.setSelectionRange(pos, pos); } catch { /* ignore */ } }
    });
    body.appendChild(q);
    const roots = [...new Set(allLoras.map(loraRootOf))];
    const defF = loraDefFolder();
    roots.sort((a, b) => (a === defF ? -1 : b === defF ? 1 : a.localeCompare(b)));
    const query = (loraUI.ovQ || '').trim().toLowerCase();
    for (const root of roots) {
      const inF = allLoras.filter(n => loraRootOf(n) === root &&
        (!query || n.toLowerCase().includes(query)));
      if (!inF.length) continue;
      const sec = document.createElement('div');
      sec.className = 'st-lovsec';
      sec.textContent = `${root} — ${inF.length} loras`;
      body.appendChild(sec);
      for (const n of inF.slice(0, 100)) {
        const pinnedA = pins.active.has(n), pinnedS = pins.suspended.has(n);
        const val = pinnedA ? pins.active.get(n) : pinnedS ? pins.suspended.get(n) : null;
        const row = document.createElement('div');
        row.className = 'st-lovrow';
        const fn = document.createElement('div');
        fn.className = 'fn';
        fn.textContent = (pinnedA ? '📌 ' : pinnedS ? '⏸ ' : '') +
          n.replace(/\\/g, '/').split('/').pop().replace(/\.safetensors$/i, '');
        row.appendChild(fn);
        const fp = document.createElement('div');
        fp.className = 'fp'; fp.textContent = n;
        row.appendChild(fp);
        const ctl = document.createElement('div');
        ctl.className = 'ctl';
        if (val !== null) {
          const sl = document.createElement('input');
          sl.type = 'range'; sl.className = 'st-lovslider'; sl.min = -1; sl.max = 2; sl.step = 0.05;
          sl.value = val;
          sl.setAttribute('aria-label', `strength for ${fn.textContent}`);
          const tag = document.createElement('span');
          tag.className = 'str'; tag.textContent = '×' + val.toFixed(2);
          // Live-update the value in place while dragging; re-render
          // once on release so the drag isn't destroyed mid-gesture.
          sl.addEventListener('input', () => {
            pins.setStrength(n, +sl.value);
            tag.textContent = '×' + (+sl.value).toFixed(2);
          });
          sl.addEventListener('change', () => { renderLoras(); renderLoraOverlay(); });
          ctl.append(sl, tag);
        }
        const btn = document.createElement('button');
        btn.textContent = pinnedA ? '⏸' : pinnedS ? '▶' : '＋';
        btn.title = pinnedA ? 'suspend' : pinnedS ? 'restore' : 'pin at 1.0';
        btn.addEventListener('click', () => {
          if (pinnedA) pins.suspend(n);
          else if (pinnedS) pins.restore(n);
          else pins.pin(n, 1.0);
          renderLoras(); renderLoraOverlay();
        });
        ctl.appendChild(btn);
        if (val !== null) {
          const del = document.createElement('button');
          del.textContent = '✕'; del.title = 'unpin';
          del.addEventListener('click', () => { pins.remove(n); renderLoras(); renderLoraOverlay(); });
          ctl.appendChild(del);
        }
        row.appendChild(ctl);
        body.appendChild(row);
      }
      if (inF.length > 100) {
        const more = document.createElement('div');
        more.className = 'st-hintline'; more.style.padding = '8px 0';
        more.textContent = `+${inF.length - 100} more — use search`;
        body.appendChild(more);
      }
    }
    if (!body.querySelector('.st-lovrow')) {
      const none = document.createElement('div');
      none.className = 'st-hintline'; none.style.padding = '8px 0';
      none.textContent = 'no LoRAs match';
      body.appendChild(none);
    }
  }

  // workflow switch re-aims the default folder (auto mode follows)
  el.wf.addEventListener('change', () => {
    restoreFamilyState();             // per-family memory instead of hard reset
    if (loraUI.auto) loraUI.openRoot = null;
    renderVariants(); renderLoras();
  });
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
      model: wfModel, edit: wfEdit,
    });
  }
  // A provenance recipe carries the *concrete* workflow id (e.g.
  // klein-4b-edit); the form only offers families. Derive the family +
  // model + mode from the id so ReUse restores the workflow too
  // (studio eval §4). Returns null when the id isn't in the families map.
  function deriveWorkflow(id) {
    for (const [fam, fd] of Object.entries(FAMILY_MODELS)) {
      const models = (fd && fd.models) || {};
      for (const [model, mv] of Object.entries(models)) {
        if (mv && mv.gen === id) return { family: fam, model, edit: false };
        if (mv && mv.edit === id) return { family: fam, model, edit: true };
      }
    }
    return null;
  }
  function applyState(raw) {
    const st = normalizeState(raw);
    if (st.workflow) {
      const dw = deriveWorkflow(st.workflow);
      let matched = false;
      if (dw && [...el.wf.options].some(o => o.value === dw.family)) {
        el.wf.value = dw.family;
        wfModel = dw.model; wfEdit = dw.edit;
        matched = true;
      } else if ([...el.wf.options].some(o => o.value === st.workflow && !o.disabled)) {
        el.wf.value = st.workflow;
        matched = true;
      }
      if (matched) {
        // A saved model/mode (from _last or a preset) wins over the
        // derived default — but only when it names a real model of this
        // family, and edit only when that model has an edit graph
        // (studio wishlist §6a). Without one, the derive/first-model
        // default stands (old states).
        const v = familyVariants();
        if (st.model && v && v[st.model]) {
          wfModel = st.model;
          wfEdit = st.edit === true && !!(v[st.model].edit);
        }
        saveFamilyState(); renderVariants();
      }
    }
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
      if (e.target.closest('.st-verbswitch, [data-id="pips"]')) return;
      // LoRA tray changes belong in _last too (studio eval §6) — but not
      // every slider tick / search keystroke: those save on release.
      if (ev === 'input' && e.target.closest('.st-loraui')) return;
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

  // ── mask: its own generation panel. The mask run is single-shot and
  // lands as a CANDIDATE — never auto-promoted; the user picks the masked
  // result over the source with ⬇. The painted mask stays across runs on
  // the same source and resets only when the source changes (openWorking /
  // showVerb own that). The model picker is driven by the workflow schema,
  // not a preset dropdown: the verb picks the variant (mask-inpaint), the
  // user picks the model.
  //
  // Enabled set — which edit workflows have a Studio mask path. Today that
  // is Klein 4B ONLY: the only masked-inpaint execution in the backend is
  // Update POST /api/update/inpaint-async → comfy_inpaint_klein in
  // backend/comfy.py (Klein-only), and foxden POST /api/foxden/generate
  // (GenerateBody) has NO mask field at all — zero mask references in
  // backend/routers/foxden.py — so Moss edit cannot run a mask through it.
  // Moss is listed disabled until Moss/Krea mask plumbing lands; then this
  // set grows and the picker just works.
  const MASK_EDIT_WORKFLOWS = new Set(['klein-4b', 'klein']);   // klein-4b self-edits via denoise (2026-11-17 swap)
  let maskModel = 'klein-4b';   // selected edit workflow id
  const modelLabel = m => /^[0-9]/.test(m) ? m.toUpperCase() : m[0].toUpperCase() + m.slice(1);
  async function loadMaskModels() {
    let families = null;
    try {
      const s = await fetch('/api/foxden/workflows/schema');
      if (s.ok) families = (await s.json()).families || null;
    } catch { /* fall back to the /config families map below */ }
    if (!families) families = FAMILY_MODELS;
    const sel = el.mmodel;
    sel.innerHTML = '';
    const options = [];
    for (const [fam, fd] of Object.entries(families || {})) {
      for (const [model, v] of Object.entries((fd && fd.models) || {})) {
        if (!v || !v.edit) continue;   // edit-role models only
        options.push({ family: fam, model, edit: v.edit,
          label: `${modelLabel(fam)} ${modelLabel(model)}` });
      }
    }
    // klein workflows self-edit via denoise (2026-11-17 swap) — their family
    // entries have no edit role, so add them explicitly or the picker only
    // offers moss.
    const kleinAdd = [['4b', 'klein-4b', 'Klein 4B'], ['9b', 'klein', 'Klein 9B']];
    for (const [model, id, label] of kleinAdd) {
      if (!options.some(o => o.edit === id))
        options.unshift({ family: 'klein', model, edit: id, label });
    }
    // Both sources failed: Klein 4B is the one mask path that exists.
    if (!options.length) options.push({ family: 'klein', model: '4b', edit: 'klein-4b', label: 'Klein 4B' });
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.edit;
      const enabled = MASK_EDIT_WORKFLOWS.has(o.edit);
      opt.disabled = !enabled;
      opt.textContent = enabled ? o.label : `${o.label} (mask path coming)`;
      sel.appendChild(opt);
    }
    const firstEnabled = options.find(o => MASK_EDIT_WORKFLOWS.has(o.edit));
    maskModel = firstEnabled ? firstEnabled.edit : options[0].edit;
    sel.value = maskModel;
  }
  el.mmodel.addEventListener('change', () => { maskModel = el.mmodel.value; });
  el.mdenoise.addEventListener('input', () => {
    el['mdenoise-val'].textContent = (+el.mdenoise.value).toFixed(2);
  });

  let maskRunning = false;
  async function runMask() {
    if (maskRunning || !stack) { if (!stack) say('no working image — set one first', true); return; }
    const srcEntry = source(stack);
    if (!srcEntry.path) { say('working image has no server path', true); return; }
    if (!MASK_EDIT_WORKFLOWS.has(maskModel)) { say('this model has no mask path yet', true); return; }
    if (!maskCanvas || !maskHasWhite()) { say('paint a region to regenerate first', true); return; }
    const useRandom = el.mrandom.checked;
    const seed = useRandom ? null : (parseInt(el.mseed.value, 10) || 0);
    maskRunning = true;
    el.runbtn.disabled = true;
    busy = true;
    setFabProgress(0.05, '…');
    try {
      const body = { path: srcEntry.path, prompt: el.mprompt.value,
        mask_b64: maskCanvas.toDataURL('image/png'),
        denoise: parseFloat(el.mdenoise.value) || 0.45,
        seed, random: useRandom };
      const r = await fetch('/api/update/inpaint-async', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).detail || r.status));
      const { job_id } = await r.json();
      const data = await pollJob(job_id);
      el.mseed.value = String(data.seed);
      // Candidate flow (mirrors generate()'s completion): the masked result
      // lands as a candidate and is previewed — it never auto-promotes, and
      // the painted mask stays put for the next run on the same source.
      // data.image is a data URL (base64 PNG), not a view URL — it works as
      // an img src for the strip and the canvas. data.render_path is the
      // gallery path, or null when the store failed: the candidate still
      // previews, but ⬇ stays unavailable (see renderCandidates).
      const cand = { url: data.image, path: data.render_path || '', recipe: 'masked-inpaint', masked: true };
      cands.startRun([cand]);
      renderCandidates();
      previewed = cand;
      previewUrl = cand.url;
      // The preview always lands, comparer or not (see the candidate tap).
      compareOn = false; cmpPct = 100;
      el['img-a'].src = previewUrl;
      el['img-a'].addEventListener('load', () => fitFrame(), { once: true });
      syncComparer();
      showToast(`Mask edit complete — seed ${data.seed}`);
      openOverlayInImmersive();
      say(`mask edit done (seed ${data.seed}) — Use as source to advance it to the working image`);
    } catch (err) {
      say('mask run failed: ' + err.message, true);
    }
    maskRunning = false; busy = false;
    el.runbtn.disabled = false;
    setFabProgress(0, null);
  }
  el.madvance.addEventListener('click', () => promoteCandidate(previewed));
  async function pollJob(jobId) {
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > 15 * 60 * 1000) throw new Error('job timed out after 15 minutes');
      await new Promise(res => setTimeout(res, 2000));
      const r = await fetch(`/api/update/jobs/${jobId}`);
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).detail || r.status));
      const job = await r.json();
      if (job.status === 'done') return job.result;
      if (job.status === 'error') throw new Error(job.error || 'job failed');
      el.mstatus.textContent = `ComfyUI ${job.status}…`;
      setFabProgress(Math.min(0.9, (Date.now() - started) / 300000), '⏳');
    }
  }

  // Preview reset: clears a candidate preview off the canvas (openWorking
  // calls it when the working image changes).
  function clearPreview() {
    if (!previewUrl) return;
    previewUrl = null;
    if (stack) { const cur = current(stack); el['img-b'].src = cur.url; el['img-a'].src = compareEntry(stack).url; }
  }

  // ── provenance panel ──
  async function renderProvenance() {
    const st = studioState().get();
    if (!st.path) {
      el.provtable.innerHTML = '<span class="st-hintline">no working image</span>';
      el.parentchain.innerHTML = '<span class="st-hintline">no working image</span>';
      el.historyline.innerHTML = '<span class="st-hintline">no working image</span>';
      return;
    }
    let rec = st.provenance;
    if (!rec || st.dirty.provenance) rec = await studioState().refreshProvenance();
    if (!rec) {
      el.provtable.innerHTML = '<span class="st-hintline">no provenance record (pre-provenance image)</span>';
      el.parentchain.innerHTML = '';
      renderHistoryLine();   // the stack lineage exists without a server record
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
    renderHistoryLine();
  }

  // ── generation history (2026-11-27) ──
  // The stack as an interactive list, oldest first. View jumps to an
  // entry; Make base makes it the next run's source (the view follows —
  // the base is always the viewed entry); Back steps to the previous
  // entry and re-bases to it in one move. Before stays the compare
  // preview (display-only). Provenance below is the read-only record
  // of the same rows.
  // The painted mask belongs to the run source: when the base changes,
  // the old mask is for the wrong image — reset it, mirroring
  // promoteCandidate (which does the same on advance).
  function resetMaskForSourceChange() {
    maskCanvas = null; maskPainted = false; maskUndoStack = [];
    if (verb === 'mask') initMaskForSource();
  }
  // Leaving a preview behind when the history moves the view: saveAs
  // prefers a previewed candidate, so a stale preview would make Save
  // act on the candidate, not the viewed entry.
  function dropPreview() {
    previewed = null;
    clearPreview();
    renderCandidates();
  }
  function renderHistory() {
    const body = el.histbody;
    if (!stack) {
      body.innerHTML = '<span class="st-hintline">no working image</span>';
      el.histback.disabled = true;
      return;
    }
    el.histback.disabled = !canRevert(stack);
    body.innerHTML = '';
    for (const row of lineage(stack)) {
      const e = row.entry;
      const d = document.createElement('div');
      d.className = 'st-histrow' + (row.isCurrent ? ' cur' : '');
      const im = document.createElement('img');
      im.src = e.url; im.alt = e.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'nm'; nm.textContent = e.name;
      const sub = document.createElement('div');
      sub.className = 'sub';
      const parentName = row.parent != null ? stack.entries[row.parent].name : null;
      sub.textContent = `${e.recipe || 'original'}${parentName ? ` · from ${parentName}` : ''}`;
      const marks = document.createElement('div');
      marks.className = 'mark';
      marks.textContent = [row.isCurrent ? 'CURRENT' : '', row.isBase ? 'BASE' : ''].filter(Boolean).join(' · ');
      meta.append(nm, sub, marks);
      const view = document.createElement('button');
      view.textContent = 'View';
      view.title = `View ${e.name}`;
      view.addEventListener('click', () => {
        stack = selectEntry(stack, row.index);
        dropPreview();
        showCurrent();
        renderHistory();
        refreshProvenanceIfOpen();
        say(`viewing ${e.name}`);
      });
      const base = document.createElement('button');
      base.textContent = 'Make base';
      base.title = `Make ${e.name} the next run's source`;
      base.disabled = row.isBase;
      base.addEventListener('click', () => {
        stack = setViewedAsBase(selectEntry(stack, row.index));
        dropPreview();
        showCurrent();
        resetMaskForSourceChange();
        renderHistory();
        refreshProvenanceIfOpen();
        say(`base: ${e.name}`);
      });
      d.append(im, meta, view, base);
      body.appendChild(d);
    }
  }
  function refreshProvenanceIfOpen() {
    if (verb === 'provenance') renderProvenance();
  }
  function stepBackInHistory() {
    if (!stack || !canRevert(stack)) return;
    stack = stepBack(stack);
    dropPreview();
    showCurrent();
    resetMaskForSourceChange();
    renderHistory();
    refreshProvenanceIfOpen();
    say(`back to ${current(stack).name} — base follows`);
  }
  // Provenance record of the same rows (read-only): the History pop-up
  // is the interactive version, this is the record.
  function renderHistoryLine() {
    if (!stack) {
      el.historyline.innerHTML = '<span class="st-hintline">no working image</span>';
      return;
    }
    el.historyline.innerHTML = lineage(stack).map(row => {
      const e = row.entry;
      const parentName = row.parent != null ? stack.entries[row.parent].name : null;
      return `<div class="node${row.isCurrent ? ' cur' : ''}"><div><b>${esc(e.name)}</b>${row.isCurrent ? ' — current' : ''}${row.isBase ? ' · base' : ''}<small>${esc((e.recipe || 'original') + (parentName ? ` · from ${parentName}` : ''))}</small></div></div>`;
    }).join('');
  }

  // ── fullscreen (immersive) mode ──
  function setImmersive(on) {
    root.classList.toggle('st-immersive', on);
    el.imm.textContent = on ? '⧉ Expanded' : '⛶ Fullscreen';
    if (!on) { el.candoverlay.classList.remove('open'); el.loraoverlay.classList.remove('open'); el.historyoverlay.classList.remove('open'); el.promptdrawer.classList.remove('open'); }
    else fitFrame();
  }
  el.imm.addEventListener('click', () => setImmersive(!root.classList.contains('st-immersive')));
  el.edgetab.addEventListener('click', () => setImmersive(false));   // the ONLY way back — always visible
  el.bottomhandle.addEventListener('click', () => el.candoverlay.classList.toggle('open'));
  el.candoverlay.addEventListener('click', e => {
    if (e.target === el.candoverlay) el.candoverlay.classList.remove('open');
  });
  // LoRA inspector overlay: same bottom-sheet open/close as the
  // candidates overlay (button, ✕, backdrop tap).
  el.lorapop.addEventListener('click', () => { renderLoraOverlay(); el.loraoverlay.classList.add('open'); });
  el.loraclose.addEventListener('click', () => el.loraoverlay.classList.remove('open'));
  el.loraoverlay.addEventListener('click', e => {
    if (e.target === el.loraoverlay) el.loraoverlay.classList.remove('open');
  });
  // Generation history overlay (2026-11-27): same bottom-sheet
  // open/close as the LoRA inspector.
  el.history.addEventListener('click', () => { renderHistory(); el.historyoverlay.classList.add('open'); });
  el.histclose.addEventListener('click', () => el.historyoverlay.classList.remove('open'));
  el.historyoverlay.addEventListener('click', e => {
    if (e.target === el.historyoverlay) el.historyoverlay.classList.remove('open');
  });
  el.histback.addEventListener('click', stepBackInHistory);
  // ── clipboard round-trip (2026-11-27) ──
  // Paste: the button reads the clipboard (needs permission + a secure
  // context, so it is usually unavailable over tailnet http); Ctrl/Cmd+V
  // uses the paste event, which needs no clipboard-read permission.
  // The listener is document-level — a paste with focus on the body
  // never reaches the panel — but fires only while Studio is the active
  // tab, and text fields keep their own paste: only an image item is
  // intercepted. The pasted image becomes the working image (not a
  // silent candidate) — that is what "paste it back as an update" means.
  async function pasteFromClipboard() {
    // Guard paste while a render is busy (2026-11-27): a mid-run repaste
    // replaces the stack, and the completion handler then lands its
    // preview on the wrong stack — ⬇ would push the old source's render
    // onto the pasted image's stack.
    if (busy) return;
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      say('clipboard read is unavailable here — paste with Ctrl/Cmd+V instead', true);
      return;
    }
    let items;
    try { items = await navigator.clipboard.read(); }
    catch (err) { say(`clipboard read failed (${err.message}) — paste with Ctrl/Cmd+V instead`, true); return; }
    for (const item of items || []) {
      const type = (item.types || []).find(t => t.indexOf('image/') === 0);
      if (!type) continue;
      try {
        const blob = await item.getType(type);
        const ext = (type.split('/')[1] || 'png').split('+')[0];
        const p = await importImageAsWorking(blob, { name: `pasted-image.${ext}`, origin: 'paste' });
        say(`working image: ${p}`);
      } catch (err) { say(`paste failed: ${err.message}`, true); }
      return;
    }
    say('no image on the clipboard', true);
  }
  el.paste.addEventListener('click', pasteFromClipboard);
  document.addEventListener('paste', async e => {
    if (!panel.classList.contains('active')) return;
    // Same busy guard as the Paste button (2026-11-27) — a mid-run
    // repaste replaces the stack under the completion handler.
    if (busy) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.items].filter(it => it.kind === 'file' && it.type.indexOf('image/') === 0)
      .map(it => it.getAsFile()).filter(Boolean);
    if (!files.length) return; // not an image paste — leave it alone
    e.preventDefault();
    try {
      const p = await importImageAsWorking(files[0], { name: files[0].name || 'pasted-image.png', origin: 'paste' });
      say(`working image: ${p}`);
    } catch (err) { say(`paste failed: ${err.message}`, true); }
  });
  // Copy the working image: clipboard when available, download when
  // not — the message says which path was taken, never silent.
  el.copy.addEventListener('click', async () => {
    const st = studioState().get();
    if (!st.path) { say('no working image to copy', true); return; }
    try {
      const how = await copyImageToClipboard(galleryFileUrl(st.path), st.name || 'image.png');
      if (how === 'clipboard') say('copied to clipboard');
      else say('clipboard unavailable — downloaded the file instead', true);
    } catch (err) { say(`copy failed: ${err.message}`, true); }
  });
  el.genfab.addEventListener('click', () => {
    if (busy) return;
    // The fab runs the ACTIVE tab: Generate generates, Mask runs the
    // mask edit, Provenance has nothing to run — go generate instead.
    if (verb === 'mask') runMask();
    else if (verb === 'generate') generate();
    else { showVerb('generate'); generate(); }
  });
  // Immersive prompt drawer (2026-11-18): the rail (and its prompt
  // fields) is hidden in fullscreen, so a bottom-left pop-out mirrors
  // the ACTIVE verb's prompt — Generate → prompt, Mask → mprompt,
  // Provenance falls back to the Generate prompt. Two-way sync: opening
  // fills from the field, typing in the drawer writes back, and typing
  // in the main field while the drawer is open updates the drawer.
  const activePromptEl = () => (verb === 'mask' ? el.mprompt : el.prompt);
  const syncDrawerFromField = () => { el['promptdrawer-text'].value = activePromptEl().value; };
  const openPromptDrawer = () => { syncDrawerFromField(); el.promptdrawer.classList.add('open'); };
  const closePromptDrawer = () => el.promptdrawer.classList.remove('open');
  el.promptfab.addEventListener('click', () => {
    el.promptdrawer.classList.contains('open') ? closePromptDrawer() : openPromptDrawer();
  });
  el['promptdrawer-close'].addEventListener('click', closePromptDrawer);
  el['promptdrawer-text'].addEventListener('input', () => { activePromptEl().value = el['promptdrawer-text'].value; });
  el.prompt.addEventListener('input', () => { if (el.promptdrawer.classList.contains('open') && verb !== 'mask') syncDrawerFromField(); });
  el.mprompt.addEventListener('input', () => { if (el.promptdrawer.classList.contains('open') && verb === 'mask') syncDrawerFromField(); });
  let toastTimer;
  function showToast(msg) {
    el.toasttext.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }
  // Candidates overlay stays open (2026-11-18): it used to auto-close
  // after 3.5s; now it opens on run completion in immersive mode and
  // stays until the user closes it (handle, backdrop tap, or exit).
  function openOverlayInImmersive() {
    if (!root.classList.contains('st-immersive')) return;
    el.candoverlay.classList.add('open');
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
    loadMaskModels();   // after loadConfig: the /config families map is its fallback
    const last = await loadPresets();
    if (last) applyState(last);
    restored = true;
  })();
  studioState().restore();
  showVerb('generate');
  renderCandidates();
  void revert; void revertToOriginal;   // stack API surface (kept for the version contract; canRevert + stepBack are used by the History pop-up)

  return { showVerb, setBatch, saveAs, setImmersive };
}

registerModule({
  name: 'studio',
  label: 'Studio',
  icon: '🎨',
  order: 0,
  mount: (panel, jobbar) => mountStudio(panel, jobbar),
});
