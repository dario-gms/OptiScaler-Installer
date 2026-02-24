const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile, execSync } = require('child_process');
const os = require('os');

const GITHUB_API = 'https://api.github.com';
const REPO = 'optiscaler/OptiScaler';

// Backup folder created inside the game directory
const BACKUP_DIR_NAME = '.optiscaler_backup';
// Manifest written alongside the backup — records exactly what was installed
const MANIFEST_NAME = 'optiscaler_manifest.json';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    frame: true,
    backgroundColor: '#0a0c0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'OptiScaler Installer',
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── IPC: folder picker ───────────────────────────────────────────────────────
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select game installation folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── IPC: scan directory ──────────────────────────────────────────────────────

// Files OptiScaler hooks into as entry points
const HOOK_TARGETS = [
  'nvngx_dlss.dll', 'nvngx_dlssd.dll', 'nvngx_dlssg.dll',
  'sl.dlss.dll', 'sl.interposer.dll',
  'libxess.dll', 'libxess_dx11.dll',
  // Standard FSR names
  'amd_fidelityfx_dx12.dll', 'amd_fidelityfx_vk.dll',
  // Alternative FSR names used by some games (e.g. Clair Obscur, Space Marine 2)
  'amd_fidelityfx_upscaler_dx12.dll',
  'amd_fidelityfx_framegeneration_dx12.dll',
  'ffx_fsr2_api_dx12_x64.dll',
  'ffx_fsr2_api_vk_x64.dll',
  'ffx_fsr3upscaler_x64.dll',
  'ffx_framegeneration_x64.dll',
  // Graphics hook targets
  'dxgi.dll', 'd3d12.dll', 'dsound.dll', 'winmm.dll', 'version.dll',
  // Linux / Proton
  'nvngx_dlss.so', 'libxess.so', 'libamd_fidelityfx_vk.so',
];

// Which of those confirm the game actually has upscaling support
const UPSCALER_TRIGGERS = new Set([
  'nvngx_dlss.dll', 'sl.dlss.dll', 'sl.interposer.dll',
  'libxess.dll',
  'amd_fidelityfx_dx12.dll', 'amd_fidelityfx_vk.dll',
  'amd_fidelityfx_upscaler_dx12.dll',
  'amd_fidelityfx_framegeneration_dx12.dll',
  'ffx_fsr2_api_dx12_x64.dll', 'ffx_fsr2_api_vk_x64.dll',
  'ffx_fsr3upscaler_x64.dll', 'ffx_framegeneration_x64.dll',
  'nvngx_dlss.so', 'libxess.so', 'libamd_fidelityfx_vk.so',
]);

const EXE_EXTENSIONS = new Set(['.exe', '.sh', '.AppImage']);

// Directories that are clearly not game directories — skip to avoid slow scans
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'cache', 'shadercache', 'shader_cache',
  'logs', 'log', 'crashes', 'crash', 'screenshots', 'screenshots', 'saves',
  'savegames', 'photos', 'videos', 'redist', 'redistributables', 'vcredist',
  'directx', '_commonredist', 'support', 'tools',
]);

// EXE names that are launchers / helpers, not the actual game
const LAUNCHER_EXE_FRAGMENTS = [
  'launcher', 'setup', 'install', 'uninstall', 'crash', 'report',
  'helper', 'updater', 'update', 'prereq', 'prerequisite', 'uplay',
  'eac', 'anticheat', 'easyanticheat', 'battleye', 'steam', 'galaxy',
];

function isLauncherExe(lower) {
  return LAUNCHER_EXE_FRAGMENTS.some(frag => lower.includes(frag));
}

