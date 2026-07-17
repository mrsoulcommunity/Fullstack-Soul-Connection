'use strict';
const http = require('http');
const https = require('https');

function fetchText(url, timeoutMs = 15000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error('Invalid subscription URL'));
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reject(new Error('Only http/https URLs are supported'));
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { timeout: timeoutMs, headers: { 'User-Agent': 'SoulConnection/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, target).toString();
        fetchText(next, timeoutMs, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Subscription request failed: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('Subscription request timed out')));
    req.on('error', reject);
  });
}

module.exports = { fetchText };
