'use strict';
// UniFi Network Integration API client (UniFi OS console, Network 9.x+).
// API-key auth only: header X-API-KEY, base /proxy/network/integration/v1.
// Used for the AP inventory (pane + PoE whitelist) and the RESTART action.

const https = require('https');
const log = require('./log');

const API_PATH = '/proxy/network/integration/v1';

// Lowercase MAC address, colon-separated. Guards remote shell interpolation
// downstream (the whitelist rendered into the switch script, cycle-mac).
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

function baseUrl(cfg) {
  return String(cfg.unifi.url || '').replace(/\/+$/, '') + API_PATH;
}

function isConfigured(cfg) {
  const u = (cfg && cfg.unifi) || {};
  if (!u.url || !u.apiKey) return false;
  return !/PASTE-|unifi\.example\.com/.test(`${u.url} ${u.apiKey}`);
}

// Default transport. Resolves { status, body (parsed JSON or null), text }.
function httpsJson(cfg, method, url, payload) {
  const options = {
    method,
    headers: { 'X-API-KEY': cfg.unifi.apiKey, accept: 'application/json' },
  };
  if (payload !== undefined) options.headers['content-type'] = 'application/json';
  if (cfg.unifi.allowSelfSigned) options.agent = new https.Agent({ rejectUnauthorized: false });
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        resolve({ status: res.statusCode, body, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('UniFi API timeout')));
    if (payload !== undefined) req.write(JSON.stringify(payload));
    req.end();
  });
}

function normalise(d) {
  return {
    id: d.id,
    name: d.name || d.macAddress || '?',
    model: d.model || '?',
    mac: String(d.macAddress || '').toLowerCase(),
    ip: d.ipAddress || '',
    state: d.state || 'UNKNOWN',
    online: d.state === 'ONLINE',
    firmware: d.firmwareVersion || '',
  };
}

// transport is injectable for tests.
function createClient(cfg, transport = httpsJson) {
  let siteId = null;

  async function call(method, path, payload) {
    const r = await transport(cfg, method, baseUrl(cfg) + path, payload);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`UniFi API ${r.status}: ${String(r.text || '').slice(0, 200)}`);
    }
    return r.body;
  }

  async function getSiteId() {
    if (siteId) return siteId;
    const j = await call('GET', '/sites');
    const first = ((j && j.data) || [])[0];
    if (!first) throw new Error('UniFi API returned no sites');
    siteId = first.id;
    return siteId;
  }

  async function listAccessPoints() {
    const site = await getSiteId();
    const out = [];
    const limit = 200;
    let offset = 0;
    for (;;) {
      const j = await call('GET', `/sites/${site}/devices?limit=${limit}&offset=${offset}`);
      const page = (j && j.data) || [];
      for (const d of page) {
        if (!(d.features || []).includes('accessPoint')) continue;
        if (!MAC_RE.test(String(d.macAddress || '').toLowerCase())) {
          log.warn('unifi: device has invalid MAC address, excluding from AP list', { id: d.id });
          continue;
        }
        out.push(normalise(d));
      }
      offset += page.length;
      if (!page.length || offset >= Number(j.totalCount || 0)) break;
    }
    return out;
  }

  async function getUptime(id) {
    const site = await getSiteId();
    const r = await transport(cfg, 'GET', `${baseUrl(cfg)}/sites/${site}/devices/${id}/statistics/latest`);
    if (r.status < 200 || r.status >= 300 || !r.body) return null;
    return { uptimeSec: r.body.uptimeSec ?? null, lastHeartbeatAt: r.body.lastHeartbeatAt || null };
  }

  async function restart(id) {
    const site = await getSiteId();
    await call('POST', `/sites/${site}/devices/${id}/actions`, { action: 'RESTART' });
    log.info('unifi: restart issued', { device: id });
  }

  return { getSiteId, listAccessPoints, getUptime, restart };
}

module.exports = { createClient, isConfigured, httpsJson };
