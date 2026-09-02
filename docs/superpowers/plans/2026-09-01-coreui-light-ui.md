# CoreUI Light-Theme UI Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-styled dark single-page UI with a light CoreUI 5 / Bootstrap 5 admin layout (sidebar views for Devices, Settings, Logs; Bootstrap modals for per-device actions) without changing the server API.

**Architecture:** Vanilla JS, no build step. CoreUI's bundled CSS/JS (which includes Bootstrap 5 and Popper) is vendored via npm and served by Express from `node_modules`. The frontend becomes three files: `public/index.html` (static markup for sidebar, header, three view sections, one shared modal, toast container), `public/app.css` (small custom layer), `public/app.js` (api helper, hash router, per-view render/load functions, modal handlers). Server change is limited to two `express.static` mounts.

**Tech Stack:** Node 18+, Express 4, `@coreui/coreui` 5.9.0, `@coreui/icons` 3.1.0, vanilla ES2020 browser JS.

**Spec:** `docs/superpowers/specs/2026-09-01-coreui-light-ui-design.md`

## Global Constraints

- No CDN references anywhere in `public/`. All CSS/JS/icons load from `/vendor/...` or `/app.*`.
- No build step, bundler, or frontend framework. Files in `public/` are served as written.
- Light theme only; no dark mode toggle.
- No `/api` route, request, or response shape changes. `server.js` gains only two static mounts.
- All user-supplied strings pass through `esc()` before insertion into `innerHTML`.
- Vendor mounts sit after the basic-auth middleware so assets stay behind auth like `public/` does today.
- Do not bump `package.json` version, tag, or push. The user releases with a local gitignored script.
- Pin exact versions: `"@coreui/coreui": "5.9.0"`, `"@coreui/icons": "3.1.0"`.

## Local test environment (used by every task)

The server needs `config.json` and reads device state from `state/devices.json`. Both are gitignored. The dev machine has neither, so create them once:

```bash
cd /Users/bryce/Documents/poe-portal
[ -f config.json ] || cp config.example.json config.json
cat > state/seed.json <<'EOF'
{
  "lastSync": "2026-09-01T10:00:00.000Z",
  "protectedMacs": [],
  "devices": {
    "aa:bb:cc:00:00:01": { "key": "aa:bb:cc:00:00:01", "name": "Barn switch", "ip": "10.0.0.11", "model": "ER-X-SFP", "site": "Main site", "online": true,
      "overrides": {}, "lastDeploy": { "at": "2026-08-30T12:00:00.000Z", "ok": true, "steps": ["uploaded", "installed"] },
      "lastCheck": { "at": "2026-09-01T09:55:00.000Z", "installed": true, "inSync": true, "scheduled": true } },
    "aa:bb:cc:00:00:02": { "key": "aa:bb:cc:00:00:02", "name": "Dock switch", "ip": "10.0.0.12", "model": "ER-X-SFP", "site": "Main site", "online": true,
      "overrides": { "GATEWAY_IP": "10.0.0.1" }, "lastDeploy": null,
      "lastCheck": { "at": "2026-09-01T09:55:00.000Z", "installed": true, "inSync": false, "scheduled": true } },
    "aa:bb:cc:00:00:03": { "key": "aa:bb:cc:00:00:03", "name": "Pump house", "ip": "10.0.0.13", "model": "ER-X", "site": "Remote", "online": false,
      "overrides": {}, "lastDeploy": { "at": "2026-08-20T12:00:00.000Z", "ok": false, "error": "connect ETIMEDOUT" },
      "lastCheck": { "at": "2026-09-01T09:55:00.000Z", "error": "connect ETIMEDOUT 10.0.0.13:22" } },
    "aa:bb:cc:00:00:04": { "key": "aa:bb:cc:00:00:04", "name": "Shop switch", "ip": "10.0.0.14", "model": "ER-X-SFP", "site": "Main site", "online": true,
      "overrides": {}, "lastDeploy": null, "lastCheck": null }
  }
}
EOF
[ -s state/devices.json ] || cp state/seed.json state/devices.json
```

`state/` is gitignored, so `seed.json` never ships. Whenever a task says "restore the seed state", run `cp state/seed.json state/devices.json` with the server stopped.

Start the server with `node server.js` (it binds `127.0.0.1:8090`, basic auth `admin` / `change-me`). Stop it with Ctrl-C or `pkill -f "node server.js"` between tasks. Browser checks open `http://admin:change-me@127.0.0.1:8090/`. SSH-dependent actions (Check, Deploy, Status, key setup) will fail against fake IPs; that is expected and is used to verify error toasts.

---

### Task 1: Vendor CoreUI via npm and serve it from Express

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `server.js:82` (static mounts)

**Interfaces:**
- Produces: URLs `/vendor/coreui/css/coreui.min.css`, `/vendor/coreui/js/coreui.bundle.min.js`, `/vendor/icons/sprites/free.svg` that Task 2 links to.

- [ ] **Step 1: Add dependencies**

```bash
cd /Users/bryce/Documents/poe-portal
npm install --save-exact @coreui/coreui@5.9.0 @coreui/icons@3.1.0
```

Expected: `package.json` dependencies now contain exactly:

```json
"dependencies": {
  "@coreui/coreui": "5.9.0",
  "@coreui/icons": "3.1.0",
  "express": "^4.19.2",
  "ssh2": "^1.15.0"
}
```

Confirm the files exist:

```bash
ls node_modules/@coreui/coreui/dist/css/coreui.min.css node_modules/@coreui/coreui/dist/js/coreui.bundle.min.js node_modules/@coreui/icons/sprites/free.svg
```

- [ ] **Step 2: Write the failing check**

With the server not yet modified, start it and probe the vendor URL:

```bash
node server.js & sleep 1
curl -s -o /dev/null -w '%{http_code}\n' -u admin:change-me http://127.0.0.1:8090/vendor/coreui/css/coreui.min.css
kill %1
```

Expected: `404`.

- [ ] **Step 3: Add the static mounts**

In `server.js`, directly after the existing line

```js
app.use(express.static(path.join(__dirname, 'public')));
```

add:

```js
// vendored UI assets (CoreUI bundles Bootstrap 5 + Popper) — served from
// node_modules so the Pi needs no internet access to render the portal
app.use('/vendor/coreui', express.static(path.join(__dirname, 'node_modules', '@coreui', 'coreui', 'dist')));
app.use('/vendor/icons', express.static(path.join(__dirname, 'node_modules', '@coreui', 'icons')));
```

