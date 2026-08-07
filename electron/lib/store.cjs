'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SAVE_DEBOUNCE_MS = 200;

class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    // Sibling files used by the crash-safe write path below.
    this.tmpPath = `${filePath}.tmp`;
    this.bakPath = `${filePath}.bak`;
    this.data = { ...defaults };
    this._saveTimer = null;
    this._chain = Promise.resolve();
    this._dirty = false;
    this._load();
  }

  _readJson(file) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A truncated write can still parse (e.g. `null`, or a bare number), so
    // only a plain object counts as a usable store file.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('store file is not a JSON object');
    }
    return parsed;
  }

  // Profiles/subscriptions are user data that can't be regenerated, so a
  // damaged file must never silently degrade into "fresh install". Fall back
  // to the previous good copy, and if that fails too, keep the unreadable
  // file aside instead of overwriting it on the next save.
  _load() {
    try {
      this.data = { ...this.data, ...this._readJson(this.filePath) };
      return;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(`Store at ${this.filePath} is unreadable:`, e.message);
      }
    }

    try {
      this.data = { ...this.data, ...this._readJson(this.bakPath) };
      console.warn('Recovered store from backup:', this.bakPath);
      return;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(`Store backup at ${this.bakPath} is unreadable:`, e.message);
      }
    }

    // Nothing readable. Preserve whatever is on disk (if anything) so the data
    // can still be recovered by hand, then start from defaults.
    try {
      if (fs.existsSync(this.filePath)) {
        const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
        fs.renameSync(this.filePath, quarantine);
        console.error('Kept the unreadable store file at:', quarantine);
      }
    } catch (e) {
      console.error('Could not set the unreadable store file aside:', e.message);
    }
  }

  // Write to a temp file, fsync it, snapshot the current file as .bak, then
  // rename the temp file over the real one. rename() is atomic, so a crash or
  // power loss leaves either the old file or the new one intact -- never a
  // half-written profiles.json.
  _persistSync() {
    const json = JSON.stringify(this.data);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    const fd = fs.openSync(this.tmpPath, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.copyFileSync(this.filePath, this.bakPath);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Failed to refresh store backup:', e.message);
    }

    fs.renameSync(this.tmpPath, this.filePath);
  }

  async _persistAsync() {
    const json = JSON.stringify(this.data);
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });

    const handle = await fsp.open(this.tmpPath, 'w');
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fsp.copyFile(this.filePath, this.bakPath);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Failed to refresh store backup:', e.message);
    }

    await fsp.rename(this.tmpPath, this.filePath);
  }

  _writeNow() {
    this._dirty = false;
    // Serialize on a promise chain so two saves can never interleave over the
    // same temp file.
    this._chain = this._chain
      .then(() => this._persistAsync())
      .catch((err) => console.error('Failed to persist store:', err));
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    // In-memory state updates immediately (so get() is always consistent);
    // the disk write is debounced and async so a burst of set() calls (e.g.
    // connect() updating activeProfileId/mode/lastUsedAt back-to-back) costs
    // one write instead of N synchronous full-file rewrites blocking the
    // main thread.
    this.data[key] = value;
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeNow();
    }, SAVE_DEBOUNCE_MS);
  }

  // Synchronous, immediate write -- call right before the app quits so a
  // pending debounced save is never lost.
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._dirty) return;
    this._dirty = false;
    try {
      this._persistSync();
    } catch (err) {
      console.error('Failed to flush store:', err);
    }
  }
}

module.exports = { JsonStore };
