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

// --- boot ----------------------------------------------------------------------
(async () => {
  dlg.el = $('#dlg');
  dlg.inst = new coreui.Modal(dlg.el);
  $('#btnSidebar').onclick = () => coreui.Sidebar.getOrCreateInstance($('#sidebar')).toggle();
  DEFAULTS = await api('GET', '/api/defaults').then((j) => j.defaults).catch(() => ({}));
  if (currentView() !== 'devices') loadDevices().catch(() => {});
  route();
})();
