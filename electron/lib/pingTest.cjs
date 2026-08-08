'use strict';
// Latency measurement for the sidebar's ping pill.
//
// The number this returns is a measurement, never an estimate: a real TCP
// handshake against the server, repeated, with the noise sources that would
// inflate it deliberately removed --
//
//   * DNS is resolved ONCE up front and the samples dial the resulting IP, so
//     a slow resolver doesn't get billed to the server's latency (the old
//     single-shot version measured DNS + handshake together and reported the
//     sum as "ping").
//   * The first handshake is a throwaway: it also pays for ARP/route setup and
//     any conntrack entry the path needs, and reads 20-80ms high on a cold
//     route.
//   * The headline figure is the MEDIAN of the remaining samples, so one
//     scheduling hiccup can't move it -- min/max/jitter/loss ride along for
//     the tooltip.
const net = require('net');
const dns = require('dns');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// hrtime rather than Date.now(): the wall clock has ~1-15ms granularity on
// Windows, which is the same order as the thing being measured.
function handshake(address, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const socket = new net.Socket();
    let done = false;

    const finish = (ms) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ms);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(Number(process.hrtime.bigint() - start) / 1e6));
    socket.once('error', () => finish(-1));
    socket.once('timeout', () => finish(-1));

    socket.connect(port, address);
  });
}

// Kept for callers that just want one reachability probe.
function tcpPing(address, port, timeoutMs = 5000) {
  return handshake(address, port, timeoutMs).then((ms) => (ms < 0 ? -1 : Math.round(ms)));
}

async function resolveOnce(host, timeoutMs = 4000) {
  if (net.isIP(host)) return { ip: host, dnsMs: 0 };
  const start = process.hrtime.bigint();
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), timeoutMs));
  // verbatim:false keeps the OS's own address preference (A before AAAA on a
  // v4-only link), matching what xray will actually dial.
  const { address } = await Promise.race([dns.promises.lookup(host, { verbatim: false }), timer]);
  return { ip: address, dnsMs: Number(process.hrtime.bigint() - start) / 1e6 };
}

function median(sorted) {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(samples) {
  const ok = samples.filter((s) => s > 0);
  const loss = Math.round(((samples.length - ok.length) / Math.max(samples.length, 1)) * 100);
  if (!ok.length) return { ms: -1, min: null, max: null, avg: null, jitter: null, loss: 100, samples };
  const sorted = [...ok].sort((a, b) => a - b);
  let jitter = null;
  if (ok.length > 1) {
    let sum = 0;
    for (let i = 1; i < ok.length; i++) sum += Math.abs(ok[i] - ok[i - 1]);
    jitter = sum / (ok.length - 1);
  }
  return {
    ms: Math.round(median(sorted)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    avg: Math.round(ok.reduce((a, b) => a + b, 0) / ok.length),
    jitter: jitter == null ? null : Math.round(jitter),
    loss,
    samples: samples.map((s) => (s > 0 ? Math.round(s) : -1)),
  };
}

// Sequential on purpose -- parallel handshakes queue behind each other in the
// same socket buffer and measure contention instead of latency.
async function measurePing(address, port, { count = 5, timeoutMs = 3000, gapMs = 80 } = {}) {
  let ip;
  let dnsMs;
  try {
    ({ ip, dnsMs } = await resolveOnce(address));
    dnsMs = Math.round(dnsMs);
  } catch (err) {
    // Stop here rather than falling through to the handshakes: socket.connect()
    // on a hostname goes through the very same OS resolver that just failed, so
    // every sample would re-pay the lookup and fail identically. Measured on a
    // link with a slow NXDOMAIN path, that redundancy cost 8.5s to learn
    // nothing the first lookup hadn't already said.
    const timedOut = /timeout/i.test(err.message || '');
    return {
      method: 'tcp',
      ip: null,
      dnsMs: null,
      dnsFailed: true,
      dnsError: timedOut
        ? 'ترجمه‌ی نام دامنه‌ی سرور بیش از حد طول کشید (DNS)'
        : 'نام دامنه‌ی سرور پیدا نشد (DNS)',
      warmupMs: null,
      ...summarize([]),
    };
  }
  const target = ip;

  const warmup = await handshake(target, port, timeoutMs);
  const samples = [];
  for (let i = 0; i < count; i++) {
    const ms = await handshake(target, port, timeoutMs);
    samples.push(ms);
    // A host that answers nothing would otherwise burn count x timeoutMs
    // before saying so -- with a failed warm-up, two dead samples is enough.
    if (warmup < 0 && samples.length >= 2 && !samples.some((s) => s > 0)) break;
    if (i < count - 1) await sleep(gapMs);
  }

  return {
    method: 'tcp',
    ip,
    dnsMs,
    dnsFailed: false,
    warmupMs: warmup > 0 ? Math.round(warmup) : null,
    ...summarize(samples),
  };
}

module.exports = { tcpPing, measurePing };
