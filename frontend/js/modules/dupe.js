// Dupe module — system-found near-dupe families (plan §9.1) with the
// STACK-SPREAD family-detail view (2026-10-07y).
//
// Verdicts, never writes: nothing here deletes. "Send rejected → Pending
// Delete" feeds the existing Pending queue; /api/pending/confirm stays the
// only destructive endpoint. Bottom-bar rule: destructive low, navigation top.
//
// STACK-SPREAD layout (touch-first, iPad PWA, no keyboard):
//   status header  — family id, N/M, picked/rejected/unhandled, verdict dots,
//                    DRAFT vs COMMITTED badge
//   fan band       — small overlapping challenger cards; TAP = duel champion
//   champion card  — BIG card, center. TAP = pick (→ strip, ordinal #N).
//                    SWIPE DOWN (or Reject button ≥44pt) = reject → discard
//                    row face-down. LONG-PRESS = menu (Meld / Defer remainder
//                    / Reject remainder / full-size). ⤢ = full-size image.
//   discard row    — face-down rejected cards; TAP = un-reject (reversible)
//   picks strip    — bottom edge, ordered chips with ordinals; drag reorder,
//                    TAP chip = un-pick
//   survey / focus — pinch-out on the fan (or Survey button) → grid; tap a
//                    grid cell → focus deck: one full-size image, swipe
//                    prev/next, tap = pick, verdict dots.
// NOTHING persists before Commit; commit = verdict POST + send-pending.
import { registerModule } from '../shell.js';
import { sigIsOverride, sigChipText } from './dupe-signals.js';
import { zoomMembers, orderBySimilarity, twinInfo, nextUnhandled,
         TWIN_NEAR } from './dupe-view.js';

const api = (p, opts) => fetch(`/api/dupe${p}`, opts).then(r => {
  if (!r.ok) return r.json().then(e => Promise.reject(new Error(e.detail || r.status)));
  return r.json();
});

const fileUrl = (path) => `/api/dupe/file?path=${encodeURIComponent(path)}`;
const thumbUrl = (path) => `/api/dupe/thumb?path=${encodeURIComponent(path)}`;
// Only the server knows which members are jailed/missing (thumb=null there) —
// building thumb URLs client-side produced 400 console noise on bad members.
const setImg = (img, m) => {
  if (m && m.thumb) { img.src = m.thumb; }
  else { img.removeAttribute('src'); img.alt = 'unavailable';
         img.style.background = '#191926'; }
};

