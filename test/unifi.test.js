'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createClient, isConfigured } = require('../lib/unifi');

const cfg = { unifi: { url: 'https://u.example:11443/', apiKey: 'k', allowSelfSigned: true } };
const PREFIX = 'https://u.example:11443/proxy/network/integration/v1';

// routes: { 'GET /sites': body | (payload) => body | { status, body } }
function fakeTransport(routes) {
  const calls = [];
  const fn = async (c, method, url, payload) => {
    calls.push({ method, url, payload });
    assert.ok(url.startsWith(PREFIX), 'url uses the integration base: ' + url);
    const key = `${method} ${url.slice(PREFIX.length)}`;
    const h = routes[key];
    if (!h) return { status: 404, body: null, text: 'no route ' + key };
    const r = typeof h === 'function' ? h(payload) : h;
    if (r && typeof r.status === 'number' && 'body' in r) return { ...r, text: JSON.stringify(r.body) };
    return { status: 200, body: r, text: JSON.stringify(r) };
  };
  return { calls, fn };
}

const SITES = { data: [{ id: 'S1', internalReference: 'abc', name: 'Site' }] };

test('listAccessPoints filters to APs, lowercases MACs, normalises fields, pages', async () => {
  const t = fakeTransport({
    'GET /sites': SITES,
    'GET /sites/S1/devices?limit=200&offset=0': {
      totalCount: 3,
      data: [
        { id: 'a', name: 'AP1', model: 'U6 Lite', macAddress: 'AA:BB:CC:00:00:01', ipAddress: '10.0.0.1', state: 'ONLINE', features: ['accessPoint'], firmwareVersion: '6.6.55' },
        { id: 's', name: 'SW', model: 'USW', macAddress: 'aa:bb:cc:00:00:99', state: 'ONLINE', features: ['switching'] },
      ],
    },
    'GET /sites/S1/devices?limit=200&offset=2': {
      totalCount: 3,
      data: [{ id: 'b', name: 'AP2', model: 'AC Mesh', macAddress: 'aa:bb:cc:00:00:02', state: 'OFFLINE', features: ['accessPoint'] }],
    },
  });
  const aps = await createClient(cfg, t.fn).listAccessPoints();
  assert.deepStrictEqual(aps, [
    { id: 'a', name: 'AP1', model: 'U6 Lite', mac: 'aa:bb:cc:00:00:01', ip: '10.0.0.1', state: 'ONLINE', online: true, firmware: '6.6.55' },
    { id: 'b', name: 'AP2', model: 'AC Mesh', mac: 'aa:bb:cc:00:00:02', ip: '', state: 'OFFLINE', online: false, firmware: '' },
  ]);
});

test('listAccessPoints excludes a device whose MAC address is not a valid MAC', async () => {
  const t = fakeTransport({
    'GET /sites': SITES,
    'GET /sites/S1/devices?limit=200&offset=0': {
      totalCount: 1,
      data: [{ id: 'bad1', name: 'Sketchy', model: 'U6', macAddress: 'bad; rm -rf /', state: 'ONLINE', features: ['accessPoint'] }],
    },
  });
  const aps = await createClient(cfg, t.fn).listAccessPoints();
  assert.deepStrictEqual(aps, []);
});

test('site id is fetched once and cached across calls', async () => {
  const t = fakeTransport({
    'GET /sites': SITES,
    'GET /sites/S1/devices?limit=200&offset=0': { totalCount: 0, data: [] },
  });
  const c = createClient(cfg, t.fn);
  await c.listAccessPoints();
  await c.listAccessPoints();
  assert.strictEqual(t.calls.filter((x) => x.url.endsWith('/sites')).length, 1);
});

test('restart posts the RESTART action for the device', async () => {
  let posted = null;
  const t = fakeTransport({
    'GET /sites': SITES,
    'POST /sites/S1/devices/dev1/actions': (payload) => { posted = payload; return {}; },
  });
  await createClient(cfg, t.fn).restart('dev1');
  assert.deepStrictEqual(posted, { action: 'RESTART' });
});

test('non-2xx responses throw with the status code', async () => {
  const t = fakeTransport({ 'GET /sites': { status: 401, body: { message: 'nope' } } });
  await assert.rejects(createClient(cfg, t.fn).listAccessPoints(), /UniFi API 401/);
});

test('getUptime returns statistics or null on error', async () => {
  const t = fakeTransport({
    'GET /sites': SITES,
    'GET /sites/S1/devices/ok/statistics/latest': { uptimeSec: 123, lastHeartbeatAt: '2026-09-02T00:00:00Z' },
    'GET /sites/S1/devices/bad/statistics/latest': { status: 500, body: null },
  });
  const c = createClient(cfg, t.fn);
  assert.deepStrictEqual(await c.getUptime('ok'), { uptimeSec: 123, lastHeartbeatAt: '2026-09-02T00:00:00Z' });
  assert.strictEqual(await c.getUptime('bad'), null);
});

test('isConfigured rejects missing values and placeholders', () => {
  assert.strictEqual(isConfigured({}), false);
  assert.strictEqual(isConfigured({ unifi: { url: 'https://unifi.example.com:11443', apiKey: 'PASTE-NETWORK-INTEGRATION-API-KEY' } }), false);
  assert.strictEqual(isConfigured({ unifi: { url: 'https://u.local:11443', apiKey: '' } }), false);
  assert.strictEqual(isConfigured({ unifi: { url: 'https://u.local:11443', apiKey: 'abc' } }), true);
});
