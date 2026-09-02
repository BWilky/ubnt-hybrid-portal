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