function scanDir(dirPath, depth = 0) {
  const found   = {};     // upscaler DLLs: name -> fullPath
  const exeDirs = [];     // directories where a game EXE was found

  if (depth > 4) return { found, exeDirs };

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { found, exeDirs };
  }

  let hasGameExeHere = false;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const lower    = entry.name.toLowerCase();

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(lower)) {
        const sub = scanDir(fullPath, depth + 1);
        Object.assign(found, sub.found);
        exeDirs.push(...sub.exeDirs);
      }
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(lower);
    if (EXE_EXTENSIONS.has(ext) && !isLauncherExe(lower)) hasGameExeHere = true;

    if (HOOK_TARGETS.includes(lower)) found[lower] = fullPath;
  }

  if (hasGameExeHere) exeDirs.push(dirPath);

  return { found, exeDirs };
}

/**
 * Choose the best directory to install OptiScaler into.
 * Priority:
 *   1. A directory that contains both a game EXE and an upscaler DLL (ideal).
 *   2. A directory that contains a game EXE and whose parent has upscaler DLLs.
 *   3. Any directory with a game EXE (shallowest non-root wins for typical UE structure).
 *   4. Fall back to the root the user picked.
 */
function findInstallPath(rootDir, exeDirs, found) {
  if (exeDirs.length === 0) return rootDir;

  const upscalerDirs = new Set(Object.values(found).map(p => path.dirname(p)));

  // 1. EXE dir that also has upscaler DLL(s)
  for (const d of exeDirs) {
    if (upscalerDirs.has(d)) return d;
  }

  // 2. EXE dir whose parent or grandparent contains upscaler DLL(s)
  for (const d of exeDirs) {
    if (upscalerDirs.has(path.dirname(d)) || upscalerDirs.has(path.dirname(path.dirname(d)))) return d;
  }

  // 3. Shallowest EXE dir that is NOT the user-picked root (avoids root-level launcher.exe)
  const nonRoot = exeDirs.filter(d => d !== rootDir);
  if (nonRoot.length > 0) {
    nonRoot.sort((a, b) => a.length - b.length);
    return nonRoot[0];
  }

  return exeDirs[0];
}

ipcMain.handle('scan-directory', async (_event, dirPath) => {
  if (!fs.existsSync(dirPath)) throw new Error(`Path does not exist: ${dirPath}`);

  const result = scanDir(dirPath);
  const exeFound = result.exeDirs.length > 0;
  const installPath = findInstallPath(dirPath, result.exeDirs, result.found);

  // Check if a previous OptiScaler install exists (check both root and install path)
  let existingInstall = null;
  for (const checkDir of new Set([dirPath, installPath])) {
    const manifestPath = path.join(checkDir, MANIFEST_NAME);
    if (fs.existsSync(manifestPath)) {
      try { existingInstall = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); break; } catch { }
    }
  }

  return { found: result.found, exeFound, installPath, existingInstall };
});

