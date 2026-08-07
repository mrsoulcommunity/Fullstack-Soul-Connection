'use strict';
const http = require('http');

// Measures real round-trip latency through the local HTTP proxy inbound,
// i.e. the latency actually experienced by traffic going through the tunnel.
// `host`/credentials come from the user's Network settings -- probing the
// wrong address, or omitting configured proxy auth, measures nothing useful
// (an unauthenticated request is answered locally with a 407 in microseconds).
function proxyPing({ host = '127.0.0.1', port, username, password } = {}, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (ms) => {
      if (settled) return;
      settled = true;
      resolve(ms);
    };

    const headers = { Host: 'www.gstatic.com', Connection: 'close' };
    if (username) {
      const token = Buffer.from(`${username}:${password || ''}`, 'utf8').toString('base64');
      headers['Proxy-Authorization'] = `Basic ${token}`;
    }

    const req = http.request({
      host,
      port,
      method: 'GET',
      path: 'http://www.gstatic.com/generate_204',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      // Anything the proxy rejects locally (407 auth, 403 routing block) never
      // crossed the tunnel, so its timing is meaningless -- report "no answer"
      // rather than a flattering sub-millisecond number.
      const rejectedLocally = res.statusCode === 407 || res.statusCode === 403;
      res.on('end', () => finish(rejectedLocally ? -1 : Date.now() - start));
      res.on('error', () => finish(-1));
    });

    req.on('timeout', () => { req.destroy(); finish(-1); });
    req.on('error', () => finish(-1));
    req.end();
  });
}

module.exports = { proxyPing };
