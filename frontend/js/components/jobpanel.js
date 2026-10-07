// JobPanel — shared job-status panel. Modules report long-running jobs
// (repaints, later scans/renders) so the shell shows one consistent queue view.

export class JobPanel {
  constructor(el) {
    this.el = el;
    this.jobs = new Map(); // id -> { label, total, done, state }
    this._nextId = 1;
  }

  start(label, total = 1) {
    const id = this._nextId++;
    this.jobs.set(id, { label, total, done: 0, state: 'run' });
    this._render();
    return id;
  }

  progress(id, n = 1) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.done = Math.min(j.total, j.done + n);
    if (j.done >= j.total) j.state = 'ok';
    this._render();
  }

  fail(id, msg) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.state = 'err';
    j.msg = String(msg || '').slice(0, 160);
    this._render();
    setTimeout(() => { this.jobs.delete(id); this._render(); }, 8000);
  }

  finish(id) {
    this.jobs.delete(id);
    this._render();
  }

  /** One-shot status badge (transient messages from modules). */
  note(msg, cls = '') {
    const b = document.createElement('span');
    b.className = 'badge ' + cls;
    b.textContent = msg;
    this.el.appendChild(b);
    setTimeout(() => b.remove(), 6000);
  }

  _render() {
    this.el.innerHTML = '';
    for (const j of this.jobs.values()) {
      const b = document.createElement('span');
      b.className = 'badge' + (j.state === 'err' ? ' err' : j.state === 'ok' ? ' ok' : '');
      b.textContent = j.state === 'run'
        ? `${j.label} ${j.done}/${j.total}`
        : j.state === 'err' ? `${j.label} failed: ${j.msg || ''}` : `${j.label} done`;
      this.el.appendChild(b);
    }
  }
}
