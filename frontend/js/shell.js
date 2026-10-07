// EllieEdit shell — module registry + tab bar + job bar.
// The shell stays dumb: modules self-register a descriptor
// { name, label, icon, mount(panelEl, jobbar) } and the shell composes them.
// Adding a tool = a module file in js/modules/ + a FastAPI router.

const registry = [];
const mounted = new Map(); // name -> { panelEl }

export function registerModule(desc) {
  registry.push(desc);
  registry.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
}

function buildTabs() {
  tabbar.innerHTML = '';
  for (const desc of registry) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.name = desc.name;
    btn.innerHTML = `<span class="icon">${desc.icon}</span><span>${desc.label}</span>`;
    btn.addEventListener('click', () => activate(desc.name));
    tabbar.appendChild(btn);
  }
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
}

// Import modules (self-registering) then build.
Promise.all([
  import('./modules/facecycle.js'),
]).then(() => {
  buildTabs();
  mountAll();
}).catch(err => {
  jobbar.innerHTML = `<span class="badge err">Module load failed: ${String(err.message || err)}</span>`;
  console.error(err);
});
