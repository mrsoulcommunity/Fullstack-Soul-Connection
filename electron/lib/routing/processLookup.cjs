'use strict';
// "Which program opened this connection?"
//
// Windows only, and deliberately built out of two plain command-line tools
// (netstat + tasklist) rather than a native addon: the app ships as a portable
// exe with no build step on the user's machine, so a prebuilt .node binding
// would have to be shipped per-arch and would be the single most likely thing
// an antivirus quarantines. The cost is a process spawn on a cache miss, which
// this module then works hard to make rare.
//
// The whole thing is async and cached; nothing here ever blocks the event loop,
// so a slow netstat delays one pending connection's routing decision -- never
// the UI, and never the connections already flowing.
const { execFile } = require('child_process');

// A connection table older than this is refetched. Short enough that a brand
// new process is found on its first connection, long enough that a browser
// opening thirty sockets at once costs exactly one netstat.
const TABLE_TTL_MS = 800;
// Hard floor between spawns, even on repeated misses: a burst of connections
// from an unknown process must not turn into a burst of netstat processes.
const REFRESH_MIN_GAP_MS = 350;
// Process names are stable for the life of a PID; the only risk is PID reuse,
// which this TTL bounds.
const NAME_TTL_MS = 60000;
const EXEC_TIMEOUT_MS = 4000;
const MAX_NAME_CACHE = 512;

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, {
        windowsHide: true,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LANG: 'C' },
      }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
    } catch {
      resolve('');
    }
  });
}

// Rows look like:
//   TCP    127.0.0.1:52345    127.0.0.1:10808    ESTABLISHED    1234
// The header and the state word are localized on non-English Windows, but the
// literal "TCP" and the column layout are not -- so the row shape is what we
// key on, never a translated word.
const ROW_RE = /^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/i;

function portOf(addr) {
  const i = addr.lastIndexOf(':');
  if (i === -1) return 0;
  return Number(addr.slice(i + 1)) || 0;
}

class ProcessLookup {
  constructor() {
    this.portToPid = new Map();
    this.tableAt = 0;
    this.refreshing = null;
    this.lastSpawnAt = 0;
    this.names = new Map(); // pid -> { name, at }
    this.enabled = process.platform === 'win32';
  }

  async _refreshTable() {
    if (this.refreshing) return this.refreshing;
    const wait = Math.max(0, REFRESH_MIN_GAP_MS - (Date.now() - this.lastSpawnAt));
    this.refreshing = (async () => {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      this.lastSpawnAt = Date.now();
      const out = await run('netstat', ['-ano', '-p', 'TCP']);
      const map = new Map();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(ROW_RE);
        if (!m) continue;
        const port = portOf(m[1]);
        if (port) map.set(port, Number(m[4]));
      }
      // An empty parse means netstat failed or was blocked; keeping the previous
      // table is strictly better than forgetting every process we knew about.
      if (map.size) {
        this.portToPid = map;
        this.tableAt = Date.now();
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _nameOf(pid) {
    const hit = this.names.get(pid);
    if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;

    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
    const m = out.match(/^"([^"]+)"/m);
    const name = m ? m[1].toLowerCase() : null;
    if (this.names.size >= MAX_NAME_CACHE) this.names.clear();
    this.names.set(pid, { name, at: Date.now() });
    return name;
  }

  // The public entry point: given the source port of a connection arriving at
  // our own listener, return the lowercase executable name (chrome.exe) or
  // null when it can't be determined -- a LAN client, a process that exited in
  // the same millisecond, or a netstat that didn't cooperate. Callers treat
  // null as "no app rule can match", never as an error.
  async exeForPort(port) {
    if (!this.enabled || !port) return null;

    let pid = this.portToPid.get(port);
    if (pid === undefined || Date.now() - this.tableAt > TABLE_TTL_MS) {
      await this._refreshTable();
      pid = this.portToPid.get(port);
    }
    if (pid === undefined) return null;
    try {
      return await this._nameOf(pid);
    } catch {
      return null;
    }
  }

  clear() {
    this.portToPid.clear();
    this.names.clear();
    this.tableAt = 0;
  }
}

module.exports = { ProcessLookup };
