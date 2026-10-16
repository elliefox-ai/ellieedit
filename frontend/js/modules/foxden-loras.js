// FoxDen LoRA pin state (Task 5 addendum item 6, 2026-10-14). Pure — no DOM —
// so node can test it. Active pins are what /generate submits; suspended pins
// are parked with their strength so a render can be A/B'd with and without a
// LoRA without losing the value. The filter box only ever narrows the pick
// list; pins and the suspended tray are never filtered.

export function createPins() {
  const active = new Map();      // name -> strength (submitted)
  const suspended = new Map();   // name -> strength (parked)
  const clamp = v => Math.min(2, Math.max(-1, Number.isFinite(v) ? v : 1));
  return {
    active, suspended,
    pin(name, strength = 1) {
      suspended.delete(name);
      active.set(name, clamp(strength));
    },
    setStrength(name, strength) {
      if (active.has(name)) active.set(name, clamp(strength));
      else if (suspended.has(name)) suspended.set(name, clamp(strength));
    },
    suspend(name) {
      if (!active.has(name)) return;
      suspended.set(name, active.get(name));
      active.delete(name);
    },
    restore(name) {
      if (!suspended.has(name)) return;
      active.set(name, suspended.get(name));
      suspended.delete(name);
    },
    remove(name) { active.delete(name); suspended.delete(name); },
    clear() { active.clear(); suspended.clear(); },
    // Submitted to the server: ACTIVE only.
    payload() { return [...active].map(([name, strength_model]) => ({ name, strength_model })); },
    // Recorded alongside so "Reuse settings" can restore the parked tray too.
    suspendedPayload() { return [...suspended].map(([name, strength_model]) => ({ name, strength_model })); },
    // Faithful restore from a recent entry (older entries have no suspended list).
    restoreFrom(loras, suspendedLoras) {
      active.clear(); suspended.clear();
      for (const l of loras || []) active.set(l.name, clamp(l.strength_model));
      for (const l of suspendedLoras || []) if (!active.has(l.name)) suspended.set(l.name, clamp(l.strength_model));
    },
    // Pick list: filter narrows it; anything already pinned/parked is shown
    // above, so it is not repeated here.
    pickList(all, query) {
      const q = (query || '').trim().toLowerCase();
      return all.filter(n => !active.has(n) && !suspended.has(n) && (!q || n.toLowerCase().includes(q)));
    },
    count() { return active.size; },
  };
}
