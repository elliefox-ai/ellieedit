// Shared image clipboard + import (2026-11-27) — ONE home for both.
// The Gallery copy action, the Studio copy/paste actions, and the file
// picker all go through here; Claude's candidate-tap work calls
// importImageAsWorking too. Do NOT duplicate the upload→set or
// fetch→clipboard flows elsewhere.
//
// Clipboard reality on the box: the app is served over tailnet http,
// which is not a secure context, so navigator.clipboard is usually
// ABSENT there — copy falls back to a download, paste must come via
// Ctrl/Cmd+V (the paste event needs no clipboard-read permission).
// Neither helper ever fails silently: copy reports which path it took,
// import throws and the caller says why.

import { studioState } from './studio-state.js';

// THE single import-image function: any image data — File/Blob or a
// data URL — becomes the working image, via the gallery upload (the
// same path the file picker takes). The uploaded file becomes a gallery
// file, then the store set opens it in Studio (openWorking runs off the
// subscription). Returns the server path. Throws on upload failure;
// callers report it.
export async function importImageAsWorking(data, { name = 'pasted-image.png', origin = 'paste' } = {}) {
  let blob = data;
  if (typeof data === 'string') {
    // Data URL → blob (fetch handles data: URLs).
    blob = await (await fetch(data)).blob();
  }
  if (!(blob instanceof Blob)) throw new Error('import needs a Blob, File, or data URL');
  const fd = new FormData();
  fd.append('file', blob, name);
  const r = await fetch('/api/gallery/upload', { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `upload failed: ${r.status}`);
  studioState().set(d.path, origin, { name: d.path.split('/').pop() });
  return d.path;
}

// Copy an image (server URL) to the clipboard. Returns 'clipboard' when
// the write landed, 'download' when the Clipboard API was unavailable
// or the write was denied — the file is downloaded instead, same name.
// Throws only when the image itself cannot be fetched.
export async function copyImageToClipboard(url, name) {
  const blob = await (await fetch(url)).blob();
  const type = blob.type || 'image/png';
  if (typeof navigator !== 'undefined' && navigator.clipboard
      && typeof navigator.clipboard.write === 'function'
      && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      return 'clipboard';
    } catch { /* denied or unavailable — fall through to download */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name || 'image.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'download';
}