registerModule({
  name: 'dupe',
  label: 'Dupe',
  icon: '👯',
  mount(panel, jobbar) {
    panel.innerHTML = `
    <style>
      .dupe-wrap { display:flex; flex-direction:column; height:100%; overflow:hidden; }
      .dupe-top { display:flex; gap:8px; align-items:center; padding:8px 12px;
                  border-bottom:1px solid #2a2a44; flex-wrap:wrap; flex-shrink:0; }
      .dupe-top .status { font-size:11px; color:#8a8aaa; }
      .pill { background:#1d1d33; border:1px solid #2a2a44; color:#8a8aaa;
              padding:4px 12px; border-radius:14px; cursor:pointer; font-size:12px; }
      .pill.active { background:#5b4a8a; border-color:#7a6aaa; color:#fff; }
      .dupe-scroll { flex:1; overflow-y:auto; padding:12px; }
      .fam-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; }
      .fam-card { background:#161628; border:1px solid #2a2a44; border-radius:8px;
                  padding:10px; cursor:pointer; }
      .fam-card:hover { border-color:#4a4a6c; }
      .fam-card.resolved { opacity:0.65; border-color:#3a3a55; }
      .fam-strip { display:flex; gap:4px; margin:6px 0; }
      .fam-strip img { width:25%; height:90px; object-fit:cover; border-radius:4px;
                       background:#0f0f1a; flex:1; min-width:0; }
      .fam-meta { font-size:11px; color:#8a8aaa; display:flex; gap:6px; flex-wrap:wrap; }
      .tier-badge { background:#2a2a44; border-radius:8px; padding:1px 7px; color:#b0b0d0; font-size:10px; }
      .tier-badge.exact, .tier-badge.near-identical { color:#e8c37a; }
      .verdict-tag { border-radius:8px; padding:1px 7px; font-size:10px; }
      .verdict-tag.kept { background:#1d3a25; color:#7de08a; }
      .verdict-tag.rejected { background:#3a1d1d; color:#e87a7a; }
      /* signal-conflict surfacing (2026-10-08d) */
      .sig-flag { background:#3a2d10; border:1px solid #7a5f1e; color:#e8c37a;
                  border-radius:8px; padding:1px 7px; font-size:10px; cursor:help; }
      #ss-signals { margin:6px 12px 0; padding:6px 10px; background:#14142680;
                    border:1px solid #2a2a44; border-radius:8px; font-size:11px;
                    color:#b0b0d0; flex-shrink:0; }
      #ss-signals .sig-line { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
      #ss-signals .sig-conflict { color:#e8c37a; cursor:help; }
      #ss-signals .sig-err { color:#e87a7a; }
      #ss-signals .sig-chip { background:#2a2a44; border-radius:8px; padding:1px 7px;
                              font-size:10px; color:#b0b0d0; max-width:220px;
                              overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #ss-signals .sig-chip.conflict { background:#3a2d10; color:#e8c37a; }
      #ss-suggest { display:flex; gap:8px; align-items:center; flex-wrap:wrap;
                    margin-top:6px; padding-top:6px; border-top:1px solid #2a2a44; }
      #ss-suggest .lbl { color:#7de08a; }
      #ss-suggest .ee-btn { font-size:11px; padding:8px 14px; min-height:40px; }
      .sig-mini { position:absolute; top:2px; left:2px; background:#000000b0;
                  border-radius:6px; padding:0 5px; font-size:9px; color:#b0b0d0; }
      .sig-mini.reject { color:#e87a7a; } .sig-mini.keep { color:#7de08a; }
      .verdict-tag.melded { background:#1d2a3a; color:#7ab8e8; }
      .dupe-more { display:flex; justify-content:center; padding:12px; }
      .fam-card.skel { opacity:0.5; pointer-events:none; }
      .skel .fam-strip img { background:#22223a; }
      .rel-links a { color:#7ab8e8; cursor:pointer; text-decoration:underline; font-size:11px; }

      /* ── STACK-SPREAD detail ─────────────────────────────────────── */
      .dupe-detail { display:none; flex-direction:column; height:100%;
                     min-height:0; overflow:hidden; position:relative; }
      .dupe-detail.open { display:flex; }
      /* '.open' on the family list means HIDDEN — renderDetail adds it so the
         grid stops occupying space above the detail. This rule went missing
         once and iPad Safari showed the list instead of the detail
         (2026-10-07z bugfix). Keep it adjacent to the detail rules. */
      .fam-list.open { display:none; }
      .ss-header { display:flex; gap:10px; align-items:center; flex-wrap:wrap;
                   padding:8px 12px; border-bottom:1px solid #2a2a44; flex-shrink:0;
                   font-size:12px; color:#8a8aaa; }
      .ss-header .fam-id { color:#d4d4e0; }
      .ss-dots { display:flex; gap:3px; align-items:center; flex-wrap:wrap; }
      .ss-dot { width:11px; height:11px; border-radius:50%; background:#33334d;
                border:1px solid #44445f; }
      .ss-dot.pick { background:#2f8a4f; border-color:#4fbf74; }
      .ss-dot.reject { background:#8a2f2f; border-color:#bf4f4f; }
      .ss-dot.meld { background:#2f5a8a; border-color:#4f8abf; }
      .ss-dot.defer { background:#8a7a2f; border-color:#bfa84f; }
      .ss-badge { border-radius:8px; padding:2px 9px; font-size:10px; font-weight:600; }
      .ss-badge.draft { background:#3a2f1d; color:#e8c37a; }
      .ss-badge.committed { background:#1d3a25; color:#7de08a; }
      .ss-fan { flex:0 0 130px; min-height:0; display:flex; gap:6px; padding:8px 12px;
                overflow-x:auto; overflow-y:auto; touch-action:pan-x pan-y; }
      .ss-fan-card { flex:0 0 92px; width:92px; height:112px; background:#161628;
                     border:1px solid #3a3a55; border-radius:8px; overflow:hidden;
                     cursor:pointer; position:relative; }
      .ss-fan-card img { width:100%; height:86px; object-fit:cover; background:#0f0f1a;
                         display:block; pointer-events:none; }
      .ss-fan-card .nm { font-size:9px; color:#8a8aaa; padding:2px 4px;
                         white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ss-fan-card.champion-shadow { display:none; } /* champion never in fan */
      .ss-stage { flex:1; min-height:0; display:flex; align-items:center;
                  justify-content:center; gap:16px; padding:8px 12px; }
      .ss-champ { position:relative; height:100%; max-height:52vh; aspect-ratio:1;
                  max-width:min(52vh, 100%); background:#0f0f1a; border:2px solid #5b4a8a;
                  border-radius:12px; overflow:hidden; touch-action:none;
                  cursor:grab; user-select:none; -webkit-user-select:none; }
      .ss-champ img { width:100%; height:100%; object-fit:contain; display:block;
                      pointer-events:none; }
      .ss-champ .nm { position:absolute; left:0; right:0; bottom:0; font-size:10px;
                      color:#d4d4e0; background:rgba(15,15,26,0.85); padding:4px 8px;
                      pointer-events:none; white-space:nowrap; overflow:hidden;
                      text-overflow:ellipsis; }
      .ss-champ-tools { position:absolute; top:6px; right:6px; display:flex; gap:6px; }
      .ss-tool { min-width:44px; min-height:44px; border-radius:10px; border:1px solid #4a4a6c;
                 background:rgba(29,29,51,0.92); color:#d4d4e0; font-size:18px;
                 cursor:pointer; touch-action:manipulation; }
      .ss-side { display:flex; flex-direction:column; gap:10px; flex-shrink:0; }
      .ss-side .ee-btn { min-height:44px; min-width:44px; }
      .ss-reject { background:#3a1d1d; border-color:#6a2f2f; color:#e87a7a; font-size:15px; }
      .ss-reject:hover:not(:disabled) { background:#5a2a2a; }
      .ss-gesture-hint { font-size:10px; color:#5a5a7a; text-align:center; max-width:150px; }
      .ss-discard { flex:0 0 78px; display:flex; gap:6px; padding:6px 12px;
                    overflow-x:auto; align-items:center; flex-shrink:0;
                    border-top:1px solid #22223a; }
      .ss-discard .lbl { font-size:10px; color:#5a5a7a; flex-shrink:0; }
      .ss-dead { flex:0 0 60px; width:60px; height:60px; border-radius:8px; background:#191926;
                 border:1px solid #4a2f2f; cursor:pointer; position:relative;
                 background-image:repeating-linear-gradient(45deg,transparent,transparent 6px,rgba(138,47,47,0.12) 6px,rgba(138,47,47,0.12) 12px); }
      .ss-dead img { width:100%; height:100%; object-fit:cover; opacity:0.18; filter:grayscale(1); }
      .ss-strip { flex:0 0 84px; display:flex; gap:6px; padding:8px 12px; overflow-x:auto;
                  align-items:center; flex-shrink:0; border-top:1px solid #2a2a44;
                  background:#12121f; touch-action:pan-x; }
      .ss-strip .lbl { font-size:10px; color:#5a5a7a; flex-shrink:0; }
      .ss-pick-chip { flex:0 0 64px; width:64px; height:64px; border-radius:8px; overflow:hidden;
                      position:relative; cursor:grab; border:2px solid #2f8a4f;
                      touch-action:none; background:#0f0f1a; }
      .ss-pick-chip img { width:100%; height:100%; object-fit:cover; pointer-events:none; }
      .ss-pick-chip .ord { position:absolute; top:2px; left:2px; background:#2f8a4f;
                           color:#fff; font-size:10px; font-weight:700; border-radius:6px;
                           padding:0 5px; pointer-events:none; }
      .ss-meld-chip { flex:0 0 auto; height:64px; display:flex; align-items:center; gap:4px;
                      border:2px solid #2f5a8a; border-radius:8px; padding:4px 8px;
                      background:#101a26; cursor:pointer; }
      .ss-meld-chip img { width:48px; height:48px; object-fit:cover; border-radius:4px; }
      .ss-empty-note { font-size:11px; color:#5a5a7a; }
      .ss-bottom { display:flex; gap:8px; padding:8px 12px; border-top:1px solid #2a2a44;
                   background:#12121f; flex-shrink:0; flex-wrap:wrap; align-items:center; }
      .ss-bottom .danger { background:#3a1d1d; border-color:#6a2f2f; color:#e87a7a; }
      .ss-bottom .danger:hover:not(:disabled) { background:#5a2a2a; }
      .dupe-note { flex:1; min-width:160px; background:#0f0f1a; color:#d4d4e0;
                   border:1px solid #2a2a44; border-radius:4px; padding:5px 8px; font-size:12px; }
      .back { margin-right:auto; }
      .ss-menu { position:absolute; z-index:30; background:#1d1d33; border:1px solid #4a4a6c;
                 border-radius:10px; padding:6px; display:flex; flex-direction:column;
                 gap:4px; min-width:230px; box-shadow:0 8px 30px rgba(0,0,0,0.6); }
      .ss-menu .ee-btn { min-height:44px; text-align:left; }
      .ss-overlay { position:absolute; inset:0; z-index:40; background:#0c0c16;
                    display:flex; flex-direction:column; }
      .ss-ov-top { display:flex; gap:8px; align-items:center; padding:8px 12px;
                   border-bottom:1px solid #2a2a44; flex-shrink:0; font-size:12px;
                   color:#8a8aaa; flex-wrap:wrap; }
      .ss-survey-grid { flex:1; overflow:auto; padding:10px; display:grid;
                        grid-template-columns:repeat(auto-fill,minmax(120px,1fr));
                        gap:8px; align-content:start; }
      .ss-cell { background:#161628; border:2px solid #2a2a44; border-radius:8px;
                 overflow:hidden; cursor:pointer; position:relative; }
      .ss-cell.pick { border-color:#2f8a4f; }
      .ss-cell.reject { border-color:#8a2f2f; }
      .ss-cell.meld { border-color:#2f5a8a; }
      .ss-cell.meldsel { border-color:#4f8abf; box-shadow:0 0 0 2px #4f8abf, 0 0 10px rgba(79,138,191,0.6); }
      .ss-cell.meldsel::after { content:'⑂'; position:absolute; top:4px; left:4px;
        background:#2f5a8a; color:#fff; font-size:10px; font-weight:700;
        padding:1px 6px; border-radius:6px; }
      .ss-meld-bar { display:flex; gap:10px; align-items:center; padding:8px 12px;
        border-top:1px solid #2a2a44; background:#1d2438; }
      .ss-meld-bar .ee-btn { min-height:40px; }
      .ss-meld-result { display:flex; flex-direction:column; align-items:center; gap:6px; }
      .ss-meld-result img { max-width:320px; max-height:320px; object-fit:contain;
        border:2px solid #2f5a8a; border-radius:8px; background:#0f0f1a; }
      .ss-meld-result .tag { background:#1d2a3a; color:#7ab8e8; font-size:11px;
        font-weight:700; padding:2px 10px; border-radius:8px; letter-spacing:0.5px; }
      .ss-cell img { width:100%; height:110px; object-fit:cover; background:#0f0f1a; display:block; }
      .ss-cell .nm { font-size:9px; color:#8a8aaa; padding:2px 4px; white-space:nowrap;
                     overflow:hidden; text-overflow:ellipsis; }
      .ss-focus { flex:1; min-height:0; display:flex; align-items:center;
                  justify-content:center; position:relative; touch-action:none; }
      .ss-focus img { max-width:100%; max-height:100%; object-fit:contain; pointer-events:none; }
      .ss-focus .dots { position:absolute; bottom:10px; left:50%; transform:translateX(-50%);
                        display:flex; gap:4px; }
      /* zoom view filter (2026-10-08j re-scope) */
      .zoom-mode-btn.active { background:#5b4a8a; border-color:#7a6aaa; color:#fff; }
      .zoom-empty-hint { color:#8a8aaa; font-size:13px; text-align:center;
                         padding:20px; }
      .ss-focus .dots .ss-dot { width:14px; height:14px; }
      .ss-focus-tools { position:absolute; top:8px; right:8px; display:flex; gap:6px; }
      .ss-nav { position:absolute; top:0; bottom:0; width:64px; display:flex; align-items:center;
                justify-content:center; font-size:26px; color:#8a8aaa; cursor:pointer;
                background:transparent; border:none; min-width:44px; min-height:44px; }
      .ss-nav.prev { left:0; } .ss-nav.next { right:0; }
      .ss-committed { flex:1; display:flex; flex-direction:column; align-items:center;
                      justify-content:center; gap:12px; padding:20px; }
      .ss-committed .big { font-size:16px; color:#7de08a; }
      .ss-committed .sum { font-size:12px; color:#8a8aaa; }
      .dupe-detail .err { color:#e87a7a; }

      /* ── SIFT view (2026-10-08c) — keep-K-of-N inside the family detail.
         Same draft model as the spread; entry/exit from the spread header. */
      .ss-sift-grid { flex:1; overflow:auto; padding:10px; display:grid;
                      grid-template-columns:repeat(auto-fill,minmax(120px,1fr));
                      gap:8px; align-content:start; }
      .ss-sift-grid .ss-cell { min-height:110px; }
      .ss-cell.keep { border-color:#2f8a4f; box-shadow:0 0 0 2px #2f8a4f; }
      .ss-cell .ord-badge { position:absolute; top:4px; left:4px; background:#2f8a4f;
                            color:#fff; font-size:11px; font-weight:700;
                            border-radius:6px; padding:1px 6px; pointer-events:none; }
      .ss-cell .sift-rej { position:absolute; top:2px; right:2px; min-width:44px;
                           min-height:44px; border-radius:8px; border:1px solid #6a2f2f;
                           background:rgba(58,29,29,0.88); color:#e87a7a; font-size:16px;
                           cursor:pointer; touch-action:manipulation; }
      .ss-cell.reject .sift-rej { background:#8a2f2f; color:#fff; }
      .ss-sift-bar { display:flex; gap:8px; align-items:center; padding:8px 12px;
                     border-top:1px solid #2a2a44; background:#12121f; flex-shrink:0;
                     flex-wrap:wrap; }
      .ss-sift-bar .keep-count { font-size:13px; color:#7de08a; font-weight:600; }
      .ss-sift-bar .ee-btn.sweep { background:#3a1d1d; border-color:#6a2f2f; color:#e87a7a;
                                   min-height:44px; }
      .ss-sift-bar .ee-btn.sweep:hover:not(:disabled) { background:#5a2a2a; }
      .ss-sift-bar .note { font-size:10px; color:#5a5a7a; flex:1; min-width:140px; }

      /* twin loop (2026-10-08m): zoom badges — big CURRENT / PINNED #n
         overlays; the stage border goes amber while the pinned twin shows */
      .ss-zoom-badge { position:absolute; top:8px; left:8px; z-index:5;
        background:rgba(15,15,26,0.85); color:#d4d4e0; font-size:12px;
        font-weight:700; letter-spacing:1px; padding:3px 10px;
        border-radius:8px; pointer-events:none; }
      .ss-zoom-badge.pin { background:rgba(58,42,10,0.9); color:#e8a13a;
        border:1px solid #e8a13a; }
      .ss-focus img { pointer-events:auto; }

      /* ── keyboard shortcuts (desktop-only affordance, 2026-10-08b) ──
         Handlers are keydown-only, so touch behavior is untouched; these
         styles merely hide the affordances on coarse/no-hover devices. */
      .kbd-btn { min-width:34px; min-height:34px; padding:0 8px; font-size:12px;
                 flex-shrink:0; }
      .kbd-legend { position:absolute; z-index:60; right:12px; top:46px;
                    background:#1d1d33; border:1px solid #4a4a6c; border-radius:10px;
                    padding:10px 14px; font-size:12px; color:#d4d4e0;
                    display:flex; flex-direction:column; gap:4px;
                    box-shadow:0 8px 30px rgba(0,0,0,0.6); }
      .kbd-legend b { color:#e8c37a; margin-right:8px; font-weight:600; }
      .ss-kbd-pos { font-size:10px; color:#7a7a9a; }
      .ss-cell.kbd-focus { border-color:#d4d4e0; outline:2px solid #d4d4e0; }
      [data-kbd]::after { content:''; }
      @media (hover:hover) and (pointer:fine) {
        [data-kbd]::after { content:' (' attr(data-kbd) ')';
                            color:#8a8aaa; font-size:11px; }
      }
      @media (hover:none), (pointer:coarse) {
        .kbd-btn, .kbd-legend { display:none !important; }
      }
    </style>
    <div class="dupe-wrap">
      <div class="dupe-top">
        <span class="pill" data-f="unresolved">Unresolved</span>
        <span class="pill" data-f="resolved">Resolved</span>
        <span class="pill" data-f="all">All</span>
        <span class="status" id="dupe-status"></span>
      </div>
      <div class="dupe-scroll" id="dupe-scroll">
        <div class="fam-list" id="fam-list"></div>
        <div class="dupe-more" id="dupe-more" style="display:none">
          <button class="ee-btn" id="dupe-loadmore">Load more</button>
        </div>
        <div class="dupe-detail" id="dupe-detail"></div>
      </div>
      <div class="dupe-bottom" id="dupe-bottom" style="display:none">
        <button class="ee-btn back" id="dupe-back">← Back to families</button>
        <input class="dupe-note" id="dupe-note" placeholder="note (optional)">
        <button class="ee-btn danger" id="dupe-commit">Commit family</button>
      </div>
    </div>`;

    const el = {
      pills: [...panel.querySelectorAll('.dupe-top .pill')],
      status: panel.querySelector('#dupe-status'),
      list: panel.querySelector('#fam-list'),
      more: panel.querySelector('#dupe-more'),
      loadmore: panel.querySelector('#dupe-loadmore'),
      detail: panel.querySelector('#dupe-detail'),
      scroll: panel.querySelector('#dupe-scroll'),
      bottom: panel.querySelector('#dupe-bottom'),
      back: panel.querySelector('#dupe-back'),
      note: panel.querySelector('#dupe-note'),
      commit: panel.querySelector('#dupe-commit'),
    };
    let filter = 'unresolved';
    let cursor = '';
    let exhausted = false;
    let current = null;        // detail family (API shape)
    // Render-generation guard: the last render started wins. A stale async
    // renderList resolving AFTER renderDetail must never close the detail
    // (that was the flicker suspect; also guards tab-activated re-fires).
    let viewSeq = 0;
    // Debug trace: set localStorage.eeDupeDebug='1' to log state transitions
    // (browser→detail→browser) into the status row for iPad field diagnosis.
    const dupeDebug = (() => { try { return localStorage.eeDupeDebug === '1'; } catch (_) { return false; } })();
    function trace(msg) {
      if (!dupeDebug) return;
      const st = panel.querySelector('#dupe-status');
      if (st) st.textContent = `[trace] ${msg}`;
      console.log(`[dupe trace] ${msg}`);
    }
    // ── draft state (nothing persists before commit) ──
    // Per-family drafts survive tab switches: switching away no longer
    // wipes an in-progress verdict when a family detail is open.
    const familyDrafts = new Map(); // family_id -> {verdicts, picks, melded}
    let draft = null;          // { verdicts:{path:v}, picks:[path], melded:[a,b]|null }
    let championIdx = 0;       // index into current.members
    let committed = false;
    let commitSummary = null;
    let surveyFocus = 0;       // keyboard-highlighted cell index in survey grid
    // signal-conflict surfacing (2026-10-08d)
    let signals = null;        // /families/{id}/signals payload for current
    let sigSuggestion = null;  // shown suggestion (for once-only override log)
    let sigDismissed = false;  // suggestion dismissed this detail visit
    let meldMode = false;      // survey multi-select for the FaceCycle meld
    let meldSel = new Set();   // member paths chosen as merge candidates
    let sigShownLogged = false;
    // TWIN-CLEARING LOOP (2026-10-08m): twin map for the current family
    // (path -> {twin, kind, dist}), rebuilt per detail render on the
    // similarity-ordered members.
    let twinMap = new Map();
    // families deferred this session — skipped by Commit & next (step 4)
    const deferredFamilies = new Set();

    function job(text, cls = '') {
      jobbar.querySelectorAll('.badge.dupe').forEach(b => b.remove());
      if (text) {
        const b = document.createElement('span');
        b.className = `badge dupe ${cls}`;
        b.textContent = text;
        jobbar.appendChild(b);
      }
    }

    // ─────────────────────────────── family browser (unchanged, praised) ──
    el.pills.forEach(p => p.addEventListener('click', () => {
      filter = p.dataset.f;
      renderList();
    }));
    el.loadmore.addEventListener('click', () => renderList(cursor));

    function skeletons(n = 6) {
      const grid = document.createElement('div');
      grid.className = 'fam-grid';
      for (let i = 0; i < n; i++) {
        const card = document.createElement('div');
        card.className = 'fam-card skel';
        const strip = document.createElement('div');
        strip.className = 'fam-strip';
        for (let j = 0; j < 4; j++) strip.appendChild(document.createElement('img'));
        const meta = document.createElement('div');
        meta.className = 'fam-meta';
        meta.innerHTML = '<span>…</span><span>loading</span>';
        card.append(strip, meta);
        grid.appendChild(card);
      }
      return grid;
    }

    async function renderStatus() {
      try {
        const s = await api('/status');
        if (!s.indexed) {
          el.status.textContent = `no index at ${s.root} — ${s.detail}`;
          return;
        }
        el.status.textContent =
          `${s.families} families · ${s.members} members · ` +
          `${s.unresolved} unresolved · index ${s.index_generated} · ${s.freshness}`;
      } catch (e) { el.status.textContent = `status failed: ${e.message}`; }
    }

    function cardFor(f) {
      const card = document.createElement('div');
      card.className = `fam-card ${f.state === 'resolved' ? 'resolved' : ''}`;
      const strip = document.createElement('div');
      strip.className = 'fam-strip';
      for (const m of (f.members || [])) {
        if (m.thumb) {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = m.thumb;
          strip.appendChild(img);
        }
      }
      const meta = document.createElement('div');
      meta.className = 'fam-meta';
      meta.innerHTML =
        `<span>${f.id}</span><span>${f.size} members</span>` +
        (f.tiers || []).map(t => `<span class="tier-badge ${t}">${t}</span>`).join('') +
        (f.conflict ? '<span class="sig-flag" title="signal conflict — prior verdict splits members the hashes call near-identical">⚡</span>' : '') +
        (f.state === 'resolved' ? '<span class="verdict-tag kept">resolved</span>' : '');
      card.append(strip, meta);
      card.addEventListener('click', () => renderDetail(f.id));
      return card;
    }

    async function renderList(nextCursor = '') {
      const seq = ++viewSeq;
      trace(`renderList(seq=${seq})`);
      el.pills.forEach(p => p.classList.toggle('active', p.dataset.f === filter));
      el.detail.classList.remove('open');
      el.list.classList.remove('open');
      el.bottom.style.display = 'none';
      current = null;
      const firstPage = !nextCursor;
      if (firstPage) {
        cursor = '';
        exhausted = false;
        el.list.innerHTML = '';
        el.list.appendChild(skeletons());
      }
      // list mode shows the grid; '.open' hides it via the .fam-list.open rule
      el.list.classList.remove('open');
      el.more.style.display = 'none';
      job(firstPage ? 'loading families…' : 'loading more…');
      try {
        const data = await api(`/families?state=${filter}&cursor=${encodeURIComponent(nextCursor)}`);
        if (seq !== viewSeq) { trace(`renderList(${seq}) stale — a newer render won`); return; }
        el.pills[0].textContent = `Unresolved (${data.counts.unresolved})`;
        el.pills[1].textContent = `Resolved (${data.counts.resolved})`;
        el.pills[2].textContent = `All (${data.total})`;
        let grid = el.list.querySelector('.fam-grid');
        if (firstPage || !grid) {
          el.list.innerHTML = '';
          grid = document.createElement('div');
          grid.className = 'fam-grid';
          el.list.appendChild(grid);
        }
        for (const f of data.items) {
          try {
            grid.appendChild(cardFor(f));
          } catch (cardErr) {
            const ec = document.createElement('div');
            ec.className = 'fam-card';
            ec.style.color = '#e87a7a';
            ec.textContent = `card error (${f.id}): ${cardErr.message}`;
            grid.appendChild(ec);
            console.error('dupe card render failed', f.id, cardErr);
          }
        }
        cursor = data.next_cursor || '';
        exhausted = !data.next_cursor;
        el.more.style.display = exhausted ? 'none' : 'flex';
        job('');
      } catch (e) { job(`dupe: ${e.message}`, 'err'); }
    }

    // ───────────────────────────────────────── STACK-SPREAD detail view ──
    const DRAFT_CLASSES = { kept: 'pick', pick: 'pick', rejected: 'reject', melded: 'meld', deferred: 'defer' };

    function verdictOf(m) { return draft.verdicts[m.path] || null; }

    function unhandled() {
      return current.members.filter(m => !verdictOf(m));
    }
    function picks() { return draft.picks.map(p => current.members.find(m => m.path === p)).filter(Boolean); }
    function rejectedMembers() { return current.members.filter(m => verdictOf(m) === 'rejected'); }

    function championMember() {
      const m = current.members[championIdx];
      if (m && !verdictOf(m)) return m;
      // champion handled → promote next unhandled; fall back to first member
      const u = unhandled();
      return u[0] || m || current.members[0];
    }
    function fanMembers() {
      const champ = championMember();
      return current.members.filter(m => m !== champ && !verdictOf(m));
    }

    // ── Keyboard shortcuts (2026-10-08b, desktop-only) ─────────────────
    // keydown only → touch/iPad behavior is untouched. Level dispatch:
    // zoom → survey → spread. Esc always steps back one level
    // (zoom → survey → spread → families), matching the on-screen backs.
    function kbdLegendBtn(items) {
      const wrap = document.createElement('span');
      wrap.style.cssText = 'position:relative;display:inline-flex;';
      const btn = document.createElement('button');
      btn.className = 'ee-btn kbd-btn';
      btn.textContent = '⌨?';
      btn.title = 'keyboard shortcuts (desktop only)';
      const box = document.createElement('div');
      box.className = 'kbd-legend';
      box.style.display = 'none';
      box.innerHTML = items.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('');
      btn.addEventListener('click', () => {
        box.style.display = box.style.display === 'none' ? 'flex' : 'none';
      });
      wrap.append(btn, box);
      return wrap;
    }

    function kbCycle(dir) {
      const cands = current.members.map((m, i) => ({ m, i }))
        .filter(x => !verdictOf(x.m));
      if (!cands.length) return;
      let pos = cands.findIndex(x => x.i === championIdx);
      if (pos < 0) pos = 0;
      pos = (pos + dir + cands.length) % cands.length;
      championIdx = cands[pos].i;
      renderSpread();
    }

    function paintSurveyFocus() {
      const cells = el.detail.querySelectorAll('#ss-survey .ss-cell');
      cells.forEach((c, i) => c.classList.toggle('kbd-focus', i === surveyFocus));
      cells[surveyFocus]?.scrollIntoView({ block: 'nearest' });
    }

    function surveyStep(key) {
      const cells = [...el.detail.querySelectorAll('#ss-survey .ss-cell')];
      if (!cells.length) return;
      // column count = cells sharing row 0's offsetTop
      const top0 = cells[0].offsetTop;
      const cols = Math.max(1, cells.filter(c => c.offsetTop === top0).length);
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
      surveyFocus = Math.max(0, Math.min(cells.length - 1, surveyFocus + (moves[key] || 0)));
      paintSurveyFocus();
    }

    function stepBackLevel() {
      const sift = el.detail.querySelector('#ss-sift');
      if (sift) { closeSift(); renderSpread(); return; }
      const zoom = el.detail.querySelector('#ss-zoom');
      if (zoom) { zoom.querySelector('#ss-zoom-back')?.click(); return; }
      const survey = el.detail.querySelector('#ss-survey');
      if (survey) {
        [...survey.querySelectorAll('.ss-ov-top .ee-btn')]
          .find(b => b.textContent.includes('Back to stack'))?.click();
        return;
      }
      if (el.detail.classList.contains('open')) el.back.click();
    }

    function onDupeKey(e) {
      if (!panel.classList.contains('active')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
                t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!current || !el.detail.classList.contains('open')) return;
      try {
        const k = e.key;
        if (k === 'Escape') { stepBackLevel(); e.preventDefault(); return; }
        const sift = el.detail.querySelector('#ss-sift');
        if (sift) {                       // SIFT level: grid nav + keep/reject
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
            siftStep(k); e.preventDefault(); return;
          }
          if (k === 'Enter' || k === 'p' || k === 'P') {
            siftToggleFocused(); e.preventDefault(); return;
          }
          if (k === 'f' || k === 'F') {
            siftRejectFocused(); e.preventDefault(); return;
          }
          return;
        }
        const zoom = el.detail.querySelector('#ss-zoom');
        if (zoom) {                       // ZOOM level
          if (k === 'ArrowLeft') zoom.querySelector('.ss-nav.prev').click();
          else if (k === 'ArrowRight') zoom.querySelector('.ss-nav.next').click();
          else if (k === 'a' || k === 'A') zoom.querySelector('#ss-zoom-pick')?.click();
          else if (k === 'f' || k === 'F') zoom.querySelector('#ss-zoom-reject')?.click();
          else if (k === 't' || k === 'T') zoom.querySelector('#ss-zoom-twin')?.click();
          else if (k === 'p' || k === 'P') zoom.querySelector('#ss-zoom-pin')?.click();
          else if (k === ' ') zoom.querySelector('#ss-zoom-flip')?.click();
          else return;
          e.preventDefault(); return;
        }
        const survey = el.detail.querySelector('#ss-survey');
        if (survey) {                     // SURVEY level: arrows + Enter only
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
            surveyStep(k); e.preventDefault(); return;
          }
          if (k === 'Enter' || k === ' ') {
            openZoom(surveyFocus, 'survey'); e.preventDefault(); return;
          }
          return;
        }
        if (committed) return;            // SPREAD level
        if (k === 'ArrowLeft') kbCycle(-1);
        else if (k === 'ArrowRight') kbCycle(1);
        else if (k === 'a' || k === 'A') { const ch = championMember(); if (!verdictOf(ch)) doPick(ch); }
        else if (k === 'f' || k === 'F') { const ch = championMember(); if (!verdictOf(ch)) doReject(ch); }
        else return;
        e.preventDefault();
      } catch (err) {
        // same visibility contract as render errors: chip it, never swallow
        job(`kbd: ${err.message}`, 'err');
        console.error('dupe keyboard handler failed', err);
      }
    }
    document.addEventListener('keydown', onDupeKey);

    function openMenu(anchorX, anchorY) {
      closeMenu();
      const menu = document.createElement('div');
      menu.className = 'ss-menu';
      menu.id = 'ss-menu';
      const mk = (label, fn, disabled) => {
        const b = document.createElement('button');
        b.className = 'ee-btn';
        b.textContent = label;
        if (disabled) b.disabled = true;
        b.addEventListener('click', () => { closeMenu(); fn(); });
        return b;
      };
      const picksN = draft.picks.length;
      menu.append(
        mk(picksN === 2 ? 'Meld the 2 picks (blend entry)'
                         : `Meld (needs exactly 2 picks — have ${picksN})`,
           doMeld, picksN !== 2),
        mk('Defer family (mark unhandled → deferred)', doDeferFamily, false),
        mk('Reject family remainder', doRejectRemainder, false),
        mk('Cancel', () => {}, false),
      );
      el.detail.appendChild(menu);
      const mw = 240, mh = 220;
      menu.style.left = Math.max(4, Math.min(anchorX - mw / 2, el.detail.clientWidth - mw - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(anchorY - 10, el.detail.clientHeight - mh - 4)) + 'px';
      setTimeout(() => document.addEventListener('pointerdown', menuOutside), 0);
    }
    function menuOutside(e) { if (!e.target.closest('#ss-menu')) closeMenu(); }
    function closeMenu() {
      el.detail.querySelector('#ss-menu')?.remove();
      document.removeEventListener('pointerdown', menuOutside);
    }

    function doMeld() {
      if (draft.picks.length !== 2) return;
      draft.melded = [...draft.picks];
      draft.melded.forEach(p => { draft.verdicts[p] = 'melded'; });
      draft.picks = [];
      renderSpread();
    }
    function doDeferFamily() {
      for (const m of unhandled()) draft.verdicts[m.path] = 'deferred';
      draft.picks = [];
      renderSpread();
    }
    function doRejectRemainder() {
      for (const m of unhandled()) draft.verdicts[m.path] = 'rejected';
      draft.picks = [];
      renderSpread();
    }

    function doPick(m) {
      if (verdictOf(m)) return;
      sigLogOverride(m.path, 'kept');
      draft.verdicts[m.path] = 'kept';
      draft.picks.push(m.path);
      renderSpread();
    }
    function unPick(m) {
      delete draft.verdicts[m.path];
      draft.picks = draft.picks.filter(p => p !== m.path);
      renderSpread();
    }
    function doReject(m) {
      if (verdictOf(m)) return;
      sigLogOverride(m.path, 'rejected');
      draft.verdicts[m.path] = 'rejected';
      renderSpread();
    }
    function unReject(m) {
      delete draft.verdicts[m.path];
      renderSpread();
    }
    function duel(m) {
      const i = current.members.indexOf(m);
      if (i >= 0) { championIdx = i; renderSpread(); }
    }

    // ── SIGNAL-CONFLICT SURFACING (2026-10-08d) ────────────────────────
    // Two curation signals: dupelib hash tiers + prior verdict history.
    // Duel history is honestly unavailable (no .duel-curator state on this
    // host, not path-addressable) — the chips show verdict history only.
    // Disagreement is information, never an action: Apply fills the DRAFT.
    function sigEvent(event, detail) {
      if (!current) return Promise.resolve();
      return api('/signals/event', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ family: current.id, event, detail }),
      }).catch(e => trace(`sigEvent(${event}) failed: ${e.message}`));
    }

    async function loadSignals(fid) {
      signals = null; sigSuggestion = null; sigDismissed = false; sigShownLogged = false;
      try {
        const sig = await api(`/families/${fid}/signals`);
        if (!current || current.id !== fid) { trace('signals stale — dropped'); return; }
        signals = sig;
        trace(`signals: conflicts=${sig.conflicts.length} suggestion=${!!sig.suggestion}`);
        renderSignalsBar();
      } catch (e) {
        // error-chip instrumentation: never break the detail view
        trace(`signals failed: ${e.message}`);
        console.error('[dupe signals]', e.message);
        const bar = el.detail.querySelector('#ss-signals');
        if (bar) bar.innerHTML = `<div class="sig-err">signals unavailable: ${e.message}</div>`;
      }
    }

    function ensureSignalsBar() {
      let bar = el.detail.querySelector('#ss-signals');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ss-signals';
        el.detail.insertBefore(bar, el.detail.firstChild);
      }
      return bar;
    }

    function renderSignalsBar() {
      // History chips + conflict lines render in committed mode too — a
      // resolved family being revisited is exactly where prior disagreements
      // matter. Only the Apply suggestion stays gated to uncommitted detail.
      if (!signals) return;
      const bar = ensureSignalsBar();
      bar.innerHTML = '';
      const line = document.createElement('div');
      line.className = 'sig-line';
      // per-member history chips (verdict history; duels unavailable)
      for (const m of current.members) {
        const h = signals.members[m.path];
        const t = sigChipText(h);
        if (!t) continue;
        const chip = document.createElement('span');
        chip.className = 'sig-chip' + (signals.conflict_members.includes(m.path) ? ' conflict' : '');
        chip.textContent = `${m.name}: ${t}`;
        chip.title = t === 'kept ×1' || t.startsWith('kept ×')
          ? 'prior verdict history — kept entries' : 'prior verdict history';
        line.appendChild(chip);
      }
      // explicit disagreement lines
      for (const c of signals.conflicts) {
        const d = document.createElement('span');
        d.className = 'sig-conflict';
        d.textContent = `⚡ ${c.detail}`;
        d.title = 'signals disagree — your verdicts vs the hash tiers. No auto-verdicts.';
        line.appendChild(d);
      }
      if (!line.children.length) {
        const n = document.createElement('span');
        n.textContent = 'no prior verdict history for this family';
        line.appendChild(n);
      }
      bar.appendChild(line);
      // suggestion — only on strong agreement, dismissible, never silent
      if (signals.suggestion && !sigDismissed && !committed) {
        const s = signals.suggestion;
        if (!sigShownLogged) { sigShownLogged = true; sigEvent('shown', s.label); }
        sigSuggestion = s;
        const row = document.createElement('div');
        row.id = 'ss-suggest';
        const lbl = document.createElement('span');
        lbl.className = 'lbl';
        lbl.textContent = `Signals suggest: keep ${Path_name(s.keep)}, reject rest`;
        const apply = document.createElement('button');
        apply.className = 'ee-btn primary';
        apply.id = 'ss-suggest-apply';
        apply.textContent = 'Apply suggestion';
        apply.title = 'fills the DRAFT — nothing persists until Commit';
        apply.addEventListener('click', () => {
          for (const p of s.reject) draft.verdicts[p] = 'rejected';
          if (!draft.picks.includes(s.keep)) draft.picks.push(s.keep);
          draft.verdicts[s.keep] = 'kept';
          sigEvent('applied', s.label);
          sigDismissed = true;   // consumed — re-renders must not resurrect it
          renderSpread();
          job('suggestion applied to draft — commit when ready');
        });
        const dis = document.createElement('button');
        dis.className = 'ee-btn';
        dis.id = 'ss-suggest-dismiss';
        dis.textContent = '✕ Dismiss';
        dis.title = 'dismiss — logged as calibration data';
        dis.addEventListener('click', () => {
          sigDismissed = true;
          sigEvent('dismissed', s.label);
          row.remove();
        });
        row.append(lbl, apply, dis);
        bar.appendChild(row);
      }
    }

    function Path_name(p) { return (p || '').split('/').pop(); }

    function sigLogOverride(path, verdict) {
      if (!sigSuggestion || !sigIsOverride(sigSuggestion, path, verdict)) return;
      sigEvent('override', `manual ${verdict} on ${path} vs suggestion: ${sigSuggestion.label}`);
      sigSuggestion = null;   // once per suggestion
    }

    // ── UNIFIED ZOOM (2026-10-08a) — one surface, entered from spread
    // (champion ⤢), survey (cell tap). Full-size /api/dupe/file image,
    // prev/next cycling across ALL family members (‹ › buttons + swipe),
    // position label, pick/reject in place. Exit: '‹ back to <parent>'
    // restores the origin (spread or survey) with draft intact; swipe-down
    // or tap on the top bar also dismisses. Each level has exactly one exit
    // to its parent: families ← spread ← survey ← zoom.
    //
    // ZOOM VIEW FILTER (2026-10-08j re-scope): a segmented All | Accepted |
    // Rejected control in the zoom chrome limits which members the cycle
    // visits — accepted = kept/melded, rejected = rejected (dupe-view.js).
    // Filtering only changes the visited set: never verdicts, ledger, or
    // the detail layout. Arrow/swipe cycling inherits the existing bindings
    // and works within the filtered set; label reads 'Accepted 3/7'. An
    // empty filtered set shows an inline hint, never a blank frame.
    const ZOOM_MODES = ['all', 'accepted', 'rejected'];
    function openZoom(startIdx, origin, startMode = 'all') {
      let zoomMode = ZOOM_MODES.includes(startMode) ? startMode : 'all';
      let list = zoomMembers(current.members, draft ? draft.verdicts : {}, zoomMode);
      let idx = Math.max(0, Math.min(startIdx, list.length - 1));
      trace(`zoom open idx=${idx + 1}/${list.length} mode=${zoomMode} origin=${origin}`);
      const ov = document.createElement('div');
      ov.className = 'ss-overlay';
      ov.id = 'ss-zoom';
      const top = document.createElement('div');
      top.className = 'ss-ov-top';
      const info = document.createElement('span');
      info.id = 'ss-zoom-pos';
      // Twin chip (2026-10-08m): '≈ exact · #5' — kind + the twin's 1-based
      // position in the visited order. Click (or T) jumps to the twin.
      const twinChip = document.createElement('button');
      twinChip.className = 'ee-btn ss-zoom-twin';
      twinChip.id = 'ss-zoom-twin';
      twinChip.style.minHeight = '32px';
      twinChip.title = 'jump to the twin (T)';
      twinChip.addEventListener('click', () => jumpTwin());
      // Auto-advance (2026-10-08m step 2): after A/F assigns a verdict,
      // jump to the next unhandled member of the visited set. Default ON,
      // toggled via localStorage.eeAutoAdvance ('0' = off — the probe
      // sets this before its legacy zoom_pick step).
      const autoAdvanceOn = () => {
        try { return localStorage.eeAutoAdvance !== '0'; } catch (_) { return true; }
      };
      const autoBtn = document.createElement('button');
      autoBtn.className = 'ee-btn';
      autoBtn.id = 'ss-zoom-auto';
      autoBtn.style.minHeight = '32px';
      autoBtn.title = 'after A/F, jump to the next unhandled member';
      autoBtn.addEventListener('click', () => {
        const on = autoAdvanceOn();
        try { localStorage.eeAutoAdvance = on ? '0' : '1'; } catch (_) {}
        paint();
      });
      // PIN indicator (top bar): 'PIN: none' | 'PIN: #2' — text only;
      // pinning itself lives on the stage Pin button (P key).
      const pinInfo = document.createElement('span');
      pinInfo.id = 'ss-zoom-pin-info';
      pinInfo.textContent = 'PIN: none';
      const back = document.createElement('button');
      back.className = 'ee-btn';
      back.id = 'ss-zoom-back';
      back.style.minHeight = '44px';
      back.textContent = origin === 'survey' ? '‹ back to survey' : '‹ back to spread';
      back.dataset.kbd = 'Esc';
      const dismiss = () => {
        trace(`zoom close → ${origin} (draft intact)`);
        ov.remove();
        if (origin === 'survey') openSurvey(); else renderSpread();
      };
      back.addEventListener('click', dismiss);
      // tap on the top bar (outside buttons) = dismiss; swipe-down likewise.
      top.addEventListener('click', e => { if (!e.target.closest('button')) dismiss(); });
      const stage = document.createElement('div');
      stage.className = 'ss-focus';
      // bottom line: unhandled counter ('3 of 7 unhandled' → 'all handled')
      const count = document.createElement('div');
      count.id = 'ss-zoom-count';
      count.style.cssText = 'text-align:center;padding:6px 0 10px;font-size:12px;color:#8a8aaa;flex-shrink:0;';
      const dots = document.createElement('div');
      dots.className = 'dots';
      // ── PIN + FLICKER-FREE FLIP (2026-10-08m step 3) ── two stacked
      // <img> elements: pinned + current. Flip swaps VISIBILITY only —
      // no src writes, so flipping costs zero network and never flickers.
      let pinned = null;      // member | null
      let pinnedIdx = -1;     // index of the pinned member in the visited set
      let showingPinned = false;
      const pinImg = document.createElement('img');
      pinImg.alt = 'pinned';
      pinImg.style.cssText = 'position:absolute;inset:0;max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;display:none;';
      const curBadge = document.createElement('div');
      curBadge.className = 'ss-zoom-badge';
      curBadge.textContent = 'CURRENT';
      const pinBadge = document.createElement('div');
      pinBadge.className = 'ss-zoom-badge pin';
      pinBadge.style.display = 'none';
      const flip = () => {
        if (!pinned) return;
        showingPinned = !showingPinned;
        trace(`zoom flip → ${showingPinned ? 'pinned' : 'current'}`);
        paint();   // visibility only — no src swap, zero network
      };
      const togglePin = () => {
        if (pinned) { pinned = null; pinnedIdx = -1; showingPinned = false; }
        else { pinned = list[idx]; pinnedIdx = idx; }
        trace(`zoom pin → ${pinned ? `#${pinnedIdx + 1}` : 'none'}`);
        paint();
      };
      const pinBtn = document.createElement('button');
      pinBtn.className = 'ee-btn';
      pinBtn.style.minHeight = '44px';
      pinBtn.id = 'ss-zoom-pin';
      pinBtn.dataset.kbd = 'P';
      pinBtn.addEventListener('click', togglePin);
      // hidden flip action — Space (keyboard) and stage taps both land here
      const flipBtn = document.createElement('button');
      flipBtn.id = 'ss-zoom-flip';
      flipBtn.style.display = 'none';
      flipBtn.addEventListener('click', flip);
      const img = document.createElement('img');
      img.alt = 'zoom';
      const prev = document.createElement('button');
      prev.className = 'ss-nav prev'; prev.textContent = '‹';
      const next = document.createElement('button');
      next.className = 'ss-nav next'; next.textContent = '›';
      const tools = document.createElement('div');
      tools.className = 'ss-focus-tools';
      const pickBtn = document.createElement('button');
      pickBtn.className = 'ee-btn';
      pickBtn.style.minHeight = '44px';
      pickBtn.id = 'ss-zoom-pick';
      pickBtn.dataset.kbd = 'A';
      const rejBtn = document.createElement('button');
      rejBtn.className = 'ee-btn ss-reject';
      rejBtn.style.minHeight = '44px';
      rejBtn.id = 'ss-zoom-reject';
      rejBtn.dataset.kbd = 'F';
      const paint = () => {
        if (!list.length) {
          // Empty state: plain inline hint in the stage, never a blank frame.
          img.removeAttribute('src');
          info.textContent = zoomMode === 'accepted' ? 'Accepted 0/0'
                           : zoomMode === 'rejected' ? 'Rejected 0/0' : '0/0';
          const hint = stage.querySelector('.zoom-empty-hint') ||
            Object.assign(document.createElement('div'),
                          { className: 'zoom-empty-hint' });
          hint.dataset.empty = zoomMode;
          hint.textContent = zoomMode === 'accepted'
            ? 'No accepted members in this family yet.'
            : zoomMode === 'rejected'
              ? 'No rejected members in this family yet.'
              : 'No members in this family.';
          if (!hint.isConnected) stage.insertBefore(hint, prev);
          pickBtn.disabled = rejBtn.disabled = true;
          dots.innerHTML = '';
          autoBtn.textContent = `Auto-advance: ${autoAdvanceOn() ? 'On' : 'Off'}`;
          count.textContent = '0 of 0 unhandled';
          count.style.color = '#7de08a';
          twinChip.style.display = 'none';
          pinInfo.textContent = `PIN: ${pinned ? '#' + (pinnedIdx + 1) : 'none'}`;
          pinBtn.textContent = pinned ? `📌 Unpin (#${pinnedIdx + 1})` : '📌 Pin';
          pinImg.style.display = 'none';
          img.style.visibility = 'visible';
          curBadge.style.display = 'none';
          pinBadge.style.display = 'none';
          return;
        }
        stage.querySelector('.zoom-empty-hint')?.remove();
        pickBtn.disabled = rejBtn.disabled = false;
        const m = list[idx];
        // stacked flip: both <img> keep their src; only visibility changes
        if (pinned) pinImg.src = fileUrl(pinned.path);
        pinImg.style.display = showingPinned && pinned ? 'block' : 'none';
        img.style.visibility = showingPinned && pinned ? 'hidden' : 'visible';
        if (!showingPinned || !pinned) img.src = fileUrl(m.path);
        stage.style.border = showingPinned && pinned ? '2px solid #e8a13a' : '';
        curBadge.style.display = showingPinned && pinned ? 'none' : '';
        pinBadge.style.display = showingPinned && pinned ? '' : 'none';
        pinBadge.textContent = `PINNED #${pinnedIdx + 1}`;
        pinBtn.textContent = pinned ? `📌 Unpin (#${pinnedIdx + 1})` : '📌 Pin';
        pinInfo.textContent = `PIN: ${pinned ? '#' + (pinnedIdx + 1) : 'none'}`;
        // prefetch neighbors + pinned: warm the cache, no layout cost
        for (const ni of [idx - 1, idx + 1]) {
          const nm = list[(ni + list.length) % list.length];
          if (nm) {
            const im = new Image();
            im.src = fileUrl(nm.path);
            if (im.decode) im.decode().catch(() => {});
          }
        }
        if (pinned && !showingPinned) {
          const im = new Image();
          im.src = fileUrl(pinned.path);
          if (im.decode) im.decode().catch(() => {});
        }
        const modeLbl = zoomMode === 'all' ? 'All'
                      : zoomMode === 'accepted' ? 'Accepted' : 'Rejected';
        info.textContent = `${modeLbl} ${idx + 1} / ${list.length} · ${m.name}`;
        // twin chip: kind + the twin's 1-based position in this visited set
        const tw = twinMap.get(m.path);
        const twIdx = tw ? list.findIndex(x => x.path === tw.twin) : -1;
        if (tw && twIdx >= 0) {
          twinChip.style.display = '';
          twinChip.textContent = `≈ ${tw.kind} · #${twIdx + 1}`;
          twinChip.title = `twin: ${list[twIdx].name} (${tw.kind}, d=${tw.dist}) — jump (T)`;
        } else {
          twinChip.style.display = 'none';
        }
        // auto-advance toggle label + bottom unhandled counter
        autoBtn.textContent = `Auto-advance: ${autoAdvanceOn() ? 'On' : 'Off'}`;
        const un = list.filter(mm => !verdictOf(mm)).length;
        count.textContent = un ? `${un} of ${list.length} unhandled`
                               : 'all handled';
        count.style.color = un ? '#8a8aaa' : '#7de08a';        const v = verdictOf(m);
        pickBtn.textContent = v === 'kept' ? `Un-pick ✓ (#${draft.picks.indexOf(m.path) + 1})`
                            : v ? `verdict: ${v}` : '✓ Pick';
        pickBtn.disabled = !!v && v !== 'kept';
        rejBtn.textContent = v === 'rejected' ? 'Un-reject' : '✕ Reject';
        rejBtn.disabled = !!v && v !== 'rejected';
        pickBtn.onclick = () => {
          const fresh = !v;
          if (v === 'kept') { unPickNoRender(m); } else if (!v) { draft.verdicts[m.path] = 'kept'; draft.picks.push(m.path); }
          trace(`zoom pick idx=${idx + 1} verdict=${verdictOf(m)}`);
          if (fresh && autoAdvanceOn()) advance();
          else paint();
        };
        rejBtn.onclick = () => {
          const fresh = !v;
          if (v === 'rejected') { delete draft.verdicts[m.path]; }
          else if (!v) { draft.verdicts[m.path] = 'rejected'; }
          trace(`zoom reject idx=${idx + 1} verdict=${verdictOf(m)}`);
          if (fresh && autoAdvanceOn()) advance();
          else paint();
        };
        dots.innerHTML = '';
        list.forEach((mm, i) => {
          const d = document.createElement('span');
          const vv = verdictOf(mm);
          d.className = 'ss-dot' + (vv ? ` ${DRAFT_CLASSES[vv]}` : '');
          if (i === idx) d.style.outline = '2px solid #d4d4e0';
          else if (mm === pinned) d.style.outline = '2px solid #e8a13a';  // ring on pinned
          else d.style.outline = '';
          d.title = mm.name;
          dots.appendChild(d);
        });
      };
      // verdict helpers that DON'T re-render the spread (which would wipe
      // this overlay); draft mutation only, origin re-renders on exit.
      function unPickNoRender(m) {
        delete draft.verdicts[m.path];
        draft.picks = draft.picks.filter(p => p !== m.path);
      }
      const setZoomMode = (mode) => {
        if (mode === zoomMode) return;
        zoomMode = mode;
        list = zoomMembers(current.members, draft ? draft.verdicts : {}, zoomMode);
        idx = 0;
        trace(`zoom mode → ${zoomMode} (${list.length} members)`);
        modeBtns.forEach(b => b.classList.toggle('active', b.dataset.zm === zoomMode));
        paint();
      };
      const modeBtns = ZOOM_MODES.map(mode => {
        const b = document.createElement('button');
        b.className = 'ee-btn zoom-mode-btn';
        b.dataset.zm = mode;
        b.style.minHeight = '40px';
        b.style.minWidth = '40px';
        b.textContent = mode[0].toUpperCase() + mode.slice(1);
        b.title = `zoom cycles ${mode} members only`;
        b.addEventListener('click', () => setZoomMode(mode));
        return b;
      });
      modeBtns.forEach(b => b.classList.toggle('active', b.dataset.zm === zoomMode));
      const jumpTwin = () => {
        const m = list[idx];
        const tw = m && twinMap.get(m.path);
        if (!tw) return;
        const ti = list.findIndex(x => x.path === tw.twin);
        if (ti < 0) return;
        idx = ti;
        trace(`zoom twin jump → ${idx + 1} (${tw.kind})`);
        paint();
      };
      // advance: next unhandled member of the visited set (wraps; stays
      // put when everything visible is handled) — then repaint via paint().
      const advance = () => {
        const ni = nextUnhandled(list, draft ? draft.verdicts : {}, idx);
        if (ni >= 0) idx = ni;
        paint();
      };
      const cycle = (dir) => {
        idx = (idx + dir + list.length) % list.length;
        trace(`zoom cycle → ${idx + 1}/${list.length}`);
        paint();
      };
      prev.addEventListener('click', () => cycle(-1));
      next.addEventListener('click', () => cycle(1));
      // swipe: left/right = cycle, down = dismiss, tap = flip. Pointer based,
      // touch-action:none on the stage — no page-scroll fight.
      // (2026-10-08m step 3: tap-to-pick REMOVED — tap now flips pinned/
      // current; verdicts only via the ≥44px Pin/Pick/Reject buttons.)
      let down = null;
      stage.addEventListener('pointerdown', e => {
        down = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      });
      stage.addEventListener('pointermove', e => {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) down.moved = true;
      });
      stage.addEventListener('pointerup', e => {
        if (!down) return;
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        const tap = !down.moved && Date.now() - down.t < 500;
        down = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
          cycle(dx < 0 ? 1 : -1);
        } else if (dy > 80) {
          dismiss();
        } else if (tap && !e.target.closest('button')) {
          flip();
        }
      });
      stage.append(img, pinImg, curBadge, pinBadge, prev, next, dots, tools,
        flipBtn);
      tools.append(pinBtn, pickBtn, rejBtn);
      top.append(back, ...modeBtns, info, twinChip, pinInfo, autoBtn,
        kbdLegendBtn([
          ['←/→', 'cycle members'],
          ['A', 'pick this member'],
          ['F', 'reject this member'],
          ['P', 'pin / unpin'],
          ['Space', 'flip pinned ↔ current'],
          ['T', 'jump to the twin'],
          ['Esc', 'back'],
        ]));
      ov.append(top, stage, count);
      el.detail.appendChild(ov);
      paint();
    }

    function openSurvey() {
      closeSurvey();
      surveyFocus = 0;
      meldSel.clear();      // meld selection is per survey visit
      meldMode = false;
      const ov = document.createElement('div');
      ov.className = 'ss-overlay';
      ov.id = 'ss-survey';
      const top = document.createElement('div');
      top.className = 'ss-ov-top';
      const info = document.createElement('span');
      info.textContent = `Survey — all ${current.members.length} members · tap an image to inspect`;
      const close = document.createElement('button');
      close.className = 'ee-btn';
      close.textContent = '✕ Back to stack';
      close.dataset.kbd = 'Esc';
      close.addEventListener('click', () => { closeSurvey(); renderSpread(); });
      // ── MELD SELECT (2026-10-08g): multi-select members as merge
      // candidates — orthogonal to keep/reject verdicts. 1..8 cap reused
      // from the gallery handoff planner. On 'Meld these' the batch hands
      // off to FaceCycle with the family context; Save back there collapses
      // the group. This IS the dupe→FaceCycle handoff — no separate
      // non-meld path (operator decision, 2026-10-08).
      const meldBtn = document.createElement('button');
      meldBtn.className = 'ee-btn';
      meldBtn.id = 'ss-meld-mode';
      meldBtn.textContent = '⑂ Meld select';
      meldBtn.title = 'multi-select members to blend into one in FaceCycle';
      top.appendChild(meldBtn);
      const grid = document.createElement('div');
      grid.className = 'ss-survey-grid';
      current.members.forEach((m, i) => {
        const cell = document.createElement('div');
        const v = verdictOf(m);
        cell.className = 'ss-cell' + (v ? ` ${DRAFT_CLASSES[v]}` : '');
        const img = document.createElement('img');
        img.loading = 'lazy';
        setImg(img, m);
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = m.name;
        // no overlay icon — the whole cell is the tap target; near-twin
        // differences live in exactly the pixels an icon used to cover.
        cell.addEventListener('click', () => {
          if (meldMode) { toggleMeldSel(m, cell); return; }
          openZoom(i, 'survey');
        });
        cell.append(img, nm);
        grid.appendChild(cell);
      });
      // meld action bar (bottom, 40px touch targets)
      const bar = document.createElement('div');
      bar.className = 'ss-meld-bar';
      bar.id = 'ss-meld-bar';
      bar.style.display = 'none';
      const meldGo = document.createElement('button');
      meldGo.className = 'ee-btn primary';
      meldGo.id = 'ss-meld-go';
      meldGo.textContent = 'Meld these (0)';
      meldGo.disabled = true;
      meldGo.addEventListener('click', doMeldHandoff);
      const meldExit = document.createElement('button');
      meldExit.className = 'ee-btn';
      meldExit.textContent = 'Exit meld select';
      meldExit.addEventListener('click', () => {
        meldMode = false; meldSel.clear(); paintMeldBar();
        grid.querySelectorAll('.ss-cell.meldsel').forEach(c => c.classList.remove('meldsel'));
      });
      bar.append(meldGo, meldExit);
      meldBtn.addEventListener('click', () => {
        meldMode = !meldMode;
        paintMeldBar();
      });
      top.append(info, close,
        kbdLegendBtn([
          ['←/→/↑/↓', 'move the focus cell'],
          ['Enter / Space', 'inspect the focused cell'],
          ['Esc', 'back to spread'],
        ]));
      ov.append(top, grid, bar);
      el.detail.appendChild(ov);
      paintSurveyFocus();
    }
    function toggleMeldSel(m, cell) {
      if (meldSel.has(m.path)) { meldSel.delete(m.path); cell.classList.remove('meldsel'); }
      else { meldSel.add(m.path); cell.classList.add('meldsel'); }
      paintMeldBar();
    }
    function paintMeldBar() {
      const bar = el.detail.querySelector('#ss-meld-bar');
      if (!bar) return;
      bar.style.display = meldMode ? 'flex' : 'none';
      const go = bar.querySelector('#ss-meld-go');
      const n = meldSel.size;
      go.textContent = `Meld these (${n})`;
      go.disabled = !meldMode || n < 1 || n > 8;
    }
    // Hand the meld batch to FaceCycle through the SAME jailed-url planner
    // and event the gallery multi-select handoff uses, plus the family
    // context Save back needs. Dupe thumbs/files serve via /api/dupe —
    // FaceCycle fetches either URL shape identically.
    function doMeldHandoff() {
      const members = current.members.filter(m => meldSel.has(m.path));
      if (members.length < 1 || members.length > 8) return;
      const familyId = current.id;
      const memberPaths = members.map(m => m.path);
      window.dispatchEvent(new CustomEvent('ellieedit:activate',
        { detail: { name: 'facecycle' } }));
      window.dispatchEvent(new CustomEvent('ellieedit:facecycle-handoff', {
        detail: {
          urls: members.map(m => `/api/dupe/file?path=${encodeURIComponent(m.path)}`),
          names: members.map(m => m.name),
          meld: { family: familyId, members: memberPaths },
        },
      }));
    }
    function closeSurvey() { el.detail.querySelector('#ss-survey')?.remove(); }

    // ── SIFT view (2026-10-08c) — keep-K-of-N over the family. Same draft
    // state as the spread (verdicts + picks); nothing persists before Commit.
    // Shows members that are NOT rejected (unhandled + kept) as a grid;
    // tap toggles keep with an ordinal badge; ✕ rejects individually;
    // 'Reject the rest' sweeps all unhandled non-kept members to rejected.
    // Exit ('back to stack') restores the spread with the draft intact.
    let siftFocus = 0;   // keyboard-highlighted cell index in the sift grid
    function siftMembers() {
      return current.members.filter(m => verdictOf(m) !== 'rejected');
    }
    function openSift() {
      closeSift();
      trace('sift enter');
      siftFocus = 0;
      const ov = document.createElement('div');
      ov.className = 'ss-overlay';
      ov.id = 'ss-sift';
      const top = document.createElement('div');
      top.className = 'ss-ov-top';
      const info = document.createElement('span');
      info.textContent = 'Sift — tap to keep (ordered picks) · ✕ rejects · same draft';
      const close = document.createElement('button');
      close.className = 'ee-btn';
      close.textContent = '✕ Back to stack';
      close.dataset.kbd = 'Esc';
      close.addEventListener('click', () => { closeSift(); renderSpread(); });
      const grid = document.createElement('div');
      grid.className = 'ss-sift-grid';
      grid.id = 'ss-sift-grid';
      const bar = document.createElement('div');
      bar.className = 'ss-sift-bar';
      const count = document.createElement('span');
      count.className = 'keep-count';
      const sweep = document.createElement('button');
      sweep.className = 'ee-btn sweep';
      sweep.id = 'ss-sift-sweep';
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = 'state-in-layout: keeps + counter stay visible here; nothing saves until Commit';
      sweep.addEventListener('click', () => {
        try {
          const n = unhandled().length;
          for (const m of unhandled()) draft.verdicts[m.path] = 'rejected';
          trace(`sift sweep — rejected ${n} remainder`);
          renderSiftBody();
        } catch (err) {
          job(`sift sweep: ${err.message}`, 'err');
          console.error('sift sweep failed', err);
        }
      });
      bar.append(count, sweep, note);
      top.append(info, close, kbdLegendBtn([
        ['←/→/↑/↓', 'move the focus cell'],
        ['Enter / P', 'toggle keep on the focused cell'],
        ['F', 'reject the focused cell'],
        ['Esc', 'back to stack'],
      ]));
      ov.append(top, grid, bar);
      el.detail.appendChild(ov);
      renderSiftBody();
    }
    function closeSift() { el.detail.querySelector('#ss-sift')?.remove(); }

    function renderSiftBody() {
      const grid = el.detail.querySelector('#ss-sift-grid');
      const ov = el.detail.querySelector('#ss-sift');
      if (!grid || !ov) return;
      const mem = siftMembers();
      const keeps = draft.picks.length;
      const count = ov.querySelector('.keep-count');
      const sweep = ov.querySelector('#ss-sift-sweep');
      count.textContent = `${keeps} kept of ${current.members.length}`;
      sweep.textContent = 'Reject the rest';
      sweep.disabled = !unhandled().length;
      grid.innerHTML = '';
      mem.forEach((m, i) => {
        const v = verdictOf(m);
        const cell = document.createElement('div');
        cell.className = 'ss-cell' + (v === 'kept' ? ' keep' : v ? ` ${DRAFT_CLASSES[v]}` : '');
        const img = document.createElement('img');
        img.loading = 'lazy';
        setImg(img, m);
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = m.name;
        cell.append(img, nm);
        if (v === 'kept') {
          const ord = document.createElement('span');
          ord.className = 'ord-badge';
          const rank = draft.picks.indexOf(m.path) + 1;
          ord.textContent = rank === 1 ? '1st' : rank === 2 ? '2nd'
            : rank === 3 ? '3rd' : `${rank}th`;
          cell.appendChild(ord);
        } else if (!v) {
          const rej = document.createElement('button');
          rej.className = 'sift-rej';
          rej.textContent = '✕';
          rej.title = `reject ${m.name}`;
          rej.addEventListener('click', e => {
            e.stopPropagation();
            try {
              draft.verdicts[m.path] = 'rejected';   // draft only — no spread render
              trace(`sift reject ${m.name}`);
              renderSiftBody();
            }
            catch (err) { job(`sift reject: ${err.message}`, 'err'); console.error('sift reject failed', err); }
          });
          cell.appendChild(rej);
        }
        cell.addEventListener('click', () => {
          try {
            // draft mutation ONLY — renderSpread would wipe this overlay.
            if (v === 'kept') {
              delete draft.verdicts[m.path];
              draft.picks = draft.picks.filter(p => p !== m.path);
            } else if (!v) {
              draft.verdicts[m.path] = 'kept';
              draft.picks.push(m.path);
            }
            trace(`sift toggle ${m.name} → ${verdictOf(m) || 'unhandled'}`);
            renderSiftBody();
          } catch (err) {
            job(`sift toggle: ${err.message}`, 'err');
            console.error('sift toggle failed', err);
          }
        });
        grid.appendChild(cell);
      });
      siftFocus = Math.max(0, Math.min(siftFocus, mem.length - 1));
      paintSiftFocus();
    }

    function paintSiftFocus() {
      const cells = el.detail.querySelectorAll('#ss-sift-grid .ss-cell');
      cells.forEach((c, i) => c.classList.toggle('kbd-focus', i === siftFocus));
      cells[siftFocus]?.scrollIntoView({ block: 'nearest' });
    }
    function siftStep(key) {
      const cells = [...el.detail.querySelectorAll('#ss-sift-grid .ss-cell')];
      if (!cells.length) return;
      const top0 = cells[0].offsetTop;
      const cols = Math.max(1, cells.filter(c => c.offsetTop === top0).length);
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
      siftFocus = Math.max(0, Math.min(cells.length - 1, siftFocus + (moves[key] || 0)));
      paintSiftFocus();
    }
    function siftToggleFocused() {
      const m = siftMembers()[siftFocus];
      if (!m) return;
      const v = verdictOf(m);
      // draft mutation ONLY — doPick/doReject re-render the spread, which
      // wipes this overlay; sift re-renders its own body instead.
      if (v === 'kept') {
        delete draft.verdicts[m.path];
        draft.picks = draft.picks.filter(p => p !== m.path);
      } else if (!v) {
        draft.verdicts[m.path] = 'kept';
        draft.picks.push(m.path);
      }
      trace(`sift kbd toggle ${m.name} → ${verdictOf(m) || 'unhandled'}`);
      renderSiftBody();
    }
    function siftRejectFocused() {
      const m = siftMembers()[siftFocus];
      if (!m || verdictOf(m)) return;
      draft.verdicts[m.path] = 'rejected';   // draft only — see siftToggleFocused
      trace(`sift kbd reject ${m.name}`);
      renderSiftBody();
    }

    function toolBtn(txt, title, fn) {
      const b = document.createElement('button');
      b.className = 'ss-tool';
      b.textContent = txt;
      b.title = title;
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      return b;
    }

    // Champion gestures: tap=pick, swipe-down=reject, long-press=menu,
    // buttons for reject + full-size (pilot both reject controls).
    function bindChampionGestures(champ, m) {
      let press = null, lpTimer = null;
      const clear = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
      champ.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        press = { x: e.clientX, y: e.clientY, dy: 0, moved: false, menuFired: false };
        try { champ.setPointerCapture(e.pointerId); } catch (_) {}
        clear();
        lpTimer = setTimeout(() => {
          if (press && !press.moved) {
            press.menuFired = true;
            const r = champ.getBoundingClientRect();
            openMenu(r.left + r.width / 2, r.top + 20);
          }
        }, 500);
      });
      champ.addEventListener('pointermove', e => {
        if (!press) return;
        const dy = e.clientY - press.y;
        const dx = e.clientX - press.x;
        if (Math.hypot(dx, dy) > 10) {
          press.moved = true;
          clear();
        }
        if (dy > 0) {
          press.dy = dy;
          champ.style.transform = `translateY(${Math.min(dy, 200)}px) rotate(${dy / 40}deg)`;
          champ.style.opacity = String(Math.max(0.3, 1 - dy / 260));
        }
      });
      const finish = (e, cancelled) => {
        if (!press) return;
        const { dy, moved, menuFired } = press;
        press = null;
        clear();
        champ.style.transform = '';
        champ.style.opacity = '';
        if (cancelled || menuFired) return;
        if (dy > 80 && moved) { doReject(m); return; }
        if (!moved) doPick(m);
      };
      champ.addEventListener('pointerup', e => finish(e, false));
      champ.addEventListener('pointercancel', e => finish(e, true));
    }

    // Picks-strip drag reorder: pointerdown on a chip → track x → live swap.
    function bindChipDrag(chip, path) {
      let drag = null;
      chip.addEventListener('pointerdown', e => {
        drag = { startX: e.clientX, dx: 0, moved: false };
        try { chip.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      chip.addEventListener('pointermove', e => {
        if (!drag) return;
        drag.dx = e.clientX - drag.startX;
        if (Math.abs(drag.dx) > 6) drag.moved = true;
        if (drag.moved) {
          chip.style.transform = `translateX(${drag.dx}px)`;
          chip.style.zIndex = '5';
          const strip = chip.parentElement;
          const chips = [...strip.querySelectorAll('.ss-pick-chip')]
            .filter(c => c !== chip);
          const target = chips.find(c => {
            const r = c.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX <= r.right;
          });
          if (target) {
            const from = draft.picks.indexOf(path);
            const to = draft.picks.indexOf(target.dataset.path);
            draft.picks.splice(from, 1);
            draft.picks.splice(to, 0, path);
            renderStripOnly();
            // keep dragging the same chip (it was re-rendered)
            const nue = strip.querySelector(`.ss-pick-chip[data-path="${CSS.escape(path)}"]`);
            if (nue) { drag.startX = e.clientX; drag.dx = 0; }
          }
        }
      });
      const end = (cancelled) => {
        if (!drag) return;
        const tap = !drag.moved && !cancelled;
        drag = null;
        renderStripOnly();
        if (tap) unPick(current.members.find(m => m.path === path));
      };
      chip.addEventListener('pointerup', () => end(false));
      chip.addEventListener('pointercancel', () => end(true));
    }

    function renderStripOnly() {
      const strip = el.detail.querySelector('#ss-strip');
      if (!strip) return renderSpread();
      const lbl = strip.querySelector('.lbl');
      strip.innerHTML = '';
      strip.appendChild(lbl);
      const ps = picks();
      if (draft.melded) {
        const a = current.members.find(m => m.path === draft.melded[0]);
        const b = current.members.find(m => m.path === draft.melded[1]);
        if (a && b) {
          const chip = document.createElement('div');
          chip.className = 'ss-meld-chip';
          chip.title = 'Melded pair — tap to undo';
          const ia = document.createElement('img'); setImg(ia, a);
          const ib = document.createElement('img'); setImg(ib, b);
          const t = document.createElement('span');
          t.textContent = 'meld';
          t.style.cssText = 'font-size:11px;color:#7ab8e8;';
          chip.append(ia, ib, t);
          chip.addEventListener('click', () => {
            draft.melded.forEach(p => delete draft.verdicts[p]);
            draft.melded = null;
            renderSpread();
          });
          strip.appendChild(chip);
        }
      }
      if (!ps.length && !draft.melded) {
        const n = document.createElement('span');
        n.className = 'ss-empty-note';
        n.textContent = 'tap the big card to pick it';
        strip.appendChild(n);
      }
      ps.forEach((m, i) => {
        const chip = document.createElement('div');
        chip.className = 'ss-pick-chip';
        chip.dataset.path = m.path;
        chip.title = `pick #${i + 1} — drag to reorder, tap to un-pick`;
        const img = document.createElement('img');
        setImg(img, m);
        const ord = document.createElement('span');
        ord.className = 'ord';
        ord.textContent = `#${i + 1}`;
        chip.append(img, ord);
        bindChipDrag(chip, m.path);
        strip.appendChild(chip);
      });
    }

    function renderSpread() {
      if (!current || committed) return;
      closeMenu();
      const champ = championMember();
      if (!champ) return;
      el.detail.innerHTML = '';

      // header
      const head = document.createElement('div');
      head.className = 'ss-header';
      const pk = picks().length, rj = rejectedMembers().length, uh = unhandled().length;
      const dots = current.members.map(m => {
        const v = verdictOf(m);
        return `<span class="ss-dot ${v ? DRAFT_CLASSES[v] : ''}" title="${m.name}${v ? ' · ' + v : ''}"></span>`;
      }).join('');
      head.innerHTML =
        `<span class="fam-id">${current.id}</span>` +
        `<span>${current.members.length} members</span>` +
        `<span class="verdict-tag kept">${pk} picked</span>` +
        `<span class="verdict-tag rejected">${rj} rejected</span>` +
        `<span>${uh} unhandled</span>` +
        `<span class="ss-dots">${dots}</span>` +
        `<span class="ss-kbd-pos" id="ss-kbd-pos">⌨ ${current.members.indexOf(champ) + 1}/${current.members.length}</span>` +
        `<span class="ss-badge draft">DRAFT — nothing saved until Commit</span>`;
      head.appendChild(kbdLegendBtn([
        ['←/→', 'cycle champion through challengers'],
        ['A', 'pick the champion'],
        ['F', 'reject the champion'],
        ['Esc', 'back to families'],
      ]));
      el.detail.appendChild(head);

      // fan band
      const fan = document.createElement('div');
      fan.className = 'ss-fan';
      const fm = fanMembers();
      if (!fm.length) {
        const n = document.createElement('span');
        n.className = 'ss-empty-note';
        n.textContent = current.members.length === 1
          ? 'single member — pick or reject it below'
          : 'no challengers left — pick or reject the champion';
        fan.appendChild(n);
      }
      for (const m of fm) {
        const c = document.createElement('div');
        c.className = 'ss-fan-card';
        c.style.position = 'relative';
        c.title = `tap to duel the champion — ${m.name}`;
        const img = document.createElement('img');
        img.loading = 'lazy';
        setImg(img, m);
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = m.name;
        // prior-verdict history badge, if the operator has judged this
        // member before (signal chips, never auto-applied)
        const h = signals && signals.members[m.path];
        const ht = h && sigChipText(h);
        if (ht) {
          const badge = document.createElement('span');
          badge.className = 'sig-mini ' + (h.last === 'rejected' ? 'reject' : 'keep');
          badge.textContent = h.last === 'rejected' ? `✕${h.rejected}` : `✓${h.kept}`;
          badge.title = `prior verdicts: ${ht}`;
          c.appendChild(badge);
        }
        if (signals && signals.conflict_members.includes(m.path)) {
          const fl = document.createElement('span');
          fl.className = 'sig-mini';
          fl.style.color = '#e8c37a';
          fl.textContent = '⚡';
          fl.title = 'conflicts with hash tiers — see the signals bar';
          c.appendChild(fl);
        }
        c.append(img, nm);
        c.addEventListener('click', () => duel(m));
        fan.appendChild(c);
      }
      el.detail.appendChild(fan);

      // stage: champion + side controls
      const stage = document.createElement('div');
      stage.className = 'ss-stage';
      const big = document.createElement('div');
      big.className = 'ss-champ';
      const bigImg = document.createElement('img');
      bigImg.src = thumbUrl(champ.path);
      bigImg.alt = champ.name;
      const tools = document.createElement('div');
      tools.className = 'ss-champ-tools';
      tools.append(
        toolBtn('⤢', 'inspect full-size — cycle members, pick/reject in place',
                () => openZoom(current.members.indexOf(champ), 'spread')),
        toolBtn('☰', 'actions: meld / defer / reject remainder', (e) => {
          const r = e.target.getBoundingClientRect();
          openMenu(r.left, r.bottom + 6);
        }),
      );
      const nmBar = document.createElement('div');
      nmBar.className = 'nm';
      nmBar.textContent = `${champ.name}${verdictOf(champ) ? ' · ' + verdictOf(champ) : ''}`;
      big.append(bigImg, tools, nmBar);
      bindChampionGestures(big, champ);

      const side = document.createElement('div');
      side.className = 'ss-side';
      const rejBtn = document.createElement('button');
      rejBtn.id = 'ss-reject';
      rejBtn.className = 'ee-btn ss-reject';
      rejBtn.textContent = '✕ Reject';
      rejBtn.dataset.kbd = 'F';
      rejBtn.title = 'reject — or swipe the big card down';
      rejBtn.addEventListener('click', () => doReject(champ));
      const survBtn = document.createElement('button');
      survBtn.id = 'ss-survey-btn';
      survBtn.className = 'ee-btn';
      survBtn.textContent = '▦ Survey';
      survBtn.dataset.kbd = 'Esc';
      survBtn.title = 'spread all members into a grid (or pinch out)';
      survBtn.addEventListener('click', openSurvey);
      const siftBtn = document.createElement('button');
      siftBtn.id = 'ss-sift-btn';
      siftBtn.className = 'ee-btn';
      siftBtn.textContent = '⇅ Sift';
      siftBtn.title = 'keep-K-of-N pass over the whole family (same draft)';
      siftBtn.addEventListener('click', openSift);
      const hint = document.createElement('div');
      hint.className = 'ss-gesture-hint';
      hint.textContent = 'tap = pick · swipe down = reject · hold = menu · pinch out = survey';
      side.append(rejBtn, survBtn, siftBtn, hint);
      stage.append(big, side);
      el.detail.appendChild(stage);

      // discard row (face-down, tap to un-reject)
      const discard = document.createElement('div');
      discard.className = 'ss-discard';
      const dl = document.createElement('span');
      dl.className = 'lbl';
      dl.textContent = `rejected (${rejectedMembers().length}) — tap to undo`;
      discard.appendChild(dl);
      for (const m of rejectedMembers()) {
        const d = document.createElement('div');
        d.className = 'ss-dead';
        d.title = `rejected — tap to restore: ${m.name}`;
        const img = document.createElement('img');
        setImg(img, m);
        d.appendChild(img);
        d.addEventListener('click', () => unReject(m));
        discard.appendChild(d);
      }
      if (!rejectedMembers().length) {
        const n = document.createElement('span');
        n.className = 'ss-empty-note';
        n.textContent = 'none yet';
        discard.appendChild(n);
      }
      el.detail.appendChild(discard);

      // picks strip
      const strip = document.createElement('div');
      strip.className = 'ss-strip';
      strip.id = 'ss-strip';
      const sl = document.createElement('span');
      sl.className = 'lbl';
      sl.textContent = `picks (${pk}) — drag to reorder · tap to un-pick`;
      strip.appendChild(sl);
      el.detail.appendChild(strip);
      renderStripOnly();

      // pinch-out on the fan band opens survey
      let pinch = null;
      fan.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
          const [a, b] = e.touches;
          pinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        }
      }, { passive: true });
      fan.addEventListener('touchmove', e => {
        if (pinch && e.touches.length === 2) {
          const [a, b] = e.touches;
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          if (d / pinch > 1.4) { pinch = null; openSurvey(); }
        }
      }, { passive: true });
      fan.addEventListener('touchend', () => { pinch = null; }, { passive: true });

      // signals bar survives spread re-renders (renderSpread wipes
      // el.detail) — re-hung after every rebuild, suggestion state intact
      renderSignalsBar();
    }

    function renderCommitted(summary) {
      el.detail.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'ss-committed';
      const big = document.createElement('div');
      big.className = 'big';
      big.textContent = '✓ Family committed';
      const sum = document.createElement('div');
      sum.className = 'sum';
      sum.textContent = summary;
      const dots = current.members.map(m => {
        const v = draft.verdicts[m.path];
        return `<span class="ss-dot ${v ? DRAFT_CLASSES[v] : ''}" title="${m.name}"></span>`;
      }).join('');
      const row = document.createElement('div');
      row.className = 'ss-dots';
      row.innerHTML = dots;
      const backBtn = document.createElement('button');
      backBtn.className = 'ee-btn primary';
      backBtn.textContent = '← Back to families';
      backBtn.addEventListener('click', () => renderList());
      box.append(big, sum, row, backBtn);
      // Meld result in place of the melded group (Save back flow): the
      // blend itself + which components collapsed into it.
      if (current.meld) {
        const mr = document.createElement('div');
        mr.className = 'ss-meld-result';
        const img = document.createElement('img');
        img.src = `/api/gallery/thumb?path=${encodeURIComponent(current.meld.result)}`;
        img.alt = current.meld.result;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = `⑂ MELD RESULT — ${current.meld.members.length} members collapsed · ` +
          `${current.meld.result} (components queued for deletion)`;
        mr.append(img, tag);
        el.detail.appendChild(box);   // box must be a child before insertBefore
        el.detail.insertBefore(mr, box);
        return;
      }
      el.detail.appendChild(box);
    }

    async function renderDetail(fid) {
      const seq = ++viewSeq;
      trace(`renderDetail(${fid}, seq=${seq})`);
      job('loading family…');
      try {
        const f = await api(`/families/${fid}`);
        if (seq !== viewSeq) { trace(`renderDetail(${fid}) stale — a newer render won`); return; }
        current = f;
        committed = false;
        commitSummary = null;
        // TWIN-CLEARING ORDER (2026-10-08m): applied once here, so spread,
        // survey, zoom and kbCycle all traverse nearest-hash-neighbors
        // first — twins get judged back-to-back.
        current.members = orderBySimilarity(f.members);
        twinMap = twinInfo(current.members, f.edges || []);
        // Restore a tab-switched draft, else start fresh.
        const saved = familyDrafts.get(fid);
        draft = saved ? { verdicts: { ...saved.verdicts },
                         picks: [...saved.picks], melded: saved.melded || null }
                      : { verdicts: {}, picks: [], melded: null };
        familyDrafts.delete(fid);
        loadSignals(fid);   // lazy, non-blocking — detail renders first
        // resolved families: pre-load existing verdicts as the committed truth
        for (const [p, v] of Object.entries(f.verdicts || {})) {
          if (v) draft.verdicts[p] = v;
          if (v === 'kept') draft.picks.push(p);
        }
        el.note.value = f.note || '';
        championIdx = 0;
        if (f.state === 'resolved') {
          committed = true;
          const vs = draft.verdicts;
          const c = Object.values(vs).filter(x => x === 'kept').length;
          const r = Object.values(vs).filter(x => x === 'rejected').length;
          const mm = Object.values(vs).filter(x => x === 'melded').length;
          const df = Object.values(vs).filter(x => x === 'deferred').length;
          commitSummary =
            `saved verdict: ${c} kept · ${r} rejected · ${mm} melded · ${df} deferred`;
        }
        el.list.classList.add('open');     // hide list (open = hidden)
        el.detail.classList.add('open');   // show detail
        el.bottom.style.display = 'flex';
        el.scroll.scrollTop = 0;
        try {
          if (committed) renderCommitted(commitSummary);
          else renderSpread();
        } catch (renderErr) {
          // red error panel INSIDE the detail — never a silent blank view
          console.error('dupe renderSpread failed', renderErr);
          trace(`renderSpread threw: ${renderErr.message}`);
          el.detail.innerHTML =
            `<div style="padding:16px;color:#e87a7a;font-size:13px;">` +
            `detail render failed: ${renderErr.message}</div>`;
        }
        trace(`detail open (list display=${getComputedStyle(el.list).display})`);
        job('');
      } catch (e) {
        trace(`renderDetail(${fid}) failed: ${e.message}`);
        job(`dupe: ${e.message}`, 'err');
      }
    }

    el.back.addEventListener('click', () => { familyDrafts.delete(current?.id); renderList(); });

    el.commit.addEventListener('click', async () => {
      if (!current || committed) return;
      const handled = draft.verdicts;
      const rejects = Object.values(handled).filter(v => v === 'rejected').length;
      const keeps = draft.picks.length;
      const melds = draft.melded ? 2 : 0;
      if (!Object.keys(handled).length) {
        job('nothing to commit — pick or reject at least one member', 'err');
        return;
      }
      const msg = `Commit family?\n` +
        `${keeps} pick(s) · ${melds} melded · ${rejects} rejected → Deletion queue.\n` +
        `Rejects go to the pending manifest (still reversible there until confirm).`;
      if (!window.confirm(msg)) return;
      try {
        await api(`/families/${current.id}/verdict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            members: handled,
            note: el.note.value.trim(),
            // ADDITIVE rank payload (Sift, 2026-10-08c): 1-based order of the
            // picks. Server tolerates its absence; old clients never send it.
            ranks: Object.fromEntries(draft.picks.map((p, i) => [p, i + 1])),
          }),
        });
        let pendingNote = 'no rejects — ledger only';
        if (rejects) {
          const r = await api(`/families/${current.id}/send-pending`, { method: 'POST' });
          pendingNote = `pending: +${r.added} (${r.already_pending} already queued, ${r.missing} missing)`;
          window.dispatchEvent(new CustomEvent('ellieedit:pending-changed'));
        }
        committed = true;
        commitSummary = `${pendingNote} · ${keeps} picked · ${melds} melded · ${rejects} rejected`;
        renderCommitted(commitSummary);
        job(`committed — ${pendingNote}`, 'ok');
      } catch (e) {
        job(`commit failed: ${e.message}`, 'err');
      }
    });

    // Diagnostics: surface thrown errors and unhandled rejections into the
    // status row so a silent blank grid can never happen again (iPad Safari).
    if (!window.__eeErrorHook) {
      window.__eeErrorHook = true;
      const show = (kind, msg) => {
        const st = document.querySelector('#dupe-status');
        if (st) st.textContent = `${kind}: ${msg}`;
        console.error(`[ellieedit ${kind}]`, msg);
      };
      window.addEventListener('error', e => show('error', e.message));
      window.addEventListener('unhandledrejection', e =>
        show('rejection', e.reason && e.reason.message || String(e.reason)));
    }

    panel.addEventListener('ellieedit:dupe-sync', () => renderList());
    // FaceCycle Save back: the blend landed, ledger + manifest updated
    // server-side — re-open the family so the result renders in place.
    window.addEventListener('ellieedit:dupe-meld-saved', e => {
      const fid = e.detail?.family;
      if (!fid) return;
      // Save back returns to the Dupe module with the family's detail shown,
      // meld result in place of the group, ACCEPTED in the ledger. The
      // detail may have been torn down while FaceCycle was active
      // (current=null) — renderDetail re-opens it either way; a saved meld
      // is final, so force the committed view with the meld result.
      renderDetail(fid).then(() => {
        committed = true;
        commitSummary = commitSummary || 'meld saved — components queued for deletion';
        renderCommitted(commitSummary);
      }).catch(err => job(`meld re-open failed: ${err.message}`, 'err'));
    });
    window.addEventListener('ellieedit:tab-activated', e => {
      if (e.detail?.name !== 'dupe') return;
      // A family is open: stash its draft and leave the detail untouched —
      // re-rendering the list here used to wipe the in-progress verdict.
      if (current && !committed && draft) {
        familyDrafts.set(current.id, {
          verdicts: { ...draft.verdicts },
          picks: [...draft.picks],
          melded: draft.melded,
        });
        return;
      }
      if (!current) renderList();
    });
    renderStatus();
    renderList();
  },
});
