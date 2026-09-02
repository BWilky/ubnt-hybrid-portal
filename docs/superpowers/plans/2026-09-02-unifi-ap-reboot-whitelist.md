# UniFi AP Pane, Rolling Weekly Reboot, and PoE Whitelist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a UniFi "Access points" pane, a weekly rolling AP reboot (shuffled queue, 3 in flight, PoE-cycle fallback for offline APs), and a strict UniFi-AP whitelist for the ER-X PoE watchdog, while retiring the per-switch weekly AP cycle.

**Architecture:** A new `lib/unifi.js` talks to the UniFi Network Integration API with an API key. Pure scheduling logic lives in `lib/apscheduler.js` and is unit-tested with `node --test`; a thin driver in `server.js` runs it on a 30 s timer and persists state. The watchdog template gains `ALLOWED_MACS`, an `apmap` mode (machine-readable learned port map) and a `cycle-mac` mode; `lib/ssh.js` fetches the learned map on every check/deploy and stops installing the `weekly-ap-cycle` cron. The UI adds an Access points view and a UniFi settings card to the CoreUI frontend built on branch `coreui-light-ui`.

**Tech Stack:** Node 18+ (`node:test`, `node:assert`, `https`), Express 4, ssh2, bash (EdgeOS), CoreUI 5 / Bootstrap 5 vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-09-01-unifi-ap-reboot-whitelist-design.md`

**Base branch:** start from `coreui-light-ui` (the rebuilt UI). All file paths below refer to that tree.

## Global Constraints

- UniFi auth is API key only, header `X-API-KEY`; base path `/proxy/network/integration/v1`. The key is never logged and never returned by any API (`GET /api/settings` returns `unifi.configured: true|false`).
- `config.json` gains `unifi: { url, apiKey, allowSelfSigned, refreshMinutes, reboot: { enabled, day, start, hours, concurrency, timeoutMinutes } }` with defaults `refreshMinutes 5`, `reboot { enabled: false, day: 3, start: "02:00", hours: 3, concurrency: 3, timeoutMinutes: 8 }`. `day` is 0 (Sunday) to 6, Pi local time.
- Settings validation ranges: `day` 0–6, `start` matches `HH:MM`, `hours` 1–24, `concurrency` 1–10, `timeoutMinutes` 2–30, `refreshMinutes` 0–1440 (0 = off).
- `defaults.AP_CYCLE_CRON` is removed everywhere (example config, template, README, settings handling). Existing config files that still contain it are tolerated and the key is dropped on the next settings save.
- Empty `ALLOWED_MACS` keeps the watchdog's legacy OUI behaviour; non-empty makes the whitelist strict.
- Scheduler rules: shuffled queue of non-skipped APs; at most `concurrency` in flight; new restarts only while `enabled`, inside the window, and the last successful AP sync is newer than 2 × `refreshMinutes`; in-flight confirmations continue past the window end; offline APs get `cycle-mac` on their learned switch, or are re-queued once per cycle when the port is unknown or SSH auth is missing; per-AP timeout `timeoutMinutes`.
- Confirmation rule: an AP is back when it is `ONLINE` and (`uptimeSec < secondsSinceStart + 120`), or, for the PoE method when no statistics are available, when it is `ONLINE` at least 60 s after the cycle.
- `ssh.checkStatus().scheduled` is true only when the crontab has the 1-minute `poe-watchdog` entry and `weekly-reboot`, and does not have `weekly-ap-cycle`.
- Unit tests run with `npm test` (`node --test`), no new dependencies.
- All user-supplied strings pass through `esc()` before `innerHTML` in the frontend. No CDN.
- Do not bump `package.json` version, tag, or push. The user releases with a local gitignored script.

## Local test environment

Same as the UI plan: `config.json` (gitignored) with `portal.authUser` `""` for browser automation, `state/seed.json` copied to `state/devices.json` before browser checks. The dev `config.json` already contains a real `unifi.url` and `unifi.apiKey` for the user's controller; read-only calls against it (`/info`, `/sites`, `/devices`) are fine during verification. **Never call the RESTART action or `cycle-mac` against real devices in any task except the final integration check in Task 8, and there only on the single AP the user names.** If the user has not named one, skip that step and say so.

Start the server with `node server.js`; stop it before finishing a task. Reset `state/devices.json` from `state/seed.json` after browser tests. Note that `state/devices.json` will also gain `aps`, `apReboot`, `allowedMacs` and `apsSyncedAt` keys once Task 5 lands; the seed file does not carry them, which is fine (they are created empty on load).

---

### Task 1: UniFi Integration API client + config scaffolding

**Files:**
- Create: `lib/unifi.js`
- Create: `test/unifi.test.js`
- Modify: `package.json` (add `"test": "node --test"` script)
- Modify: `config.example.json` (add `unifi` section, remove `AP_CYCLE_CRON`)

**Interfaces:**
- Produces: `unifi.isConfigured(cfg) → bool`; `unifi.createClient(cfg, transport?) → { getSiteId(), listAccessPoints(), getUptime(id), restart(id) }`; `unifi.httpsJson(cfg, method, url, payload?) → Promise<{ status, body, text }>` (default transport). AP objects: `{ id, name, model, mac (lowercase), ip, state, online, firmware }`.

- [ ] **Step 1: Add the test script and config example changes**

In `package.json` add inside `"scripts"`:

```json
"test": "node --test"
```

In `config.example.json`, remove the line `"AP_CYCLE_CRON": "30 4 * * 3"` (and the trailing comma on `REBOOT_CRON`), and add after the `"ssh"` block:

```json
  "unifi": {
    "url": "https://unifi.example.com:11443",
    "apiKey": "PASTE-NETWORK-INTEGRATION-API-KEY",
    "allowSelfSigned": true,
    "refreshMinutes": 5,
    "reboot": {
      "enabled": false,
      "day": 3,
      "start": "02:00",
      "hours": 3,
      "concurrency": 3,
      "timeoutMinutes": 8
    }
  },
```

Validate: `node -e 'JSON.parse(require("fs").readFileSync("config.example.json","utf8")); console.log("ok")'` prints `ok`.

- [ ] **Step 2: Write the failing tests**

Create `test/unifi.test.js`:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/unifi'`.

- [ ] **Step 4: Write `lib/unifi.js`**

```js
'use strict';
// UniFi Network Integration API client (UniFi OS console, Network 9.x+).
// API-key auth only: header X-API-KEY, base /proxy/network/integration/v1.
// Used for the AP inventory (pane + PoE whitelist) and the RESTART action.

const https = require('https');
const log = require('./log');

const API_PATH = '/proxy/network/integration/v1';

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
        if ((d.features || []).includes('accessPoint')) out.push(normalise(d));
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: a summary of `pass 6` and `fail 0` (Node prints these as `# pass` or `ℹ pass` depending on version), no warnings.

- [ ] **Step 6: Live read-only smoke check**

```bash
node -e '
const cfg = JSON.parse(require("fs").readFileSync("config.json","utf8"));
const u = require("./lib/unifi");
if (!u.isConfigured(cfg)) { console.log("unifi not configured locally; skipping"); process.exit(0); }
u.createClient(cfg).listAccessPoints().then((a) => console.log("APs:", a.length, "online:", a.filter((x) => x.online).length)).catch((e) => { console.error(e.message); process.exit(1); });'
```

Expected: `APs: 64 online: <n>` (numbers may differ as the fleet changes). No RESTART is issued.

- [ ] **Step 7: Commit**

```bash
git add lib/unifi.js test/unifi.test.js package.json config.example.json
git commit -m "UniFi Integration API client with tests; unifi config section"
```

---

### Task 2: Pure scheduler logic

**Files:**
- Create: `lib/apscheduler.js`
- Create: `test/apscheduler.test.js`

