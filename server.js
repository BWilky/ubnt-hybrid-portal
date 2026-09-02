'use strict';
// poe-watchdog-portal: UISP inventory -> per-device rendered watchdog script
// -> SSH deploy + drift detection + status, behind a tiny dashboard.

const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const express = require('express');
const uisp = require('./lib/uisp');
const ssh = require('./lib/ssh');
const log = require('./lib/log');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state', 'devices.json');
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'poe-watchdog.sh.tpl');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('No config.json found. Copy config.example.json to config.json and edit it.');
  process.exit(1);
}
const { writeFileAtomic } = require('./lib/fsutil');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
delete cfg.defaults.AP_CYCLE_CRON; // retired; tolerated in old config files
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

// --- persisted state: device list + per-device overrides + last results -----
let state = { devices: {}, lastSync: null };
if (fs.existsSync(STATE_PATH)) {
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { /* fresh */ }
}
function saveState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- in-memory SSH credentials ------------------------------------------------
// Entered via the GUI, held only in this variable, never persisted anywhere.
// Lost on restart by design — re-enter them in the portal.
let sshCreds = null; // { username, password } | null

function requireAuth(res) {
  if (ssh.haveAuth(cfg, sshCreds)) return true;
  res.status(428).json({
    ok: false,
    error: 'SSH credentials not set — click "SSH login" in the portal header first.',
  });
  return false;
}

// --- template rendering ------------------------------------------------------
function renderScript(dev) {
  const vars = { ...cfg.defaults, ...(dev.overrides || {}) };
  const all = {
    ...vars,
    DEVICE_NAME: dev.name,
    DEVICE_IP: dev.ip,
    // NOTE: RENDERED_AT is deliberately static per-content, not a timestamp,
    // so the hash only changes when the actual config/content changes.
    RENDERED_AT: 'portal-managed',
    // backhaul radio MACs from UISP — ports carrying these are never touched
    PROTECTED_MACS: (state.protectedMacs || []).join(' '),
    // UniFi AP MACs — strict whitelist of ports the watchdog may manage
    ALLOWED_MACS: (state.allowedMacs || []).join(' '),
  };
  let out = template;
  for (const [k, v] of Object.entries(all)) {
    out = out.split('{{' + k + '}}').join(String(v));
  }
  return { script: out, vars };
}

// --- express -----------------------------------------------------------------
const app = express();
app.use(express.json());

// very small basic-auth gate (run this on a trusted mgmt network regardless)
app.use((req, res, next) => {
  const { authUser, authPass } = cfg.portal;
  if (!authUser) return next();
  const hdr = req.headers.authorization || '';
  const [user, pass] = Buffer.from(hdr.split(' ')[1] || '', 'base64').toString().split(':');
  if (user === authUser && pass === authPass) return next();
  res.set('WWW-Authenticate', 'Basic realm="poe-portal"').status(401).send('auth required');
});

app.use(express.static(path.join(__dirname, 'public')));

// vendored UI assets (CoreUI bundles Bootstrap 5 + Popper) — served from
// node_modules so the Pi needs no internet access to render the portal
app.use('/vendor/coreui', express.static(path.join(__dirname, 'node_modules', '@coreui', 'coreui', 'dist')));
app.use('/vendor/icons', express.static(path.join(__dirname, 'node_modules', '@coreui', 'icons')));

// log every API call with its outcome and duration
app.use('/api', (req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    log.info(`${req.method} ${req.originalUrl}`, { status: res.statusCode, ms: Date.now() - t0 });
  });
  next();
});

// GET /api/logs -- recent portal log entries (ring buffer, for the UI)
app.get('/api/logs', (req, res) => res.json({ entries: log.recent(200) }));

// --- SSH credential endpoints (in-memory only) --------------------------------
// GET returns whether creds are set (never the password itself).
app.get('/api/ssh-creds', (req, res) => {
  res.json({
    set: !!sshCreds,
    username: sshCreds ? sshCreds.username : null,
    keyFallback: !sshCreds && ssh.haveAuth(cfg, null),
  });
});

// POST stores creds in memory for this process only.
app.post('/api/ssh-creds', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }
  sshCreds = { username: String(username), password: String(password) };
  log.info('SSH credentials set (memory only)', { username: sshCreds.username });
  res.json({ ok: true, username: sshCreds.username });
});

// DELETE wipes them.
app.delete('/api/ssh-creds', (req, res) => {
  sshCreds = null;
  log.info('SSH credentials cleared');
  res.json({ ok: true });
});

