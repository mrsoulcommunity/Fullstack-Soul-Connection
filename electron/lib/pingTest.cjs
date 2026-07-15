'use strict';
const net = require('net');

function tcpPing(address, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;

    const finish = (ms) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ms);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(Date.now() - start));
    socket.once('error', () => finish(-1));
    socket.once('timeout', () => finish(-1));

    socket.connect(port, address);
  });
}

module.exports = { tcpPing };