- [ ] **Step 4: Verify the mounts**

```bash
node server.js & sleep 1
for u in vendor/coreui/css/coreui.min.css vendor/coreui/js/coreui.bundle.min.js vendor/icons/sprites/free.svg; do
  printf '%s ' "$u"; curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -u admin:change-me "http://127.0.0.1:8090/$u"
done
printf 'unauth '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/vendor/coreui/css/coreui.min.css
kill %1
```

Expected:

```
vendor/coreui/css/coreui.min.css 200 text/css; charset=UTF-8
vendor/coreui/js/coreui.bundle.min.js 200 application/javascript; charset=UTF-8
vendor/icons/sprites/free.svg 200 image/svg+xml
unauth 401
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json server.js
git commit -m "Vendor CoreUI 5 + icons via npm, serve from /vendor"
```

---

### Task 2: New page shell, custom CSS, and app.js core (helpers, router, toast, modal)

Replaces the old `public/index.html` entirely. After this task the page renders the sidebar, header, and three empty views; routing works; nothing loads data yet.

**Files:**
- Replace: `public/index.html`
- Create: `public/app.css`
- Create: `public/app.js`

**Interfaces:**
- Produces for later tasks (all in `app.js`, global scope):
  - `$(sel, root?)`, `$$(sel, root?)` — querySelector / querySelectorAll-as-array.
  - `icon(name, cls = 'icon')` → SVG string using the CoreUI sprite, e.g. `icon('search')`.
  - `esc(s)` → HTML-escaped string.
  - `fmtTime(iso)` → `toLocaleString()` or `''`.
  - `api(method, url, body?)` → parsed JSON; throws `Error(j.error || statusText)` on non-2xx.
  - `toast(msg, { variant = '', ms = 3500 } = {})` — variant is a Bootstrap colour name (`success`, `danger`, `warning`) or `''`.
  - `dlg.open(title, html, { size = 'modal-lg' } = {})`, `dlg.body(html)`, `dlg.close()`, `dlg.el` (the modal element).
  - `busy(btn, on)` — disables a button and swaps in a spinner; restores on `false`.
  - `fieldHtml(prefix, key, value, placeholder)` → a Bootstrap row with a monospace label and small input. Input has `name="<key>"` and `id="<prefix>-<key>"`.
  - `VIEWS` object: `{ devices: {title, enter}, settings: {title, enter}, logs: {title, enter} }`. Each `enter` is an async function. Tasks 3, 6, 7 define `loadDevices`, `loadSettings`, `loadLogs`; this task adds stubs that later tasks replace.
  - `route()` and `currentView()`.
  - DOM ids the later tasks target: `#viewTitle`, `#lastSync`, `#btnSsh`, `#btnSync`, `#btnCheckAll`, `#btnDeployAll`, `#statTotal`, `#statOnline`, `#statSync`, `#statAttn`, `#devSearch`, `#devFilter`, `#devCount`, `#tbl`, `#rows`, `#empty`, `#noMatch`, `#settingsForm`, `#defaultsFields`, `#autoCheck`, `#settingsSaved`, `#saveSettings`, `#logLevel`, `#logsRefresh`, `#logPane`, `#dlg`, `#dlgTitle`, `#dlgBody`, `#toasts`, `#sidebar`, `#btnSidebar`.

- [ ] **Step 1: Write `public/app.css`**

```css
/* Custom layer over CoreUI. Keep this small; prefer utility classes in markup. */

.icon { width: 1rem; height: 1rem; }
.icon-lg { width: 1.25rem; height: 1.25rem; }
.sidebar-nav .nav-icon { width: 1.25rem; height: 1.25rem; }

.mono { font-family: var(--cui-font-monospace); font-size: .8125rem; }

/* UISP online/offline dot in the device column */
.dot {
  display: inline-block; width: .5rem; height: .5rem; border-radius: 50%;
  margin-right: .4rem; vertical-align: middle;
}
.dot-online { background: var(--cui-success); }
.dot-offline { background: var(--cui-danger); }

.stat-card .stat-value { font-size: 1.75rem; font-weight: 600; line-height: 1.1; }

.table-devices td { vertical-align: middle; }
.table-devices .dropdown-menu { font-size: .875rem; }

/* monospace panels: logs view + status modal */
.log-pane, #dlg pre {
  font-family: var(--cui-font-monospace); font-size: .78rem; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word; margin: 0;
  background: var(--cui-tertiary-bg); border-radius: var(--cui-border-radius); padding: .75rem 1rem;
}
.log-pane { max-height: 70vh; overflow: auto; }
#dlg pre + h6 { margin-top: 1rem; }
```

- [ ] **Step 2: Replace `public/index.html`**

Overwrite the whole file with:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PoE watchdog fleet</title>
<link rel="stylesheet" href="/vendor/coreui/css/coreui.min.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>

<div class="sidebar sidebar-fixed border-end" id="sidebar">
  <div class="sidebar-header border-bottom">
    <div class="sidebar-brand d-flex align-items-center gap-2">
      <svg class="icon icon-lg"><use href="/vendor/icons/sprites/free.svg#cil-router"></use></svg>
      <span class="fw-semibold">PoE watchdog fleet</span>
    </div>
  </div>
  <ul class="sidebar-nav">
    <li class="nav-item"><a class="nav-link" href="#/devices" data-view="devices">
      <svg class="nav-icon"><use href="/vendor/icons/sprites/free.svg#cil-storage"></use></svg>Devices</a></li>
    <li class="nav-item"><a class="nav-link" href="#/settings" data-view="settings">
      <svg class="nav-icon"><use href="/vendor/icons/sprites/free.svg#cil-settings"></use></svg>Settings</a></li>
    <li class="nav-item"><a class="nav-link" href="#/logs" data-view="logs">
      <svg class="nav-icon"><use href="/vendor/icons/sprites/free.svg#cil-terminal"></use></svg>Logs</a></li>
  </ul>
</div>

