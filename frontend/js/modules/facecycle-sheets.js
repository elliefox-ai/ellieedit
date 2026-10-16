// FaceCycle bottom sheets (Task 7 rev.2, 2026-10-15): 🖌 Repaint and 🔍 Detect.
// Pure DOM-light controller so node can test it. Opening/closing ONLY toggles
// classes/ARIA on the sheet, its opener and the backdrop — it never touches the
// canvas, regions, undo log or any in-flight generation.

export function createSheetController({ backdrop, sheets, openers = {} }) {
  let current = null;
  const paint = () => {
    for (const [name, el] of Object.entries(sheets)) {
      el.classList.toggle('open', name === current);
      el.setAttribute?.('aria-hidden', name === current ? 'false' : 'true');
    }
    for (const [name, el] of Object.entries(openers)) {
      el.setAttribute?.('aria-expanded', name === current ? 'true' : 'false');
      el.classList.toggle('active-toggle', name === current);
    }
    backdrop.classList.toggle('open', current !== null);
  };
  const api = {
    open(name) { if (!(name in sheets)) return false; current = name; paint(); return true; },
    close() { if (current === null) return false; current = null; paint(); return true; },
    toggle(name) { return current === name ? (api.close(), false) : api.open(name); },
    current: () => current,
    isOpen: () => current !== null,
  };
  paint();
  return api;
}
