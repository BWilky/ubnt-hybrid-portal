'use strict';
// Minimal UISP (UNMS) API client. Inventory only -- UISP has no API for
// pushing files or running commands on EdgeMax devices, so deployment
// happens over SSH (see ssh.js).

const https = require('https');

function fetchDevices(cfg) {
  const base = cfg.uisp.url.replace(/\/+$/, '');
  const url = new URL(base + '/api/v2.1/devices');

  const options = {
    method: 'GET',
    headers: { 'x-auth-token': cfg.uisp.apiToken, accept: 'application/json' },
  };
  if (cfg.uisp.allowSelfSigned) {
    options.agent = new https.Agent({ rejectUnauthorized: false });
  }

  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`UISP API ${res.statusCode}: ${body.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('UISP API returned non-JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('UISP API timeout')));
    req.end();
  });
}

// Normalize to what the portal needs, filtered to the target model.
async function getSwitches(cfg) {
  const raw = await fetchDevices(cfg);
  const re = new RegExp(cfg.uisp.modelMatch || 'ER-?X', 'i');

  return raw
    .filter((d) => {
      const id = d.identification || {};
      const model = id.model || id.modelName || '';
      return re.test(model);
    })
    .map((d) => {
      const id = d.identification || {};
      // ipAddress can look like "10.0.0.12/24" or "10.0.0.12:443"
      const ipRaw = d.ipAddress || (d.overview && d.overview.ipAddress) || '';
      const ip = String(ipRaw).split('/')[0].split(':')[0];
      return {
        uispId: id.id,
        name: id.name || id.hostname || ip,
        model: id.model || id.modelName || '?',
        mac: id.mac || '',
        ip,
        firmware: (id.firmwareVersion || ''),
        online: (d.overview && d.overview.status) === 'active',
        site: (id.site && id.site.name) || '',
      };
    })
    .filter((d) => d.ip);
}

module.exports = { getSwitches };