<div class="wrapper d-flex flex-column min-vh-100">
  <header class="header header-sticky p-0 mb-4">
    <div class="container-fluid border-bottom px-4 py-2 d-flex align-items-center flex-wrap gap-2">
      <button class="header-toggler d-lg-none" type="button" id="btnSidebar" aria-label="Toggle navigation">
        <svg class="icon icon-lg"><use href="/vendor/icons/sprites/free.svg#cil-menu"></use></svg>
      </button>
      <h1 class="h5 mb-0 me-auto" id="viewTitle">Devices</h1>
      <span class="small text-body-secondary" id="lastSync"></span>
      <button class="btn btn-sm btn-outline-secondary" id="btnSsh" type="button"
        title="Fleet SSH credentials — kept in memory only, never stored">SSH: …</button>
      <button class="btn btn-sm btn-outline-secondary" id="btnSync" type="button">Sync from UISP</button>
      <button class="btn btn-sm btn-outline-secondary" id="btnCheckAll" type="button" title="Check drift on every device">Check all</button>
      <button class="btn btn-sm btn-primary" id="btnDeployAll" type="button">Deploy to all</button>
    </div>
  </header>

  <div class="body flex-grow-1 px-4 pb-5">

    <!-- ===== Devices ===== -->
    <section id="view-devices" class="view">
      <div class="row g-3 mb-4">
        <div class="col-6 col-xl-3"><div class="card stat-card"><div class="card-body">
          <div class="small text-uppercase text-body-secondary">Devices</div>
          <div class="stat-value" id="statTotal">–</div></div></div></div>
        <div class="col-6 col-xl-3"><div class="card stat-card"><div class="card-body">
          <div class="small text-uppercase text-body-secondary">Online in UISP</div>
          <div class="stat-value" id="statOnline">–</div></div></div></div>
        <div class="col-6 col-xl-3"><div class="card stat-card"><div class="card-body">
          <div class="small text-uppercase text-body-secondary">In sync</div>
          <div class="stat-value text-success" id="statSync">–</div></div></div></div>
        <div class="col-6 col-xl-3"><div class="card stat-card"><div class="card-body">
          <div class="small text-uppercase text-body-secondary">Needs attention</div>
          <div class="stat-value text-warning" id="statAttn">–</div></div></div></div>
      </div>

      <div class="card">
        <div class="card-header d-flex flex-wrap align-items-center gap-2">
          <div class="input-group input-group-sm" style="max-width: 280px">
            <span class="input-group-text"><svg class="icon"><use href="/vendor/icons/sprites/free.svg#cil-search"></use></svg></span>
            <input class="form-control" id="devSearch" placeholder="Search name, IP, site" autocomplete="off">
          </div>
          <select class="form-select form-select-sm w-auto" id="devFilter">
            <option value="all">All states</option>
            <option value="ok">In sync</option>
            <option value="drift">Drift</option>
            <option value="missing">Not installed</option>
            <option value="unreachable">Unreachable</option>
            <option value="never">Never checked</option>
          </select>
          <span class="ms-auto small text-body-secondary" id="devCount"></span>
        </div>
        <div class="table-responsive">
          <table class="table table-hover table-devices mb-0" id="tbl" hidden>
            <thead class="table-light">
              <tr><th>Device</th><th>IP</th><th>Model</th><th>Watchdog</th><th>Last deploy</th><th></th></tr>
            </thead>
            <tbody id="rows"></tbody>
          </table>
          <div class="text-center text-body-secondary py-5" id="empty">
            No devices yet. Use <strong>Sync from UISP</strong> to pull your ER-X-SFP fleet.
          </div>
          <div class="text-center text-body-secondary py-4" id="noMatch" hidden>No devices match the current filter.</div>
        </div>
      </div>
    </section>

    <!-- ===== Settings ===== -->
    <section id="view-settings" class="view" hidden>
      <form id="settingsForm" class="row g-4">
        <div class="col-lg-7">
          <div class="card">
            <div class="card-header fw-semibold">Fleet defaults</div>
            <div class="card-body">
              <p class="small text-body-secondary">Fleet-wide defaults for every device (per-device overrides win). Saved to the Pi's config.</p>
              <div id="defaultsFields"></div>
            </div>
          </div>
        </div>
        <div class="col-lg-5">
          <div class="card mb-4">
            <div class="card-header fw-semibold">Drift auto-check</div>
            <div class="card-body">
              <label class="form-label small" for="autoCheck">Interval in minutes</label>
              <input class="form-control form-control-sm mono" id="autoCheck" inputmode="numeric" autocomplete="off">
              <div class="form-text">0 disables. Needs SSH auth to run.</div>
            </div>
          </div>
          <div class="alert alert-success" id="settingsSaved" hidden>
            Saved. Next: <strong>Check all</strong>, then <strong>Deploy to all</strong> to apply.
          </div>
          <button class="btn btn-primary" type="submit" id="saveSettings">Save settings</button>
        </div>
      </form>
    </section>

    <!-- ===== Logs ===== -->
    <section id="view-logs" class="view" hidden>
      <div class="card">
        <div class="card-header d-flex flex-wrap align-items-center gap-2">
          <select class="form-select form-select-sm w-auto" id="logLevel">
            <option value="all">All levels</option>
            <option value="warn">Warnings and errors</option>
            <option value="error">Errors only</option>
          </select>
          <span class="small text-body-secondary">Also in <code>journalctl -u ubnt-hybrid-portal</code></span>
          <button class="btn btn-sm btn-outline-secondary ms-auto" id="logsRefresh" type="button">Refresh</button>
        </div>
        <div class="card-body"><pre class="log-pane" id="logPane">loading…</pre></div>
      </div>
    </section>

  </div>
</div>

<div class="toast-container position-fixed bottom-0 end-0 p-3" id="toasts"></div>

<div class="modal fade" id="dlg" tabindex="-1" aria-labelledby="dlgTitle" aria-hidden="true">
  <div class="modal-dialog modal-dialog-scrollable modal-lg">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title" id="dlgTitle"></h5>
        <button type="button" class="btn-close" data-coreui-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body" id="dlgBody"></div>
    </div>
  </div>
</div>

<script src="/vendor/coreui/js/coreui.bundle.min.js"></script>
<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `public/app.js` core**

