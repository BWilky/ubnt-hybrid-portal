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
