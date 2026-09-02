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
  el.setAttribute('role', variant === 'danger' ? 'alert' : 'status');
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

const VIEWS = {
  devices: { title: 'Devices', enter: () => loadDevices() },
  aps: { title: 'Access points', enter: () => loadAps() },
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
  clearInterval(APS_TIMER);
  APS_TIMER = null;
  if (name === 'aps') APS_TIMER = setInterval(refreshAps, 30000);
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

// fire-and-forget reload; surfaces failures as a toast instead of an unhandled rejection
function refreshDevices() {
  return loadDevices().catch((e) => toast('Reload failed: ' + e.message, { variant: 'danger', ms: 6000 }));
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
  if (a === 'check' || a === 'deploy' || a === 'rescue') refreshDevices();
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
      refreshDevices();
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

// --- access points view --------------------------------------------------------
let APS = { aps: [], reboot: {}, configured: true, syncedAt: null };
let APS_TIMER = null;

async function loadAps() {
  APS = await api('GET', '/api/aps');
  renderAps();
}

function refreshAps() {
  return loadAps().catch((e) => toast('Reload failed: ' + e.message, { variant: 'danger', ms: 6000 }));
}

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

function renderApSchedule() {
  const r = APS.reboot || {};
  const badge = $('#rbBadge');
  badge.className = 'badge ' + (r.enabled ? 'text-bg-success' : 'text-bg-secondary');
  badge.textContent = r.enabled ? 'schedule on' : 'schedule off';
  $('#rbSummary').textContent = `${DAY_NAMES[r.day] || '?'} ${r.start} for ${r.hours} h, ${r.concurrency} at a time`;
  const bits = [];
  if (r.inFlight && r.inFlight.length) bits.push(`${r.inFlight.length} in flight`);
  if (r.queueLength) bits.push(`${r.queueLength} queued`);
  if (r.cycleStartedAt) bits.push(`cycle started ${fmtTime(r.cycleStartedAt)}`);
  else if (r.lastCycleCompletedAt) bits.push(`last cycle done ${fmtTime(r.lastCycleCompletedAt)}`);
  if (r.enabled && r.nextWindowAt) bits.push(`next window ${fmtTime(r.nextWindowAt)}`);
  $('#rbProgress').textContent = bits.join(' · ');
}

function renderAps() {
  const list = APS.aps || [];
  $('#apsNotConfigured').hidden = APS.configured !== false;
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  $('#apStatTotal').textContent = list.length;
  $('#apStatOnline').textContent = list.filter((a) => a.online).length;
  $('#apStatOffline').textContent = list.filter((a) => !a.online).length;
  $('#apStatRebooted').textContent = list.filter((a) => a.lastReboot && a.lastReboot.result === 'ok' && new Date(a.lastReboot.at) > week).length;
  renderApSchedule();
  $('#apSynced').textContent = APS.syncedAt ? 'synced ' + fmtTime(APS.syncedAt) : 'not synced yet';

  const q = $('#apSearch').value.trim().toLowerCase();
  const f = $('#apFilter').value;
  const rows = list.filter((a) => {
    if (f === 'online' && !a.online) return false;
    if (f === 'offline' && a.online) return false;
    if (f === 'skipped' && !a.skip) return false;
    if (!q) return true;
    return [a.name, a.mac, a.ip, a.model].some((v) => String(v || '').toLowerCase().includes(q));
  });
  $('#apRows').innerHTML = rows.map(apRowHtml).join('');
  $('#apTbl').hidden = list.length === 0;
  $('#apEmpty').hidden = list.length !== 0;
  $('#apNoMatch').hidden = !(list.length && !rows.length);
  $('#apCount').textContent = list.length ? `${rows.length} of ${list.length}` : '';
}

function apRowHtml(a) {
  const lr = a.lastReboot;
  const resVariant = !lr ? '' : lr.result === 'ok' ? 'success' : /^skipped/.test(lr.result) ? 'secondary' : 'danger';
  const last = lr
    ? `${esc(fmtTime(lr.at))}<div class="small"><span class="badge text-bg-${resVariant}">${esc(lr.result)}</span>
        <span class="text-body-secondary">via ${esc(lr.method)}${lr.via ? ' · ' + esc(lr.via) + ' ' + esc(lr.port || '') : ''}</span></div>`
    : '<span class="text-body-secondary">—</span>';
  const state = a.inFlight
    ? '<span class="badge text-bg-warning">rebooting…</span>'
    : `<span class="badge text-bg-${a.online ? 'success' : 'danger'}">${a.online ? 'online' : 'offline'}</span>`;
  return `<tr data-mac="${esc(a.mac)}" class="${a.inFlight ? 'ap-inflight' : ''}">
    <td>${state}${a.queued ? '<div class="small text-body-secondary">queued</div>' : ''}</td>
    <td class="fw-semibold">${esc(a.name)}</td>
    <td>${esc(a.model)}</td>
    <td class="mono">${esc(a.mac)}</td>
    <td class="mono">${esc(a.ip)}</td>
    <td class="mono">${esc(a.firmware)}</td>
    <td class="small">${last}</td>
    <td class="text-end text-nowrap">
      <div class="form-check form-switch d-inline-block me-2 align-middle" title="Skip this AP in the weekly reboot">
        <input class="form-check-input" type="checkbox" data-a="skip" ${a.skip ? 'checked' : ''}>
        <label class="form-check-label small">skip</label>
      </div>
      <button class="btn btn-sm btn-outline-primary" type="button" data-a="reboot" ${a.inFlight ? 'disabled' : ''}>Reboot now</button>
    </td></tr>`;
}

$('#apRows').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-a]');
  if (!btn) return;
  const mac = btn.closest('tr').dataset.mac;
  const a = (APS.aps || []).find((x) => x.mac === mac);
  if (a && btn.dataset.a === 'reboot') confirmApReboot(a);
});
$('#apRows').addEventListener('change', async (ev) => {
  const sw = ev.target.closest('input[data-a="skip"]');
  if (!sw) return;
  const mac = sw.closest('tr').dataset.mac;
  try {
    const r = await api('PUT', `/api/aps/${mac}`, { skip: sw.checked });
    toast(r.skip ? 'Skipped in weekly reboot' : 'Included in weekly reboot');
  } catch (e) { toast(e.message, { variant: 'danger', ms: 6000 }); }
  refreshAps();
});

