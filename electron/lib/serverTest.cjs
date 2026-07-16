'use strict';
// Server evaluation engine behind the "سرور یاب" (Server Finder):
//   Mode 1  pingStats  — ICMP (best effort) + TCP latency samples → avg/min/max/jitter/loss
//   Mode 2  realPing   — boots a throwaway xray instance for the profile and measures
//                        the latency actually experienced through the tunnel
//   Mode 3  speedTest  — benchmarks download/upload throughput through the tunnel
// Every entry point takes a caller-provided token so an in-flight test can be
// cancelled from the renderer via cancel(token).
const net = require('net');
const tls = require('tls');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildXrayConfig } = require('./xrayConfig.cjs');
const { XrayProcess } = require('./xrayProcess.cjs');
const { findFreePort } = require('./freePort.cjs');

const SPEED_HOST = 'speed.cloudflare.com';
const DOWN_PATH = '/__down?bytes=80000000';
const UP_PATH = '/__up';
const PROBE_URL = 'http://www.gstatic.com/generate_204';

// ---- cancellation registry ----
const controllers = new Map();

function begin(token) {
  const c = new AbortController();
  controllers.set(token, c);
  return c.signal;
}
function end(token) {
  controllers.delete(token);
}
function cancel(token) {
  const c = controllers.get(token);
  if (c) c.abort();
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error('cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(done, ms);
  function done() {
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  }
  function onAbort() {
    clearTimeout(t);
    const err = new Error('cancelled');
    err.name = 'AbortError';
    if (signal) signal.removeEventListener('abort', onAbort);
    reject(err);
  }
  if (signal) signal.addEventListener('abort', onAbort);
});

function stats(okSamples) {
  if (!okSamples.length) return { avg: null, min: null, max: null, jitter: null };
  const avg = Math.round(okSamples.reduce((a, b) => a + b, 0) / okSamples.length);
  const min = Math.min(...okSamples);
  const max = Math.max(...okSamples);
  let jitter = null;
  if (okSamples.length > 1) {
    let sum = 0;
    for (let i = 1; i < okSamples.length; i++) sum += Math.abs(okSamples[i] - okSamples[i - 1]);
    jitter = Math.round(sum / (okSamples.length - 1));
  }
  return { avg, min, max, jitter };
}

// ---- Mode 1: network ping ----

function tcpPingOnce(address, port, timeoutMs, signal) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ms) => {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(ms);
    };
    const onAbort = () => finish(-1);
    if (signal) signal.addEventListener('abort', onAbort);
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(Date.now() - start));
    socket.once('error', () => finish(-1));
    socket.once('timeout', () => finish(-1));
    socket.connect(port, address);
  });
}

// Windows ping.exe with locale-tolerant parsing: reply lines are detected by
// the untranslated "TTL=" marker and times by the trailing "<n>ms" token.
function icmpPingStats(address, { count = 4, timeoutMs = 3000, signal } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn('ping', ['-n', String(count), '-w', String(timeoutMs), address], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    const onAbort = () => { try { proc.kill(); } catch { /* ignore */ } };
    if (signal) signal.addEventListener('abort', onAbort);
    proc.stdout.on('data', (b) => { out += b.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const samples = [];
      for (const line of out.split(/\r?\n/)) {
        if (!/TTL=/i.test(line)) continue;
        const m = line.match(/[=<](\d+)\s*ms/i);
        if (m) samples.push(Number(m[1]));
      }
      if (!samples.length) return resolve(null);
      const loss = Math.round(((count - samples.length) / count) * 100);
      resolve({ method: 'icmp', samples, loss, ...stats(samples) });
    });
    setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, count * (timeoutMs + 1000) + 4000);
  });
}

async function tcpPingStats(address, port, { count = 6, timeoutMs = 4000, gapMs = 140, signal, onSample } = {}) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    throwIfAborted(signal);
    const ms = await tcpPingOnce(address, port, timeoutMs, signal);
    samples.push(ms);
    if (onSample) onSample({ index: i, ms });
    if (i < count - 1) await sleep(gapMs, signal);
  }
  const ok = samples.filter((s) => s > 0);
  const loss = Math.round(((samples.length - ok.length) / samples.length) * 100);
  return { method: 'tcp', samples, loss, ...stats(ok) };
}

