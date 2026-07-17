'use strict';
// Probes the app's OWN local SOCKS5/HTTP listener (not a remote server) to
// confirm the "Manual Proxy" configuration in Settings actually works --
// a real socket handshake against 127.0.0.1:<port>, with credentials if any.
const net = require('net');

const TIMEOUT_MS = 2500;

function socksProbe(host, port, username, password) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout', message: 'پاسخی دریافت نشد' }));
    socket.once('error', (err) => finish({ ok: false, reason: 'refused', message: err.message }));

    socket.once('connect', () => {
      // Greeting: offer no-auth (0x00) and/or username/password (0x02).
      const methods = username ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });

    let stage = 'greeting';
    socket.on('data', (buf) => {
      if (stage === 'greeting') {
        if (buf.length < 2 || buf[0] !== 0x05) {
          return finish({ ok: false, reason: 'protocol-mismatch', message: 'پاسخ SOCKS5 معتبر نبود' });
        }
        if (buf[1] === 0xff) {
          return finish({ ok: false, reason: 'no-acceptable-auth', message: 'سرور روش احراز هویت را نپذیرفت' });
        }
        if (buf[1] === 0x02 && username) {
          stage = 'auth';
          const userBuf = Buffer.from(username, 'utf8');
          const passBuf = Buffer.from(password || '', 'utf8');
          socket.write(Buffer.concat([
            Buffer.from([0x01, userBuf.length]), userBuf,
            Buffer.from([passBuf.length]), passBuf,
          ]));
          return;
        }
        return finish({ ok: true, ms: Date.now() - start });
      }
      if (stage === 'auth') {
        if (buf.length >= 2 && buf[1] === 0x00) {
          return finish({ ok: true, ms: Date.now() - start });
        }
        return finish({ ok: false, reason: 'auth-failed', message: 'نام کاربری یا رمز عبور اشتباه است' });
      }
    });

    socket.connect(port, host);
  });
}

function httpProbe(host, port, username, password) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout', message: 'پاسخی دریافت نشد' }));
    socket.once('error', (err) => finish({ ok: false, reason: 'refused', message: err.message }));

    socket.once('connect', () => {
      const headers = ['CONNECT example.com:443 HTTP/1.1', 'Host: example.com:443'];
      if (username) {
        const token = Buffer.from(`${username}:${password || ''}`, 'utf8').toString('base64');
        headers.push(`Proxy-Authorization: Basic ${token}`);
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });

    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n');
      if (idx === -1) return;
      const statusLine = buf.slice(0, idx);
      const match = statusLine.match(/^HTTP\/1\.[01] (\d{3})/);
      if (!match) return finish({ ok: false, reason: 'protocol-mismatch', message: 'پاسخ HTTP معتبر نبود' });
      const code = Number(match[1]);
      if (code >= 200 && code < 300) return finish({ ok: true, ms: Date.now() - start });
      if (code === 407) {
        return finish(username
          ? { ok: false, reason: 'auth-failed', message: 'نام کاربری یا رمز عبور اشتباه است' }
          : { ok: true, ms: Date.now() - start }); // listener alive, just needs credentials
      }
      return finish({ ok: false, reason: 'unexpected-status', message: `کد وضعیت غیرمنتظره: ${code}` });
    });

    socket.connect(port, host);
  });
}

async function testLocalProxy({ protocol, host, port, username, password }) {
  if (protocol === 'socks') return socksProbe(host, port, username, password);
  if (protocol === 'http') return httpProbe(host, port, username, password);
  return { ok: false, reason: 'invalid-protocol', message: 'پروتکل نامعتبر' };
}

module.exports = { testLocalProxy };