// POST /api/ssh-keys/setup -- one-click key auth:
// generate an ed25519 keypair (kept in state/, which updates preserve),
// install the public key on every device using the in-memory password creds,
// verify key login works, persist privateKeyPath to config.json, then forget
// the password. Idempotent: re-run any time to cover devices that failed.
app.post('/api/ssh-keys/setup', async (req, res) => {
  if (!sshCreds) {
    return res.status(428).json({ ok: false, error: 'Enter the SSH username/password first — key setup uses it once to install the key.' });
  }
  const devs = Object.values(state.devices);
  if (!devs.length) return res.status(400).json({ ok: false, error: 'No devices — sync from UISP first.' });

  try {
    const keyPath = path.join(__dirname, 'state', 'portal_ed25519');
    if (!fs.existsSync(keyPath)) {
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'ubnt-hybrid-portal', '-f', keyPath]);
      log.info('generated ed25519 keypair', { keyPath });
    }
    const [type, b64] = fs.readFileSync(keyPath + '.pub', 'utf8').trim().split(/\s+/);
    const pub = { name: 'ubnt-hybrid-portal', type, b64 };
    const keyCfg = { ...cfg, ssh: { ...cfg.ssh, username: sshCreds.username, privateKeyPath: keyPath } };

    const results = await ssh.pooledMap(devs, cfg.ssh.concurrency || 4, async (dev) => {
      await ssh.installPubkey(cfg, sshCreds, dev.ip, pub);
      try {
        await ssh.ping(keyCfg, null, dev.ip);
      } catch (e) {
        throw new Error('key installed but key login failed: ' + e.message);
      }
      return true;
    });

    const out = devs.map((d, i) => ({ key: d.key, name: d.name, ...results[i] }));
    const okCount = out.filter((r) => r.ok).length;

    if (okCount > 0) {
      // persist the key fallback and drop the password from memory
      const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      disk.ssh.username = sshCreds.username;
      disk.ssh.privateKeyPath = keyPath;
      writeFileAtomic(CONFIG_PATH, JSON.stringify(disk, null, 2) + '\n', { mode: 0o600 });
      cfg.ssh.username = sshCreds.username;
      cfg.ssh.privateKeyPath = keyPath;
      sshCreds = null;
      log.info('key auth enabled; password creds forgotten', { ok: okCount, failed: devs.length - okCount });
    }
    res.json({ ok: okCount === devs.length, results: out, enabled: okCount > 0 });
  } catch (e) {
    log.error('key setup failed', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- rescue mode ---------------------------------------------------------------
// For a device that locked itself out (e.g. cut PoE to its own backhaul):
// arm rescue, then physically power-cycle the device. The portal polls the IP
// and deploys the current (fixed) script the moment SSH answers — winning the
// race against an old on-device script that would re-cut PoE minutes after
// boot. Keeps polling through failed attempts; expires after 2 hours.
const rescues = {}; // key -> { startedAt, status }

function rescueTick(key) {
  const r = rescues[key];
  const dev = state.devices[key];
  if (!r || !dev) return;
  if (Date.now() - r.startedAt > 2 * 60 * 60 * 1000) {
    delete rescues[key];
    log.warn('rescue expired after 2h', { device: dev.name });
    return;
  }
  ssh.ping(cfg, sshCreds, dev.ip)
    .then(async () => {
      log.info('rescue: device answered — deploying immediately', { device: dev.name, ip: dev.ip });
      const { script, vars } = renderScript(dev);
      const { apPorts, ...res2 } = await ssh.deploy(cfg, sshCreds, dev.ip, script, vars);
      dev.lastDeploy = { at: new Date().toISOString(), ...res2 };
      dev.lastCheck = { at: new Date().toISOString(), installed: true, inSync: true, scheduled: true };
      dev.apPorts = apPorts || dev.apPorts || {};
      saveState();
      delete rescues[key];
      log.info('rescue complete: fixed script deployed', { device: dev.name });
    })
    .catch((e) => {
      r.status = e.message;
      setTimeout(() => rescueTick(key), 15000);
    });
}

app.get('/api/rescues', (req, res) => {
  res.json({ rescues: Object.keys(rescues) });
});

app.post('/api/devices/:key/rescue', (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  if (!requireAuth(res)) return;
  if (rescues[dev.key]) return res.json({ ok: true, already: true });
  rescues[dev.key] = { startedAt: Date.now(), status: 'polling' };
  log.info('rescue armed — power-cycle the device now', { device: dev.name, ip: dev.ip });
  setTimeout(() => rescueTick(dev.key), 100);
  res.json({ ok: true });
});

app.delete('/api/devices/:key/rescue', (req, res) => {
  delete rescues[req.params.key];
  log.info('rescue disarmed', { device: req.params.key });
  res.json({ ok: true });
});

// GET /api/defaults -- fleet-wide default vars (for the config dialog)
app.get('/api/defaults', (req, res) => res.json({ defaults: cfg.defaults }));

// GET /api/devices -- current known fleet
app.get('/api/devices', (req, res) => {
  res.json({ lastSync: state.lastSync, devices: Object.values(state.devices) });
});

// POST /api/sync -- pull fleet from UISP, merge (keeps overrides/results)
app.post('/api/sync', async (req, res) => {
  try {
    const found = await uisp.getSwitches(cfg);
    try {
      state.protectedMacs = await uisp.getBackhaulMacs(cfg);
      log.info('protected backhaul MACs from UISP', { count: state.protectedMacs.length });
    } catch (e) {
      log.warn('could not fetch backhaul MACs; keeping previous list', { error: e.message });
    }
    for (const d of found) {
      const key = d.mac || d.ip;
      const existing = state.devices[key] || {};
      state.devices[key] = {
        ...existing,
        ...d,
        key,
        overrides: existing.overrides || {},
        lastDeploy: existing.lastDeploy || null,
        lastCheck: existing.lastCheck || null,
      };
    }
    state.lastSync = new Date().toISOString();
    saveState();
    log.info('UISP sync ok', { found: found.length });
    res.json({ ok: true, count: found.length });
  } catch (e) {
    log.error('UISP sync failed', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PUT /api/devices/:key/overrides -- per-device config (GATEWAY_IP etc.)
app.put('/api/devices/:key/overrides', (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  const allowed = Object.keys(cfg.defaults);
  dev.overrides = dev.overrides || {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) continue;
    if (v === '' || v === null) delete dev.overrides[k];
    else dev.overrides[k] = v;
  }
  saveState();
  res.json({ ok: true, overrides: dev.overrides });
});

// GET /api/devices/:key/preview -- rendered script for review
app.get('/api/devices/:key/preview', (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  const { script } = renderScript(dev);
  res.type('text/plain').send(script);
});

// POST /api/devices/:key/check -- hash drift + scheduler presence
app.post('/api/devices/:key/check', async (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  if (!requireAuth(res)) return;
  try {
    const { script } = renderScript(dev);
    const result = await ssh.checkStatus(cfg, sshCreds, dev.ip, script);
    const { apPorts, ...check } = result;
    dev.lastCheck = { at: new Date().toISOString(), ...check };
    dev.apPorts = apPorts || dev.apPorts || {};
    saveState();
    res.json({ ok: true, result: dev.lastCheck });
  } catch (e) {
    dev.lastCheck = { at: new Date().toISOString(), error: e.message };
    saveState();
    log.error('check failed', { device: dev.name, ip: dev.ip, error: e.message });
    res.status(502).json({ ok: false, error: e.message });
  }
});

// POST /api/devices/:key/deploy -- render, upload, verify, ensure scheduler
app.post('/api/devices/:key/deploy', async (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  if (!requireAuth(res)) return;
  try {
    const { script, vars } = renderScript(dev);
    const { apPorts, ...result } = await ssh.deploy(cfg, sshCreds, dev.ip, script, vars);
    dev.lastDeploy = { at: new Date().toISOString(), ...result };
    dev.lastCheck = { at: new Date().toISOString(), installed: true, inSync: true, scheduled: true };
    dev.apPorts = apPorts || dev.apPorts || {};
    saveState();
    res.json({ ok: true, result });
  } catch (e) {
    dev.lastDeploy = { at: new Date().toISOString(), ok: false, error: e.message };
    saveState();
    log.error('deploy failed', { device: dev.name, ip: dev.ip, error: e.message });
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Fleet-wide deploy/check, concurrency-limited. Shared by the API routes and
// the auto-check timer.
async function fleetRun(action) {
  const devs = Object.values(state.devices);
  const results = await ssh.pooledMap(devs, cfg.ssh.concurrency || 4, async (dev) => {
    const { script, vars } = renderScript(dev);
    try {
      if (action === 'deploy') {
        const { apPorts, ...r } = await ssh.deploy(cfg, sshCreds, dev.ip, script, vars);
        dev.lastDeploy = { at: new Date().toISOString(), ...r };
        dev.lastCheck = { at: new Date().toISOString(), installed: true, inSync: true, scheduled: true };
        dev.apPorts = apPorts || dev.apPorts || {};
        return r;
      }
      const { apPorts, ...r } = await ssh.checkStatus(cfg, sshCreds, dev.ip, script);
      dev.lastCheck = { at: new Date().toISOString(), ...r };
      dev.apPorts = apPorts || dev.apPorts || {};
      return r;
    } catch (e) {
      // record the failure per device, same as the single-device endpoints
      if (action === 'deploy') dev.lastDeploy = { at: new Date().toISOString(), ok: false, error: e.message };
      else dev.lastCheck = { at: new Date().toISOString(), error: e.message };
      throw e;
    }
  });
  saveState();
  return devs.map((d, i) => ({ key: d.key, name: d.name, ...results[i] }));
}

// POST /api/deploy-all and /api/check-all
app.post('/api/:action(deploy-all|check-all)', async (req, res) => {
  const action = req.params.action === 'deploy-all' ? 'deploy' : 'check';
  if (!requireAuth(res)) return;
  res.json({ ok: true, results: await fleetRun(action) });
});

// --- periodic drift auto-check -------------------------------------------------
// Runs check-all every portal.autoCheckMinutes (0 disables). Skips quietly
// when SSH credentials haven't been entered yet (e.g. right after a restart).
let autoTimer = null;
function scheduleAutoCheck() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  const mins = Number(cfg.portal.autoCheckMinutes ?? 15);
  if (!mins || mins < 1) { log.info('auto-check disabled'); return; }
  autoTimer = setInterval(async () => {
    if (!ssh.haveAuth(cfg, sshCreds)) {
      log.info('auto-check skipped: SSH credentials not set');
      return;
    }
    const n = Object.keys(state.devices).length;
    if (!n) return;
    try {
      const results = await fleetRun('check');
      const bad = results.filter((r) => !r.ok);
      log[bad.length ? 'warn' : 'info']('auto-check done', {
        devices: n,
        failures: bad.length,
        failed: bad.map((b) => b.name).join(',') || undefined,
      });
    } catch (e) {
      log.error('auto-check crashed', { error: e.message });
    }
  }, mins * 60 * 1000);
  log.info('auto-check scheduled', { everyMinutes: mins });
}

// --- global settings (fleet defaults + auto-check interval) --------------------
app.get('/api/settings', (req, res) => {
  res.json({ defaults: cfg.defaults, autoCheckMinutes: Number(cfg.portal.autoCheckMinutes ?? 15) });
});

// PUT persists to config.json (secrets and other sections untouched).
app.put('/api/settings', (req, res) => {
  const { defaults, autoCheckMinutes } = req.body || {};
  const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  delete disk.defaults.AP_CYCLE_CRON;
  if (defaults && typeof defaults === 'object') {
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in cfg.defaults)) continue; // only known keys
      const val = v !== '' && v !== null && !isNaN(v) ? Number(v) : String(v ?? '');
      cfg.defaults[k] = val;
      disk.defaults[k] = val;
    }
  }
  if (autoCheckMinutes !== undefined) {
    const n = Math.max(0, parseInt(autoCheckMinutes, 10) || 0);
    cfg.portal.autoCheckMinutes = n;
    disk.portal.autoCheckMinutes = n;
  }
  writeFileAtomic(CONFIG_PATH, JSON.stringify(disk, null, 2) + '\n', { mode: 0o600 });
  scheduleAutoCheck();
  log.info('settings updated', { autoCheckMinutes: cfg.portal.autoCheckMinutes ?? 15 });
  res.json({ ok: true, defaults: cfg.defaults, autoCheckMinutes: Number(cfg.portal.autoCheckMinutes ?? 15) });
});

// GET /api/devices/:key/watchdog -- live `status` output + recent logs
app.get('/api/devices/:key/watchdog', async (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  if (!requireAuth(res)) return;
  try {
    const result = await ssh.getWatchdogStatus(cfg, sshCreds, dev.ip);
    res.json({ ok: true, ...result });
  } catch (e) {
    log.error('watchdog status failed', { device: dev.name, ip: dev.ip, error: e.message });
    res.status(502).json({ ok: false, error: e.message });
  }
});

// DELETE /api/devices/:key -- forget a device (e.g. decommissioned)
app.delete('/api/devices/:key', (req, res) => {
  delete state.devices[req.params.key];
  saveState();
  res.json({ ok: true });
});

const bind = cfg.portal.bind || '127.0.0.1';
app.listen(cfg.portal.port, bind, () => {
  log.info(`portal listening on http://${bind}:${cfg.portal.port}`);
  scheduleAutoCheck();
});
