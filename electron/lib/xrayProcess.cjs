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
      this.proc = spawn(this.xrayBinPath, ['run', '-c', this.configPath], {
        cwd: path.dirname(this.xrayBinPath),
        windowsHide: true,
      });

      let settled = false;
      const onData = (buf) => {
        const text = buf.toString('utf8');
        this.logLines.push(text);
        if (this.logLines.length > 500) this.logLines.shift();
        this.emit('log', text);
        if (!settled && /started/i.test(text)) {
          settled = true;
          resolve();
        }
      };

      this.proc.stdout.on('data', onData);
      this.proc.stderr.on('data', onData);

      this.proc.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
        this.emit('exit', -1);
      });

      this.proc.on('exit', (code) => {
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
      const onExit = () => resolve();
      proc.once('exit', onExit);
      proc.kill();
      setTimeout(() => {
        if (this.isRunning) proc.kill('SIGKILL');
        resolve();
      }, 3000);
    });
  }
}

module.exports = { XrayProcess };
