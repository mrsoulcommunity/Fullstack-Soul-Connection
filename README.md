# Soul Connection

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/mrsoulcommunity/Fullstack-Soul-Connection?label=version)](https://github.com/mrsoulcommunity/Fullstack-Soul-Connection/releases)
[![Downloads](https://img.shields.io/github/downloads/mrsoulcommunity/Fullstack-Soul-Connection/total)](https://github.com/mrsoulcommunity/Fullstack-Soul-Connection/releases)

> **A powerful, secure, and user-friendly cross-platform proxy client built with React, Electron, and gRPC.**

Soul Connection is a modern desktop application designed to manage and connect to various proxy protocols seamlessly. Built on top of the robust Sing-box core, it provides an intuitive interface for managing VLESS, Trojan, and Shadowsocks connections with advanced features like real-time latency testing, subscription management, and system proxy configuration.

---

## ✨ Features

- 🚀 **Multi-Protocol Support**: Full support for VLESS (Reality), Trojan, and Shadowsocks protocols.
- 🛡️ **Secure & Private**: Built-in encryption and privacy-focused design with no data logging.
- ⚡ **High Performance**: Optimized routing engine powered by Sing-box for minimal latency.
- 🌐 **Cross-Platform**: Runs smoothly on Windows, macOS, and Linux.
- 🎨 **Modern UI**: Clean, responsive interface built with React and Tailwind CSS.
- 🔄 **Subscription Management**: Import and auto-update configurations via remote links.
- 📊 **Real-time Latency Test**: One-click speed test for all servers with visual indicators.
- 🔍 **Smart Routing**: Automatic rule-based routing for domestic and international traffic.
- 💻 **System Proxy Integration**: Easily toggle system-wide proxy or use PAC mode.
- 📦 **Portable Mode**: Available as a portable executable for USB drives or restricted environments.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18, TypeScript, Tailwind CSS, Radix UI |
| **Desktop Shell** | Electron 28+ |
| **Build Tool** | Vite |
| **Core Engine** | Sing-box (via gRPC) |
| **State Management** | Zustand / Context API |
| **Communication** | gRPC (Protobuf) |
| **Packaging** | electron-builder |

---

## 📦 Installation

### Prerequisites

Ensure you have the following installed:
- [Node.js](https://nodejs.org/) (v18 or higher)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)
- Git

### Clone the Repository

```bash
git clone https://github.com/mrsoulcommunity/Fullstack-Soul-Connection.git
cd Fullstack-Soul-Connection
```

### Install Dependencies

```bash
npm install
# or
yarn install
```

---

## 🚀 Usage

### Development Mode

Run the app in development mode with hot-reloading:

```bash
npm run dev
```

### Build Executables

#### Standard Build
Creates installers for your current platform:
```bash
npm run build
```

#### Portable Build
Creates a standalone executable (Windows):
```bash
npm run build:portable
```

#### Publish Release
Builds and prepares artifacts for GitHub release:
```bash
npm run publish
```

### Running the App

1. Launch the application via the generated executable or `npm run dev`.
2. **Add a Server**:
   - Click **"Import from Clipboard"** to paste a share link (`vless://`, `trojan://`, `ss://`).
   - Or manually enter configuration details.
3. **Connect**: Select a server from the list and click **"Connect"**.
4. **Test Latency**: Click the **⚡** icon next to any server to check its speed.
5. **System Proxy**: Enable "System Proxy" in settings to route all traffic through the tunnel.

---

## 📂 Project Structure

```text
Fullstack-Soul-Connection/
├── src/
│   ├── main/             # Electron Main Process (gRPC, Window Mgmt)
│   ├── renderer/         # React Frontend (UI Components)
│   ├── core/             # Sing-box integration logic
│   └── utils/            # Helper functions
├── public/               # Static assets
├── proto/                # Protobuf definitions for gRPC
├── releases/             # Build output directory
├── package.json          # Project metadata & scripts
├── vite.config.ts        # Vite configuration
└── electron-builder.yml  # Packaging configuration
```

---

## ⚙️ Configuration

The app stores user preferences and server lists in a local JSON file:
- **Windows**: `%APPDATA%\soul-connection\config.json`
- **macOS**: `~/Library/Application Support/soul-connection/config.json`
- **Linux**: `~/.config/soul-connection/config.json`

Supported configuration options:
- `autoConnect`: Automatically connect to the last used server on startup.
- `startupLaunch`: Run app on system boot.
- `theme`: Light/Dark/System theme preference.
- `routingMode`: Global, Rule-based, or Direct.

---

## 📜 Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build production app for current OS |
| `npm run build:win` | Build for Windows |
| `npm run build:mac` | Build for macOS |
| `npm run build:linux` | Build for Linux |
| `npm run build:portable` | Create portable executable |
| `npm run publish` | Build and prepare for GitHub release |
| `npm run lint` | Run ESLint checks |
| `npm run type-check` | Verify TypeScript types |

---

## 🌐 Supported Protocols

| Protocol | Features | Status |
|----------|----------|--------|
| **VLESS** | Reality, Vision, XTLS | ✅ Fully Supported |
| **Trojan** | TLS, WebSocket | ✅ Fully Supported |
| **Shadowsocks** | AEAD Ciphers (AES-128-GCM, Chacha20) | ✅ Fully Supported |

---

## 🤝 Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

Please read our [Contributing Guidelines](CONTRIBUTING.md) for details on code style and testing.

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

## 👥 Authors

- **Soul Community** - *Initial work* - [mrsoulcommunity](https://github.com/mrsoulcommunity)

See also the list of [contributors](https://github.com/mrsoulcommunity/Fullstack-Soul-Connection/contributors) who participated in this project.

---

## ⚠️ Disclaimer

This software is intended for educational purposes and legitimate privacy protection only. The developers are not responsible for any misuse of this software. Users must comply with local laws and regulations regarding internet usage and proxy services.

---

## 📥 Download

Get the latest version from our [Releases Page](https://github.com/mrsoulcommunity/Fullstack-Soul-Connection/releases).

---

<div align="center">
  <p>Made with ❤️ by the Soul Team</p>
  <p>
    <a href="https://github.com/mrsoulcommunity/Fullstack-Soul-Connection">GitHub</a> •
    <a href="https://github.com/mrsoulcommunity/Fullstack-Soul-Connection/issues">Issues</a> •
    <a href="https://github.com/mrsoulcommunity/Fullstack-Soul-Connection/discussions">Discussions</a>
  </p>
</div>