// Runs ICMP and TCP together; prefers ICMP when the host answers it, but keeps
// the TCP result as the fallback (many servers sit behind ICMP-dropping edges).
async function pingStats(profile, opts = {}) {
  throwIfAborted(opts.signal);
  const [icmp, tcp] = await Promise.all([
    icmpPingStats(profile.address, { signal: opts.signal }),
    tcpPingStats(profile.address, profile.port, opts),
  ]);
  throwIfAborted(opts.signal);
  const best = icmp && icmp.avg != null ? icmp : tcp;
  if (best.avg == null) {
    const err = new Error('سرور به هیچ‌کدام از تست‌های پینگ پاسخ نداد');
    err.code = 'UNREACHABLE';
    throw err;
  }
  return { ...best, icmp: icmp || undefined, tcp };
}

// ---- throwaway tunnel plumbing (modes 2 & 3) ----

// Test instances get their own port range + work dir so they can never
// collide with the live session (ports 10808+) or with each other.
let nextTestPortBase = 24000;

async function startTestTunnel(profile, { xrayBin, workRoot, signal }) {
  throwIfAborted(signal);
  const base = nextTestPortBase;
  nextTestPortBase = base + 4 > 29000 ? 24000 : base + 4;
  const socksPort = await findFreePort(base);
  const httpPort = await findFreePort(socksPort + 1);
  const workDir = path.join(workRoot, `test-${socksPort}-${Date.now()}`);
  const config = buildXrayConfig(profile, { socksPort, httpPort, mode: 'proxy', logLevel: 'warning' });

  const xp = new XrayProcess(xrayBin, workDir);
  const bootStart = Date.now();
  const cleanup = async () => {
    try { await xp.stop(); } catch { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  const onAbort = () => { cleanup(); };
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    await xp.start(config);
  } catch (err) {
    if (signal) signal.removeEventListener('abort', onAbort);
    await cleanup();
    throw err;
  }
  const bootMs = Date.now() - bootStart;
  return {
    httpPort,
    bootMs,
    close: async () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      await cleanup();
    },
  };
}

// One plain-HTTP probe through the local proxy inbound → RTT of a full
// request over the tunnel (DNS + protocol + routing on the far side).
function probeViaProxy(httpPort, timeoutMs, signal) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (ms) => { if (!settled) { settled = true; resolve(ms); } };
    const req = http.request({
      host: '127.0.0.1',
      port: httpPort,
      method: 'GET',
      path: PROBE_URL,
      headers: { Host: 'www.gstatic.com', Connection: 'close' },
      timeout: timeoutMs,
      signal,
    }, (res) => {
      res.resume();
      res.on('end', () => finish(Date.now() - start));
      res.on('error', () => finish(-1));
    });
    req.on('timeout', () => { req.destroy(); finish(-1); });
    req.on('error', () => finish(-1));
    req.end();
  });
}

// ---- Mode 2: real configuration ping ----

