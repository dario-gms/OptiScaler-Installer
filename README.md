# OptiScaler Installer

A simple GUI for installing [OptiScaler](https://github.com/optiscaler/OptiScaler) into games on Windows and Linux — no terminal required.

> **This project is not affiliated with the OptiScaler team.** It fetches OptiScaler directly from the [official GitHub releases](https://github.com/optiscaler/OptiScaler/releases).

---

## Download

Go to the [Releases](https://github.com/dario-gms/OptiScaler-Installer/releases) page and grab the file for your system:

| Platform | File |
|----------|------|
| Windows (installer) | `OptiScaler Installer Setup 1.2.1.exe` |
| Windows (portable)  | `OptiScaler Installer 1.2.1.exe` |
| Linux               | `OptiScaler Installer-1.2.1.AppImage` |
| Linux (Debian/Ubuntu) | `optiscaler-installer_1.2.1_amd64.deb` |

---

## How to use

1. **Select your GPU** — pick your vendor and series from the list
2. **Select the game folder** — point to the game's installation directory (the root is fine, no need to find the exact executable)
3. **Scan** — the installer finds the right location and checks for upscaler support
4. **Configure** — adjust options if needed (defaults are tuned for your GPU)
5. **Install** — OptiScaler is downloaded from GitHub and installed automatically

All files that get replaced are backed up first. You can restore them at any time using the **Uninstall / Restore** tab.

---

## Supported GPUs

| GPU | Notes |
|-----|-------|
| Nvidia RTX (20xx–50xx) | Native DLSS — no spoofing needed |
| Nvidia GTX / 16xx | DLSS via GPU spoof |
| AMD RX 5000 / RDNA 1 | FSR 2/3 + FakeNvapi (Anti-Lag 2) |
| AMD RX 6000–7000 / RDNA 2–3 | FSR 2/3 + FakeNvapi (Anti-Lag 2) |
| AMD RX 9000 / RDNA 4 | Native FSR4 + FakeNvapi |
| Intel Arc (A/B series) | XeSS via DXGI spoof |

---

## Requirements

OptiScaler requires a game that already ships with **DLSS 2+, XeSS, or FSR 2+**. The scanner will tell you if a game is compatible. If no upscaler DLL is found, OptiScaler has nothing to hook into.

---

## ⚠️ Do not use with online games

GPU spoofing and DLL injection can trigger anti-cheat software. **Do not install OptiScaler into any game with online or multiplayer components.** This installer does not enforce this — it is your responsibility.

---

## Uninstalling

Open the **Uninstall / Restore** tab, select the game folder, and click **Uninstall & Restore**. The installer will remove all OptiScaler files and restore any originals it backed up.

---

## License

MIT. See `LICENSE`.
