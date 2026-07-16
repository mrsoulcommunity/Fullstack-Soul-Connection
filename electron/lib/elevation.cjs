'use strict';
const { execFile } = require('child_process');

// "net session" only succeeds when the current process holds admin rights --
// a standard, dependency-free way to check elevation on Windows.
function isElevated() {
  return new Promise((resolve) => {
    execFile('net', ['session'], { windowsHide: true }, (err) => resolve(!err));
  });
}

// Launches a new elevated instance of this same app via UAC (PowerShell's
// Start-Process -Verb RunAs is the standard trick; there's no direct Win32
// "runas" binding available from plain Node/Electron). Resolves true and
// exits the current, unelevated process only once Windows confirms the
// elevated instance actually launched. If the user cancels the UAC prompt
// (or it fails for any other reason), Start-Process throws immediately and
// we resolve false instead -- callers must fall back to something visible
// rather than assuming the relaunch always succeeds.
function relaunchElevated(app) {
  const exePath = process.execPath;
  const appPath = app.isPackaged ? null : app.getAppPath();

  const quoted = (s) => `'${s.replace(/'/g, "''")}'`;
  // Start-Process joins -ArgumentList array elements into a single lpParameters
  // string for ShellExecute without quoting them, so a path containing spaces
  // (like this project's own directory) gets split into multiple argv entries
  // by the child process unless we embed literal double quotes ourselves.
  const command = appPath
    ? `Start-Process -FilePath ${quoted(exePath)} -ArgumentList ${quoted(`"${appPath}"`)} -Verb RunAs`
    : `Start-Process -FilePath ${quoted(exePath)} -Verb RunAs`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command],
      { windowsHide: true },
      (err) => {
        if (err) {
          resolve(false);
          return;
        }
        app.exit(0);
        resolve(true);
      }
    );
  });
}

module.exports = { isElevated, relaunchElevated };
