'use strict';
// The per-application dispatcher.
//
// xray's routing engine has no concept of "which program sent this", so when a
// rule names an executable the decision has to be made one step earlier -- at
// the moment the connection arrives, while its source port can still be traced
// back to a PID. That is all this module does:
//
//   1. take over the public SOCKS/HTTP ports (the ones Windows' system proxy
//      points at) instead of xray;
//   2. learn just enough about each connection to decide -- the source port
//      (-> process) and the destination host;
//   3. hand the bytes to one of two private xray inbounds, one wired to the
//      proxy outbound and one wired to freedom.
//
// Step 3 is the important design choice: the dispatcher never speaks the
// tunnel protocol, never resolves DNS, never touches UDP payloads. Everything
// hard stays inside xray, where it is already correct and fast. Node only
// splices two TCP sockets, which it is good at.
//
// The one protocol it does terminate is the SOCKS5 handshake, and only because
// the destination address arrives *after* the client has been answered -- so
// there is no way to peek at it without replying first.
const net = require('net');
const { EventEmitter } = require('events');

const HANDSHAKE_TIMEOUT_MS = 20000;
const MAX_REQUEST_LINE = 8192;

const SOCKS_VER = 0x05;
const METHOD_NOAUTH = 0x00;
const METHOD_USERPASS = 0x02;
const METHOD_NONE = 0xff;

// Buffered reader over a raw socket: lets the handshake code await exact byte
// counts (SOCKS) or a delimiter (HTTP) and then hand back whatever the client
// had already sent beyond that, so nothing is lost when the socket flips from
// "being parsed" to "being piped".
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.pending = null;
    this.done = false;
    this._onData = (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this._settle();
    };
    this._onEnd = () => {
      this.done = true;
      this._settle();
    };
    socket.on('data', this._onData);
    socket.on('end', this._onEnd);
    socket.on('error', this._onEnd);
    socket.on('close', this._onEnd);
  }

  _settle() {
    const p = this.pending;
    if (!p) return;
    if (p.kind === 'bytes') {
      if (this.buf.length >= p.n) {
        const out = this.buf.subarray(0, p.n);
        this.buf = this.buf.subarray(p.n);
        this.pending = null;
        p.resolve(out);
      } else if (this.done) {
        this.pending = null;
        p.reject(new Error('connection closed during handshake'));
      }
      return;
    }
    const idx = this.buf.indexOf(p.delim);
    if (idx !== -1) {
      const out = this.buf.subarray(0, idx);
      this.buf = this.buf.subarray(idx + p.delim.length);
      this.pending = null;
      p.resolve(out);
    } else if (this.buf.length > p.max || this.done) {
      this.pending = null;
      p.reject(new Error('malformed request'));
    }
  }

  _wait(req) {
    return new Promise((resolve, reject) => {
      this.pending = { ...req, resolve, reject };
      this._settle();
    });
  }

  bytes(n) { return this._wait({ kind: 'bytes', n }); }
  until(delim, max) { return this._wait({ kind: 'delim', delim: Buffer.from(delim), max }); }

  // Stop intercepting and return everything still buffered, so the caller can
  // replay it to the upstream socket before piping. The socket is paused on
  // the way out: attaching a 'data' listener put it in flowing mode, and a
  // flowing socket with no listener silently drops whatever arrives in the
  // gap before pipe() takes over. pipe() resumes it again.
  release() {
    try { this.socket.pause(); } catch { /* already gone */ }
    this.socket.off('data', this._onData);
    this.socket.off('end', this._onEnd);
    this.socket.off('error', this._onEnd);
    this.socket.off('close', this._onEnd);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    this.pending = null;
    return rest;
  }
}