```js
'use strict';
/* PoE watchdog fleet portal — frontend.
   Vanilla JS on CoreUI 5 (Bootstrap 5 bundled). Sections:
   helpers → router → devices view → row actions/modals → header actions → settings → logs → boot */

// --- helpers -------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ICONS = '/vendor/icons/sprites/free.svg';
const icon = (name, cls = 'icon') => `<svg class="${cls}"><use href="${ICONS}#cil-${name}"></use></svg>`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(iso) { return iso ? new Date(iso).toLocaleString() : ''; }

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg, { variant = '', ms = 3500 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast align-items-center border-0' + (variant ? ` text-bg-${variant}` : '');
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(msg)}</div>
    <button type="button" class="btn-close me-2 m-auto${variant && variant !== 'warning' ? ' btn-close-white' : ''}"
      data-coreui-dismiss="toast" aria-label="Close"></button></div>`;
  $('#toasts').appendChild(el);
  el.addEventListener('hidden.coreui.toast', () => el.remove());
  new coreui.Toast(el, { delay: ms }).show();
}

// one shared modal; callers set title + body html
const dlg = {
  el: null, inst: null,
  open(title, html, { size = 'modal-lg' } = {}) {
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = html;
    $('.modal-dialog', this.el).className = `modal-dialog modal-dialog-scrollable ${size}`.trim();
    this.inst.show();
  },
  body(html) { $('#dlgBody').innerHTML = html; },
  close() { this.inst.hide(); },
};

// disable a button and show a spinner while an async action runs
function busy(btn, on) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>${esc(btn.textContent.trim())}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label !== undefined) btn.innerHTML = btn.dataset.label;
  }
}

// label + input row used by settings, overrides and ssh forms
function fieldHtml(prefix, key, value, placeholder) {
  const id = `${prefix}-${key}`;
  return `<div class="row mb-2 align-items-center">
    <label class="col-sm-4 col-form-label col-form-label-sm mono" for="${esc(id)}">${esc(key)}</label>
    <div class="col-sm-8"><input class="form-control form-control-sm mono" id="${esc(id)}" name="${esc(key)}"
      value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"></div></div>`;
}

// --- router --------------------------------------------------------------------
// stubs; replaced by the devices/settings/logs sections below
async function loadDevices() {}
async function loadSettings() {}
async function loadLogs() {}

const VIEWS = {
  devices: { title: 'Devices', enter: () => loadDevices() },
  settings: { title: 'Settings', enter: () => loadSettings() },
  logs: { title: 'Logs', enter: () => loadLogs() },
};

function currentView() {
  const name = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0];
  return VIEWS[name] ? name : 'devices';
}

function route() {
  const name = currentView();
  $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + name));
  $$('.sidebar-nav .nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  $('#viewTitle').textContent = VIEWS[name].title;
  document.title = `${VIEWS[name].title} · PoE watchdog fleet`;
  if (dlg.inst) dlg.close();
  const sb = coreui.Sidebar.getInstance($('#sidebar'));
  if (sb && window.innerWidth < 992) sb.hide();
  VIEWS[name].enter().catch((e) => toast(e.message, { variant: 'danger', ms: 6000 }));
}
window.addEventListener('hashchange', route);

// --- boot ----------------------------------------------------------------------
(async () => {
  dlg.el = $('#dlg');
  dlg.inst = new coreui.Modal(dlg.el);
  $('#btnSidebar').onclick = () => coreui.Sidebar.getOrCreateInstance($('#sidebar')).toggle();
  route();
})();
```

- [ ] **Step 4: Verify in the browser**

```bash
node server.js & sleep 1
curl -s -u admin:change-me http://127.0.0.1:8090/ | grep -c 'cdn\|https://'
```

Expected: `0` (no external URLs in the page).

Open `http://admin:change-me@127.0.0.1:8090/` in a browser and confirm:
- Light page, left sidebar with brand and three items, sticky header with the five buttons.
- Clicking Settings / Logs swaps the visible section, updates the header title and the active sidebar item, and the URL hash becomes `#/settings` / `#/logs`. Reloading on `#/logs` lands on Logs. Browser back returns to the prior view.
- Network tab: every request is to `127.0.0.1:8090`; no failed requests.
- Resize below 992px: sidebar hides, hamburger appears in the header, clicking it slides the sidebar in with a backdrop; picking a nav item closes it.
- Console has no errors.

Stop the server with `kill %1`.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.css public/app.js
git commit -m "UI: CoreUI light shell with sidebar views, router, toast + modal helpers"
```

---

### Task 3: Devices view — load, stat cards, table, search and status filter

**Files:**
- Modify: `public/app.js` (replace the `loadDevices` stub; add devices section)

**Interfaces:**
- Consumes: `$`, `$$`, `esc`, `fmtTime`, `api`, `toast` from Task 2; DOM ids from Task 2.
- Produces: globals `DEFAULTS` (object), `RESCUES` (Set of device keys), `DEVICES` (array), `wdState(d)` → `{ key, variant, label, detail }` where `key ∈ 'never'|'unreachable'|'missing'|'drift'|'ok'`, `loadDevices()`, `renderDevices()`, `rowHtml(d)`. Row action buttons carry `data-a` in `check|deploy|status|config|preview|rescue`; Task 4 attaches the handler.

- [ ] **Step 1: Replace the `loadDevices` stub with the devices section**

Delete the line `async function loadDevices() {}` and insert this block after the `// --- router` section (before `// --- boot`):

