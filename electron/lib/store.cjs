'use strict';
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = { ...defaults };
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

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }
}

module.exports = { JsonStore };
