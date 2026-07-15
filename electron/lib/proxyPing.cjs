'use strict';
const http = require('http');

// Measures real round-trip latency through the local HTTP proxy inbound,
// i.e. the latency actually experienced by traffic going through the tunnel.
function proxyPing(httpProxyPort, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (ms) => {
      if (settled) return;
      settled = true;
      resolve(ms);
    };

    const req = http.request({
      host: '127.0.0.1',
      port: httpProxyPort,
      method: 'GET',
      path: 'http://www.gstatic.com/generate_204',
      headers: { Host: 'www.gstatic.com', Connection: 'close' },
      timeout: timeoutMs,
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

module.exports = { proxyPing };
