--- README.md (原始)


+++ README.md (修改后)
# Soul Connection

A modern V2Ray/Xray client for Windows with a clean and intuitive user interface.

## Features

- **Multiple Protocol Support**: VLESS, Trojan, and Shadowsocks (SS)
- **Modern UI**: Built with React and Vite for a responsive experience
- **Server Testing**: Built-in ping and speed test capabilities
- **Smart Server Selection**: Automatic server finder with latency testing
- **System Proxy Management**: Easy toggle for system-wide proxy
- **QR Code Support**: Import configurations via QR codes
- **Auto-Update**: Built-in updater powered by electron-updater
- **Portable Mode**: Available as a standalone portable executable

## Technologies

- **Frontend**: React 18, Vite 5
- **Backend**: Electron 33
- **Core**: Xray/V2Ray engine
- **Communication**: gRPC for stats and management
- **Build Tools**: electron-builder for packaging

## Installation

### Prerequisites

- Node.js (v16 or higher recommended)
- npm (comes with Node.js)
- Windows OS (for building/running)

### Development Setup

```bash
# Clone the repository
git clone <repository-url>
cd Fullstack-Soul-Connection

# Install dependencies
npm install

# Start in development mode
npm start
```

### Building Executable

#### Standard Build (NSIS Installer)
```bash
npm run dist
```

#### Portable Build (No Installation Required)
```bash
npm run dist:portable
```

Or use the batch file:
```batch
build-portable.bat
```

#### Publish to GitHub Releases
```bash
npm run dist:publish
```

## Usage

### Running the Application

**Development Mode:**
```bash
npm start
```

**After Building:**
- Locate the built executable in the `release` folder
- Run `Soul Connection.exe` (installer version) or
- Run `Soul Connection-Portable-<version>.exe` (portable version)

### Adding Servers

1. Click the "Add" button in the main interface
2. Paste your VLESS/Trojan/Shadowsocks link
3. Or scan/import from QR code
4. Test connection before connecting

### Connecting

1. Select a server from your list
2. Click "Connect"
3. The app will configure system proxy automatically
4. Status bar shows connection state and traffic

### Server Testing

- Use the built-in test dashboard to check server latency
- Auto-find feature locates the fastest available server
- Individual server testing available in context menu

## Project Structure

```
Fullstack-Soul-Connection/
├── electron/           # Electron main process
│   ├── assets/         # App icons and resources
│   ├── lib/            # Core functionality modules
│   │   ├── xrayProcess.cjs    # Xray process management
│   │   ├── systemProxy.cjs    # System proxy configuration
│   │   ├── serverTest.cjs     # Server testing utilities
│   │   └── ...
│   ├── main.cjs        # Main process entry point
│   └── preload.cjs     # Preload script for IPC
├── src/                # React frontend source
│   ├── components/     # UI components
│   ├── utils/          # Utility functions
│   ├── finder/         # Server discovery logic
│   ├── App.jsx         # Main application component
│   └── main.jsx        # React entry point
├── scripts/            # Build scripts
├── public/             # Static assets
├── build-portable.bat  # Portable build script
├── build.bat           # Standard build script
├── package.json        # Project configuration
└── vite.config.js      # Vite configuration
```

## Configuration

The application stores settings in Electron's local storage. Configuration includes:

- Server list
- System proxy settings
- Kill switch preferences
- Network settings

## Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run dev` | Build UI and start Electron (development) |
| `npm start` | Build UI and start Electron (production-like) |
| `npm run build:ui` | Build the React UI only |
| `npm run dist` | Build NSIS installer |
| `npm run dist:portable` | Build portable executable |
| `npm run dist:publish` | Build and publish to GitHub |

## Supported Protocols

- **VLESS**: Reality, TLS, WS, XHTTP transports
- **Trojan**: TLS with WebSocket
- **Shadowsocks**: ChaCha20-IETF-Poly1305 cipher

## License

MIT License - see [LICENSE](LICENSE) for details

## Author

Soul

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## Disclaimer

This tool is intended for educational and legitimate purposes only. Users are responsible for complying with their local laws and regulations when using this software.
