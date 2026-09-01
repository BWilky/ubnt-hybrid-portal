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

// Returns { installed, remoteHash, inSync, uptime }
async function checkStatus(cfg, creds, host, renderedScript) {
  return withConn(cfg, creds, host, async (conn) => {
    const hash = await exec(conn, `sha256sum ${REMOTE_PATH} 2>/dev/null | awk '{print $1}'`);
    const up = await exec(conn, 'uptime');
    const sched = await exec(conn, "grep -c 'poe-watchdog' /etc/cron.d/vyatta-crontab 2>/dev/null || echo 0");
    const remoteHash = hash.stdout.trim();
    return {
      installed: !!remoteHash,
      remoteHash,
      inSync: remoteHash === sha256(renderedScript),
      scheduled: parseInt(sched.stdout.trim(), 10) > 0,
      uptime: up.stdout.trim(),
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
      `${W} set system task-scheduler task weekly-ap-cycle executable path ${REMOTE_PATH}`,
      `${W} set system task-scheduler task weekly-ap-cycle executable arguments weekly-ap-cycle`,
      `${W} set system task-scheduler task weekly-ap-cycle crontab-spec '${vars.AP_CYCLE_CRON}'`,
      `${W} set system task-scheduler task weekly-reboot executable path ${REMOTE_PATH}`,
      `${W} set system task-scheduler task weekly-reboot executable arguments weekly-reboot`,
      `${W} set system task-scheduler task weekly-reboot crontab-spec '${vars.REBOOT_CRON}'`,
      `${W} commit`,
      `${W} save`,
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

    return { ok: true, steps };
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

module.exports = { haveAuth, checkStatus, getWatchdogStatus, deploy, pooledMap, sha256, REMOTE_PATH };
