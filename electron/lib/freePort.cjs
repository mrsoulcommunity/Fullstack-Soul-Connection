'use strict';
const net = require('net');

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

async function findFreePort(preferredPort) {
  if (await isPortFree(preferredPort)) return preferredPort;
  for (let port = preferredPort + 1; port < preferredPort + 200; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('هیچ پورت آزادی برای اجرای پروکسی پیدا نشد');
}

module.exports = { findFreePort };