```js
// --- devices view --------------------------------------------------------------
let DEFAULTS = {};          // fleet defaults, placeholders in the overrides modal
let RESCUES = new Set();    // device keys with rescue armed
let DEVICES = [];           // last loaded fleet, sorted by name

// classify a device's watchdog state (same rules as the old syncLed)
function wdState(d) {
  const c = d.lastCheck;
  if (!c) return { key: 'never', variant: 'secondary', label: 'never checked', detail: '' };
  if (c.error) return { key: 'unreachable', variant: 'danger', label: 'unreachable', detail: c.error };
  if (!c.installed) return { key: 'missing', variant: 'danger', label: 'not installed', detail: '' };
  if (!c.inSync) return { key: 'drift', variant: 'warning', label: 'drift detected', detail: 'remote script differs from rendered config' };
  if (!c.scheduled) return { key: 'drift', variant: 'warning', label: 'in sync, no scheduler', detail: 'task-scheduler entries missing' };
  return { key: 'ok', variant: 'success', label: 'in sync + scheduled', detail: '' };
}
const ATTENTION = new Set(['drift', 'missing', 'unreachable']);

async function loadDevices() {
  RESCUES = new Set(await api('GET', '/api/rescues').then((j) => j.rescues).catch(() => []));
  const j = await api('GET', '/api/devices');
  $('#lastSync').textContent = j.lastSync ? 'synced ' + fmtTime(j.lastSync) : 'not synced yet';
  DEVICES = j.devices.sort((a, b) => a.name.localeCompare(b.name));
  renderDevices();
}

function renderStats(devs) {
  const states = devs.map(wdState);
  $('#statTotal').textContent = devs.length;
  $('#statOnline').textContent = devs.filter((d) => d.online).length;
  $('#statSync').textContent = states.filter((s) => s.key === 'ok').length;
  $('#statAttn').textContent = states.filter((s) => ATTENTION.has(s.key)).length;
}

function renderDevices() {
  renderStats(DEVICES);
  const q = $('#devSearch').value.trim().toLowerCase();
  const f = $('#devFilter').value;
  const list = DEVICES.filter((d) => {
    if (f !== 'all' && wdState(d).key !== f) return false;
    if (!q) return true;
    return [d.name, d.ip, d.site, d.model].some((v) => String(v || '').toLowerCase().includes(q));
  });
  $('#rows').innerHTML = list.map(rowHtml).join('');
  $('#tbl').hidden = DEVICES.length === 0;
  $('#empty').hidden = DEVICES.length !== 0;
  $('#noMatch').hidden = !(DEVICES.length && !list.length);
  $('#devCount').textContent = DEVICES.length ? `${list.length} of ${DEVICES.length}` : '';
}

function rowHtml(d) {
  const w = wdState(d);
  const dep = !d.lastDeploy
    ? '<span class="text-body-secondary">—</span>'
    : d.lastDeploy.ok !== false
      ? esc(fmtTime(d.lastDeploy.at))
      : `<span class="text-danger" title="${esc(d.lastDeploy.error || '')}">failed ${esc(fmtTime(d.lastDeploy.at))}</span>`;
  const rescue = d.lastCheck && d.lastCheck.error
    ? `<li><button class="dropdown-item text-danger" type="button" data-a="rescue">${RESCUES.has(d.key) ? 'Disarm rescue' : 'Rescue'}</button></li>`
    : '';
  return `<tr data-key="${esc(d.key)}">
    <td>
      <span class="dot ${d.online ? 'dot-online' : 'dot-offline'}" title="${d.online ? 'online in UISP' : 'offline in UISP'}"></span>
      <span class="fw-semibold">${esc(d.name)}</span>
      <div class="small text-body-secondary ps-3">${esc(d.site || '')}</div>
    </td>
    <td class="mono">${esc(d.ip)}</td>
    <td class="mono">${esc(d.model)}</td>
    <td>
      <span class="badge text-bg-${w.variant}" title="${esc(w.detail)}">${esc(w.label)}</span>
      <div class="small text-body-secondary">${esc(d.lastCheck ? fmtTime(d.lastCheck.at) : '')}</div>
    </td>
    <td class="small">${dep}</td>
    <td class="text-end">
      <div class="btn-group btn-group-sm">
        <button class="btn btn-outline-secondary" type="button" data-a="check">Check</button>
        <button class="btn btn-outline-primary" type="button" data-a="deploy">Deploy</button>
        <button class="btn btn-outline-secondary dropdown-toggle dropdown-toggle-split" type="button"
          data-coreui-toggle="dropdown" data-coreui-popper-config='{"strategy":"fixed"}' aria-expanded="false">
          <span class="visually-hidden">More</span></button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><button class="dropdown-item" type="button" data-a="status">Watchdog status</button></li>
          <li><button class="dropdown-item" type="button" data-a="config">Overrides</button></li>
          <li><button class="dropdown-item" type="button" data-a="preview">View script</button></li>
          ${rescue}
        </ul>
      </div>
    </td>
  </tr>`;
}

$('#devSearch').addEventListener('input', renderDevices);
$('#devFilter').addEventListener('change', renderDevices);
```

Also change the boot block so the header's sync time and stats load even when the first view is Settings or Logs, and so `DEFAULTS` is ready for the overrides modal:

```js
(async () => {
  dlg.el = $('#dlg');
  dlg.inst = new coreui.Modal(dlg.el);
  $('#btnSidebar').onclick = () => coreui.Sidebar.getOrCreateInstance($('#sidebar')).toggle();
  DEFAULTS = await api('GET', '/api/defaults').then((j) => j.defaults).catch(() => ({}));
  if (currentView() !== 'devices') loadDevices().catch(() => {});
  route();
})();
```

- [ ] **Step 2: Verify in the browser**

Start `node server.js` (seed state from the "Local test environment" section must exist) and open the portal. Confirm:
- Stat cards read Devices 4, Online in UISP 3, In sync 1, Needs attention 2.
- Table shows four rows sorted Barn, Dock, Pump house, Shop. Badges: Barn green "in sync + scheduled", Dock amber "drift detected", Pump house red "unreachable" (hover shows the ETIMEDOUT text), Shop grey "never checked".
- Pump house Last deploy shows red "failed …"; Dock shows "—".
- Header shows "synced <local time>".
- Typing `dock` in search leaves one row and the counter reads "1 of 4". Clearing restores four.
- Filter "Unreachable" shows only Pump house. Filter "In sync" shows only Barn. Filter "Not installed" shows the "No devices match" message.
- The split dropdown opens and is not clipped by the table container; Pump house's menu has a red "Rescue" item, the others do not.
- Console has no errors. Buttons do nothing yet (Task 4).

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "UI: devices view with stat cards, table, search and state filter"
```

---

### Task 4: Row actions — check, deploy, status modal, overrides modal, script, rescue

**Files:**
- Modify: `public/app.js` (add after the devices view section)

**Interfaces:**
- Consumes: `DEVICES`, `RESCUES`, `DEFAULTS`, `loadDevices`, `busy`, `dlg`, `fieldHtml`, `toast`, `api`, `esc`, `$`, `$$`.
- Produces: `act(action, device, btn)`, `showStatus(d)`, `openOverrides(d)`, `toggleRescue(d)`.

- [ ] **Step 1: Add the row-action section**

Insert after the devices view section (after the two `addEventListener` lines) and before `// --- boot`:

```js
// --- per-device actions -----------------------------------------------------------
$('#rows').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-a]');
  if (!btn) return;
  const key = btn.closest('tr').dataset.key;
  const d = DEVICES.find((x) => x.key === key);
  if (d) act(btn.dataset.a, d, btn);
});

async function act(a, d, btn) {
  const spin = btn && !btn.classList.contains('dropdown-item');
  if (spin) busy(btn, true);
  try {
    if (a === 'check') {
      await api('POST', `/api/devices/${d.key}/check`);
      toast(`${d.name}: checked`);
    } else if (a === 'deploy') {
      const r = await api('POST', `/api/devices/${d.key}/deploy`);
      toast(`${d.name}: ${r.result.steps.join(', ')}`, { variant: 'success' });
    } else if (a === 'preview') {
      window.open(`/api/devices/${d.key}/preview`, '_blank');
    } else if (a === 'status') {
      await showStatus(d);
    } else if (a === 'config') {
      openOverrides(d);
    } else if (a === 'rescue') {
      await toggleRescue(d);
    }
  } catch (e) {
    toast(`${d.name}: ${e.message}`, { variant: 'danger', ms: 6000 });
  }
  if (spin) busy(btn, false);
  if (a === 'check' || a === 'deploy' || a === 'rescue') loadDevices();
}

async function showStatus(d) {
  dlg.open(`${d.name} — watchdog status`, `
    <div class="text-center py-4">
      <div class="spinner-border" role="status"></div>
      <div class="mt-2 small text-body-secondary">connecting to ${esc(d.ip)}…</div>
    </div>`);
  try {
    const r = await api('GET', `/api/devices/${d.key}/watchdog`);
    dlg.body(`<pre>${esc(r.status)}</pre><h6>Recent log lines</h6><pre>${esc(r.logs || '(none)')}</pre>`);
  } catch (e) {
    dlg.body(`<div class="alert alert-danger mb-2">${esc(e.message)}</div>
      <p class="small text-body-secondary mb-0">See <a href="#/logs">Logs</a>
      (or <code>journalctl -u ubnt-hybrid-portal</code>) for details.</p>`);
    throw e;
  }
}

function openOverrides(d) {
  const ov = d.overrides || {};
  dlg.open(`${d.name} — per-device overrides`, `
    <p class="small text-body-secondary">Blank fields inherit the fleet default (shown as placeholder). Save, then deploy to apply.</p>
    <form id="ovForm">
      ${Object.keys(DEFAULTS).map((k) => fieldHtml('ov', k, ov[k] ?? '', DEFAULTS[k])).join('')}
      <div class="text-end mt-3"><button class="btn btn-primary" type="submit">Save overrides</button></div>
    </form>`);
  $('#ovForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = {};
    $$('#ovForm input').forEach((i) => (body[i.name] = i.value.trim()));
    try {
      await api('PUT', `/api/devices/${d.key}/overrides`, body);
      dlg.close();
      toast(`${d.name}: overrides saved — deploy to apply`);
      loadDevices();
    } catch (e) {
      toast(`${d.name}: ${e.message}`, { variant: 'danger', ms: 6000 });
    }
  };
}

async function toggleRescue(d) {
  if (RESCUES.has(d.key)) {
    await api('DELETE', `/api/devices/${d.key}/rescue`);
    toast(`${d.name}: rescue disarmed`);
  } else {
    await api('POST', `/api/devices/${d.key}/rescue`);
    toast(`${d.name}: rescue armed — power-cycle the device now. The portal deploys the moment it answers.`,
      { variant: 'warning', ms: 8000 });
  }
}
```

- [ ] **Step 2: Verify in the browser**

Restart `node server.js` and open the portal. No SSH creds are set, so SSH actions return 428 with a clear message. Confirm:
- Check on Barn: the button shows a spinner, then a red toast "Barn switch: SSH credentials not set — …", button re-enables.
- Deploy on Barn: same red toast.
- Dropdown → Watchdog status on Barn: modal opens with spinner, then shows a red alert with the same message and a Logs link. Clicking the Logs link closes the modal and routes to Logs.
- Dropdown → Overrides on Dock: modal lists every key from `config.json` defaults, `GATEWAY_IP` has value `10.0.0.1`, others are blank with the fleet value as placeholder. Set `FAIL_LIMIT` to `7`, Save: modal closes, toast "Dock switch: overrides saved — deploy to apply". Reopen: `FAIL_LIMIT` is `7`. Clear it and Save: reopening shows it blank again. `state/devices.json` reflects the change.
- Dropdown → View script on Barn: new tab with the rendered shell script as plain text.
- Dropdown → Rescue on Pump house: red toast about SSH creds (rescue requires auth). That is the expected failure path.
- Console has no errors.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "UI: per-device actions, status + overrides modals, rescue toggle"
```

---

### Task 5: Header actions — SSH badge and modal, Sync, Check all, Deploy all

**Files:**
- Modify: `public/app.js` (add header section)

**Interfaces:**
- Consumes: `busy`, `dlg`, `fieldHtml`, `icon`, `toast`, `api`, `esc`, `loadDevices`, `$`.
- Produces: `loadSsh()` (updates `#btnSsh` label/colour), header click handlers.

- [ ] **Step 1: Add the header section**

Insert after the per-device actions section and before `// --- boot`:

