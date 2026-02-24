# OptiScaler Installer

A cross-platform GUI for installing [OptiScaler](https://github.com/optiscaler/OptiScaler) into games on Windows and Linux. Built with Electron — no server, no dependencies at runtime beyond the app itself.

![screenshot placeholder](assets/screenshot.png)

## What it does

1. You pick your GPU vendor (Nvidia RTX/GTX, AMD RDNA 2/3/4, Intel Arc).
2. You point it at a game directory.
3. It scans for upscaler entry points (`nvngx_dlss.dll`, `libxess.dll`, `amd_fidelityfx_dx12.dll`, etc.).
4. If compatible files are found, it downloads the correct OptiScaler release from GitHub, copies the right DLLs, and generates a pre-tuned `OptiScaler.ini`.

### Spoofing logic per GPU

| GPU | Entry DLL | DXGI spoof | FakeNvapi | Notes |
|-----|-----------|------------|-----------|-------|
| Nvidia RTX | `nvngx.dll` | off | off | Native DLSS path |
| Nvidia GTX/16xx | `dxgi.dll` | on | off | Spoof needed for DLSS |
| AMD RDNA 2/3 | `dxgi.dll` | on | on | Anti-Lag 2 via FakeNvapi |
| AMD RDNA 4 | `dxgi.dll` | on | on | FSR4 native + spoof for DLSS input |
| Intel Arc | `dxgi.dll` | on | off | Activates XMX path for XeSS |

### Important: online games

**Do not install OptiScaler into online or multiplayer games.** GPU spoofing and DLL injection can trigger anti-cheat software. This installer does not enforce this restriction — that's your responsibility.

---

## Development setup

### Requirements

- Node.js 18+ ([nodejs.org](https://nodejs.org))
- npm 9+
- Git

On Linux, also install `unzip` if it isn't already present (`apt install unzip` or equivalent).  
On Windows, `Expand-Archive` (PowerShell built-in) is used instead.

### Install dependencies

```bash
git clone https://github.com/YOUR_USERNAME/optiscaler-installer
cd optiscaler-installer
npm install
```

### Run in development

```bash
npm start
```

This opens the Electron window. The `window.electronAPI` bridge is active, so folder browsing, scanning, and installation all work against the real filesystem.

---

## Building releases

`electron-builder` handles packaging. Outputs go to `dist/`.

### Windows (from a Windows machine or CI)

```bash
npm run build:win
```

Produces:
- `dist/OptiScaler Installer Setup 1.0.0.exe` — NSIS installer
- `dist/OptiScaler Installer 1.0.0.exe` — portable single-file exe

### Linux (from a Linux machine or CI)

```bash
npm run build:linux
```

Produces:
- `dist/OptiScaler Installer-1.0.0.AppImage` — portable, runs on any x64 distro
- `dist/optiscaler-installer_1.0.0_amd64.deb` — Debian/Ubuntu package

### Both at once (cross-compilation via Wine/Docker)

```bash
npm run build:all
```

Cross-compiling Windows targets from Linux requires Wine or a CI runner with a Windows agent. See [electron-builder cross-platform docs](https://www.electron.build/multi-platform-build.html).

---

## Setting up GitHub Actions for automated releases

Create `.github/workflows/release.yml`:

```yaml
name: Build and Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build:win
      - uses: actions/upload-artifact@v4
        with:
          name: windows-dist
          path: dist/*.exe

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build:linux
      - uses: actions/upload-artifact@v4
        with:
          name: linux-dist
          path: |
            dist/*.AppImage
            dist/*.deb

  publish:
    needs: [build-windows, build-linux]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: release-artifacts
          merge-multiple: true
      - uses: softprops/action-gh-release@v2
        with:
          files: release-artifacts/**/*
```

To trigger a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions builds both targets and creates a release with all artifacts attached automatically.

---

## Project structure

```
optiscaler-installer/
├── main.js          # Electron main process — IPC handlers, filesystem ops, download logic
├── preload.js       # Context bridge — exposes electronAPI to renderer safely
├── index.html       # Entire UI (HTML/CSS/JS, no bundler needed)
├── package.json     # npm + electron-builder config
├── assets/
│   ├── icon.ico     # Windows icon (256x256 recommended)
│   └── icon.png     # Linux icon (512x512 recommended)
└── .github/
    └── workflows/
        └── release.yml
```

The UI has no external CSS or JS dependencies — intentional. Keeping it self-contained means no bundler, no node_modules leaking into the renderer, and a faster iteration loop.

---

## Adding icons

Place a 256×256 `icon.ico` (Windows) and 512×512 `icon.png` (Linux) in `assets/`. electron-builder picks them up automatically from the `build.win.icon` and `build.linux.icon` paths in `package.json`.

Tools to generate `.ico` from PNG: [ImageMagick](https://imagemagick.org/) or [icoutils](https://www.nongnu.org/icoutils/).

```bash
convert icon.png -resize 256x256 icon.ico
```

---

## How the scan works

`main.js` walks up to 3 directory levels from the game path, looking for files matching the known upscaler DLL list. It restricts recursion to directories named `bin`, `binaries`, `win64`, `win32`, `x64`, `game`, and `engine` to avoid scanning entire drives.

A scan passes (`Compatible`) when:
- At least one `.exe` file is found in the root directory, and
- At least one known upscaler entry point DLL is present anywhere in the scanned tree.

If neither condition is met, the installer blocks progression and shows an explanation.

---

## License

MIT. See `LICENSE`.

This project is not affiliated with the OptiScaler team. It is a community-made installer that fetches OptiScaler directly from the [official GitHub releases](https://github.com/optiscaler/OptiScaler/releases).

### v1.2.0
- **Automatic backup before overwrite** — Before replacing any file, the installer copies the original to `.optiscaler_backup/` inside the game folder. A `optiscaler_manifest.json` records exactly what was installed and what was backed up.
- **Uninstall / Restore tab** — New top-level tab. Point it at the game directory, click Check, and it reads the manifest to show you exactly what will be restored vs deleted. Click Uninstall & Restore to undo everything the installer did.
- **Expanded scan targets** — Scanner now detects alternate FSR naming conventions used by games like Clair Obscur (`amd_fidelityfx_upscaler_dx12.dll`, `amd_fidelityfx_framegeneration_dx12.dll`) and legacy FSR2/FSR3 API DLL names (`ffx_fsr2_api_dx12_x64.dll`, `ffx_fsr3upscaler_x64.dll`, `ffx_framegeneration_x64.dll`, `sl.interposer.dll`).
- Scan results now filter out non-trigger "not found" entries to reduce noise — only relevant missing files are shown.
- After a successful install, a shortcut button to "Go to Uninstall" is shown on the completion screen.