function confirmApReboot(a) {
  dlg.open(`Reboot ${a.name}?`, `
    <p>${a.online
      ? 'The AP is online: UniFi will be asked to restart it gracefully.'
      : 'The AP is <strong>offline</strong>: the portal will power-cycle its PoE port on the switch that last saw it.'}
    Clients on it will drop for a few minutes.</p>
    <div class="text-end"><button class="btn btn-outline-secondary me-2" type="button" data-coreui-dismiss="modal">Cancel</button>
      <button class="btn btn-primary" type="button" id="apRebootGo">Reboot now</button></div>`, { size: '' });
  $('#apRebootGo').onclick = async (ev) => {
    const b = ev.currentTarget;
    busy(b, true);
    try {
      const r = await api('POST', `/api/aps/${a.mac}/reboot`);
      dlg.close();
      toast(`${a.name}: reboot issued via ${r.method}`, { variant: 'success' });
    } catch (e) {
      toast(`${a.name}: ${e.message}`, { variant: 'danger', ms: 8000 });
    }
    busy(b, false);
    refreshAps();
  };
}

$('#apSearch').addEventListener('input', renderAps);
$('#apFilter').addEventListener('change', renderAps);
$('#btnApSync').onclick = async (ev) => {
  const b = ev.currentTarget;
  busy(b, true);
  try { const r = await api('POST', '/api/aps/sync'); toast(`UniFi sync: ${r.count} access points`, { variant: 'success' }); await loadAps(); }
  catch (e) { toast('UniFi sync failed: ' + e.message, { variant: 'danger', ms: 6000 }); }
  busy(b, false);
};

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
    try { await api('DELETE', '/api/ssh-creds'); dlg.close(); toast('SSH credentials forgotten'); loadSsh(); }
    catch (e) { toast('SSH login: ' + e.message, { variant: 'danger', ms: 6000 }); }
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
    refreshDevices();
  };
}
$('#btnCheckAll').onclick = fleet('check-all', 'Check all');
$('#btnDeployAll').onclick = fleet('deploy-all', 'Deploy to all');

// --- settings view ----------------------------------------------------------------
async function loadSettings() {
  const s = await api('GET', '/api/settings');
  $('#defaultsFields').innerHTML = Object.keys(s.defaults).map((k) => fieldHtml('set', k, s.defaults[k], '')).join('');
  $('#autoCheck').value = s.autoCheckMinutes;
  const u = s.unifi || {};
  const r = u.reboot || {};
  $('#unifiStatus').textContent = u.configured ? 'Controller configured (API key in config.json).' : 'Not configured: set unifi.url and unifi.apiKey in config.json.';
  $('#unifiRefresh').value = u.refreshMinutes ?? 5;
  $('#rbEnabled').checked = !!r.enabled;
  $('#rbDay').value = String(r.day ?? 3);
  $('#rbStart').value = r.start ?? '02:00';
  $('#rbHours').value = r.hours ?? 3;
  $('#rbConc').value = r.concurrency ?? 3;
  $('#rbTimeout').value = r.timeoutMinutes ?? 8;
  $('#settingsSaved').hidden = true;
}

$('#settingsForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const b = $('#saveSettings');
  busy(b, true);
  const defaults = {};
  $$('#defaultsFields input').forEach((i) => (defaults[i.name] = i.value.trim()));
  try {
    const r = await api('PUT', '/api/settings', {
      defaults,
      autoCheckMinutes: $('#autoCheck').value.trim(),
      unifi: {
        refreshMinutes: $('#unifiRefresh').value.trim(),
        reboot: {
          enabled: $('#rbEnabled').checked,
          day: $('#rbDay').value,
          start: $('#rbStart').value.trim(),
          hours: $('#rbHours').value.trim(),
          concurrency: $('#rbConc').value.trim(),
          timeoutMinutes: $('#rbTimeout').value.trim(),
        },
      },
    });
    DEFAULTS = r.defaults;
    $('#autoCheck').value = r.autoCheckMinutes;
    $('#settingsSaved').hidden = false;
    refreshDevices(); // drift badges are unaffected until a check, but keep the list fresh
  } catch (e) {
    toast('Save failed: ' + e.message, { variant: 'danger', ms: 6000 });
  }
  busy(b, false);
};

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

// --- boot ----------------------------------------------------------------------
(async () => {
  dlg.el = $('#dlg');
  dlg.inst = new coreui.Modal(dlg.el);
  $('#btnSidebar').onclick = () => coreui.Sidebar.getOrCreateInstance($('#sidebar')).toggle();
  route();
  DEFAULTS = await api('GET', '/api/defaults').then((j) => j.defaults).catch(() => ({}));
  loadSsh();
  if (currentView() !== 'devices') loadDevices().catch(() => {});
})();