```js
// --- header: SSH credentials (in-memory on the server; never stored) -----------------
async function loadSsh() {
  const b = $('#btnSsh');
  try {
    const j = await api('GET', '/api/ssh-creds');
    const ok = j.set || j.keyFallback;
    b.className = 'btn btn-sm ' + (ok ? 'btn-outline-success' : 'btn-outline-danger');
    b.innerHTML = j.set ? `${icon('lock-unlocked')} SSH: ${esc(j.username)}`
      : j.keyFallback ? `${icon('lock-unlocked')} SSH: key auth`
      : `${icon('lock-locked')} SSH: login required`;
  } catch (e) { /* badge is non-critical; leave the placeholder label */ }
}

$('#btnSsh').onclick = () => {
  dlg.open('SSH login', `
    <p class="small text-body-secondary">One admin login used for every device. Held in the portal's memory only —
      never written to disk — and forgotten when the portal restarts, so you'll re-enter it after a reboot.</p>
    <form id="sshForm">
      ${fieldHtml('ssh', 'username', 'ubnt', '')}
      <div class="row mb-2 align-items-center">
        <label class="col-sm-4 col-form-label col-form-label-sm mono" for="ssh-password">password</label>
        <div class="col-sm-8"><input class="form-control form-control-sm mono" type="password" id="ssh-password"
          name="password" autocomplete="off"></div>
      </div>
      <div class="d-flex gap-2 mt-3">
        <button class="btn btn-primary" type="submit">Use these credentials</button>
        <button class="btn btn-outline-secondary" type="button" id="sshClear">Forget credentials</button>
      </div>
    </form>
    <hr>
    <p class="small text-body-secondary"><strong>Recommended: set up key auth.</strong> Uses the username/password above
      ONE time to install the portal's public key on every device, verifies it, then forgets the password.
      No more logging in after restarts — and the admin password is never stored.</p>
    <button class="btn btn-outline-primary" type="button" id="sshKeySetup">Set up key auth on all devices</button>
    <div id="sshKeyResult" class="mt-3"></div>`, { size: '' });

  const save = async () => {
    await api('POST', '/api/ssh-creds', { username: $('#ssh-username').value.trim(), password: $('#ssh-password').value });
  };
  $('#sshForm').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await save(); dlg.close(); toast('SSH credentials set (memory only)', { variant: 'success' }); loadSsh(); }
    catch (e) { toast('SSH login: ' + e.message, { variant: 'danger', ms: 6000 }); }
  };
  $('#sshClear').onclick = async () => {
    await api('DELETE', '/api/ssh-creds');
    dlg.close(); toast('SSH credentials forgotten'); loadSsh();
  };
  $('#sshKeySetup').onclick = async (ev) => {
    const b = ev.currentTarget;
    busy(b, true);
    $('#sshKeyResult').innerHTML = '<div class="small text-body-secondary">Installing key on all devices…</div>';
    try {
      if ($('#ssh-password').value) await save(); // use freshly typed creds if present
      const r = await api('POST', '/api/ssh-keys/setup');
      const items = r.results.map((x) =>
        `<li class="list-group-item py-1 small ${x.ok ? 'text-success' : 'text-danger'}">${icon(x.ok ? 'check' : 'x')}
          ${esc(x.name)}${x.ok ? '' : ' — ' + esc(x.error)}</li>`).join('');
      $('#sshKeyResult').innerHTML = `<ul class="list-group list-group-flush">${items}</ul>
        <div class="alert ${r.enabled ? 'alert-success' : 'alert-warning'} small mt-3 mb-0">
          ${r.enabled ? 'Key auth enabled — password forgotten. Re-run this later for any failed device.'
                      : 'No device accepted the key; password kept.'}</div>`;
      loadSsh();
    } catch (e) {
      $('#sshKeyResult').innerHTML = `<div class="alert alert-danger mb-0">${esc(e.message)}</div>`;
    }
    busy(b, false);
  };
  dlg.el.addEventListener('shown.coreui.modal', () => $('#ssh-password')?.focus(), { once: true });
};

// --- header: fleet actions -----------------------------------------------------------
$('#btnSync').onclick = async (ev) => {
  const b = ev.currentTarget;
  busy(b, true);
  try {
    const r = await api('POST', '/api/sync');
    toast(`UISP sync: ${r.count} switches found`, { variant: 'success' });
    await loadDevices();
  } catch (e) {
    toast('Sync failed: ' + e.message, { variant: 'danger', ms: 6000 });
  }
  busy(b, false);
};

function fleet(action, label) {
  return async (ev) => {
    const b = ev.currentTarget;
    busy(b, true);
    try {
      const r = await api('POST', '/api/' + action);
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) toast(`${label}: ${bad.length} failure(s) — ${bad.map((x) => x.name).join(', ')}`, { variant: 'danger', ms: 8000 });
      else toast(`${label}: all ${r.results.length} devices OK`, { variant: 'success' });
    } catch (e) {
      toast(`${label} failed: ${e.message}`, { variant: 'danger', ms: 6000 });
    }
    busy(b, false);
    loadDevices();
  };
}
$('#btnCheckAll').onclick = fleet('check-all', 'Check all');
$('#btnDeployAll').onclick = fleet('deploy-all', 'Deploy to all');
```

Add `loadSsh();` to the boot block, right after the `DEFAULTS = …` line.

- [ ] **Step 2: Verify in the browser**

Restart `node server.js`, open the portal. Confirm:
- Header SSH button is red-outlined "SSH: login required" with a padlock icon.
- Click it: a normal-width modal opens with username `ubnt` prefilled and focus in the password field. Submit with an empty password: red toast "SSH login: username and password are required". Enter any password and press Enter: modal closes, green toast, button turns green "SSH: ubnt".
- Check all: button spinner, then red toast "Check all: 4 failure(s) — Barn switch, Dock switch, Pump house, Shop switch" (SSH to the fake IPs times out; this can take up to the configured 10s ready timeout). Fleet check failures do not rewrite `lastCheck`, so the badges stay as seeded.
- Rescue on Pump house (its dropdown has the item because its seeded check errored): amber toast "rescue armed — power-cycle…", row re-renders, dropdown item reads "Disarm rescue". Click Disarm rescue: toast "rescue disarmed", item reads "Rescue" again.
- Deploy to all: same spinner and failure toast.
- Reopen SSH modal → Forget credentials: modal closes, button turns red again.
- Sync from UISP: with the example config, expect a red toast "Sync failed: …" (unreachable UISP host). Button re-enables.
- Console has no errors.

Restore the seed state afterwards so later tasks see the mixed states (server stopped):

```bash
cp state/seed.json state/devices.json
```

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "UI: SSH login modal + auth badge, sync and fleet actions with spinners"
```

---

### Task 6: Settings view

**Files:**
- Modify: `public/app.js` (replace the `loadSettings` stub; add settings section)

**Interfaces:**
- Consumes: `fieldHtml`, `busy`, `toast`, `api`, `$`, `$$`, `DEFAULTS`.
- Produces: `loadSettings()`.

- [ ] **Step 1: Replace the `loadSettings` stub**

Delete `async function loadSettings() {}` and insert before `// --- boot`:

