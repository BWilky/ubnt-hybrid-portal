'use strict';
// Tiny logger: timestamped lines to stdout (journalctl picks these up when
// running under systemd) + an in-memory ring buffer served at /api/logs so
// the web UI can show recent activity. Never log secrets — callers must
// redact passwords/tokens before passing meta.

const MAX_ENTRIES = 500;
const buffer = [];

function fmtMeta(meta) {
  if (!meta) return '';
  return ' ' + Object.entries(meta)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

function log(level, msg, meta) {
  const at = new Date().toLocaleString('sv-SE'); // local time, YYYY-MM-DD HH:MM:SS
  const line = `${at} ${level.toUpperCase().padEnd(5)} ${msg}${fmtMeta(meta)}`;
  (level === 'error' ? console.error : console.log)(line);
  buffer.push({ at, level, msg, meta: meta || null });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  recent: (n = 200) => buffer.slice(-n),
};
