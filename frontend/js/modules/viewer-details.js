// Viewer details lines for Gallery + Library (issue #6, 2026-11-04).
// Pure helpers — no DOM / shell imports so node can test them (gallery.js
// and library.js themselves pull in shell.js).
//
// What each viewer bar already shows, so these lines do NOT repeat it:
//   Gallery bar: name · W×H · modified date · bank (non-primary)
//   Library bar: name · tags
// What the details line adds:
//   Gallery: folder path, position in the current view, pending state.
//   Library: human-entered subject / shot / figures / detail metadata,
//     full path, modified date, position in the current view.
// Prompts are deliberately absent: gallery/library files carry no prompt
// metadata — only FoxDen recents do, and FoxDen's viewer already shows
// the prompt in its bigmeta line. So a details line that promised a
// prompt here would be inventing one.

function folderOf(path) {
  if (typeof path !== 'string') return '';
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

function position(idx, total) {
  if (!Number.isInteger(idx) || !Number.isInteger(total) || total <= 0) return '';
  if (idx < 0 || idx >= total) return '';
  return `${idx + 1} of ${total}`;
}

function dateStr(mtime) {
  if (!Number.isFinite(mtime) || mtime <= 0) return '';
  return new Date(mtime * 1000).toLocaleString();
}

export function galleryDetails(item, idx, total) {
  const it = item || {};
  const parts = [];
  const folder = folderOf(it.path);
  if (folder) parts.push(folder);
  const pos = position(idx, total);
  if (pos) parts.push(pos);
  if (it.pending) parts.push('marked for deletion');
  return parts.join(' · ');
}

export function libraryDetails(item, idx, total) {
  const it = item || {};
  const meta = it.meta || {};
  const parts = [];
  if (meta.subject) parts.push(`subject: ${meta.subject}`);
  if (meta.shot) parts.push(`shot: ${meta.shot}`);
  if (meta.figures) parts.push(`figures: ${meta.figures}`);
  if (meta.detail) parts.push(`detail: ${meta.detail}`);
  if (it.path) parts.push(it.path);
  const d = dateStr(it.mtime);
  if (d) parts.push(d);
  const pos = position(idx, total);
  if (pos) parts.push(pos);
  return parts.join(' · ');
}
