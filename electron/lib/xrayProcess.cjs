'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class XrayProcess extends EventEmitter {
  constructor(xrayBinPath, workDir) {
    super();
    this.xrayBinPath = xrayBinPath;
    this.workDir = workDir;
    this.proc = null;
    this.configPath = path.join(workDir, 'active-config.json');
    this.logLines = [];
  }

  get isRunning() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  start(config) {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        return reject(new Error('Xray is already running'));
      }
      fs.mkdirSync(this.workDir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');

      this.logLines = [];
      const proc = spawn(this.xrayBinPath, ['run', '-c', this.configPath], {
        cwd: path.dirname(this.xrayBinPath),
        windowsHide: true,
      });
      this.proc = proc;

      // Guards against a stale/superseded process (one we've already moved on
      // from via a later start() call) still emitting events for this session.
      const isCurrent = () => this.proc === proc;

      let settled = false;
      const onData = (buf) => {
        if (!isCurrent()) return;
        const text = buf.toString('utf8');
        this.logLines.push(text);
        if (this.logLines.length > 500) this.logLines.shift();
        this.emit('log', text);
        if (!settled && /started/i.test(text)) {
          settled = true;
          resolve();
        }
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        if (!isCurrent()) return;
        if (!settled) { settled = true; reject(err); }
        this.emit('exit', -1);
      });

      proc.on('exit', (code) => {
        if (!isCurrent()) return;
        this.emit('exit', code);
        if (!settled) {
          settled = true;
          if (code === 0 || code === null) resolve();
          else reject(new Error(`Xray exited with code ${code}:\n${this.logLines.join('')}`));
        }
      });

      setTimeout(() => {
        if (!settled) { settled = true; resolve(); }
      }, 1500);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.isRunning) return resolve();
      const proc = this.proc;
      const isAlive = () => proc.exitCode === null && !proc.killed;
      let settled = false;
      let killTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      proc.once('exit', finish);
      proc.kill();
      killTimer = setTimeout(() => {
        if (isAlive()) proc.kill('SIGKILL');
        finish();
      }, 3000);
    });
  }
}

module.exports = { XrayProcess };