```js
// --- settings view ----------------------------------------------------------------
async function loadSettings() {
  const s = await api('GET', '/api/settings');
  $('#defaultsFields').innerHTML = Object.keys(s.defaults).map((k) => fieldHtml('set', k, s.defaults[k], '')).join('');
  $('#autoCheck').value = s.autoCheckMinutes;
  $('#settingsSaved').hidden = true;
}

$('#settingsForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const b = $('#saveSettings');
  busy(b, true);
  const defaults = {};
  $$('#defaultsFields input').forEach((i) => (defaults[i.name] = i.value.trim()));
  try {
    const r = await api('PUT', '/api/settings', { defaults, autoCheckMinutes: $('#autoCheck').value.trim() });
    DEFAULTS = r.defaults;
    $('#autoCheck').value = r.autoCheckMinutes;
    $('#settingsSaved').hidden = false;
    loadDevices(); // drift badges are unaffected until a check, but keep the list fresh
  } catch (e) {
    toast('Save failed: ' + e.message, { variant: 'danger', ms: 6000 });
  }
  busy(b, false);
};
```

- [ ] **Step 2: Verify**

Restart `node server.js`, open `#/settings`. Confirm:
- Left card lists the nine default keys from `config.json` with their values in monospace inputs; right card shows auto-check interval `15`.
- Change `FAIL_LIMIT` to `6` and interval to `0`, Save: spinner, then the green alert appears. `config.json` on disk now has `"FAIL_LIMIT": 6` and `"autoCheckMinutes": 0`; server log line "auto-check disabled" appears in the terminal.
- Go to Devices, open Overrides on Shop: `FAIL_LIMIT` placeholder now reads `6`.
- Set the values back (`FAIL_LIMIT` 5, interval 15) and Save.
- Navigating away and back hides the green alert and reloads values from the server.

Check the file:

```bash
grep -E '"FAIL_LIMIT"|"autoCheckMinutes"' config.json
```

Expected (after restoring): `"autoCheckMinutes": 15` and `"FAIL_LIMIT": 5`.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "UI: settings view for fleet defaults and auto-check interval"
```

---

### Task 7: Logs view

**Files:**
- Modify: `public/app.js` (replace the `loadLogs` stub; add logs section)

**Interfaces:**
- Consumes: `busy`, `toast`, `api`, `$`.
- Produces: `loadLogs()`, `renderLogs()`, global `LOGS`.

- [ ] **Step 1: Replace the `loadLogs` stub**

Delete `async function loadLogs() {}` and insert before `// --- boot`:

```js
// --- logs view ------------------------------------------------------------------
let LOGS = [];
const LEVEL_RANK = { info: 0, warn: 1, error: 2 };

async function loadLogs() {
  const j = await api('GET', '/api/logs');
  LOGS = j.entries;
  renderLogs();
}

function renderLogs() {
  const min = $('#logLevel').value; // 'all' | 'warn' | 'error' = minimum level shown
  const lines = LOGS
    .filter((e) => min === 'all' || (LEVEL_RANK[e.level] ?? 0) >= LEVEL_RANK[min])
    .map((e) => {
      const meta = e.meta
        ? ' ' + Object.entries(e.meta).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
        : '';
      return `${e.at} ${e.level.toUpperCase().padEnd(5)} ${e.msg}${meta}`;
    });
  const pane = $('#logPane');
  pane.textContent = lines.join('\n') || '(no entries yet)';
  pane.scrollTop = pane.scrollHeight;
}

$('#logLevel').onchange = renderLogs;
$('#logsRefresh').onclick = async (ev) => {
  const b = ev.currentTarget;
  busy(b, true);
  try { await loadLogs(); } catch (e) { toast(e.message, { variant: 'danger', ms: 6000 }); }
  busy(b, false);
};
```

- [ ] **Step 2: Verify**

Restart `node server.js`, open the portal, click Check all once (generates warn/error lines), then go to Logs. Confirm:
- Monospace panel lists entries in `YYYY-MM-DD HH:MM:SS LEVEL msg k=v` format, scrolled to the bottom.
- "Warnings and errors" hides INFO lines; "Errors only" leaves only ERROR lines; "All levels" restores everything.
- Refresh shows a spinner briefly and appends the new `GET /api/logs` entry at the bottom.
- Console has no errors.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "UI: logs view with level filter and refresh"
```

---

### Task 8: README note, install-path check, and full walkthrough

**Files:**
- Modify: `README.md` (one short paragraph under "Manual setup")
- Verify: `install.sh` needs no change (it already runs `npm install --omit=dev`, which now pulls the vendor packages)

- [ ] **Step 1: README**

Under the "Manual setup" heading in `README.md`, after the code block, add:

```markdown
The web UI is plain HTML/JS on [CoreUI 5](https://coreui.io/) (Bootstrap 5),
vendored through npm and served by the portal itself from `/vendor/…`, so the
Pi needs no internet access to render it.
```

- [ ] **Step 2: Confirm the release tarball path works like the installer**

The installer rsyncs the repo minus `node_modules` and then runs `npm install`. Simulate that:

```bash
cd /private/tmp/claude-501/-Users-bryce-Documents-poe-portal/b5f8bbe3-e085-463c-a2e8-1c0b244f446d/scratchpad
rm -rf inst && mkdir inst
rsync -a --exclude node_modules --exclude config.json --exclude 'state/' --exclude .git /Users/bryce/Documents/poe-portal/ inst/
cd inst && npm install --omit=dev --no-audit --no-fund --loglevel=error
ls node_modules/@coreui/coreui/dist/css/coreui.min.css node_modules/@coreui/icons/sprites/free.svg
```

Expected: both paths listed, no error.

- [ ] **Step 3: Full walkthrough against the spec checklist**

Restart `node server.js` in the repo and run the spec's verification list end to end:

1. Network tab: all CSS/JS from `/vendor/...` and `/app.*`, no external hosts.
2. Devices: stat cards match the table; search and filter narrow rows; Check, Deploy, Status modal, Overrides save, View script, Rescue toggle.
3. Header: SSH button states, SSH modal flows, Sync, Check all, Deploy to all with spinner and result toast.
4. Settings: load, edit, save, placeholders update in the Overrides modal.
5. Logs: entries, level filter, refresh, auto-scroll.
6. Hash routing: reload on each route lands on that view; back button works.
7. Phone width: sidebar collapses, toggler opens it, table scrolls horizontally inside its card, header buttons wrap without overflowing.

Also run a quick static check that nothing from the old UI lingers:

```bash
grep -n 'var(--bg)\|var(--amber)\|<dialog\|showModal' public/index.html public/app.js public/app.css; echo "exit=$?"
```

Expected: no matches, `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: note CoreUI-based UI served from /vendor"
```

Do not bump the version or push; the user runs the release script themselves.