// ─── Helper: find manifest recursively (same skip rules as scanDir) ──────────
function findManifest(dirPath, depth = 0) {
  if (depth > 4) return null;

  const candidate = path.join(dirPath, MANIFEST_NAME);
  if (fs.existsSync(candidate)) return candidate;

  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch { return null; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
    const found = findManifest(path.join(dirPath, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

// ─── IPC: check if backup exists (for uninstall tab) ─────────────────────────
ipcMain.handle('check-install', async (_event, dirPath) => {
  const manifestPath = findManifest(dirPath);
  if (!manifestPath) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest._installDir = path.dirname(manifestPath);
    return manifest;
  } catch {
    return null;
  }
});

// ─── IPC: fetch release info ──────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'optiscaler-installer/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

ipcMain.handle('fetch-release', async (_event, channel) => {
  const endpoint = channel === 'nightly'
    ? `${GITHUB_API}/repos/${REPO}/releases/tags/nightly`
    : `${GITHUB_API}/repos/${REPO}/releases/latest`;

  const { statusCode, body } = await httpsGet(endpoint);
  if (statusCode !== 200) throw new Error(`GitHub API returned HTTP ${statusCode}. Check your internet connection.`);

  const data = JSON.parse(body);
  return {
    version: data.tag_name,
    assets: data.assets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
});

// ─── IPC: install ─────────────────────────────────────────────────────────────
ipcMain.handle('install', async (_event, opts, releaseInfo) => {
  const send = (msg, type = 'info') => mainWindow.webContents.send('install-log', { msg, type });
  const progress = (pct) => mainWindow.webContents.send('install-progress', pct);

  const tmpDir = path.join(os.tmpdir(), `optiscaler-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const archiveAsset = releaseInfo.assets.find(a => {
      const n = a.name.toLowerCase();
      return (n.endsWith('.7z') || n.endsWith('.zip')) && !n.startsWith('source');
    });

    if (!archiveAsset) {
      const names = releaseInfo.assets.map(a => a.name).join(', ') || 'none';
      return {
        success: false,
        error: `No installable archive found in release ${releaseInfo.version}.\nAssets: ${names}\nThe release format may have changed — please open a GitHub issue.`,
      };
    }

    const archivePath = path.join(tmpDir, archiveAsset.name);
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    send(`Downloading ${archiveAsset.name} (${formatBytes(archiveAsset.size)})...`, 'info');
    progress(8);

    await downloadFile(archiveAsset.url, archivePath, downloaded => {
      if (archiveAsset.size > 0) {
        progress(8 + Math.min(Math.round((downloaded / archiveAsset.size) * 32), 31));
      }
    });

    send('Download complete.', 'ok');
    progress(40);

    send('Extracting archive...', 'info');
    await extractArchive(archivePath, extractDir, archivePath.toLowerCase().endsWith('.7z'));
    send('Extraction complete.', 'ok');
    progress(55);

    const dest = opts.installPath || opts.gamePath;
    const backupDir = path.join(dest, BACKUP_DIR_NAME);
    fs.mkdirSync(backupDir, { recursive: true });

    // Manifest records installed files and their backup status for the uninstaller
    const manifest = {
      version: releaseInfo.version,
      installedAt: new Date().toISOString(),
      gpu: opts.gpu,
      hookDll: opts.dxgi ? 'dxgi.dll' : 'winmm.dll',
      files: [], // { dest, backedUp: bool, backupPath: string|null }
    };

    const copiedFiles = [];

    const installFile = (srcPath, destName, label) => {
      const destPath = path.join(dest, destName);
      let backedUp = false;
      let backupPath = null;

      // Back up any pre-existing file before overwriting
      if (fs.existsSync(destPath)) {
        backupPath = path.join(backupDir, destName);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(destPath, backupPath);
        backedUp = true;
        send(`Backed up: ${destName}`, 'info');
      }

      copyToGame(srcPath, destPath);
      send(`Installed: ${label || destName}`, 'ok');
      copiedFiles.push(destName);
      manifest.files.push({ dest: destName, backedUp, backupPath });
    };

    // Main hook DLL — OptiScaler.dll must be renamed to the hook target
    const hookName = opts.dxgi ? 'dxgi.dll' : 'winmm.dll';
    const optiDll = findFile(extractDir, 'OptiScaler.dll')
      || findFile(extractDir, hookName)
      || findFile(extractDir, 'dxgi.dll');

    if (!optiDll) {
      return { success: false, error: 'Could not find OptiScaler.dll in the archive. The release structure may have changed.' };
    }

    progress(58);
    installFile(optiDll, hookName, `OptiScaler.dll → ${hookName}`);

    // Core runtime DLLs bundled in the archive
    const coreDeps = [
      'amd_fidelityfx_dx12.dll', 'amd_fidelityfx_vk.dll',
      'libxess.dll', 'libxess_dx11.dll',
    ];

    for (const dep of coreDeps) {
      const src = findFile(extractDir, dep);
      if (src) installFile(src, dep);
    }
    progress(72);

    if (opts.fakenvapi) {
      const src = findFile(extractDir, 'nvapi64.dll');
      if (src) {
        installFile(src, 'nvapi64.dll', 'nvapi64.dll (FakeNvapi)');
      } else {
        send('nvapi64.dll not found in archive — FakeNvapi needs manual install from github.com/FakeMichau/fakenvapi', 'warn');
      }
    }

    if (opts.nukem) {
      for (const n of ['dlssg_to_fsr3.dll', 'dlssg-to-fsr3.dll', 'nvngx_dlssg.dll']) {
        const src = findFile(extractDir, n);
        if (src) {
          installFile(src, path.basename(src), `${path.basename(src)} (Nukem FG)`);
          break;
        }
      }
    }
    progress(88);

    if (opts.ini) {
      const iniPath = path.join(dest, 'OptiScaler.ini');
      // Back up existing ini if present
      if (fs.existsSync(iniPath)) {
        const bp = path.join(backupDir, 'OptiScaler.ini');
        fs.copyFileSync(iniPath, bp);
        send('Backed up: OptiScaler.ini', 'info');
        manifest.files.push({ dest: 'OptiScaler.ini', backedUp: true, backupPath: bp });
      } else {
        manifest.files.push({ dest: 'OptiScaler.ini', backedUp: false, backupPath: null });
      }
      fs.writeFileSync(iniPath, generateIni(opts), 'utf8');
      send('Generated: OptiScaler.ini', 'ok');
      copiedFiles.push('OptiScaler.ini');
    }

    // Write manifest so the uninstaller knows exactly what to undo
    fs.writeFileSync(path.join(dest, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
    send('Written: optiscaler_manifest.json', 'info');

    progress(100);
    return { success: true, files: copiedFiles, manifest };

  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── IPC: uninstall ───────────────────────────────────────────────────────────
ipcMain.handle('uninstall', async (_event, dirPath) => {
  const send = (msg, type = 'info') => mainWindow.webContents.send('uninstall-log', { msg, type });

  const manifestPath = findManifest(dirPath);
  if (!manifestPath) {
    return { success: false, error: 'No OptiScaler installation manifest found in this folder or its subfolders.\nMake sure you selected the game\'s root installation folder.' };
  }

  const installDir = path.dirname(manifestPath);
  if (installDir !== dirPath) {
    send(`Found installation in: ${installDir}`, 'info');
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { success: false, error: 'Manifest file is corrupted and cannot be read.' };
  }

  const backupDir = path.join(installDir, BACKUP_DIR_NAME);
  const removed = [];
  const restored = [];

  for (const entry of manifest.files) {
    const destPath = path.join(installDir, entry.dest);

    if (entry.backedUp && entry.backupPath && fs.existsSync(entry.backupPath)) {
      // Restore the original file from backup
      try {
        fs.copyFileSync(entry.backupPath, destPath);
        send(`Restored: ${entry.dest}`, 'ok');
        restored.push(entry.dest);
      } catch (e) {
        send(`Failed to restore ${entry.dest}: ${e.message}`, 'err');
      }
    } else {
      // No backup — just delete the installed file
      try {
        if (fs.existsSync(destPath)) {
          fs.rmSync(destPath);
          send(`Removed: ${entry.dest}`, 'ok');
          removed.push(entry.dest);
        }
      } catch (e) {
        send(`Failed to remove ${entry.dest}: ${e.message}`, 'err');
      }
    }
  }

  // Clean up backup folder and manifest
  try {
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    fs.rmSync(manifestPath);
    send('Removed: backup folder and manifest', 'info');
  } catch (e) {
    send(`Cleanup warning: ${e.message}`, 'warn');
  }

  return {
    success: true,
    removed,
    restored,
    installedVersion: manifest.version,
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findFile(baseDir, filename) {
  const lower = filename.toLowerCase();
  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      const full = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        const found = findFile(full, filename);
        if (found) return found;
      } else if (entry.name.toLowerCase() === lower) {
        return full;
      }
    }
  } catch {}
  return null;
}

function copyToGame(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let downloaded = 0;

    function get(u) {
      https.get(u, { headers: { 'User-Agent': 'optiscaler-installer/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location);
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.on('data', chunk => { downloaded += chunk.length; if (onProgress) onProgress(downloaded); });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    }
    get(url);
  });
}

function extractArchive(archivePath, destDir, is7z) {
  return new Promise((resolve, reject) => {
    if (is7z) {
      const bin = findBinary(['7z', '7za', '7zr']);
      if (!bin) {
        return reject(new Error(
          '7-Zip not found.\n' +
          '  Windows: https://www.7-zip.org — install and ensure 7z.exe is in PATH\n' +
          '  Linux:   sudo apt install p7zip-full\n' +
          'Then retry.'
        ));
      }
      execFile(bin, ['x', archivePath, `-o${destDir}`, '-y'], { timeout: 120000 }, err => {
        if (err) reject(new Error(`7-Zip failed: ${err.message}`)); else resolve();
      });
    } else {
      if (process.platform === 'win32') {
        execFile('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -Force -Path "${archivePath}" -DestinationPath "${destDir}"`
        ], { timeout: 60000 }, err => { if (err) reject(err); else resolve(); });
      } else {
        execFile('unzip', ['-o', archivePath, '-d', destDir], { timeout: 60000 }, err => {
          if (err) reject(err); else resolve();
        });
      }
    }
  });
}