**Interfaces:**
- Produces:
  - `emptySchedule() → { queue: [], inFlight: {}, retried: {}, cycleStartedAt: null, lastCycleCompletedAt: null }`
  - `inWindow(now: Date, reboot) → bool`
  - `nextWindowStart(now: Date, reboot) → Date | null` (the current window's start if open, else the next one)
  - `buildQueue(aps: [{ mac, skip? }], rng = Math.random) → [mac]`
  - `refillIfEmpty(sched, aps, now: Date, rng?) → bool` (true when a new cycle was started; sets `cycleStartedAt`, clears `retried`)
  - `requeueOnce(sched, mac) → bool` (true when re-queued; false when it was already retried this cycle)
  - `nextActions(sched, { now: Date, concurrency, timeoutMinutes, isBack(mac) → bool }) → { start: [mac], finished: [{ mac, result: 'ok'|'timeout', ...inFlightEntry }], sched }` (returns a new `sched`; does not add `start` entries to `inFlight`, the driver does that once the restart is issued)
  - In-flight entry shape (driver-owned): `{ startedAt: epochMs, method: 'unifi'|'poe', uptimeBefore: number|null, via?: string, port?: string }`

- [ ] **Step 1: Write the failing tests**

Create `test/apscheduler.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/apscheduler');

// Wednesday 2026-09-02 is day 3. Local-time constructor avoids TZ surprises.
const local = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi, 0, 0);
const reboot = { enabled: true, day: 3, start: '02:00', hours: 3, concurrency: 3, timeoutMinutes: 8 };

test('inWindow: inside, before, after, wrong day, midnight crossing', () => {
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 2, 0), reboot), true);
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 4, 59), reboot), true);
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 5, 0), reboot), false);
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 1, 59), reboot), false);
  assert.strictEqual(S.inWindow(local(2026, 9, 3, 3, 0), reboot), false); // Thursday
  const late = { ...reboot, start: '23:00', hours: 3 };               // Wed 23:00 -> Thu 02:00
  assert.strictEqual(S.inWindow(local(2026, 9, 3, 1, 30), late), true);
  assert.strictEqual(S.inWindow(local(2026, 9, 3, 2, 0), late), false);
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 2, 0), { ...reboot, start: 'nonsense' }), false);
});

test('nextWindowStart: current window when open, else next occurrence', () => {
  assert.deepStrictEqual(S.nextWindowStart(local(2026, 9, 2, 3, 0), reboot), local(2026, 9, 2, 2, 0));
  assert.deepStrictEqual(S.nextWindowStart(local(2026, 9, 2, 6, 0), reboot), local(2026, 9, 9, 2, 0));
  assert.deepStrictEqual(S.nextWindowStart(local(2026, 8, 31, 12, 0), reboot), local(2026, 9, 2, 2, 0)); // Monday
  assert.strictEqual(S.nextWindowStart(local(2026, 9, 2, 6, 0), { ...reboot, start: '25:00' }), null);
});

test('buildQueue: excludes skipped, contains every AP once, deterministic with seeded rng', () => {
  const aps = [{ mac: 'a' }, { mac: 'b', skip: true }, { mac: 'c' }, { mac: 'd' }];
  let n = 0;
  const rng = () => ((n += 0.37) % 1);
  const q1 = S.buildQueue(aps, rng);
  n = 0;
  const q2 = S.buildQueue(aps, rng);
  assert.deepStrictEqual([...q1].sort(), ['a', 'c', 'd']);
  assert.deepStrictEqual(q1, q2);
});

test('refillIfEmpty only starts a cycle when queue and inFlight are empty', () => {
  const now = local(2026, 9, 2, 2, 0);
  const s = S.emptySchedule();
  assert.strictEqual(S.refillIfEmpty(s, [{ mac: 'a' }, { mac: 'b' }], now, Math.random), true);
  assert.strictEqual(s.queue.length, 2);
  assert.strictEqual(s.cycleStartedAt, now.toISOString());
  assert.strictEqual(S.refillIfEmpty(s, [{ mac: 'a' }], now, Math.random), false);
  s.queue = [];
  s.inFlight = { a: { startedAt: now.getTime(), method: 'unifi', uptimeBefore: 1 } };
  assert.strictEqual(S.refillIfEmpty(s, [{ mac: 'a' }], now, Math.random), false);
});

test('requeueOnce re-queues a MAC once per cycle and refill resets that', () => {
  const s = S.emptySchedule();
  assert.strictEqual(S.requeueOnce(s, 'x'), true);
  assert.deepStrictEqual(s.queue, ['x']);
  s.queue = [];
  assert.strictEqual(S.requeueOnce(s, 'x'), false);
  S.refillIfEmpty(s, [{ mac: 'x' }], local(2026, 9, 2, 2, 0), Math.random);
  s.queue = [];
  assert.strictEqual(S.requeueOnce(s, 'x'), true);
});

test('nextActions respects concurrency, finishes confirmed and timed-out entries, never mutates input', () => {
  const t0 = local(2026, 9, 2, 2, 0).getTime();
  const sched = {
    ...S.emptySchedule(),
    queue: ['c', 'd', 'e', 'f'],
    inFlight: {
      a: { startedAt: t0, method: 'unifi', uptimeBefore: 999 },
      b: { startedAt: t0 - 9 * 60000, method: 'poe', uptimeBefore: null },
    },
  };
  const snapshot = JSON.stringify(sched);
  const r = S.nextActions(sched, { now: new Date(t0 + 60000), concurrency: 3, timeoutMinutes: 8, isBack: (m) => m === 'a' });
  assert.strictEqual(JSON.stringify(sched), snapshot);
  assert.deepStrictEqual(r.finished.map((f) => [f.mac, f.result]), [['a', 'ok'], ['b', 'timeout']]);
  assert.deepStrictEqual(r.start, ['c', 'd', 'e']);           // 0 in flight after finishing, 3 slots
  assert.deepStrictEqual(r.sched.queue, ['f']);
  assert.deepStrictEqual(r.sched.inFlight, {});
});

test('nextActions with concurrency 0 confirms in-flight but starts nothing', () => {
  const t0 = Date.now();
  const sched = { ...S.emptySchedule(), queue: ['x'], inFlight: { a: { startedAt: t0, method: 'unifi', uptimeBefore: 5 } } };
  const r = S.nextActions(sched, { now: new Date(t0 + 1000), concurrency: 0, timeoutMinutes: 8, isBack: () => true });
  assert.deepStrictEqual(r.start, []);
  assert.deepStrictEqual(r.finished.map((f) => f.mac), ['a']);
  assert.deepStrictEqual(r.sched.queue, ['x']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/apscheduler.test.js`
Expected: FAIL with `Cannot find module '../lib/apscheduler'`.

- [ ] **Step 3: Write `lib/apscheduler.js`**

```js
'use strict';
// Pure scheduling logic for the weekly rolling AP reboot. No I/O and no
// clock: the driver in server.js supplies `now`, the AP inventory and the
// confirmation predicate, and persists the returned schedule state.

function emptySchedule() {
  return { queue: [], inFlight: {}, retried: {}, cycleStartedAt: null, lastCycleCompletedAt: null };
}

function parseStart(start) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(start || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Start (local time) of the most recent window opening at or before `now`.
function lastWindowStart(now, reboot) {
  const startMin = parseStart(reboot.start);
  const day = Number(reboot.day);
  if (startMin === null || !(day >= 0 && day <= 6)) return null;
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - day + 7) % 7));
  d.setMinutes(startMin);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}

function inWindow(now, reboot) {
  const ws = lastWindowStart(now, reboot);
  if (!ws) return false;
  const elapsedMin = (now.getTime() - ws.getTime()) / 60000;
  return elapsedMin >= 0 && elapsedMin < Number(reboot.hours) * 60;
}

function nextWindowStart(now, reboot) {
  const ws = lastWindowStart(now, reboot);
  if (!ws) return null;
  if (inWindow(now, reboot)) return ws;
  const n = new Date(ws.getTime());
  n.setDate(n.getDate() + 7);
  return n;
}

// Fisher-Yates over the non-skipped MACs. `rng` is injectable for tests.
function buildQueue(aps, rng = Math.random) {
  const q = aps.filter((a) => !a.skip).map((a) => a.mac);
  for (let i = q.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
  return q;
}

// Start a new cycle when nothing is queued or in flight. Mutates `sched`.
function refillIfEmpty(sched, aps, now, rng = Math.random) {
  if (sched.queue.length || Object.keys(sched.inFlight).length) return false;
  sched.queue = buildQueue(aps, rng);
  sched.retried = {};
  sched.cycleStartedAt = now.toISOString();
  return sched.queue.length > 0;
}

// Push a MAC to the back of the queue, once per cycle. Mutates `sched`.
function requeueOnce(sched, mac) {
  sched.retried = sched.retried || {};
  if (sched.retried[mac]) return false;
  sched.retried[mac] = true;
  sched.queue.push(mac);
  return true;
}

// Decide this tick's work. Returns a new `sched`; the input is not mutated.
function nextActions(sched, { now, concurrency, timeoutMinutes, isBack }) {
  const s = { ...sched, queue: [...sched.queue], inFlight: { ...sched.inFlight }, retried: { ...(sched.retried || {}) } };
  const nowMs = now.getTime();
  const finished = [];
  for (const [mac, entry] of Object.entries(s.inFlight)) {
    let result = null;
    if (isBack(mac)) result = 'ok';
    else if (nowMs - entry.startedAt >= Number(timeoutMinutes) * 60000) result = 'timeout';
    if (!result) continue;
    finished.push({ mac, result, ...entry });
    delete s.inFlight[mac];
  }
  const start = [];
  while (s.queue.length && Object.keys(s.inFlight).length + start.length < Number(concurrency)) {
    start.push(s.queue.shift());
  }
  return { start, finished, sched: s };
}

module.exports = { emptySchedule, inWindow, nextWindowStart, buildQueue, refillIfEmpty, requeueOnce, nextActions };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: a summary of `pass 13` and `fail 0` (Node prints these as `# pass` or `ℹ pass` depending on version).

- [ ] **Step 5: Commit**

```bash
git add lib/apscheduler.js test/apscheduler.test.js
git commit -m "AP reboot scheduler: pure window/queue/concurrency logic with tests"
```

---

### Task 3: Watchdog template — ALLOWED_MACS whitelist, apmap and cycle-mac modes, retire weekly-ap-cycle

**Files:**
- Modify: `templates/poe-watchdog.sh.tpl`
- Create: `test/watchdog.test.js`

**Interfaces:**
- Produces: template variable `{{ALLOWED_MACS}}` (space-separated lowercase MACs, may be empty); script modes `apmap` (prints the persisted `ethN mac ip epoch` lines, exit 0, no lock) and `cycle-mac <mac>` (exit 0 `cycled ethN`, 2 `unknown mac`, 3 `port ethN not managed`, 4 `busy`); `weekly-ap-cycle` mode removed. Test-only environment overrides: `STATE`, `PERSIST`, `CONFIG_BOOT`, and `POE_WATCHDOG_LIB=1` to source functions without running the entry block.

- [ ] **Step 1: Write the failing test**

Create `test/watchdog.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TPL = path.join(__dirname, '..', 'templates', 'poe-watchdog.sh.tpl');

function render(vars) {
  const all = {
    GATEWAY_IP: '10.0.0.1', SECONDARY_IP: '', FAIL_LIMIT: 5, RECOVER_OK: 2, AP_FAIL_LIMIT: 3, CYCLE_COOLDOWN: 600,
    EXCLUDE_PORTS: '', REBOOT_CRON: '0 4 * * 0', DEVICE_NAME: 'test', DEVICE_IP: '10.0.0.2',
    RENDERED_AT: 'test', PROTECTED_MACS: '', ALLOWED_MACS: '', ...vars,
  };
  let out = fs.readFileSync(TPL, 'utf8');
  for (const [k, v] of Object.entries(all)) out = out.split('{{' + k + '}}').join(String(v));
  return out;
}

// Runs `body` in bash with the rendered script sourced in library mode and a
// fake switch: config.boot with eth1..eth4 on 24v, MAC table from `mactbl`.
function harness(vars, mactbl, body) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const script = path.join(t, 'poe-watchdog.sh');
  fs.writeFileSync(script, render(vars));
  fs.writeFileSync(path.join(t, 'config.boot'), [
    'interfaces {', '    ethernet eth0 {', '    }',
    ...['eth1', 'eth2', 'eth3', 'eth4'].flatMap((p) => [`    ethernet ${p} {`, '        poe {', '            output 24v', '        }', '    }']),
    '}', ''].join('\n'));
  fs.writeFileSync(path.join(t, 'mactbl'), mactbl.join('\n') + '\n');
  const pre = `
export STATE="${t}/state" PERSIST="${t}/persist" CONFIG_BOOT="${t}/config.boot" POE_WATCHDOG_LIB=1
source "${script}"
mac_table() { cat "${t}/mactbl"; }
poe_set() { echo "$1 $2" >> "${t}/poe_calls"; }
log() { :; }
POE_OFF_SECS=0
UPLINK_PORT="$(detect_uplink_port)"
PROTECTED_PORTS="$(detect_protected_ports)"
ALLOWED_PORTS="$(detect_allowed_ports)"
`;
  const r = spawnSync('bash', ['-c', pre + body], { encoding: 'utf8' });
  const calls = fs.existsSync(path.join(t, 'poe_calls')) ? fs.readFileSync(path.join(t, 'poe_calls'), 'utf8').trim().split('\n') : [];
  const allowed = fs.existsSync(path.join(t, 'persist', 'allowed-ports')) ? fs.readFileSync(path.join(t, 'persist', 'allowed-ports'), 'utf8').trim().split('\n').filter(Boolean) : [];
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status, calls, allowed };
}

const TABLE = ['eth1 44:d9:e7:00:00:01', 'eth2 f0:9f:c2:00:00:02', 'eth3 00:11:22:33:44:55'];

test('rendered script parses (bash -n) and has no weekly-ap-cycle mode', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const p = path.join(t, 's.sh');
  fs.writeFileSync(p, render({ ALLOWED_MACS: 'aa:bb:cc:dd:ee:ff' }));
  const r = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(!/weekly-ap-cycle|mode_weekly_ap_cycle|STAGGER_SECS/.test(src));
  assert.ok(/cycle-mac/.test(src) && /apmap\)/.test(src));
});

test('empty ALLOWED_MACS keeps legacy behaviour: all 24v ports managed', () => {
  const r = harness({}, TABLE, 'managed_ports');
  assert.deepStrictEqual(r.stdout.split('\n'), ['eth1', 'eth2', 'eth3', 'eth4']);
  assert.deepStrictEqual(r.allowed, []);
});

test('non-empty ALLOWED_MACS: only ports where an allowed MAC was seen are managed, and the learning persists', () => {
  const r = harness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02' }, TABLE, 'managed_ports');
  assert.deepStrictEqual(r.stdout.split('\n'), ['eth1', 'eth2']);
  assert.deepStrictEqual(r.allowed.sort(), ['eth1', 'eth2']);
});

test('EXCLUDE_PORTS still wins over the whitelist', () => {
  const r = harness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02', EXCLUDE_PORTS: 'eth2' }, TABLE, 'managed_ports');
  assert.deepStrictEqual(r.stdout.split('\n'), ['eth1']);
});

test('apmap prints the persisted map', () => {
  const r = harness({}, TABLE, 'update_apmap eth1 44:d9:e7:00:00:01 10.0.0.9 1700000000; mode_apmap');
  assert.strictEqual(r.stdout, 'eth1 44:d9:e7:00:00:01 10.0.0.9 1700000000');
});

test('cycle-mac: cycles a known managed port, exit 2 for unknown MAC, exit 3 for unmanaged port', () => {
  const vars = { ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02', EXCLUDE_PORTS: 'eth2' };
  const ok = harness(vars, TABLE, '( mode_cycle_mac 44:D9:E7:00:00:01 ); echo "rc=$?"');
  assert.match(ok.stdout, /cycled eth1[\s\S]*rc=0/);
  assert.deepStrictEqual(ok.calls, ['eth1 off', 'eth1 24v']);
  const unknown = harness(vars, TABLE, '( mode_cycle_mac de:ad:be:ef:00:00 ); echo "rc=$?"');
  assert.match(unknown.stdout, /unknown mac de:ad:be:ef:00:00[\s\S]*rc=2/);
  const unmanaged = harness(vars, TABLE, '( mode_cycle_mac f0:9f:c2:00:00:02 ); echo "rc=$?"');
  assert.match(unmanaged.stdout, /port eth2 not managed[\s\S]*rc=3/);
  assert.deepStrictEqual(unmanaged.calls, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/watchdog.test.js`
Expected: FAIL. The `bash -n` test fails on the `weekly-ap-cycle` assertion, the harness tests fail because `POE_WATCHDOG_LIB`, `detect_allowed_ports`, `mode_apmap`, `mode_cycle_mac` do not exist yet (sourcing the current script runs its entry block and exits).

- [ ] **Step 3: Edit the template header and variables**

In `templates/poe-watchdog.sh.tpl`:

Replace the `# Modes:` block near the top with:

```bash
# Modes:
#   poe-watchdog.sh check           (default; run every 1 min via task-scheduler)
#   poe-watchdog.sh weekly-reboot   (log + reboot the whole router)
#   poe-watchdog.sh status          (show learned APs, counters, state)
#   poe-watchdog.sh apmap           (machine-readable learned port map, for the portal)
#   poe-watchdog.sh cycle-mac <mac> (PoE-cycle the port carrying <mac>; portal fallback
#                                    for APs UniFi cannot restart)
```

Delete the line `STAGGER_SECS=120                # gap between APs during weekly-ap-cycle`.

Directly after the `PROTECTED_MACS="{{PROTECTED_MACS}}"` line add:

```bash

# UniFi access-point MACs (from the UniFi controller via the portal). When this
# list is non-empty it is a strict whitelist: a PoE port is only ever monitored
# or cycled once one of these MACs has been seen on it (learned persistently).
# Empty = legacy behaviour (any Ubiquiti OUI on a 24v port is treated as an AP).
ALLOWED_MACS="{{ALLOWED_MACS}}"
```

- [ ] **Step 4: Make paths overridable and add the allow-list learning**

Change the three path lines to:

```bash
STATE=${STATE:-/var/run/poe-watchdog}             # tmpfs: counters, cleared on reboot
PERSIST=${PERSIST:-/config/user-data/poe-watchdog}  # survives reboot & fw upgrade
CONFIG_BOOT=${CONFIG_BOOT:-/config/config.boot}
```

(`APMAP`, `STATICMAP`, `LOCK` stay as they are; they derive from these.)

After the `detect_protected_ports()` function add:

```bash
# --- allowed ports: the UniFi AP whitelist ------------------------------------
# Mirror of detect_protected_ports: a port joins the allowed set the moment an
# ALLOWED_MACS entry (or a static-map entry) is seen on it, and stays allowed
# (persistent, additive). Only consulted when ALLOWED_MACS is non-empty.
detect_allowed_ports() {
    local m p tbl
    [ -n "$ALLOWED_MACS" ] || return 0
    tbl=$(mac_table)
    [ -f "$STATICMAP" ] && tbl="$tbl
$(cat "$STATICMAP")"
    for m in $ALLOWED_MACS; do
        p=$(echo "$tbl" | awk -v m="$m" '$2 == m { print $1; exit }')
        if [ -n "$p" ] && ! grep -qx "$p" "$PERSIST/allowed-ports" 2>/dev/null; then
            echo "$p" >> "$PERSIST/allowed-ports"
            log "port $p carries whitelisted AP $m -> allowed for monitoring"
        fi
    done
    sort -u "$PERSIST/allowed-ports" 2>/dev/null | tr '\n' ' '
}
```

Replace `managed_ports()` with:

```bash
managed_ports() {
    awk '
        /^[[:space:]]+ethernet eth[0-9]+/ { iface=$2 }
        /output 24v/                      { if (iface != "") print iface }
    ' "$CONFIG_BOOT" | sort -u | while read -r p; do
        case " $EXCLUDE_PORTS $UPLINK_PORT $PROTECTED_PORTS " in *" $p "*) continue ;; esac
        if [ -n "$ALLOWED_MACS" ]; then
            case " $ALLOWED_PORTS " in *" $p "*) ;; *) continue ;; esac
        fi
        echo "$p"
    done
}
```

- [ ] **Step 5: Replace the weekly AP cycle with the two new modes**

Delete the whole `mode_weekly_ap_cycle()` function. In its place add:

```bash
mode_apmap() {
    cat "$APMAP"
}

mode_cycle_mac() {  # cycle-mac aa:bb:cc:dd:ee:ff
    local mac p
    mac=$(echo "${1:-}" | tr 'A-Z' 'a-z')
    [ -n "$mac" ] || { echo "usage: $0 cycle-mac <mac>"; exit 1; }
    p=$(awk -v m="$mac" '$2 == m { print $1; exit }' "$APMAP")
    [ -n "$p" ] || p=$(mac_table | awk -v m="$mac" '$2 == m { print $1; exit }')
    if [ -z "$p" ]; then echo "unknown mac $mac"; exit 2; fi
    case " $(managed_ports | tr '\n' ' ') " in
        *" $p "*) ;;
        *) echo "port $p not managed"; exit 3 ;;
    esac
    log "portal requested PoE cycle of $p ($mac)"
    poe_cycle "$p"
    echo "cycled $p"
}
```

In `mode_status()`, after the `echo "excluded ports  : ..."` line add:

```bash
    if [ -n "$ALLOWED_MACS" ]; then
        echo "whitelist       : $(echo $ALLOWED_MACS | wc -w) allowed MACs, allowed ports: ${ALLOWED_PORTS:-none yet}"
    else
        echo "whitelist       : none (legacy OUI mode)"
    fi
```

- [ ] **Step 6: Rewrite the entry block**

Replace everything from `# --- entry ---` to the end of the file with:

```bash
# --- entry -------------------------------------------------------------------
# POE_WATCHDOG_LIB=1 lets tests source the functions without running anything.
if [ "${POE_WATCHDOG_LIB:-0}" != "1" ]; then
    MODE="${1:-check}"

    # resolve the port sets once per run (functions need mac_table)
    UPLINK_PORT="$(detect_uplink_port)"
    PROTECTED_PORTS="$(detect_protected_ports)"
    ALLOWED_PORTS="$(detect_allowed_ports)"

    case "$MODE" in
        status|apmap) ;;                       # read-only, no lock
        cycle-mac)
            exec 200> "$LOCK"
            flock -w 90 200 || { echo "busy"; exit 4; } ;;
        *)
            exec 200> "$LOCK"
            flock -n 200 || { log "another instance is running, skipping ($MODE)"; exit 0; } ;;
    esac

    case "$MODE" in
        check)         mode_check ;;
        weekly-reboot) mode_weekly_reboot ;;
        status)        mode_status ;;
        apmap)         mode_apmap ;;
        cycle-mac)     mode_cycle_mac "${2:-}" ;;
        *) echo "usage: $0 {check|weekly-reboot|status|apmap|cycle-mac <mac>}"; exit 1 ;;
    esac
fi
```

Also update the top-of-file "What check does" comment item 1 to end with: `Only ports carrying a whitelisted UniFi AP MAC are managed when ALLOWED_MACS is set.`

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: a summary of `pass 19` and `fail 0` (Node prints these as `# pass` or `ℹ pass` depending on version). If `flock` is missing on macOS that is fine: the tests never execute the entry block.

- [ ] **Step 8: Commit**

```bash
git add templates/poe-watchdog.sh.tpl test/watchdog.test.js
git commit -m "Watchdog: UniFi AP whitelist (ALLOWED_MACS), apmap + cycle-mac modes, drop weekly-ap-cycle"
```

---

### Task 4: SSH layer — learned port map, cycle-mac, scheduler retirement, per-device fleet failures

**Files:**
- Modify: `lib/ssh.js`
- Modify: `server.js` (`renderScript`, `fleetRun`, check/deploy routes storing `apPorts`)
- Create: `test/ssh-parse.test.js`

**Interfaces:**
- Produces: `ssh.parseApmap(text) → { [mac]: 'ethN' }`; `ssh.checkStatus()` result gains `apPorts`; `ssh.deploy()` result gains `apPorts`; `ssh.cycleMac(cfg, creds, host, mac) → Promise<string>` (stdout, throws with the script's message on non-zero exit); `deploy()` no longer needs `vars.AP_CYCLE_CRON`; `renderScript()` supplies `ALLOWED_MACS` from `state.allowedMacs`; each device record gains `apPorts`.

- [ ] **Step 1: Write the failing test**

Create `test/ssh-parse.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseApmap, cronScheduled } = require('../lib/ssh');

test('parseApmap maps lowercase MAC to port and ignores junk', () => {
  const txt = 'eth1 44:D9:E7:00:00:01 10.0.0.9 1700000000\neth3 f0:9f:c2:00:00:02 - 1700000001\n\nnot a line\n';
  assert.deepStrictEqual(parseApmap(txt), { '44:d9:e7:00:00:01': 'eth1', 'f0:9f:c2:00:00:02': 'eth3' });
  assert.deepStrictEqual(parseApmap(''), {});
});

test('cronScheduled requires check + weekly-reboot and forbids weekly-ap-cycle', () => {
  const P = '/config/scripts/poe-watchdog.sh';
  const good = `*/1 * * * * root ${P}\n0 4 * * 0 root ${P} weekly-reboot\n`;
  const legacy = good + `30 4 * * 3 root ${P} weekly-ap-cycle\n`;
  const noReboot = `*/1 * * * * root ${P}\n`;
  assert.strictEqual(cronScheduled(good), true);
  assert.strictEqual(cronScheduled(legacy), false);
  assert.strictEqual(cronScheduled(noReboot), false);
  assert.strictEqual(cronScheduled(''), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/ssh-parse.test.js`
Expected: FAIL, `parseApmap is not a function` (or `cronScheduled`).

- [ ] **Step 3: Edit `lib/ssh.js`**

Add after the `REMOTE_PATH` constant:

```js
// "ethN mac ip epoch" lines from `poe-watchdog.sh apmap` -> { mac: port }
function parseApmap(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const [port, mac] = line.trim().split(/\s+/);
    if (/^eth\d+$/.test(port || '') && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac || '')) out[mac.toLowerCase()] = port;
  }
  return out;
}

// True when the crontab has the 1-minute check and weekly-reboot for our
// script, and the retired weekly-ap-cycle entry is gone.
function cronScheduled(crontabText) {
  const lines = String(crontabText || '').split('\n').filter((l) => l.includes(REMOTE_PATH));
  const hasCheck = lines.some((l) => !/weekly-/.test(l));
  const hasReboot = lines.some((l) => /weekly-reboot/.test(l));
  const hasLegacy = lines.some((l) => /weekly-ap-cycle/.test(l));
  return hasCheck && hasReboot && !hasLegacy;
}
```

Replace `checkStatus` with:

```js
// Returns { installed, remoteHash, inSync, scheduled, uptime, apPorts }
async function checkStatus(cfg, creds, host, renderedScript) {
  return withConn(cfg, creds, host, async (conn) => {
    const hash = await exec(conn, `sha256sum ${REMOTE_PATH} 2>/dev/null | awk '{print $1}'`);
    const up = await exec(conn, 'uptime');
    const cron = await exec(conn, 'cat /etc/cron.d/vyatta-crontab 2>/dev/null');
    const remoteHash = hash.stdout.trim();
    const apmap = remoteHash ? await exec(conn, `sudo ${REMOTE_PATH} apmap 2>/dev/null`) : { stdout: '' };
    return {
      installed: !!remoteHash,
      remoteHash,
      inSync: remoteHash === sha256(renderedScript),
      scheduled: cronScheduled(cron.stdout),
      uptime: up.stdout.trim(),
      apPorts: parseApmap(apmap.stdout),
    };
  });
}
```

In `deploy()`, replace the `schedCmd` array with:

```js
    const schedCmd = [
      `${W} begin`,
      `${W} set system task-scheduler task poe-watchdog executable path ${REMOTE_PATH}`,
      `${W} set system task-scheduler task poe-watchdog interval 1m`,
      // retired: APs are now rebooted by the portal through UniFi
      `( ${W} delete system task-scheduler task weekly-ap-cycle >/dev/null 2>&1 || true )`,
      `${W} set system task-scheduler task weekly-reboot executable path ${REMOTE_PATH}`,
      `${W} set system task-scheduler task weekly-reboot executable arguments weekly-reboot`,
      `${W} set system task-scheduler task weekly-reboot crontab-spec '${vars.REBOOT_CRON}'`,
      `${W} commit`,
      // never save while the watchdog has PoE cut — that would persist the
      // temporary "off" state to config.boot (and a reboot would keep it)
      `( [ -f /var/run/poe-watchdog/cut_ports ] || ${W} save )`,
      `${W} end`,
    ].join(' && ');
```

At the end of `deploy()`, before `return { ok: true, steps };`, add:

```js
    const apmap = await exec(conn, `sudo ${REMOTE_PATH} apmap 2>/dev/null`);
    const apPorts = parseApmap(apmap.stdout);
```

and change the return to `return { ok: true, steps, apPorts };`.

Add before `pooledMap`:

```js
// Portal-requested PoE cycle of the port carrying `mac` (offline-AP fallback).
// Resolves with the script's stdout; rejects with its message on non-zero exit.
async function cycleMac(cfg, creds, host, mac) {
  return withConn(cfg, creds, host, async (conn) => {
    const r = await exec(conn, `sudo ${REMOTE_PATH} cycle-mac ${mac} 2>&1`);
    if (r.code !== 0) throw new Error(`cycle-mac on ${host}: ${(r.stdout || r.stderr || '').trim() || 'exit ' + r.code}`);
    log.info('cycle-mac ok', { host, mac, out: r.stdout.trim() });
    return r.stdout.trim();
  });
}
```

Update the export line:

```js
module.exports = { haveAuth, checkStatus, getWatchdogStatus, deploy, cycleMac, installPubkey, ping, pooledMap, sha256, parseApmap, cronScheduled, REMOTE_PATH };
```

- [ ] **Step 4: Edit `server.js` to render the whitelist and store the learned map**

In `renderScript()`, after the `PROTECTED_MACS` line add:

```js
    // UniFi AP MACs — strict whitelist of ports the watchdog may manage
    ALLOWED_MACS: (state.allowedMacs || []).join(' '),
```

In the single-device check route, after `dev.lastCheck = { at: ..., ...result };` add `dev.apPorts = result.apPorts || dev.apPorts || {};` and remove `apPorts` from what is stored in `lastCheck` by writing it as:

```js
    const { apPorts, ...check } = result;
    dev.lastCheck = { at: new Date().toISOString(), ...check };
    dev.apPorts = apPorts || dev.apPorts || {};
```

In the single-device deploy route, likewise:

```js
    const { apPorts, ...result } = await ssh.deploy(cfg, sshCreds, dev.ip, script, vars);
    dev.lastDeploy = { at: new Date().toISOString(), ...result };
    dev.lastCheck = { at: new Date().toISOString(), installed: true, inSync: true, scheduled: true };
    dev.apPorts = apPorts || dev.apPorts || {};
```

Replace `fleetRun` with (this also records per-device failures, previously only done by the single-device routes):

```js
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
```

Also in `PUT /api/settings`, the `defaults` loop already ignores unknown keys; additionally, after loading `cfg` at startup add:

```js
delete cfg.defaults.AP_CYCLE_CRON; // retired; tolerated in old config files
```

and in the settings PUT, after computing `disk`, add `delete disk.defaults.AP_CYCLE_CRON;` so the next save drops it from disk.

- [ ] **Step 5: Run tests and a syntax check**

Run: `npm test && node --check server.js && node --check lib/ssh.js`
Expected: a summary of `pass 21` and `fail 0` (Node prints these as `# pass` or `ℹ pass` depending on version); no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add lib/ssh.js server.js test/ssh-parse.test.js
git commit -m "SSH: learned AP port map, cycle-mac, retire weekly-ap-cycle cron; render ALLOWED_MACS"
```

---

### Task 5: Server — AP inventory, scheduler driver, API routes, settings

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `lib/unifi.js`, `lib/apscheduler.js`, `ssh.cycleMac`, `ssh.haveAuth`.
- Produces routes:
  - `GET /api/aps` → `{ configured, syncedAt, aps: [ap], reboot: { enabled, day, start, hours, concurrency, timeoutMinutes, queueLength, inFlight: [mac], cycleStartedAt, lastCycleCompletedAt, nextWindowAt } }`. Each `ap` = inventory fields + `{ skip, lastReboot, rebootHistory, inFlight: bool, queued: bool }`.
  - `POST /api/aps/sync` → `{ ok, count }`
  - `POST /api/aps/:mac/reboot` → `{ ok, method }` or 409 (already in flight) / 422 (offline with no learned port or no SSH auth) / 428 (UniFi not configured)
  - `PUT /api/aps/:mac` body `{ skip: bool }` → `{ ok, skip }`
  - `GET /api/settings` adds `unifi: { configured, refreshMinutes, reboot }`; `PUT /api/settings` accepts `unifi: { refreshMinutes, reboot }` with validation (400 on bad values).
- State additions: `state.aps`, `state.apsSyncedAt`, `state.allowedMacs`, `state.apReboot`.

- [ ] **Step 1: Requires, state defaults, and helpers**

Near the other requires add:

```js
const unifi = require('./lib/unifi');
const apsched = require('./lib/apscheduler');
```

After the state file is loaded (after the `if (fs.existsSync(STATE_PATH)) ...` block) add:

```js
state.aps = state.aps || {};
state.allowedMacs = state.allowedMacs || [];
state.apsSyncedAt = state.apsSyncedAt || null;
state.apReboot = { ...apsched.emptySchedule(), ...(state.apReboot || {}) };
cfg.unifi = { refreshMinutes: 5, ...(cfg.unifi || {}) };
cfg.unifi.reboot = { enabled: false, day: 3, start: '02:00', hours: 3, concurrency: 3, timeoutMinutes: 8, ...(cfg.unifi.reboot || {}) };
```

Add a new section before `// --- express`:

```js
// --- UniFi access points -----------------------------------------------------
let unifiClient = null;
function getUnifi() {
  if (!unifi.isConfigured(cfg)) return null;
  if (!unifiClient) unifiClient = unifi.createClient(cfg);
  return unifiClient;
}

// Pull the AP list; keep portal-owned per-AP fields; refresh the whitelist.
async function syncAps() {
  const u = getUnifi();
  if (!u) throw new Error('UniFi not configured (unifi.url / unifi.apiKey in config.json)');
  const list = await u.listAccessPoints();
  const next = {};
  for (const ap of list) {
    const prev = state.aps[ap.mac] || {};
    next[ap.mac] = { ...ap, skip: !!prev.skip, lastReboot: prev.lastReboot || null, rebootHistory: prev.rebootHistory || [] };
  }
  state.aps = next;
  state.allowedMacs = Object.keys(next).sort();
  state.apsSyncedAt = new Date().toISOString();
  saveState();
  log.info('unifi sync ok', { aps: list.length, online: list.filter((a) => a.online).length });
  return list.length;
}

let apSyncTimer = null;
function scheduleApSync() {
  if (apSyncTimer) clearInterval(apSyncTimer);
  apSyncTimer = null;
  const mins = Number(cfg.unifi.refreshMinutes ?? 5);
  if (!mins || mins < 1 || !unifi.isConfigured(cfg)) return;
  apSyncTimer = setInterval(() => syncAps().catch((e) => log.warn('unifi sync failed', { error: e.message })), mins * 60 * 1000);
}

// Which switch/port carries this AP, from the maps learned on the switches.
function findApPort(mac) {
  for (const dev of Object.values(state.devices)) {
    const port = (dev.apPorts || {})[mac];
    if (port) return { dev, port };
  }
  return null;
}

function recordApResult(mac, f) {
  const ap = state.aps[mac];
  if (!ap) return;
  const entry = { at: new Date().toISOString(), method: f.method, result: f.result, via: f.via || null, port: f.port || null };
  ap.lastReboot = entry;
  ap.rebootHistory = [entry, ...(ap.rebootHistory || [])].slice(0, 10);
  log[f.result === 'ok' ? 'info' : 'warn']('AP reboot result', { ap: ap.name, mac, ...entry });
}

// Issue one reboot: UniFi RESTART when online, PoE cycle via the learned
// switch port when offline. `manual` turns the scheduler's re-queue paths into
// errors so the API caller gets a clear answer.
async function startApReboot(mac, now, { manual = false } = {}) {
  const ap = state.aps[mac];
  const u = getUnifi();
  const s = state.apReboot;
  if (!ap || !u) return;
  try {
    if (ap.online) {
      const up = await u.getUptime(ap.id);
      await u.restart(ap.id);
      s.inFlight[mac] = { startedAt: now.getTime(), method: 'unifi', uptimeBefore: up ? up.uptimeSec : null };
      log.info('AP restart issued via UniFi', { ap: ap.name, mac });
      return;
    }
    const loc = findApPort(mac);
    if (!loc) {
      if (manual) throw new Error('AP is offline and no switch port has been learned for it yet (run Check on the switches)');
      if (apsched.requeueOnce(s, mac)) log.warn('AP offline, port unknown; re-queued once', { ap: ap.name, mac });
      else recordApResult(mac, { method: 'poe', result: 'skipped-unknown-port' });
      return;
    }
    if (!ssh.haveAuth(cfg, sshCreds)) {
      if (manual) throw new Error('AP is offline and SSH credentials are not set for the PoE fallback');
      if (apsched.requeueOnce(s, mac)) log.warn('AP offline, no SSH auth; re-queued once', { ap: ap.name, mac });
      else recordApResult(mac, { method: 'poe', result: 'skipped-no-ssh' });
      return;
    }
    await ssh.cycleMac(cfg, sshCreds, loc.dev.ip, mac);
    s.inFlight[mac] = { startedAt: now.getTime(), method: 'poe', uptimeBefore: null, via: loc.dev.name, port: loc.port };
    log.info('AP offline: PoE cycled via switch', { ap: ap.name, mac, switch: loc.dev.name, port: loc.port });
  } catch (e) {
    if (manual) throw e;
    recordApResult(mac, { method: ap.online ? 'unifi' : 'poe', result: 'error: ' + e.message });
  }
}

// Confirmation predicate for in-flight entries (see spec "Confirmation rule").
function apIsBack(mac, uptimes, now) {
  const ap = state.aps[mac];
  const f = state.apReboot.inFlight[mac];
  if (!ap || !f || !ap.online) return false;
  const elapsed = (now.getTime() - f.startedAt) / 1000;
  const up = uptimes[mac];
  if (up && up.uptimeSec != null) return up.uptimeSec < elapsed + 120;
  return f.method === 'poe' && elapsed >= 60;
}

let apTickRunning = false;
async function apRebootTick() {
  if (apTickRunning) return;
  apTickRunning = true;
  try {
    const u = getUnifi();
    if (!u) return;
    const rb = cfg.unifi.reboot;
    const now = new Date();
    const s = state.apReboot;
    const inFlightMacs = Object.keys(s.inFlight);
    const staleMs = 2 * Math.max(1, Number(cfg.unifi.refreshMinutes ?? 5)) * 60000;
    const stale = !state.apsSyncedAt || now - new Date(state.apsSyncedAt) > staleMs;
    const open = !!rb.enabled && apsched.inWindow(now, rb) && !stale;
    if (!open && !inFlightMacs.length) return;

    if (inFlightMacs.length) {
      try { await syncAps(); } catch (e) { log.warn('unifi sync failed during reboot confirmation', { error: e.message }); }
    }
    const uptimes = {};
    for (const mac of inFlightMacs) {
      const ap = state.aps[mac];
      uptimes[mac] = ap ? await u.getUptime(ap.id).catch(() => null) : null;
    }

    if (open && apsched.refillIfEmpty(s, Object.values(state.aps), now)) {
      log.info('AP reboot cycle started', { queued: s.queue.length });
    }
    const r = apsched.nextActions(s, {
      now,
      concurrency: open ? Number(rb.concurrency) : 0,
      timeoutMinutes: Number(rb.timeoutMinutes),
      isBack: (mac) => apIsBack(mac, uptimes, now),
    });
    state.apReboot = r.sched;
    for (const f of r.finished) recordApResult(f.mac, f);
    for (const mac of r.start) await startApReboot(mac, now);

    const done = state.apReboot;
    if (done.cycleStartedAt && !done.queue.length && !Object.keys(done.inFlight).length) {
      done.lastCycleCompletedAt = now.toISOString();
      done.cycleStartedAt = null;
      log.info('AP reboot cycle complete');
    }
    saveState();
  } catch (e) {
    log.error('AP reboot tick crashed', { error: e.message });
  } finally {
    apTickRunning = false;
  }
}

function validateUnifiSettings(u) {
  const errs = [];
  const r = u.reboot || {};
  const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) errs.push(`${name} must be an integer ${lo}-${hi}`); return n; };
  const out = {
    refreshMinutes: num(u.refreshMinutes ?? cfg.unifi.refreshMinutes, 0, 1440, 'refreshMinutes'),
    reboot: {
      enabled: !!r.enabled,
      day: num(r.day ?? cfg.unifi.reboot.day, 0, 6, 'day'),
      start: String(r.start ?? cfg.unifi.reboot.start),
      hours: num(r.hours ?? cfg.unifi.reboot.hours, 1, 24, 'hours'),
      concurrency: num(r.concurrency ?? cfg.unifi.reboot.concurrency, 1, 10, 'concurrency'),
      timeoutMinutes: num(r.timeoutMinutes ?? cfg.unifi.reboot.timeoutMinutes, 2, 30, 'timeoutMinutes'),
    },
  };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.reboot.start)) errs.push('start must be HH:MM');
  return { out, errs };
}

function apView(ap) {
  const s = state.apReboot;
  return { ...ap, inFlight: !!s.inFlight[ap.mac], queued: s.queue.includes(ap.mac) };
}
```

- [ ] **Step 2: Routes**

After the existing `/api/settings` routes add:

```js
// --- access points -------------------------------------------------------------
app.get('/api/aps', (req, res) => {
  const rb = cfg.unifi.reboot;
  const s = state.apReboot;
  const next = apsched.nextWindowStart(new Date(), rb);
  res.json({
    configured: unifi.isConfigured(cfg),
    syncedAt: state.apsSyncedAt,
    aps: Object.values(state.aps).map(apView).sort((a, b) => a.name.localeCompare(b.name)),
    reboot: {
      ...rb,
      queueLength: s.queue.length,
      inFlight: Object.keys(s.inFlight),
      cycleStartedAt: s.cycleStartedAt,
      lastCycleCompletedAt: s.lastCycleCompletedAt,
      nextWindowAt: next ? next.toISOString() : null,
    },
  });
});

app.post('/api/aps/sync', async (req, res) => {
  try { res.json({ ok: true, count: await syncAps() }); }
  catch (e) { log.error('unifi sync failed', { error: e.message }); res.status(502).json({ ok: false, error: e.message }); }
});

app.put('/api/aps/:mac', (req, res) => {
  const ap = state.aps[req.params.mac.toLowerCase()];
  if (!ap) return res.status(404).json({ error: 'unknown access point' });
  ap.skip = !!(req.body || {}).skip;
  saveState();
  log.info('AP weekly reboot skip updated', { ap: ap.name, skip: ap.skip });
  res.json({ ok: true, skip: ap.skip });
});

app.post('/api/aps/:mac/reboot', async (req, res) => {
  const mac = req.params.mac.toLowerCase();
  const ap = state.aps[mac];
  if (!ap) return res.status(404).json({ error: 'unknown access point' });
  if (!getUnifi()) return res.status(428).json({ ok: false, error: 'UniFi not configured' });
  if (state.apReboot.inFlight[mac]) return res.status(409).json({ ok: false, error: 'a reboot of this AP is already in progress' });
  try {
    await startApReboot(mac, new Date(), { manual: true });
    saveState();
    const f = state.apReboot.inFlight[mac];
    log.info('manual AP reboot requested', { ap: ap.name, mac, method: f ? f.method : null });
    res.json({ ok: true, method: f ? f.method : null });
  } catch (e) {
    log.warn('manual AP reboot failed', { ap: ap.name, mac, error: e.message });
    res.status(422).json({ ok: false, error: e.message });
  }
});
```

Extend `GET /api/settings`:

```js
app.get('/api/settings', (req, res) => {
  res.json({
    defaults: cfg.defaults,
    autoCheckMinutes: Number(cfg.portal.autoCheckMinutes ?? 15),
    unifi: { configured: unifi.isConfigured(cfg), refreshMinutes: Number(cfg.unifi.refreshMinutes ?? 5), reboot: cfg.unifi.reboot },
  });
});
```

In `PUT /api/settings`, destructure `unifi: unifiIn` from the body too, and before the `fs.writeFileSync` add:

```js
  if (unifiIn && typeof unifiIn === 'object') {
    const { out, errs } = validateUnifiSettings(unifiIn);
    if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });
    cfg.unifi.refreshMinutes = out.refreshMinutes;
    cfg.unifi.reboot = out.reboot;
    disk.unifi = { ...(disk.unifi || {}), refreshMinutes: out.refreshMinutes, reboot: out.reboot };
    scheduleApSync();
  }
```

and include `unifi: { configured: unifi.isConfigured(cfg), refreshMinutes: cfg.unifi.refreshMinutes, reboot: cfg.unifi.reboot }` in its response JSON.

In `POST /api/sync`, after the backhaul MAC block add:

```js
    if (unifi.isConfigured(cfg)) {
      try { await syncAps(); }
      catch (e) { log.warn('UniFi AP sync failed during sync; keeping previous list', { error: e.message }); }
    }
```

In the `app.listen` callback add:

```js
  scheduleApSync();
  setInterval(apRebootTick, 30 * 1000);
  if (unifi.isConfigured(cfg)) syncAps().catch((e) => log.warn('initial unifi sync failed', { error: e.message }));
```

- [ ] **Step 3: Verify with curl (read-only against the real controller)**

```bash
node --check server.js && npm test
node server.js & sleep 2
curl -s http://127.0.0.1:8090/api/aps | python3 -c "import sys,json;d=json.load(sys.stdin);print('configured',d['configured'],'aps',len(d['aps']),'online',sum(a['online'] for a in d['aps']),'next',d['reboot']['nextWindowAt'],'enabled',d['reboot']['enabled'])"
curl -s -X PUT -H 'content-type: application/json' -d '{"unifi":{"refreshMinutes":5,"reboot":{"enabled":false,"day":3,"start":"02:00","hours":3,"concurrency":3,"timeoutMinutes":8}}}' http://127.0.0.1:8090/api/settings | head -c 300; echo
curl -s -o /dev/null -w 'bad start -> %{http_code}\n' -X PUT -H 'content-type: application/json' -d '{"unifi":{"reboot":{"start":"2am"}}}' http://127.0.0.1:8090/api/settings
MAC=$(curl -s http://127.0.0.1:8090/api/aps | python3 -c "import sys,json;print(json.load(sys.stdin)['aps'][0]['mac'])")
curl -s -X PUT -H 'content-type: application/json' -d '{"skip":true}' http://127.0.0.1:8090/api/aps/$MAC; echo
curl -s -X PUT -H 'content-type: application/json' -d '{"skip":false}' http://127.0.0.1:8090/api/aps/$MAC; echo
kill %1
python3 -c "import json;d=json.load(open('state/devices.json'));print('allowedMacs',len(d['allowedMacs']),'aps',len(d['aps']))"
```

Expected: `configured True aps 64 online <n> next <ISO date of next Wednesday 02:00> enabled False`; the settings PUT echoes `ok: true` with the `unifi` block; `bad start -> 400`; skip toggles return `{"ok":true,"skip":true}` then `false`; state shows `allowedMacs 64 aps 64`. **Do not call `/api/aps/:mac/reboot` here.**

Also confirm drift now shows: with the seed state, `GET /api/devices/<key>/preview` for any seeded device contains an `ALLOWED_MACS="..."` line with 64 MACs:

```bash
node server.js & sleep 2; curl -s "http://127.0.0.1:8090/api/devices/aa:bb:cc:00:00:01/preview" | grep -c 'ALLOWED_MACS="[0-9a-f:]' ; kill %1
```

Expected: `1`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Server: UniFi AP inventory, rolling reboot scheduler driver, AP routes and settings"
```

---

### Task 6: UI — Access points view and UniFi settings card

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/app.css`

**Interfaces:**
- Consumes: `GET /api/aps`, `POST /api/aps/sync`, `POST /api/aps/:mac/reboot`, `PUT /api/aps/:mac`, extended `/api/settings`; existing helpers `$`, `$$`, `icon`, `esc`, `fmtTime`, `api`, `toast`, `dlg`, `busy`, `fieldHtml`, `refreshDevices`, router `VIEWS`/`route()`.
- Produces: view `#/aps` with `loadAps()`, `renderAps()`; Settings card ids `#unifiRefresh #rbEnabled #rbDay #rbStart #rbHours #rbConc #rbTimeout`.

- [ ] **Step 1: Markup**

In `public/index.html`, add a sidebar item between Devices and Settings:

```html
    <li class="nav-item"><a class="nav-link" href="#/aps" data-view="aps">
      <svg class="nav-icon"><use href="/vendor/icons/sprites/free.svg#cil-wifi-signal-4"></use></svg>Access points</a></li>
```

After the Devices `</section>` add:

```html
    <!-- ===== Access points ===== -->
    <section id="view-aps" class="view" hidden>
      <div class="alert alert-warning" id="apsNotConfigured" hidden>
        UniFi is not configured. Add <code>unifi.url</code> and <code>unifi.apiKey</code> to <code>config.json</code> and restart the portal.
      </div>
      <div class="row g-3 mb-4">
        <div class="col-6 col-xl-3"><div class="card stat-card"><div class="card-body">
          <div class="small text-uppercase text-body-secondary">Access points</div>
          <div class="stat-value" id="apStatTotal">–</div></div></div></div>
        <div class="col-6 col-xl-3"><div class="card stat-card"><div class="card-body">
          <div class="small text-uppercase text-body-secondary">Online</div>
          <div class="stat-value text-success" id="apStatOnline">–</div></div></div></div>
        <div class="col-6 col-xl-3"><div class="card stat-card"><div class="card-body">
          <div class="small text-uppercase text-body-secondary">Offline</div>
          <div class="stat-value text-danger" id="apStatOffline">–</div></div></div></div>
        <div class="col-6 col-xl-3"><div class="card stat-card"><div class="card-body">
          <div class="small text-uppercase text-body-secondary">Rebooted last 7 days</div>
          <div class="stat-value" id="apStatRebooted">–</div></div></div></div>
      </div>

      <div class="card mb-4">
        <div class="card-body d-flex flex-wrap align-items-center gap-3 py-2">
          <span id="rbBadge" class="badge text-bg-secondary">schedule off</span>
          <span class="small" id="rbSummary"></span>
          <span class="small text-body-secondary" id="rbProgress"></span>
          <a class="small ms-auto" href="#/settings">Edit schedule</a>
        </div>
      </div>

      <div class="card">
        <div class="card-header d-flex flex-wrap align-items-center gap-2">
          <div class="input-group input-group-sm" style="max-width: 280px">
            <span class="input-group-text"><svg class="icon"><use href="/vendor/icons/sprites/free.svg#cil-search"></use></svg></span>
            <input class="form-control" id="apSearch" placeholder="Search name, MAC, IP, model" autocomplete="off">
          </div>
          <select class="form-select form-select-sm w-auto" id="apFilter">
            <option value="all">All</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="skipped">Skipped</option>
          </select>
          <span class="small text-body-secondary" id="apSynced"></span>
          <button class="btn btn-sm btn-outline-secondary ms-auto" id="btnApSync" type="button">Sync from UniFi</button>
          <span class="small text-body-secondary" id="apCount"></span>
        </div>
        <div class="table-responsive">
          <table class="table table-hover table-devices mb-0" id="apTbl" hidden>
            <thead class="table-light">
              <tr><th>State</th><th>Name</th><th>Model</th><th>MAC</th><th>IP</th><th>Firmware</th><th>Last reboot</th><th></th></tr>
            </thead>
            <tbody id="apRows"></tbody>
          </table>
          <div class="text-center text-body-secondary py-5" id="apEmpty">No access points yet. Use <strong>Sync from UniFi</strong>.</div>
          <div class="text-center text-body-secondary py-4" id="apNoMatch" hidden>No access points match the current filter.</div>
        </div>
      </div>
    </section>
```

In the Settings section, inside the `col-lg-5` column, before the `#settingsSaved` alert, add:

```html
          <div class="card mb-4">
            <div class="card-header fw-semibold">UniFi</div>
            <div class="card-body">
              <div class="small text-body-secondary mb-2" id="unifiStatus"></div>
              <label class="form-label small" for="unifiRefresh">AP list refresh (minutes, 0 = off)</label>
              <input class="form-control form-control-sm mono mb-3" id="unifiRefresh" inputmode="numeric" autocomplete="off">
              <div class="form-check form-switch mb-2">
                <input class="form-check-input" type="checkbox" id="rbEnabled">
                <label class="form-check-label" for="rbEnabled">Weekly rolling AP reboot</label>
              </div>
              <div class="row g-2">
                <div class="col-6"><label class="form-label small" for="rbDay">Day</label>
                  <select class="form-select form-select-sm" id="rbDay">
                    <option value="0">Sunday</option><option value="1">Monday</option><option value="2">Tuesday</option>
                    <option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option>
                  </select></div>
                <div class="col-6"><label class="form-label small" for="rbStart">Start (Pi local time)</label>
                  <input class="form-control form-control-sm mono" id="rbStart" placeholder="02:00" autocomplete="off"></div>
                <div class="col-4"><label class="form-label small" for="rbHours">Hours</label>
                  <input class="form-control form-control-sm mono" id="rbHours" inputmode="numeric"></div>
                <div class="col-4"><label class="form-label small" for="rbConc">At once</label>
                  <input class="form-control form-control-sm mono" id="rbConc" inputmode="numeric"></div>
                <div class="col-4"><label class="form-label small" for="rbTimeout">Timeout (min)</label>
                  <input class="form-control form-control-sm mono" id="rbTimeout" inputmode="numeric"></div>
              </div>
              <div class="form-text">APs are restarted through UniFi in random order, a few at a time, only inside this window; a queue continues across weeks until every AP has been done. Offline APs get a PoE cycle via their switch instead, which needs SSH auth.</div>
            </div>
          </div>
```

- [ ] **Step 2: CSS**

Append to `public/app.css`:

```css
.ap-inflight .badge { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .45; } }
```

- [ ] **Step 3: JavaScript — router entry and the APs section**

In `public/app.js`, add to `VIEWS` (between devices and settings):

```js
  aps: { title: 'Access points', enter: () => loadAps() },
```

Add a stub `async function loadAps() {}` next to the others is NOT needed; instead insert the full section below before `// --- header:` (after the per-device actions section):

```js
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
```

In `route()`, after the `document.title = ...` line add auto-refresh management:

```js
  clearInterval(APS_TIMER);
  APS_TIMER = null;
  if (name === 'aps') APS_TIMER = setInterval(refreshAps, 30000);
```

(`APS_TIMER` is declared with `let` in the APs section; because `route()` only runs at boot and on hash changes, after all declarations, this is safe.)

- [ ] **Step 4: JavaScript — settings card**

In `loadSettings()`, after `$('#autoCheck').value = ...` add:

```js
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
```

In the settings `onsubmit` handler, extend the PUT body:

```js
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
```

- [ ] **Step 5: Verify in the browser**

Start the server (real controller configured, read-only), open `http://127.0.0.1:8090/#/aps`:
- Sidebar shows Access points between Devices and Settings; header title reads "Access points".
- Stat cards show 64 / online / offline / 0 rebooted. Schedule card shows "schedule off", "Wednesdays 02:00 for 3 h, 3 at a time".
- Table lists all APs sorted by name; search `station` narrows; filter Offline shows only offline APs; Skipped shows none.
- Toggle skip on one AP: toast "Skipped in weekly reboot", filter Skipped shows it; toggle back.
- Click Reboot now on any AP: the confirm modal opens with the online/offline wording. **Click Cancel.** Do not confirm.
- Sync from UniFi: spinner, green toast with the count, synced-at text updates.
- Settings: UniFi card shows the controller as configured with the defaults; change Start to `2am`, Save: red toast "Save failed: start must be HH:MM"; set back to `02:00`, Save: green alert. Leave "Weekly rolling AP reboot" **off**.
- Console has no errors; no external network requests.
- Wait 35 s on the AP view and confirm a second `GET /api/aps` request appears (auto-refresh), and that leaving the view stops them.

Stop the server, restore `state/devices.json` from `state/seed.json`.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/app.css
git commit -m "UI: access points view with schedule status, reboot/skip actions; UniFi settings card"
```

---

### Task 7: Installer wizard, README, and example config cleanup

**Files:**
- Modify: `install.sh`
- Modify: `README.md`

- [ ] **Step 1: Installer questions**

In `install.sh`, after the `ask "Portal port" "8090"` / `PORTAL_PORT="$REPLY"` lines add:

```bash
    ask "UniFi controller URL (optional, e.g. https://unifi.example.com:11443; blank to skip)" ""
    UNIFI_URL="$REPLY"
    UNIFI_KEY=""
    if [ -n "$UNIFI_URL" ]; then
      ask "UniFi Network Integration API key (Settings → Control Plane → Integrations)" ""
      UNIFI_KEY="$REPLY"
    fi
```

In the non-tty branch add `UNIFI_URL=""; UNIFI_KEY=""`. Pass `UNIFI_URL="$UNIFI_URL" UNIFI_KEY="$UNIFI_KEY"` into the `node -e` environment and inside the node snippet add:

```js
    if (process.env.UNIFI_URL) { cfg.unifi.url = process.env.UNIFI_URL; cfg.unifi.apiKey = process.env.UNIFI_KEY || cfg.unifi.apiKey; }
```

Also update the installer's opening comment ("asks four questions") to say the wizard asks for UISP URL/token, portal password, port, and optionally the UniFi URL and API key.

- [ ] **Step 2: README**

- In the intro bullets add: "**UniFi is the access-point source**: the Network Integration API (API key) lists every AP, drives a weekly rolling reboot (random order, a few at a time, inside a window you set; offline APs get a PoE cycle from their switch instead), and its MAC list is rendered into each switch as a strict whitelist of PoE ports the watchdog may manage."
- In the config table add a row: `unifi` — URL + Integration API key (UniFi → Settings → Control Plane → Integrations → Create API Key). `refreshMinutes` and `reboot.*` are editable in the Settings view.
- In the `defaults` row, remove the mention of the AP cycle cron, keep the weekly reboot.
- Add a short "Weekly AP reboot" section (4–6 lines) describing the window, concurrency, round robin across weeks, offline fallback, and that the per-switch weekly AP cycle is retired on the next deploy.

- [ ] **Step 3: Verify**

```bash
bash -n install.sh && echo "install.sh parses"
grep -n "AP_CYCLE_CRON\|weekly-ap-cycle" README.md install.sh config.example.json templates/poe-watchdog.sh.tpl lib/ssh.js server.js public/app.js; echo "exit=$?"
npm test
```

Expected: `install.sh parses`; the grep finds only the intentional occurrences in `lib/ssh.js` (the `delete ... weekly-ap-cycle` line and the `cronScheduled` regex) and `server.js` (the two `delete ... AP_CYCLE_CRON` lines); tests pass.

- [ ] **Step 4: Commit**

```bash
git add install.sh README.md
git commit -m "Installer + README: UniFi URL/API key wizard questions, document AP reboot and whitelist"
```

---

### Task 8: Integration check against the real controller (one AP), drift and status on one switch

This task is verification only. It needs two inputs from the user: the name of one AP that may be rebooted, and confirmation that one ER-X may receive a Check and a Deploy. If either is not available, do the parts that are, and report exactly what was skipped.

**Files:** none changed unless a bug is found (then fix minimally in the file concerned, with its own commit and tests where applicable).

- [ ] **Step 1: Ask the user** for the AP name and permission to Check/Deploy one switch. Record the answer in the report.

- [ ] **Step 2: Manual reboot of the named AP**

With the server running and the AP view open: click **Reboot now** on the named AP, confirm. Expected: green toast "… reboot issued via unifi", row shows "rebooting…" with a pulsing badge and a disabled button; within about 2–5 minutes the auto-refresh shows the row back to "online" with Last reboot `ok via unifi`, and the portal log (Logs view) shows "AP restart issued via UniFi" then "AP reboot result … ok". Record the timestamps.

- [ ] **Step 3: Drift and whitelist on one switch** (only with permission and SSH auth set)

- Devices view → Check on the switch: expect amber "drift detected", because `ALLOWED_MACS` is now rendered.
- Deploy on that switch: expect success and "in sync + scheduled" (green). If it stays amber "in sync, no scheduler", the legacy `weekly-ap-cycle` task was not deleted; inspect the deploy steps in the toast/log and fix the delete command.
- Dropdown → Watchdog status: expect the line `whitelist       : 64 allowed MACs, allowed ports: …` (allowed ports fill in after the next 1-minute check on the switch) and no `weekly-ap-cycle` reference. Run Check again a couple of minutes later and confirm the device's Overrides/preview is unchanged and `state/devices.json` for that switch now has a non-empty `apPorts` map.

- [ ] **Step 4: Report**

Write the observed results, including anything skipped and why, to the task report. If the user later enables the schedule, remind them the first window will start a shuffled cycle of all non-skipped APs.

---

## Self-review notes

- Spec coverage: config (T1), UniFi client (T1), inventory + timer + whitelist render (T4/T5), learned port map (T3/T4), scheduler logic and driver (T2/T5), API (T5), template modes and whitelist (T3), scheduler retirement (T3/T4), UI pane and settings (T6), installer/README (T7), error handling (T5 driver + routes), security (key never returned: T5 `GET /api/settings` returns `configured` only), tests (T1–T4 unit; T6/T8 manual).
- Type consistency: in-flight entry shape `{ startedAt (ms), method, uptimeBefore, via?, port? }` is used identically by `apscheduler.nextActions` (T2), `startApReboot`/`apIsBack` (T5) and the row rendering (T6 via `lastReboot.method/via/port`). `apPorts` is `{ mac: port }` in `ssh.parseApmap` (T4), stored per device (T4), read by `findApPort` (T5).
- The `fleetRun` per-device failure recording (T4) is the change reverted from the UI branch; it lands here deliberately.