async function realPing(profile, { xrayBin, workRoot, signal, emit = () => {}, warmCount = 5 } = {}) {
  emit('phase', { phase: 'boot' });
  const tunnel = await startTestTunnel(profile, { xrayBin, workRoot, signal });
  try {
    throwIfAborted(signal);
    emit('phase', { phase: 'reach' });
    const tcpMs = await tcpPingOnce(profile.address, profile.port, 5000, signal);

    // Cold request: carries the tunnel's protocol + TLS handshake and routing setup.
    emit('phase', { phase: 'handshake' });
    throwIfAborted(signal);
    const firstMs = await probeViaProxy(tunnel.httpPort, 15000, signal);
    throwIfAborted(signal);
    if (firstMs < 0) {
      const err = new Error('تونل برقرار شد ولی هیچ ترافیکی از آن عبور نکرد');
      err.code = 'TUNNEL_DEAD';
      throw err;
    }

    emit('phase', { phase: 'probe' });
    const samples = [];
    for (let i = 0; i < warmCount; i++) {
      throwIfAborted(signal);
      const ms = await probeViaProxy(tunnel.httpPort, 8000, signal);
      throwIfAborted(signal);
      samples.push(ms);
      emit('sample', { index: i, ms });
      if (i < warmCount - 1) await sleep(160, signal);
    }
    const ok = samples.filter((s) => s > 0);
    if (!ok.length) {
      const err = new Error('درخواست‌های عبوری از تونل پاسخی نگرفتند');
      err.code = 'TUNNEL_DEAD';
      throw err;
    }
    const s = stats(ok);
    return {
      bootMs: tunnel.bootMs,
      tcpMs: tcpMs > 0 ? tcpMs : null,
      firstMs,
      handshakeMs: Math.max(0, firstMs - (s.avg ?? firstMs)),
      loss: Math.round(((samples.length - ok.length) / samples.length) * 100),
      samples,
      ...s,
    };
  } finally {
    await tunnel.close();
  }
}

// ---- Mode 3: speed benchmark ----

// CONNECT through the local HTTP proxy, then wrap the tunnel in TLS.
function openTlsViaProxy(httpPort, host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; socket.destroy(); reject(err); } };
    const socket = net.connect(httpPort, '127.0.0.1');
    const onAbort = () => fail(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal) signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => fail(new Error('CONNECT timeout')), timeoutMs);

    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let head = '';
    const onData = (buf) => {
      head += buf.toString('latin1');
      const idx = head.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        return fail(new Error('پروکسی محلی درخواست CONNECT را نپذیرفت'));
      }
      const tlsSocket = tls.connect({ socket, servername: host }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(tlsSocket);
      });
      tlsSocket.once('error', fail);
    };
    socket.on('data', onData);
  });
}

function speedStability(samples) {
  const vals = samples.map((s) => s.bps).filter((v) => v > 0);
  if (vals.length < 3) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (!mean) return null;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.round(Math.max(0, Math.min(100, 100 - cv * 100)));
}

async function measureDownload(httpPort, { durationMs, signal, emit }) {
  const sock = await openTlsViaProxy(httpPort, SPEED_HOST, 443, 15000, signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const samples = [];
    let total = 0;
    let headerDone = false;
    let headBuf = '';
    let windowBytes = 0;
    let start = null;
    let lastTick = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      if (signal) signal.removeEventListener('abort', onAbort);
      sock.destroy();
      const elapsed = start ? (Date.now() - start) / 1000 : 0;
      if (!total || elapsed < 0.4) return reject(new Error('دانلود تست ناموفق بود'));
      resolve({ bps: total / elapsed, bytes: total, seconds: elapsed, samples });
    };
    const fail = (err) => {
      if (settled) return;
      // A tear-down mid-stream still yields a valid measurement if we got data.
      if (total > 0 && start) return finish();
      settled = true;
      clearInterval(ticker);
      if (signal) signal.removeEventListener('abort', onAbort);
      sock.destroy();
      reject(err);
    };
    const onAbort = () => fail(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal) signal.addEventListener('abort', onAbort);

    const ticker = setInterval(() => {
      if (!start) return;
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      const bps = windowBytes / Math.max(dt, 0.001);
      samples.push({ t: now - start, bps });
      emit('speed', { dir: 'down', bps, bytes: total, elapsed: now - start });
      windowBytes = 0;
      lastTick = now;
      if (now - start >= durationMs) finish();
    }, 250);

    sock.on('data', (buf) => {
      if (!headerDone) {
        headBuf += buf.toString('latin1');
        const idx = headBuf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        headerDone = true;
        start = lastTick = Date.now();
        const bodyLen = headBuf.length - idx - 4;
        total += bodyLen;
        windowBytes += bodyLen;
        return;
      }
      total += buf.length;
      windowBytes += buf.length;
    });
    sock.on('end', finish);
    sock.on('error', fail);
    sock.write(`GET ${DOWN_PATH} HTTP/1.1\r\nHost: ${SPEED_HOST}\r\nConnection: close\r\n\r\n`);
  });
}