function findBinary(names) {
  for (const name of names) {
    try {
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
      const result = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (result) return result.split('\n')[0].trim();
    } catch {}
  }
  return null;
}

function formatBytes(bytes) {
  if (!bytes) return '?';
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function generateIni(opts) {
  const dxgiVal    = opts.dxgi      ? 'true' : 'false';
  const vulkanVal  = opts.vulkan    ? 'true' : 'false';
  const nvapiVal   = opts.fakenvapi ? 'true' : 'false';

  let dx12Backend = 'xess', dx11Backend = 'fsr22';
  if      (opts.gpuVendor === 'nvidia') { dx12Backend = 'dlss'; dx11Backend = 'dlss'; }
  else if (opts.gpuVendor === 'amd')    { dx12Backend = opts.gpu === 'amd-rdna4' ? 'fsr31' : 'fsr22'; dx11Backend = 'fsr22'; }
  else if (opts.gpuVendor === 'intel')  { dx12Backend = 'xess'; dx11Backend = 'xess'; }

  const keyToVK = {
    'INSERT':'0x2D','HOME':'0x24','END':'0x23','DELETE':'0x2E',
    'PRIOR':'0x21','NEXT':'0x22','PAUSE':'0x13',
    'F1':'0x70','F2':'0x71','F3':'0x72','F4':'0x73','F5':'0x74','F6':'0x75',
    'F7':'0x76','F8':'0x77','F9':'0x78','F10':'0x79','F11':'0x7A','F12':'0x7B',
  };
  const shortcutKey = opts.shortcutKey || 'INSERT';
  const shortcutVK  = keyToVK[shortcutKey] || keyToVK['INSERT'];

  return `; OptiScaler.ini — generated by OptiScaler Installer
; GPU: ${opts.gpu} | Hook DLL: ${opts.dxgi ? 'dxgi.dll' : 'winmm.dll'}
; Open the overlay in-game with: ${shortcutKey}

[Upscalers]
Dx12Upscaler=${dx12Backend}
Dx11Upscaler=${dx11Backend}
VulkanUpscaler=fsr21

[Spoofing]
Dxgi=${dxgiVal}
Vulkan=${vulkanVal}

[Nvapi]
OverrideNvapiDll=${nvapiVal}

[Log]
LoggingEnabled=true
LogLevel=2
LogToFile=false
LogToConsole=false
OpenConsole=false

[Menu]
Scale=1.0
ShortcutKey=${shortcutVK}

[Sharpness]
OverrideSharpness=false
Sharpness=0.3

[Hotfix]
AutoExposure=auto
DisableReactiveMask=true
`;
}
