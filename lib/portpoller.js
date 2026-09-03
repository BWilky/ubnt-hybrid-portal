'use strict';
// Pure scheduling for per-switch SSH port reads. No I/O: server.js owns the
// worker, the clock, and the SSH calls. Guarantees at most one read in flight
// (the worker pulls one job at a time) and lets an open device page jump ahead
// of the 30-minute background sweep.

const RATE_WINDOW_MS = 5 * 60 * 1000;

function emptyQueue() {
  return { pending: [], last: {} };
}

// Add a job, or upgrade a queued background job to live. Returns whether the
// queue changed. `live` jobs sit at the front (most-recent live first).
function enqueue(state, key, priority = 'background') {
  const existing = state.pending.find((j) => j.key === key);
  if (existing) {
    if (priority === 'live' && existing.priority !== 'live') {
      state.pending = state.pending.filter((j) => j.key !== key);
      state.pending.unshift({ key, priority: 'live' });
      return true;
    }
    return false;
  }
  if (priority === 'live') state.pending.unshift({ key, priority: 'live' });
  else state.pending.push({ key, priority: 'background' });
  return true;
}

function dueForBackground(state, keys, now, backgroundMs) {
  const pending = new Set(state.pending.map((j) => j.key));
  return keys.filter((k) => !pending.has(k) && (state.last[k] === undefined || now - state.last[k] >= backgroundMs));
}

function nextJob(state) {
  return state.pending.shift() || null;
}

function recordRead(state, key, now) {
  state.last[key] = now;
}

function rate(prev, cur, port, field) {
  if (!prev || !cur) return null;
  const dt = cur.at - prev.at;
  if (dt <= 0 || dt > RATE_WINDOW_MS) return null;
  const a = (prev.ports.find((p) => p.port === port) || {})[field];
  const b = (cur.ports.find((p) => p.port === port) || {})[field];
  if (a == null || b == null || b < a) return null;   // counter reset → null
  return Math.round(((b - a) / dt) * 1000);
}

module.exports = { emptyQueue, enqueue, dueForBackground, nextJob, recordRead, rate };
