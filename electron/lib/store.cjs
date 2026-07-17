'use strict';
const fs = require('fs');
const path = require('path');

const SAVE_DEBOUNCE_MS = 200;

class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = { ...defaults };
    this._saveTimer = null;
    this._writing = false;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = { ...this.data, ...JSON.parse(raw) };
    } catch {
      // no existing file yet; keep defaults
    }
  }

  _writeNow() {
    if (this._writing) {
      // A write is already in flight; try again shortly rather than risk
      // two overlapping writes to the same file.
      this._saveTimer = setTimeout(() => { this._saveTimer = null; this._writeNow(); }, SAVE_DEBOUNCE_MS);
      return;
    }
    this._dirty = false;
    this._writing = true;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(this.data);
    fs.writeFile(this.filePath, json, 'utf8', (err) => {
      this._writing = false;
      if (err) console.error('Failed to persist store:', err);
    });
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
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8');
  }
}

module.exports = { JsonStore };
