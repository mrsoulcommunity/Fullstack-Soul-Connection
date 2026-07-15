'use strict';
const { execFile } = require('child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function broadcastSettingsChange() {
  // Notify Windows/apps (e.g. browsers) that Internet Settings changed.
  return new Promise((resolve) => {
    execFile('rundll32.exe', ['wininet.dll,InternetSetOption', '0', '39', '0', '0'], () => resolve());
  });
}

async function enable(host, port, bypass = 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;<local>') {
  await run(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await run(['add', REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `${host}:${port}`, '/f']);
  await run(['add', REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', bypass, '/f']);
  await broadcastSettingsChange();
}

async function disable() {
  await run(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
  await broadcastSettingsChange();
}

module.exports = { enable, disable };