function splice(a, b) {
  a.pipe(b);
  b.pipe(a);
  const kill = () => { a.destroy(); b.destroy(); };
  a.on('error', kill);
  b.on('error', kill);
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

function parseHttpTarget(line) {
  const parts = line.split(/\s+/);
  if (parts.length < 2) return null;
  const method = parts[0].toUpperCase();
  const target = parts[1];

  if (method === 'CONNECT') {
    const i = target.lastIndexOf(':');
    if (i === -1) return { host: target, port: 443 };
    return { host: target.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(target.slice(i + 1)) || 443 };
  }
  // Absolute-form request line, which is what a proxy receives for plain HTTP.
  const m = target.match(/^https?:\/\/([^/?#]+)/i);
  if (!m) return null;
  let authority = m[1];
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    const host = authority.slice(1, end);
    const port = Number(authority.slice(end + 2)) || 80;
    return { host, port };
  }
  const i = authority.lastIndexOf(':');
  if (i === -1) return { host: authority, port: /^https/i.test(target) ? 443 : 80 };
  return { host: authority.slice(0, i), port: Number(authority.slice(i + 1)) || 80 };
}

class Dispatcher extends EventEmitter {
  // resolveRoute({ exe, host, port }) -> 'proxy' | 'direct' (may be async)
  // lookupExe(sourcePort)             -> Promise<string|null>
  // targets: { proxy: { socksPort, httpPort }, direct: { socksPort, httpPort } }
  constructor({ resolveRoute, lookupExe, targets, auth = {} }) {
    super();
    this.resolveRoute = resolveRoute;
    this.lookupExe = lookupExe;
    this.targets = targets;
    this.auth = auth;
    this.servers = [];
    this.sockets = new Set();
    this.stats = { total: 0, proxy: 0, direct: 0, identified: 0, failed: 0 };
  }

  async start({ socksHost, socksPort, httpHost, httpPort }) {
    const socks = net.createServer((s) => this._handle(s, 'socks'));
    const http = net.createServer((s) => this._handle(s, 'http'));
    this.servers = [socks, http];
    try {
      await Promise.all([
        listen(socks, socksPort, socksHost),
        listen(http, httpPort, httpHost),
      ]);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop() {
    for (const s of this.sockets) { try { s.destroy(); } catch { /* ignore */ } }
    this.sockets.clear();
    await Promise.all(this.servers.map((srv) => new Promise((resolve) => {
      try { srv.close(() => resolve()); } catch { resolve(); }
    })));
    this.servers = [];
  }

  _track(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  async _handle(client, kind) {
    this._track(client);
    client.setNoDelay(true);
    client.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
      if (!client.destroyed && !client._spliced) client.destroy();
    });
    client.on('error', () => { /* a client that vanishes mid-handshake is routine */ });

    const reader = new Reader(client);
    try {
      if (kind === 'socks') await this._handleSocks(client, reader);
      else await this._handleHttp(client, reader);
    } catch {
      this.stats.failed++;
      try { reader.release(); } catch { /* ignore */ }
      if (!client.destroyed) client.destroy();
    }
  }

  // The process behind the connection. Only loopback clients can be traced --
  // for anything arriving over the LAN there is no local PID to find, and the
  // rules simply fall through to their destination-only behaviour.
  async _exeOf(client) {
    const addr = client.remoteAddress || '';
    const loopback = addr.includes('127.0.0.1') || addr === '::1';
    if (!loopback) return null;
    try {
      const exe = await this.lookupExe(client.remotePort);
      if (exe) this.stats.identified++;
      return exe;
    } catch {
      return null;
    }
  }

  async _decide(client, host, port) {
    const exe = await this._exeOf(client);
    let route = 'proxy';
    try {
      route = (await this.resolveRoute({ exe, host, port })) === 'direct' ? 'direct' : 'proxy';
    } catch {
      route = 'proxy';
    }
    this.stats.total++;
    this.stats[route]++;
    return route;
  }

  _connectUpstream(route, protocol) {
    const t = this.targets[route] || this.targets.proxy;
    const port = protocol === 'socks' ? t.socksPort : t.httpPort;
    return new Promise((resolve, reject) => {
      const up = net.connect(port, '127.0.0.1');
      up.setNoDelay(true);
      up.once('connect', () => { up.off('error', reject); resolve(up); });
      up.once('error', reject);
    });
  }

  // ---- HTTP ----
  //
  // Nothing is terminated here: the request line is read only to learn the
  // destination, then the very same bytes are replayed to xray's http inbound,
  // which does the actual proxying (CONNECT, keep-alive, 407 auth and all).
  async _handleHttp(client, reader) {
    const line = (await reader.until('\r\n', MAX_REQUEST_LINE)).toString('latin1');
    const target = parseHttpTarget(line) || { host: '', port: 0 };
    const route = await this._decide(client, target.host, target.port);
    const up = await this._connectUpstream(route, 'http');
    const rest = reader.release();
    up.write(Buffer.concat([Buffer.from(`${line}\r\n`, 'latin1'), rest]));
    this._go(client, up, { route, host: target.host, port: target.port });
  }

  // ---- SOCKS5 ----
  //
  // Terminated only as far as the CONNECT/UDP request, because the destination
  // arrives after the client has already been answered twice. From there the
  // original request bytes are replayed verbatim into xray's socks inbound and
  // its reply is piped straight back, so xray -- not this code -- decides what
  // the client is told, including for UDP ASSOCIATE.
  async _handleSocks(client, reader) {
    const head = await reader.bytes(2);
    if (head[0] !== SOCKS_VER) throw new Error('not socks5');
    const methods = await reader.bytes(head[1]);

    const wantAuth = !!this.auth.username;
    if (wantAuth) {
      if (!methods.includes(METHOD_USERPASS)) {
        client.end(Buffer.from([SOCKS_VER, METHOD_NONE]));
        return;
      }
      client.write(Buffer.from([SOCKS_VER, METHOD_USERPASS]));
      const ver = await reader.bytes(1);
      if (ver[0] !== 0x01) throw new Error('bad auth version');
      const ulen = (await reader.bytes(1))[0];
      const user = (await reader.bytes(ulen)).toString('utf8');
      const plen = (await reader.bytes(1))[0];
      const pass = (await reader.bytes(plen)).toString('utf8');
      if (user !== this.auth.username || pass !== (this.auth.password || '')) {
        client.end(Buffer.from([0x01, 0x01]));
        return;
      }
      client.write(Buffer.from([0x01, 0x00]));
    } else {
      if (!methods.includes(METHOD_NOAUTH)) {
        client.end(Buffer.from([SOCKS_VER, METHOD_NONE]));
        return;
      }
      client.write(Buffer.from([SOCKS_VER, METHOD_NOAUTH]));
    }

    const reqHead = await reader.bytes(4); // VER CMD RSV ATYP
    if (reqHead[0] !== SOCKS_VER) throw new Error('bad request version');
    const atyp = reqHead[3];
    let addrBuf;
    let host;
    if (atyp === 0x01) {
      addrBuf = await reader.bytes(4);
      host = Array.from(addrBuf).join('.');
    } else if (atyp === 0x03) {
      const len = await reader.bytes(1);
      const name = await reader.bytes(len[0]);
      addrBuf = Buffer.concat([len, name]);
      host = name.toString('utf8');
    } else if (atyp === 0x04) {
      addrBuf = await reader.bytes(16);
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(addrBuf.readUInt16BE(i).toString(16));
      host = parts.join(':');
    } else {
      client.end(Buffer.from([SOCKS_VER, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const portBuf = await reader.bytes(2);
    const port = portBuf.readUInt16BE(0);

    const route = await this._decide(client, host, port);
    let up;
    try {
      up = await this._connectUpstream(route, 'socks');
    } catch {
      client.end(Buffer.from([SOCKS_VER, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      return;
    }

    // Our own handshake with the private inbound, which never requires auth.
    const upReader = new Reader(up);
    up.write(Buffer.from([SOCKS_VER, 0x01, METHOD_NOAUTH]));
    const upMethod = await upReader.bytes(2);
    if (upMethod[0] !== SOCKS_VER || upMethod[1] !== METHOD_NOAUTH) {
      up.destroy();
      client.end(Buffer.from([SOCKS_VER, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const upRest = upReader.release();
    up.write(Buffer.concat([reqHead, addrBuf, portBuf]));
    if (upRest.length) client.write(upRest);

    const rest = reader.release();
    if (rest.length) up.write(rest);
    this._go(client, up, { route, host, port });
  }

  _go(client, up, info) {
    client._spliced = true;
    client.setTimeout(0);
    this._track(up);
    splice(client, up);
    this.emit('routed', info);
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host || '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

module.exports = { Dispatcher };
