'use strict';
// SSH transport for EdgeOS devices: exec commands, upload the rendered
// watchdog script, verify by hash, ensure task-scheduler entries.

const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');
const log = require('./log');

const REMOTE_PATH = '/config/scripts/poe-watchdog.sh';
const TMP_PATH = '/tmp/poe-watchdog.sh.new';

// Credentials are held in memory by the server (entered via the GUI) and
// passed in per call as `creds` = { username, password }. They are never
// read from or written to disk here. Optional fallback: a key file path in
// config.json for unattended setups.
function haveAuth(cfg, creds) {
  if (creds && creds.username && creds.password) return true;
  return !!(cfg.ssh.privateKeyPath && cfg.ssh.username && fs.existsSync(cfg.ssh.privateKeyPath));
}

function connOpts(cfg, creds, host) {
  const o = {
    host,
    port: cfg.ssh.port || 22,
    readyTimeout: cfg.ssh.readyTimeoutMs || 10000,
    algorithms: { serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-rsa'] },
  };
  if (creds && creds.username && creds.password) {
    o.username = creds.username;
    o.password = creds.password;
  } else if (cfg.ssh.privateKeyPath && cfg.ssh.username && fs.existsSync(cfg.ssh.privateKeyPath)) {
    o.username = cfg.ssh.username;
    o.privateKey = fs.readFileSync(cfg.ssh.privateKeyPath);
  } else {
    throw new Error('SSH credentials not set — enter them via "SSH login" in the portal.');
  }
  return o;
}

function withConn(cfg, creds, host, fn) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      log.error('ssh session timeout', { host, ms: Date.now() - t0 });
      reject(new Error('SSH session timeout'));
    }, 90000);

    log.info('ssh connecting', { host });
    conn
      .on('ready', async () => {
        log.info('ssh connected', { host, ms: Date.now() - t0 });
        try {
          const out = await fn(conn);
          clearTimeout(timer);
          conn.end();
          log.info('ssh done', { host, ms: Date.now() - t0 });
          resolve(out);
        } catch (e) {
          clearTimeout(timer);
          conn.end();
          log.error('ssh operation failed', { host, error: e.message, ms: Date.now() - t0 });
          reject(e);
        }
      })
      .on('error', (e) => {
        clearTimeout(timer);
        log.error('ssh connect failed', { host, error: e.message, ms: Date.now() - t0 });
        reject(e);
      })
      .connect(connOpts(cfg, creds, host));
  });
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream
        .on('close', (code) => resolve({ code, stdout, stderr }))
        .on('data', (d) => (stdout += d))
        .stderr.on('data', (d) => (stderr += d));
    });
  });
}

function sftpWrite(conn, remotePath, content) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remotePath, { mode: 0o755 });
      ws.on('close', resolve).on('error', reject);
      ws.end(content);
    });
  });
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// --- public operations -------------------------------------------------------

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

async function getWatchdogStatus(cfg, creds, host) {
  return withConn(cfg, creds, host, async (conn) => {
    const r = await exec(conn, `sudo ${REMOTE_PATH} status 2>&1`);
    const logs = await exec(conn, "grep poe-watchdog /var/log/messages 2>/dev/null | tail -n 30");
    return { status: r.stdout || r.stderr, logs: logs.stdout };
  });
}

// Upload rendered script + ensure task-scheduler entries. Idempotent.
async function deploy(cfg, creds, host, renderedScript, vars) {
  return withConn(cfg, creds, host, async (conn) => {
    const steps = [];

    await sftpWrite(conn, TMP_PATH, renderedScript);
    steps.push('uploaded');
    log.info('deploy: uploaded', { host });

    const mv = await exec(
      conn,
      `sudo mv ${TMP_PATH} ${REMOTE_PATH} && sudo chown root:root ${REMOTE_PATH} && sudo chmod 755 ${REMOTE_PATH} && echo OK`
    );
    if (!/OK/.test(mv.stdout)) throw new Error('install failed: ' + (mv.stderr || mv.stdout));
    steps.push('installed');

    // Verify hash
    const hash = await exec(conn, `sha256sum ${REMOTE_PATH} | awk '{print $1}'`);
    if (hash.stdout.trim() !== sha256(renderedScript)) throw new Error('hash mismatch after install');
    steps.push('verified');

    // Ensure scheduler (idempotent: set overwrites)
    const W = '/opt/vyatta/sbin/vyatta-cfg-cmd-wrapper';
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

    const sched = await exec(conn, `sudo sg vyattacfg -c "${schedCmd}" 2>&1`);
    if (sched.code !== 0 && !/Nothing to commit/i.test(sched.stdout + sched.stderr)) {
      // "Nothing to commit" just means it was already configured
      steps.push('scheduler: WARN ' + (sched.stderr || sched.stdout).slice(0, 200));
    } else {
      steps.push('scheduler ok');
    }
    log.info('deploy: finished', { host, steps: steps.join('|') });

    const apmap = await exec(conn, `sudo ${REMOTE_PATH} apmap 2>/dev/null`);
    const apPorts = parseApmap(apmap.stdout);

    return { ok: true, steps, apPorts };
  });
}

// Install the portal's public key on a device's login user (idempotent) and
// verify a trivial exec works. Used by the one-click key-auth setup.
async function installPubkey(cfg, creds, host, pub) {
  return withConn(cfg, creds, host, async (conn) => {
    const W = '/opt/vyatta/sbin/vyatta-cfg-cmd-wrapper';
    const cmd = [
      `${W} begin`,
      `${W} set system login user ${creds.username} authentication public-keys ${pub.name} type ${pub.type}`,
      `${W} set system login user ${creds.username} authentication public-keys ${pub.name} key ${pub.b64}`,
      `${W} commit`,
      `( [ -f /var/run/poe-watchdog/cut_ports ] || ${W} save )`,
      `${W} end`,
    ].join(' && ');
    const r = await exec(conn, `sudo sg vyattacfg -c "${cmd}" 2>&1`);
    // EdgeOS wrapper chains often exit non-zero even on success (warnings,
    // `end`), so don't trust the exit code — the caller verifies the install
    // by actually logging in with the key. Just log the output for debugging.
    if (r.code !== 0) {
      log.warn('key install: non-zero exit (usually harmless)', { host, out: (r.stderr || r.stdout).slice(0, 200) });
    }
    log.info('public key install attempted', { host, user: creds.username });
    return true;
  });
}

// Trivial connect+exec, used to verify auth works (e.g. key fallback).
async function ping(cfg, creds, host) {
  return withConn(cfg, creds, host, async (conn) => {
    const r = await exec(conn, 'echo ok');
    return /ok/.test(r.stdout);
  });
}

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

// Simple concurrency-limited map
async function pooledMap(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = { ok: true, value: await fn(items[idx]) };
      } catch (e) {
        results[idx] = { ok: false, error: e.message };
      }
    }
  }
  const n = Math.min(limit, items.length) || 1;
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

module.exports = { haveAuth, checkStatus, getWatchdogStatus, deploy, cycleMac, installPubkey, ping, pooledMap, sha256, parseApmap, cronScheduled, REMOTE_PATH };
