'use strict';
// "Show me what's running, like Task Manager does."
//
// Task Manager's own split is the one users already understand: Apps (a process
// that owns a visible window) above, Background processes below. Reproducing it
// needs two things Windows' command-line tools disagree about:
//
//   * does this process have a window?  `tasklist /V` claims dwm.exe and
//     svchost.exe do, and on this machine it took 25 seconds to answer. Useless
//     on both counts. PowerShell's MainWindowHandle is correct and takes ~1.7s.
//   * what is it called?  chrome.exe means nothing to most people; the file's
//     own description ("Google Chrome") is the label Task Manager shows.
//
// So PowerShell is the primary source, `tasklist` the fallback for the case
// where PowerShell is missing, disabled by policy, or blocked -- a bare list
// with no window flags is still far better than an empty dialog.
//
// Everything is cached and awaited off the main thread; the renderer asks for
// this only when the picker is opened, and again only if the user hits refresh.
const { execFile } = require('child_process');
const path = require('path');

const CACHE_TTL_MS = 8000;
const EXEC_TIMEOUT_MS = 15000;

// Windows' own machinery. None of it is something a user would sensibly write a
// routing rule for, and leaving it in buries the twenty processes that matter
// under two hundred that don't.
const SYSTEM_PROCESSES = new Set([
  'system', 'system idle process', 'registry', 'memory compression', 'secure system',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe',
  'svchost.exe', 'fontdrvhost.exe', 'dwm.exe', 'spoolsv.exe', 'audiodg.exe',
  'conhost.exe', 'dllhost.exe', 'wmiprvse.exe', 'taskhostw.exe', 'sihost.exe',
  'ctfmon.exe', 'runtimebroker.exe', 'searchhost.exe', 'searchindexer.exe',
  'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'textinputhost.exe',
  'applicationframehost.exe', 'lockapp.exe', 'useroobebroker.exe', 'wudfhost.exe',
  'securityhealthservice.exe', 'securityhealthsystray.exe', 'msmpeng.exe', 'nissrv.exe',
  'shellhost.exe', 'widgets.exe', 'widgetservice.exe', 'phoneexperiencehost.exe',
  'crashpad_handler.exe', 'backgroundtaskhost.exe', 'smartscreen.exe', 'taskmgr.exe',
  'wmiapsrv.exe', 'trustedinstaller.exe', 'tiworker.exe', 'msiexec.exe',
]);

// Our own processes: a rule about them would only route the app's own probes.
const SELF_PROCESSES = new Set(['soul connection.exe', 'electron.exe', 'xray.exe']);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      windowsHide: true,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout) => {
      const out = String(stdout || '');
      if (err && !out) reject(err);
      else resolve(out);
    });
  });
}

// SessionId 0 is the services session -- never a user-facing app.
const PS_SCRIPT = `$ErrorActionPreference='SilentlyContinue'
Get-Process | Where-Object { $_.SessionId -ne 0 } | ForEach-Object {
  [PSCustomObject]@{
    n = $_.ProcessName
    w = [int]($_.MainWindowHandle -ne 0)
    t = $_.MainWindowTitle
    d = $_.Description
    p = $_.Path
    m = [int]($_.WorkingSet64 / 1MB)
  }
} | ConvertTo-Json -Compress`;

function exeNameOf(row) {
  if (row.p) return path.basename(String(row.p)).toLowerCase();
  const n = String(row.n || '').toLowerCase();
  if (!n) return '';
  return n.endsWith('.exe') ? n : `${n}.exe`;
}

// Collapses the raw process rows into one entry per executable: a browser with
// fifteen renderer processes is one thing the user wants to route, not fifteen.
function group(rows) {
  const map = new Map();
  for (const row of rows) {
    const exe = exeNameOf(row);
    if (!exe || SYSTEM_PROCESSES.has(exe) || SELF_PROCESSES.has(exe)) continue;
    let entry = map.get(exe);
    if (!entry) {
      entry = { exe, name: '', windowed: false, instances: 0, memoryMb: 0, title: '' };
      map.set(exe, entry);
    }
    entry.instances++;
    entry.memoryMb += Number(row.m) || 0;
    if (row.w) entry.windowed = true;
    // Prefer the file description ("Google Chrome"), fall back to a window
    // title, and only then to the bare process name.
    const desc = String(row.d || '').trim();
    if (desc && !entry.name) entry.name = desc;
    const title = String(row.t || '').trim();
    if (title && !entry.title) entry.title = title;
  }
  const out = [];
  for (const e of map.values()) {
    out.push({
      ...e,
      name: e.name || e.title || e.exe.replace(/\.exe$/, ''),
    });
  }
  // Apps first, then by memory: the heavy, visible things a user is most likely
  // to be thinking about end up at the top of the list.
  return out.sort((a, b) => (b.windowed - a.windowed) || (b.memoryMb - a.memoryMb));
}

async function fromPowerShell() {
  const out = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT,
  ]);
  const trimmed = out.trim();
  if (!trimmed) throw new Error('empty process list');
  const parsed = JSON.parse(trimmed);
  // ConvertTo-Json emits a bare object when there is exactly one result.
  return group(Array.isArray(parsed) ? parsed : [parsed]);
}

// No window information here, so everything lands in the process list. Still
// enough to type-free-pick an executable, which is the point.
async function fromTasklist() {
  const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().replace(/^"|"$/g, '').split('","');
    if (cols.length < 5) continue;
    rows.push({ n: cols[0], w: 0, d: '', p: '', m: Math.round(Number(String(cols[4]).replace(/[^\d]/g, '')) / 1024) });
  }
  if (!rows.length) throw new Error('empty process list');
  return group(rows);
}

class AppList {
  constructor() {
    this.cache = null;
    this.cachedAt = 0;
    this.inFlight = null;
    this.source = null;
  }

  async list({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return { apps: this.cache, source: this.source, cached: true };
    }
    // Two opens of the picker in quick succession share one enumeration rather
    // than racing two PowerShell processes.
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      let apps;
      let source = 'powershell';
      try {
        apps = await fromPowerShell();
      } catch {
        source = 'tasklist';
        apps = await fromTasklist();
      }
      this.cache = apps;
      this.cachedAt = Date.now();
      this.source = source;
      return { apps, source, cached: false };
    })().finally(() => { this.inFlight = null; });

    return this.inFlight;
  }
}

module.exports = { AppList, SYSTEM_PROCESSES };
