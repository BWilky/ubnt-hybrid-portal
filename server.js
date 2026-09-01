'use strict';
// poe-watchdog-portal: UISP inventory -> per-device rendered watchdog script
// -> SSH deploy + drift detection + status, behind a tiny dashboard.

const fs = require('fs');
const path = require('path');
const express = require('express');
const uisp = require('./lib/uisp');
const ssh = require('./lib/ssh');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state', 'devices.json');
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'poe-watchdog.sh.tpl');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('No config.json found. Copy config.example.json to config.json and edit it.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

// --- persisted state: device list + per-device overrides + last results -----
let state = { devices: {}, lastSync: null };
if (fs.existsSync(STATE_PATH)) {
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { /* fresh */ }
}
function saveState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
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
  res.json({ ok: true, username: sshCreds.username });
});

// DELETE wipes them.
app.delete('/api/ssh-creds', (req, res) => {
  sshCreds = null;
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
    res.json({ ok: true, count: found.length });
  } catch (e) {
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
    dev.lastCheck = { at: new Date().toISOString(), ...result };
    saveState();
    res.json({ ok: true, result: dev.lastCheck });
  } catch (e) {
    dev.lastCheck = { at: new Date().toISOString(), error: e.message };
    saveState();
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
    const result = await ssh.deploy(cfg, sshCreds, dev.ip, script, vars);
    dev.lastDeploy = { at: new Date().toISOString(), ...result };
    dev.lastCheck = { at: new Date().toISOString(), installed: true, inSync: true, scheduled: true };
    saveState();
    res.json({ ok: true, result });
  } catch (e) {
    dev.lastDeploy = { at: new Date().toISOString(), ok: false, error: e.message };
    saveState();
    res.status(502).json({ ok: false, error: e.message });
  }
});

// POST /api/deploy-all and /api/check-all -- fleet-wide, concurrency-limited
app.post('/api/:action(deploy-all|check-all)', async (req, res) => {
  const action = req.params.action === 'deploy-all' ? 'deploy' : 'check';
  if (!requireAuth(res)) return;
  const devs = Object.values(state.devices);
  const results = await ssh.pooledMap(devs, cfg.ssh.concurrency || 4, async (dev) => {
    const { script, vars } = renderScript(dev);
    if (action === 'deploy') {
      const r = await ssh.deploy(cfg, sshCreds, dev.ip, script, vars);
      dev.lastDeploy = { at: new Date().toISOString(), ...r };
      dev.lastCheck = { at: new Date().toISOString(), installed: true, inSync: true, scheduled: true };
      return r;
    }
    const r = await ssh.checkStatus(cfg, sshCreds, dev.ip, script);
    dev.lastCheck = { at: new Date().toISOString(), ...r };
    return r;
  });
  saveState();
  res.json({
    ok: true,
    results: devs.map((d, i) => ({ key: d.key, name: d.name, ...results[i] })),
  });
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
  console.log(`poe-watchdog-portal on http://${bind}:${cfg.portal.port}`);
});
