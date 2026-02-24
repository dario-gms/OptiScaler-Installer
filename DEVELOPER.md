# OptiScaler Installer — Developer Notes

Technical reference for contributors and maintainers. For end-user documentation see [README.md](README.md).

---

## Stack

- **Electron** — main process handles all filesystem and network operations via IPC
- **No renderer dependencies** — `index.html` is vanilla HTML/CSS/JS, no bundler
- **No runtime dependencies** — everything needed is either built into Node.js or bundled by electron-builder

---

## Project structure

```
optiscaler-installer/
├── main.js          # Electron main process — IPC handlers, scan, download, install, uninstall
├── preload.js       # Context bridge — exposes electronAPI to renderer safely
├── index.html       # Entire UI (HTML/CSS/JS)
├── package.json
├── assets/
│   ├── icon.ico     # Windows icon (256×256)
│   └── icon.png     # Linux icon (512×512)
└── .github/
    └── workflows/
        └── build.yml
```

---

## Dev setup

### Requirements

- Node.js 18+
- npm 9+
- Git
- Linux only: `unzip` (`apt install unzip`)
- Windows only: PowerShell (built-in, used for zip extraction)

```bash
git clone https://github.com/dario-gms/OptiScaler-Installer
cd OptiScaler-Installer
npm install
npm start
```

`npm start` opens the Electron window with the full `electronAPI` bridge active — real filesystem, real downloads.

To inspect renderer errors: `Ctrl+Shift+I` inside the app window.  
Main process logs go to the terminal where `npm start` was run.

---

## IPC API

All communication between the renderer (`index.html`) and the main process (`main.js`) goes through `window.electronAPI`, which is defined in `preload.js` using Electron's `contextBridge`.

| Method | Description |
|--------|-------------|
| `selectFolder()` | Opens native folder picker, returns path or null |
| `scanDirectory(dir)` | Scans for upscaler DLLs, returns `{ found, exeFound, installPath, existingInstall }` |
| `checkInstall(dir)` | Searches for `optiscaler_manifest.json` recursively, returns manifest or null |
| `fetchRelease(channel)` | Fetches release info from GitHub API (`latest` or `nightly`) |
| `install(opts, releaseInfo)` | Downloads, extracts, and installs OptiScaler |
| `uninstall(dir)` | Reads manifest, restores backups, removes installed files |

---

## Scan logic

`scanDir()` in `main.js` walks the directory tree recursively (up to depth 4). It skips directories that are clearly non-game: `logs`, `cache`, `redist`, `crashes`, `.git`, `node_modules`, and similar. It also ignores executables that match known launcher/helper patterns (`launcher.exe`, `setup.exe`, `crashreport.exe`, etc.) when determining whether a game executable is present.

`findInstallPath()` selects the best directory to install into using this priority:

1. A directory that contains both a game executable **and** an upscaler DLL — ideal case
2. A directory with a game executable near (parent/grandparent of) the upscaler DLLs — common in UE4/5 games (`Binaries/Win64/`)
3. The shallowest non-root directory containing a game executable
4. Fallback: the directory the user selected

This means the user can point to the root of any Steam game and the installer finds the right subdirectory automatically.

### Hook targets (files the scanner looks for)

```
nvngx_dlss.dll, nvngx_dlssd.dll, nvngx_dlssg.dll
sl.dlss.dll, sl.interposer.dll
libxess.dll, libxess_dx11.dll
amd_fidelityfx_dx12.dll, amd_fidelityfx_vk.dll
amd_fidelityfx_upscaler_dx12.dll, amd_fidelityfx_framegeneration_dx12.dll
ffx_fsr2_api_dx12_x64.dll, ffx_fsr2_api_vk_x64.dll
ffx_fsr3upscaler_x64.dll, ffx_framegeneration_x64.dll
dxgi.dll, d3d12.dll, dsound.dll, winmm.dll, version.dll
nvngx_dlss.so, libxess.so, libamd_fidelityfx_vk.so  (Linux)
```

A scan is considered **compatible** when at least one *trigger* DLL (upscaler-specific, not generic hooks like `dxgi.dll`) is found alongside a non-launcher executable.

---

## Spoofing logic per GPU

| GPU | Hook DLL | DXGI spoof | FakeNvapi | INI backend |
|-----|----------|------------|-----------|-------------|
| Nvidia RTX | `winmm.dll` | off | off | `dlss` |
| Nvidia GTX/16xx | `dxgi.dll` | on | off | `dlss` |
| AMD RDNA 1 (RX 5000) | `dxgi.dll` | on | on | `fsr22` |
| AMD RDNA 2/3 (RX 6000–7000) | `dxgi.dll` | on | on | `fsr22` |
| AMD RDNA 4 (RX 9000) | `dxgi.dll` | on | on | `fsr31` |
| Intel Arc | `dxgi.dll` | on | off | `xess` |

---

## Install process

1. Fetch release metadata from GitHub API (`/repos/optiscaler/OptiScaler/releases/latest` or `.../tags/nightly`)
2. Download the `.zip` or `.7z` archive (7-Zip required for `.7z` — `7z`/`7za`/`7zr` on PATH, or install via `apt install p7zip-full`)
3. Extract to a temp directory in `os.tmpdir()`
4. Back up any pre-existing files to `<installDir>/.optiscaler_backup/`
5. Copy the hook DLL (renamed to `dxgi.dll` or `winmm.dll`), core deps (`amd_fidelityfx_dx12.dll`, `libxess.dll`, etc.), and optionally `nvapi64.dll` (FakeNvapi) and `dlssg_to_fsr3.dll` (Nukem FG)
6. Write `OptiScaler.ini` (if enabled)
7. Write `optiscaler_manifest.json` — records every installed file and its backup path, used by the uninstaller

---

## Uninstall process

`findManifest()` recursively searches the user-provided directory (same skip rules as the scanner) for `optiscaler_manifest.json`. This means the user can point to the game root and the uninstaller resolves the correct subdirectory automatically.

For each file in the manifest:
- If `backedUp: true` — restore original from `.optiscaler_backup/`
- If `backedUp: false` — delete the installed file

On completion, `.optiscaler_backup/` and `optiscaler_manifest.json` are removed.

---

## Building releases

```bash
npm run build:win    # Windows: NSIS installer + portable exe
npm run build:linux  # Linux: AppImage + .deb
npm run build:all    # Both
```

Output goes to `dist/`.

### Icons

Place `assets/icon.ico` (256×256, Windows) and `assets/icon.png` (512×512, Linux) before building. Generate `.ico` from PNG with ImageMagick:

```bash
convert icon.png -resize 256x256 icon.ico
```

---

## Automated releases (GitHub Actions)

Push a tag matching `v*` to trigger a build + release:

```bash
git tag v1.2.1
git push origin v1.2.1
```

The workflow (`.github/workflows/build.yml`) builds in parallel on `windows-latest` and `ubuntu-latest`, then creates a GitHub Release with all artifacts attached. `skip_existing: true` prevents errors on re-runs.

---

## Version history

| Version | Changes |
|---------|---------|
| 1.2.1 | Added AMD RDNA 1 (RX 5000) support; smart install path detection (no need to navigate to exact exe folder); uninstaller also auto-detects install subdirectory |
| 1.2.0 | *(internal)* |
| 1.0.0 | Initial release |
