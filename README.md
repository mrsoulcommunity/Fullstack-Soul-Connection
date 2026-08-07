# Soul Connection

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/mrsoulcommunity/SoulConnection?label=version)](https://github.com/mrsoulcommunity/SoulConnection/releases)
[![Downloads](https://img.shields.io/github/downloads/mrsoulcommunity/SoulConnection/total)](https://github.com/mrsoulcommunity/SoulConnection/releases)

> **A modern V2Ray / Xray client for Windows — Persian UI, built with React and Electron.**

Soul Connection is a desktop client for managing and connecting to VMess, VLESS, Trojan and
Shadowsocks servers. It wraps the Xray core behind a clean, fully Persian interface, and adds
subscription management, a smart server finder with real latency and speed testing, live traffic
stats, a firewall-backed kill switch, and full-tunnel (TUN) mode.

---

## 📥 Download

Grab the latest `setup.exe` from the [Releases page](https://github.com/mrsoulcommunity/SoulConnection/releases/latest).

A single installer covers **both 32-bit (ia32) and 64-bit (x64) Windows** — it detects your
system and installs the matching build. Windows 10 or later is recommended.

Because the installer is not code-signed, SmartScreen may warn on first run. Choose
**More info → Run anyway**. Some antivirus products also flag the bundled `xray.exe`; if the app
reports that `xray.exe` is missing, add the install folder to your antivirus exclusions and
reinstall.

---

## ✨ Features

- **Protocols** — VMess, VLESS (incl. Reality / XTLS Vision), Trojan, and Shadowsocks.
- **Transports** — TCP, WebSocket, gRPC, HTTP/2, mKCP, with TLS and Reality.
- **Two connection modes** — System Proxy (default) or full-device Tunnel (TUN, needs admin).
- **Subscriptions** — import by URL, refresh manually or on a timer, with remaining-quota display.
- **Bulk paste** — paste one link or a whole wall of them at once; every valid config is
  extracted and deduplicated automatically.
- **Server Finder** — test ping, real latency through the tunnel, and download/upload speed, then
  sort servers by a combined score.
- **Kill Switch** — Windows Firewall rules that block all outbound traffic the moment the tunnel
  drops, so nothing leaks outside it.
- **Live stats** — real-time upload/download speed and per-server lifetime usage, via Xray's gRPC
  stats API.
- **Auto-reconnect** — detects an unexpected tunnel drop and retries with backoff.
- **Auto-update** — checks GitHub Releases and installs new versions in place.
- **Tray integration** — quick connect/disconnect and server switching without opening the window.
- **Backup & restore** — export and import all profiles, subscriptions, and settings as JSON.
- **QR sharing** — render any config as a QR code to copy or save.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **UI** | React 18 (plain JSX), hand-written CSS, Vazirmatn variable font |
| **Desktop shell** | Electron 33 |
| **Build tool** | Vite 5 |
| **Core engine** | Xray-core (bundled `xray.exe`, per architecture) |
| **Stats** | gRPC (`@grpc/grpc-js`) against Xray's StatsService |
| **Tunnel driver** | Wintun (`wintun.dll`) for TUN mode |
| **Packaging** | electron-builder (NSIS) |

The renderer talks to the main process only through a `contextBridge` preload
(`electron/preload.cjs`); `nodeIntegration` is off and the renderer is sandboxed.

---

## 🚀 Building from source

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- Git
- Windows (the app and its build targets are Windows-only)

### Setup

```bash
git clone https://github.com/mrsoulcommunity/SoulConnection.git
cd SoulConnection
npm install
```

The `bin/` folder is not tracked in git. Before building, populate it with the Xray core and
Wintun driver:

```text
bin/
├── geoip.dat
├── geosite.dat
├── win-x64/
│   ├── xray.exe        # 64-bit Xray core
│   └── wintun.dll      # 64-bit Wintun driver
└── win-ia32/
    ├── xray.exe        # 32-bit Xray core
    └── wintun.dll      # 32-bit Wintun driver
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Build the UI bundle and launch Electron |
| `npm run start` | Same as `dev` |
| `npm run build:ui` | Build only the Vite renderer bundle into `dist/` |
| `npm run dist` | Build `release/setup.exe` (x64 + ia32 in one installer) |
| `npm run dist:publish` | Same as `dist`, then publish to GitHub Releases (needs `GH_TOKEN`) |
| `npm run dist:portable` | Build a single-file portable x64 executable |

---

## 📂 Project structure

```text
SoulConnection/
├── electron/
│   ├── main.cjs           # Main process: IPC, tray, connection lifecycle
│   ├── preload.cjs        # contextBridge API exposed to the renderer
│   ├── assets/            # App icon
│   └── lib/               # Xray process, config builder, parsers, kill switch, …
├── src/
│   ├── App.jsx            # Root component
│   ├── components/        # UI: server list, settings, finder, modals
│   ├── finder/            # Server-test orchestration store
│   ├── utils/             # Formatting, geo lookup, scoring
│   └── assets/fonts/      # Bundled Vazirmatn variable font
├── bin/                   # Xray core + Wintun (not tracked; see above)
├── scripts/build-exe.cjs  # Packaging pipeline
├── vite.config.js
└── package.json           # Also holds the electron-builder config
```

---

## ⚙️ Where your data lives

Profiles, subscriptions, and settings are stored as a single JSON file:

- **Installed build** — `%APPDATA%\soul-connection\profiles.json`
- **Portable build** — `data\profiles.json`, next to the executable

The portable build leaves nothing behind on the host machine: delete its folder and it's gone.

---

## 🌐 Supported protocols

| Protocol | Notable features | Status |
|----------|------------------|--------|
| **VLESS** | Reality, XTLS Vision, all transports | ✅ Supported |
| **VMess** | AEAD, alterId 0 | ✅ Supported |
| **Trojan** | TLS, WebSocket, gRPC | ✅ Supported |
| **Shadowsocks** | AEAD ciphers, incl. 2022-blake3 | ✅ Supported |

---

## 🤝 Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes.
4. Push the branch and open a Pull Request.

---

## 📄 License

MIT — see [LICENSE](LICENSE).

Bundled third-party components keep their own licenses: Xray-core (MPL-2.0) and Wintun, both
covered by the notices shipped in `bin/`.

---

## ⚠️ Disclaimer

This software is intended for legitimate privacy protection and educational use only. The
developers are not responsible for any misuse. Users must comply with the laws and regulations
that apply to them regarding internet usage and proxy services.

---

## 👥 Authors

- **Soul Community** — [mrsoulcommunity](https://github.com/mrsoulcommunity)

---

<div align="center">
  <p>Made with ❤️ by the Soul Team</p>
  <p>
    <a href="https://github.com/mrsoulcommunity/SoulConnection">GitHub</a> •
    <a href="https://github.com/mrsoulcommunity/SoulConnection/issues">Issues</a> •
    <a href="https://github.com/mrsoulcommunity/SoulConnection/releases">Releases</a>
  </p>
</div>