async function measureUpload(httpPort, { bytes, signal, emit }) {
  const sock = await openTlsViaProxy(httpPort, SPEED_HOST, 443, 15000, signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const samples = [];
    const chunk = Buffer.alloc(64 * 1024);
    let written = 0;
    let windowBytes = 0;
    const start = Date.now();
    let lastTick = start;
    let writeDoneAt = null;

    const cleanup = () => {
      clearInterval(ticker);
      if (signal) signal.removeEventListener('abort', onAbort);
      sock.destroy();
    };
    const fail = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const onAbort = () => fail(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal) signal.addEventListener('abort', onAbort);

    const ticker = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      const bps = windowBytes / Math.max(dt, 0.001);
      samples.push({ t: now - start, bps });
      emit('speed', { dir: 'up', bps, bytes: written, elapsed: now - start });
      windowBytes = 0;
      lastTick = now;
      if (now - start > 30000) fail(new Error('آپلود تست بیش از حد طول کشید'));
    }, 250);

    sock.on('data', () => {
      // Any response means the server has consumed the body.
      if (!settled && writeDoneAt) {
        settled = true;
        cleanup();
        const seconds = (writeDoneAt - start) / 1000;
        resolve({ bps: bytes / Math.max(seconds, 0.001), bytes, seconds, samples });
      }
    });
    sock.on('error', fail);

    sock.write(`POST ${UP_PATH} HTTP/1.1\r\nHost: ${SPEED_HOST}\r\nContent-Length: ${bytes}\r\nConnection: close\r\n\r\n`);
    const pump = () => {
      if (settled) return;
      while (written < bytes) {
        const size = Math.min(chunk.length, bytes - written);
        written += size;
        windowBytes += size;
        const ok = sock.write(size === chunk.length ? chunk : chunk.subarray(0, size));
        if (written >= bytes) { writeDoneAt = Date.now(); return; }
        if (!ok) { sock.once('drain', pump); return; }
      }
    };
    pump();
  });
}

async function speedTest(profile, { xrayBin, workRoot, signal, emit = () => {}, downloadMs = 8000 } = {}) {
  emit('phase', { phase: 'boot' });
  const tunnel = await startTestTunnel(profile, { xrayBin, workRoot, signal });
  try {
    // Warm the tunnel and grab its RTT while we're at it.
    emit('phase', { phase: 'warmup' });
    const warm = [];
    for (let i = 0; i < 3; i++) {
      throwIfAborted(signal);
      const ms = await probeViaProxy(tunnel.httpPort, 12000, signal);
      if (ms > 0) warm.push(ms);
    }
    if (!warm.length) {
      const err = new Error('تونل برقرار شد ولی ترافیک از آن عبور نکرد');
      err.code = 'TUNNEL_DEAD';
      throw err;
    }
    const rtt = stats(warm);

    emit('phase', { phase: 'download' });
    const down = await measureDownload(tunnel.httpPort, { durationMs: downloadMs, signal, emit });

    emit('phase', { phase: 'upload' });
    // Size the upload from the observed download speed: ~3s worth, 1–24 MB.
    const upBytes = Math.max(1e6, Math.min(24e6, Math.round((down.bps / 8) * 3 / 65536) * 65536));
    let up = null;
    try {
      up = await measureUpload(tunnel.httpPort, { bytes: upBytes, signal, emit });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Upload endpoints are flakier; a failed upload shouldn't void the benchmark.
    }

    return {
      bootMs: tunnel.bootMs,
      downBps: Math.round(down.bps),
      downBytes: down.bytes,
      downSamples: down.samples,
      upBps: up ? Math.round(up.bps) : null,
      upBytes: up ? up.bytes : null,
      upSamples: up ? up.samples : [],
      stability: speedStability(down.samples),
      rttAvg: rtt.avg,
      rttJitter: rtt.jitter,
    };
  } finally {
    await tunnel.close();
  }
}

module.exports = { begin, end, cancel, pingStats, realPing, speedTest };
