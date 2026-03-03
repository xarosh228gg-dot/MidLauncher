const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const fsPromises = require('fs').promises;

const cp = require('child_process');
const { spawn } = cp;

const { Client, Authenticator } = require('minecraft-launcher-core');
const AdmZip = require('adm-zip');
const os = require('os');
const crypto = require('crypto');

let mainWindow;
let minecraftProcess;
let launchCancelled = false;

// ── Writable user data dir → AppData/Roaming/.midlauncher ──
const _ROAMING = process.platform === 'win32'
  ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  : (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
const USER_DATA = path.join(_ROAMING, '.midlauncher');
if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });

// IMPORTANT: must be called before app is ready so Electron stores
// localStorage, IndexedDB, session data etc. in .midlauncher too
app.setPath('userData', USER_DATA);

const CONFIG_PATH         = path.join(USER_DATA, 'launcher-config.json');
const MANIFEST_CACHE_PATH = path.join(USER_DATA, 'manifest-cache.json');

// ── On first launch: copy default files from resources into userData ──
;(function seedUserData() {
  const names = ['launcher-config.json', 'manifest-cache.json'];
  names.forEach(name => {
    const dest = path.join(USER_DATA, name);
    if (fs.existsSync(dest)) return;
    const candidates = [
      path.join(process.resourcesPath, name),   // installed: next to app.asar
      path.join(__dirname, name),               // dev: project root
    ];
    for (const src of candidates) {
      try { if (fs.existsSync(src)) { fs.mkdirSync(USER_DATA, { recursive: true }); fs.copyFileSync(src, dest); return; } } catch {}
    }
  });
})();
const MANIFEST_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── In-memory config cache (avoid re-reading disk on every saveConfig) ──
let _configCache = null;

function createWindow() {
  const savedSettings = (() => { try { return readConfig().settings || {}; } catch { return {}; } })();
  const w = savedSettings.windowWidth  || 925;
  const h = savedSettings.windowHeight || 530;
  mainWindow = new BrowserWindow({
    width: w, height: h,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.loadFile('index.html');

  // DevTools enabled for debugging
}

// ── Deep link: midlauncher:// ─────────────────────────────────────────────────
// Регистрируем протокол midlauncher:// для автовхода после подтверждения email
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('midlauncher', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('midlauncher');
}

function handleDeepLink(url) {
  if (!url || !mainWindow) return;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'verify') {
      const token = parsed.searchParams.get('token');
      if (token) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('deeplink-verify', token);
      }
    }
  } catch(e) { console.error('[deeplink]', e.message); }
}

// Windows/Linux: второй экземпляр передаёт аргументы первому
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_, argv) => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    const url = argv.find(a => a.startsWith('midlauncher://'));
    if (url) handleDeepLink(url);
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// macOS: открытие по URL
app.on('open-url', (event, url) => { event.preventDefault(); handleDeepLink(url); });

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════
const CUSTOM_VERSIONS_DIR = path.join(USER_DATA, 'custom-versions');
const MODPACKS_DIR        = path.join(USER_DATA, 'modpacks');

function sanitizeName(name) {
  return name.replace(/[^\w\u0400-\u04FF\s\-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'unnamed';
}

function saveNamedFiles(items, dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Build set of current valid filenames
    const validFiles = new Set();
    items.forEach(item => {
      const fname = sanitizeName(item.name) + '.json';
      validFiles.add(fname);
      fs.writeFileSync(path.join(dir, fname), JSON.stringify(item, null, 2));
    });
    // Remove deleted ones
    fs.readdirSync(dir).forEach(f => {
      if (f.endsWith('.json') && !validFiles.has(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    });
  } catch {}
}

function readConfig() {
  if (_configCache) return _configCache;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return _configCache;
    }
  } catch {}
  _configCache = { last: null, customVersions: [] };
  return _configCache;
}

function writeConfig(data) {
  _configCache = data;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2)); } catch {}
}

ipcMain.handle('get-config', () => readConfig());

ipcMain.handle('save-config', (_, data) => {
  const cfg = readConfig();
  if (data.last !== undefined)           cfg.last           = data.last;
  if (data.customVersions !== undefined) { cfg.customVersions = data.customVersions; saveNamedFiles(data.customVersions, CUSTOM_VERSIONS_DIR); }
  if (data.account !== undefined)        cfg.account        = data.account;
  if (data.accounts !== undefined)       cfg.accounts       = data.accounts;
  if (data.modpacks !== undefined)       { cfg.modpacks = data.modpacks; saveNamedFiles(data.modpacks, MODPACKS_DIR); }
  if (data.settings !== undefined) {
    cfg.settings = data.settings;
    // Apply window size immediately
    if (mainWindow && !mainWindow.isDestroyed()) {
      const w = data.settings.windowWidth  || 925;
      const h = data.settings.windowHeight || 530;
      mainWindow.setSize(Math.max(400, w), Math.max(300, h));
    }
  }
  writeConfig(cfg);
  return true;
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-java', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите java.exe или javaw.exe',
    filters: [{ name: 'Java', extensions: ['exe', ''] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ═══════════════════════════════════════════════════
// MANIFEST CACHE (disk, 1hr TTL)
// ═══════════════════════════════════════════════════
ipcMain.handle('get-manifest', async () => {
  try {
    // Check disk cache
    if (fs.existsSync(MANIFEST_CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(MANIFEST_CACHE_PATH, 'utf-8'));
      if (raw._ts && Date.now() - raw._ts < MANIFEST_TTL_MS) {
        return raw;
      }
    }
  } catch {}
  // Fetch fresh
  const data = await fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  // Slim: only keep id, type, releaseTime to save RAM
  const slim = {
    _ts: Date.now(),
    versions: data.versions.map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })),
  };
  try { fs.writeFileSync(MANIFEST_CACHE_PATH, JSON.stringify(slim)); } catch {}
  return slim;
});

// ═══════════════════════════════════════════════════
// MS TOKEN REFRESH
// ═══════════════════════════════════════════════════
ipcMain.handle('refresh-ms-token', async (_, { refreshToken }) => {
  if (!refreshToken) return { error: 'no refresh token' };
  const CLIENT_ID = '00000000402b5328';
  const REDIRECT  = 'https://login.live.com/oauth20_desktop.srf';
  try {
    const msToken = await postForm('login.live.com', '/oauth20_token.srf', {
      client_id:     CLIENT_ID,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      redirect_uri:  REDIRECT,
      scope:         'XboxLive.signin offline_access',
    });
    if (msToken.error) return { error: msToken.error_description || msToken.error };
    return { accessToken: msToken.access_token, refreshToken: msToken.refresh_token };
  } catch(e) {
    return { error: e.message };
  }
});

// ═══════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'MyLauncher/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(fetchJSON(res.headers.location));
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const get = u => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'MyLauncher/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return get(res.headers.location);
        const total = parseInt(res.headers['content-length'] || '0');
        let dl = 0;
        res.on('data', chunk => { dl += chunk.length; if (onProgress && total) onProgress(dl, total); });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        res.on('error', err => { try { fs.unlinkSync(dest); } catch {} reject(err); });
      }).on('error', err => { try { fs.unlinkSync(dest); } catch {} reject(err); });
    };
    get(url);
  });
}

function runInstaller(jarPath, mcRoot, sendStatus) {
  return new Promise((resolve, reject) => {
    sendStatus('Запуск инсталлятора...');
    const proc = spawn('java', ['-Djava.awt.headless=true', '-jar', jarPath, '--installClient'], { cwd: mcRoot });
    proc.stdout.on('data', d => sendStatus('[installer] ' + d.toString().trim()));
    proc.stderr.on('data', d => sendStatus('[installer] ' + d.toString().trim()));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('Инсталлятор: код ' + code)));
    proc.on('error', reject);
  });
}

async function findInstalledVersion(mcRoot, prefix) {
  try {
    const e = await fsPromises.readdir(path.join(mcRoot, 'versions'));
    return e.filter(x => x.startsWith(prefix)).sort().reverse()[0] || null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════
// MODLOADER INSTALLERS
// ═══════════════════════════════════════════════════
async function installFabric(mcVersion, loaderVersion, mcRoot, sendStatus, sendProgress) {
  const META = 'https://meta.fabricmc.net/v2';
  let lv = loaderVersion;
  if (!lv) {
    const d = await fetchJSON(META + '/versions/loader/' + mcVersion);
    if (!d?.length) throw new Error('Fabric не поддерживает MC ' + mcVersion);
    lv = d[0].loader.version;
  }
  const vid = 'fabric-loader-' + lv + '-' + mcVersion;
  const jp  = path.join(mcRoot, 'versions', vid, vid + '.json');
  if (fs.existsSync(jp)) { sendStatus('Fabric уже установлен: ' + vid); return vid; }
  sendStatus('Установка Fabric ' + lv + '...');
  sendProgress(25);
  const profile = await fetchJSON(META + '/versions/loader/' + mcVersion + '/' + lv + '/profile/json');
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  fs.writeFileSync(jp, JSON.stringify(profile, null, 2));
  sendProgress(35);
  return vid;
}

async function installQuilt(mcVersion, loaderVersion, mcRoot, sendStatus, sendProgress) {
  const META = 'https://meta.quiltmc.org/v3';
  let lv = loaderVersion;
  if (!lv) {
    const d = await fetchJSON(META + '/versions/loader/' + mcVersion);
    if (!d?.length) throw new Error('Quilt не поддерживает MC ' + mcVersion);
    lv = d[0].loader.version;
  }
  const vid = 'quilt-loader-' + lv + '-' + mcVersion;
  const jp  = path.join(mcRoot, 'versions', vid, vid + '.json');
  if (fs.existsSync(jp)) { sendStatus('Quilt уже установлен: ' + vid); return vid; }
  sendStatus('Установка Quilt ' + lv + '...');
  sendProgress(25);
  const profile = await fetchJSON(META + '/versions/loader/' + mcVersion + '/' + lv + '/profile/json');
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  fs.writeFileSync(jp, JSON.stringify(profile, null, 2));
  sendProgress(35);
  return vid;
}

async function installNeoForge(mcVersion, loaderVersion, mcRoot, sendStatus, sendProgress) {
  sendStatus('Получение версий NeoForge...');
  const parts = mcVersion.split('.');
  const prefix = parts.length >= 3 ? parts[1] + '.' + parts[2] + '.' : parts[1] + '.';
  let nfv = loaderVersion;
  if (!nfv) {
    let versions = [];
    try {
      const d = await fetchJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
      versions = (d.versions||[]).filter(v => v.startsWith(prefix) && !v.includes('beta') && !v.includes('alpha'))
        .sort((a,b) => b.localeCompare(a, undefined, { numeric:true }));
    } catch {}
    if (!versions.length) {
      const xml = await new Promise((res, rej) => {
        https.get('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
          { headers:{ 'User-Agent':'MyLauncher/1.0' } }, r => {
            let d=''; r.on('data', c=>d+=c); r.on('end', ()=>res(d));
          }).on('error', rej);
      });
      const m = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(x=>x[1]);
      versions = m.filter(v => v.startsWith(prefix) && !v.includes('beta') && !v.includes('alpha'))
        .sort((a,b) => b.localeCompare(a, undefined, { numeric:true }));
    }
    if (!versions.length) throw new Error('NeoForge не найден для MC ' + mcVersion);
    nfv = versions[0];
  }
  const existing = await findInstalledVersion(mcRoot, 'neoforge-' + nfv);
  if (existing) { sendStatus('NeoForge уже установлен: ' + existing); return existing; }
  const installerUrl  = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/' + nfv + '/neoforge-' + nfv + '-installer.jar';
  const installerPath = path.join(mcRoot, 'neoforge-installer.jar');
  sendStatus('Скачивание NeoForge ' + nfv + '...');
  sendProgress(20);
  await downloadFile(installerUrl, installerPath, (d,t) => sendProgress(20 + Math.round((d/t)*15)));
  sendProgress(35);
  await runInstaller(installerPath, mcRoot, sendStatus);
  try { fs.unlinkSync(installerPath); } catch {}
  const installed = await findInstalledVersion(mcRoot, 'neoforge-');
  if (!installed) throw new Error('NeoForge установлен, но версия не найдена');
  sendProgress(50);
  return installed;
}

async function installForge(mcVersion, loaderVersion, mcRoot, sendStatus, sendProgress) {
  sendStatus('Получение версий Forge...');
  const promos = await fetchJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  let fv = loaderVersion;
  if (!fv) {
    fv = promos.promos[mcVersion + '-recommended'] || promos.promos[mcVersion + '-latest'];
    if (!fv) throw new Error('Forge не найден для MC ' + mcVersion);
  }
  const fullId   = mcVersion + '-' + fv;
  const existing = await findInstalledVersion(mcRoot, mcVersion + '-forge');
  if (existing) { sendStatus('Forge уже установлен: ' + existing); return existing; }
  const installerUrl  = 'https://maven.minecraftforge.net/net/minecraftforge/forge/' + fullId + '/forge-' + fullId + '-installer.jar';
  const installerPath = path.join(mcRoot, 'forge-installer.jar');
  sendStatus('Скачивание Forge ' + fv + '...');
  sendProgress(20);
  await downloadFile(installerUrl, installerPath, (d,t) => sendProgress(20 + Math.round((d/t)*15)));
  sendProgress(35);
  await runInstaller(installerPath, mcRoot, sendStatus);
  try { fs.unlinkSync(installerPath); } catch {}
  const installed = await findInstalledVersion(mcRoot, mcVersion + '-forge');
  if (!installed) throw new Error('Forge установлен, но версия не найдена');
  sendProgress(50);
  return installed;
}

// ═══════════════════════════════════════════════════
// IPC: LAUNCH
// ═══════════════════════════════════════════════════
ipcMain.on('cancel-launch', () => {
  launchCancelled = true;
  if (minecraftProcess) { minecraftProcess.kill(); minecraftProcess = null; }
});

ipcMain.on('launch-minecraft', async (event, payload) => {
  launchCancelled = false;
  const { version: mcVersion, loader = 'vanilla', loaderVersion = null, versionType = 'release', account = null } = payload;
  const send    = (ch, v) => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send(ch, v); };
  const sendStatus   = msg  => send('status', msg);
  const sendProgress = perc => send('progress', perc);
  const cfg = readConfig();
  const settings = cfg.settings || {};
  const mcRoot = settings.gameDir ? path.join(settings.gameDir, 'minecraft') : path.join(USER_DATA, 'minecraft');

  const checkCancelled = () => {
    if (launchCancelled) throw new Error('__CANCELLED__');
  };

  try {
    sendStatus('▶ MC ' + mcVersion + '  |  ' + loader);
    sendProgress(5);
    await fsPromises.mkdir(mcRoot, { recursive: true });

    // Auto-refresh Microsoft token before launch
    if (account && account.type === 'ms' && account.refreshToken) {
      try {
        const refreshed = await postForm('login.live.com', '/oauth20_token.srf', {
          client_id:     '00000000402b5328',
          grant_type:    'refresh_token',
          refresh_token: account.refreshToken,
          redirect_uri:  'https://login.live.com/oauth20_desktop.srf',
          scope:         'XboxLive.signin offline_access',
        });
        if (refreshed.access_token) {
          account.accessToken  = refreshed.access_token;
          if (refreshed.refresh_token) account.refreshToken = refreshed.refresh_token;
          // Persist updated tokens
          const cfg2 = readConfig();
          if (cfg2.account?.username === account.username) cfg2.account = account;
          if (cfg2.accounts) cfg2.accounts = cfg2.accounts.map(a => a.username === account.username ? account : a);
          writeConfig(cfg2);
          send('account-updated', account);
          sendStatus('✓ Microsoft токен обновлён');
        }
      } catch(e) { sendStatus('⚠ Не удалось обновить токен: ' + e.message); }
    }

    checkCancelled();
    let customVersionId;
    if (loader === 'fabric')   customVersionId = await installFabric(mcVersion, loaderVersion, mcRoot, sendStatus, sendProgress);
    checkCancelled();
    if (loader === 'quilt')    customVersionId = await installQuilt(mcVersion, loaderVersion, mcRoot, sendStatus, sendProgress);
    checkCancelled();
    if (loader === 'neoforge') customVersionId = await installNeoForge(mcVersion, loaderVersion, mcRoot, sendStatus, sendProgress);
    checkCancelled();
    if (loader === 'forge')    customVersionId = await installForge(mcVersion, loaderVersion, mcRoot, sendStatus, sendProgress);
    checkCancelled();

    // Detect if MC version jar already exists → show "Запуск" instead of "Скачивание"
    const versionJar = path.join(mcRoot, 'versions', mcVersion, mcVersion + '.jar');
    const alreadyDownloaded = fs.existsSync(versionJar);
    send('mode', alreadyDownloaded ? 'launch' : 'download');

    const launcher = new Client();

    // Java path from settings
    const javaPath = settings.javaType === 'custom' && settings.javaPath ? settings.javaPath : null;

    // Build authorization object
    let authorization;
    if (account && account.type === 'elyby' && account.accessToken) {
      authorization = {
        access_token:    account.accessToken,
        client_token:    account.uuid || 'midlauncher',
        uuid:            account.uuid || account.accessToken.substring(0, 32),
        name:            account.username,
        user_properties: '{}',
        user_type:       'mojang',
        meta: { type: 'mojang' },
      };
    } else if (account && account.type === 'ms' && account.accessToken) {
      authorization = {
        access_token:    account.accessToken,
        client_token:    account.uuid || 'midlauncher',
        uuid:            account.uuid,
        name:            account.username,
        user_properties: '{}',
      };
    } else if (account && account.type === 'local') {
      authorization = Authenticator.getAuth(account.username);
    } else {
      authorization = Authenticator.getAuth('Player');
    }

    // Ely.by authlib-injector JVM args for server auth + skin
    const jvmArgs = [];
    if (account && account.type === 'elyby') {
      const injectorPath = (() => {
    const candidates = [
      path.join(process.resourcesPath, 'authlib-injector.jar'),
      path.join(__dirname, 'authlib-injector.jar'),
    ];
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    return path.join(process.resourcesPath, 'authlib-injector.jar');
  })();
      if (!fs.existsSync(injectorPath)) {
        sendStatus('⬇ Скачивание authlib-injector.jar...');
        try {
          const relData = await fetchJSON('https://api.github.com/repos/yushijinhun/authlib-injector/releases/latest');
          const asset = (relData.assets || []).find(a => a.name && a.name.endsWith('.jar') && !a.name.includes('sources'));
          if (asset) {
            await downloadFile(asset.browser_download_url, injectorPath);
            sendStatus('✓ authlib-injector.jar скачан');
          } else {
            sendStatus('⚠ Не удалось найти authlib-injector.jar в релизах');
          }
        } catch(e) {
          sendStatus('⚠ Ошибка скачивания authlib-injector: ' + e.message);
        }
      }
      if (fs.existsSync(injectorPath)) {
        jvmArgs.push('-javaagent:' + injectorPath + '=ely.by');  // official Ely.by shorthand
        jvmArgs.push('-Dauthlibinjector.side=client');
        sendStatus('✓ authlib-injector подключён: ' + injectorPath);
        sendStatus('[debug] JVM arg: -javaagent:' + injectorPath + '=ely.by');
      }
    }

    const instanceName = payload.instanceName || mcVersion;
    const safeName = instanceName.replace(/[\/\\:*?"<>|]/g, '_').trim() || 'default';
    const gameDir = path.join(mcRoot, 'versions', safeName);
    if (!fs.existsSync(gameDir)) {
      fs.mkdirSync(gameDir, { recursive: true });
      for (const sub of ['mods','saves','screenshots','resourcepacks','shaderpacks','config'])
        fs.mkdirSync(path.join(gameDir, sub), { recursive: true });
    }
    const opts = {
      authorization,
      root: mcRoot,
      version: { number: mcVersion, type: versionType, custom: customVersionId },
      memory: {
        max: String(settings.memoryMb || 4096),
        min: String(Math.max(512, Math.round((settings.memoryMb || 4096) / 4))),
      },
      overrides: {
        gameDirectory: gameDir,
        detached: false,
        windowsHide: !(settings.showConsole),
        ...(javaPath ? { exec: javaPath } : {}),
      },
    };
    let lastSent = 50;
    let gameActuallyLaunched = false;
    launcher.on('download-status', s => {
      if (gameActuallyLaunched) return;
      checkCancelled();
      if (s.total > 0) {
        sendStatus('⬇ ' + s.name + ' [' + s.current + '/' + s.total + ']');
        const pct = Math.round(50 + (s.current / s.total) * 40);
        if (pct > lastSent) { lastSent = pct; sendProgress(Math.min(pct, 90)); }
      }
    });
    launcher.on('download', f => { if (!gameActuallyLaunched) sendStatus('✓ ' + f); });
    launcher.on('debug',    m => sendStatus('[debug] ' + m));
    // Track whether we've already hidden/closed on first game output
    let windowActionDone = false;
    launcher.on('data', m => {
      sendStatus('[game] ' + m);
      if (m.includes('Done') || m.includes('Loaded')) sendProgress(100);
      // Hide/close launcher on first game output — game window is open by now
      if (!windowActionDone && mainWindow && !mainWindow.isDestroyed()) {
        windowActionDone = true;
        if (settings.hideOnLaunch === 'hide') {
          mainWindow.hide();
        } else if (settings.hideOnLaunch === 'close') {
          // Small delay so renderer receives 'Игра запущена!' before window closes
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
          }, 800);
        }
      }
    });
    launcher.on('close',    c => {
      sendStatus('Игра закрыта (код ' + c + ')');
      sendProgress(100);
      minecraftProcess = null;
      windowActionDone = false;
      // Show window again if it was hidden (no-op if it was closed)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    // Inject authlib-injector into Java spawn args via cp.spawn patch
    const _savedSpawn = cp.spawn;
    if (jvmArgs.length) {
      cp.spawn = function(cmd, args, spawnOpts) {
        if (typeof cmd === 'string' && /java(w)?(\.exe)?$/i.test(cmd)) {
          args = [...jvmArgs, ...args];
          sendStatus('[debug] Injected JVM args: ' + jvmArgs.join(' '));
        }
        return _savedSpawn.call(this, cmd, args, spawnOpts || {});
      };
    }
    sendStatus('Подготовка файлов...');
    sendProgress(50);
    minecraftProcess = await launcher.launch(opts);
    // Restore original spawn after launch
    cp.spawn = _savedSpawn;
    gameActuallyLaunched = true;
    checkCancelled();
    sendStatus('Игра запущена!');
    sendProgress(100);
    // Window hide/close is handled in launcher.on('data') — when game actually outputs first line
  } catch(err) {
    if (err.message === '__CANCELLED__') {
      if (minecraftProcess) { minecraftProcess.kill(); minecraftProcess = null; }
      sendStatus('Отменено');
      send('cancelled', true);
    } else {
      console.error(err);
      sendStatus('ОШИБКА: ' + err.message);
      sendProgress(100);
    }
  }
});

ipcMain.on('kill-process', () => {
  if (minecraftProcess) {
    const pid = minecraftProcess.pid;
    try {
      if (process.platform === 'win32') {
        // taskkill gracefully closes the window → Minecraft saves world before exit
        cp.exec('taskkill /PID ' + pid + ' /T');
        // fallback: force kill after 5 seconds if still running
        setTimeout(() => {
          try { cp.exec('taskkill /PID ' + pid + ' /T /F'); } catch {}
        }, 5000);
      } else {
        minecraftProcess.kill('SIGTERM');
      }
    } catch {}
    minecraftProcess = null;
  }
});

// ═══════════════════════════════════════════════════
// ELY.BY OAUTH
// ═══════════════════════════════════════════════════
// Ely.by OAuth2 PKCE flow:
// 1. Open browser with authorization URL
// 2. Local HTTP server catches redirect with code
// 3. Exchange code for access_token
// 4. Fetch profile (username, uuid)

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

ipcMain.handle('elyby-oauth', async () => {
  const CLIENT_ID     = 'elymidlauncher';
  const CLIENT_SECRET = 'NyEUyk0JsA6ekhkS79XeO_wog1yUKjYZ0OL3IREohD14rzjuONQwalHvTErOqYRC';
  const REDIRECT_URI  = 'http://localhost:9876/';
  const state         = base64url(crypto.randomBytes(16));

  const authUrl = 'https://account.ely.by/oauth2/v1' +
    '?client_id='    + CLIENT_ID +
    '&response_type=code' +
    '&scope=account_info+minecraft_server_session' +
    '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
    '&state='        + state +
    '&prompt=select_account';

  console.log('[ElyBy OAuth] Opening:', authUrl);

  return new Promise((resolve) => {
    let resolved = false;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:9876');

      // Ignore favicon and other noise
      if (!url.searchParams.get('code') && !url.searchParams.get('error')) {
        res.writeHead(200); res.end(); return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#0f0f11;color:#d0d0d8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center"><div style="font-size:32px;margin-bottom:16px">✓</div>
        <div style="font-size:18px;font-weight:600">Авторизация успешна!</div>
        <div style="color:#606070;margin-top:8px;font-size:13px">Можно закрыть это окно</div></div></body></html>`);

      if (resolved) return;
      resolved = true;
      server.close();

      const code  = url.searchParams.get('code');
      const scode = url.searchParams.get('state');
      console.log('[ElyBy OAuth] code:', code, '| state match:', scode === state, '| expected:', state, '| got:', scode);
      if (!code || scode !== state) { resolve({ error: 'Неверный state или нет кода' }); return; }

      try {
        const tokenData = await new Promise((res2, rej2) => {
          const body = new URLSearchParams({
            client_id:     CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type:    'authorization_code',
            code,
            redirect_uri:  REDIRECT_URI,
          }).toString();
          const req2 = https.request({
            hostname: 'account.ely.by',
            path:     '/api/oauth2/v1/token',
            method:   'POST',
            headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
          }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res2(JSON.parse(d))}catch(e){rej2(e)} }); });
          req2.on('error', rej2);
          req2.write(body); req2.end();
        });

        console.log('[ElyBy OAuth] token response:', JSON.stringify(tokenData));
        if (tokenData.error) { resolve({ error: tokenData.error_description || tokenData.error }); return; }

        // Fetch profile
        const profile = await new Promise((res3, rej3) => {
          https.get({
            hostname: 'account.ely.by',
            path:     '/api/account/v1/info',
            headers:  { 'Authorization': 'Bearer ' + tokenData.access_token, 'User-Agent': 'MidLauncher/1.0' }
          }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res3(JSON.parse(d))}catch(e){rej3(e)} }); }).on('error', rej3);
        });

        // Fetch proper Minecraft UUID from Ely.by authlib-injector API
        let minecraftUuid = null;
        try {
          const uname = profile.username || profile.name;
          const uuidData = await fetchJSON('https://account.ely.by/api/authlib-injector/api/users/profiles/minecraft/' + encodeURIComponent(uname));
          if (uuidData && uuidData.id) {
            // Format as UUID with dashes: 32hex -> 8-4-4-4-12
            const raw = uuidData.id.replace(/-/g, '');
            minecraftUuid = raw.slice(0,8)+'-'+raw.slice(8,12)+'-'+raw.slice(12,16)+'-'+raw.slice(16,20)+'-'+raw.slice(20);
          }
        } catch(e) { /* fallback below */ }

        resolve({
          username:    profile.username || profile.name,
          uuid:        minecraftUuid || profile.uuid || null,
          accessToken: tokenData.access_token,
        });
      } catch(e) {
        resolve({ error: 'Ошибка авторизации: ' + e.message });
      }
    });

    server.listen(9876, '127.0.0.1', () => {
      shell.openExternal(authUrl);
    });

    server.on('error', () => resolve({ error: 'Порт 9876 занят' }));

    setTimeout(() => {
      try { server.close(); } catch {}
      resolve({ error: 'Время ожидания истекло' });
    }, 5 * 60 * 1000);
  });
});


// ═══════════════════════════════════════════════════
// MICROSOFT OAUTH
// ═══════════════════════════════════════════════════
// Flow: Microsoft OAuth2 → XBL → XSTS → Minecraft API

function postJson(hostname, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders
      }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('JSON parse: ' + d.slice(0,200))); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postForm(hostname, urlPath, params) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(params).toString();
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      }
    }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const loc = new URL(r.headers.location);
        return resolve(postForm(loc.hostname, loc.pathname + loc.search, params));
      }
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('JSON parse: ' + d.slice(0,200))); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

ipcMain.handle('ms-oauth', async () => {

  // Public client ID for Xbox Live / Minecraft (used by many open-source launchers)
  const CLIENT_ID = '00000000402b5328';
  const REDIRECT  = 'https://login.live.com/oauth20_desktop.srf';
  const SCOPE     = 'XboxLive.signin offline_access';
  const state     = base64url(crypto.randomBytes(16));

  const authUrl = 'https://login.live.com/oauth20_authorize.srf' +
    '?client_id='    + CLIENT_ID +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(REDIRECT) +
    '&scope='        + encodeURIComponent(SCOPE) +
    '&state='        + state +
    '&prompt=select_account';

  console.log('[MS OAuth] Opening auth window');

  return new Promise((resolve) => {
    let resolved = false;

    const win = new BrowserWindow({
      width: 500, height: 680,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      title: 'Вход через Microsoft',
      show: false,
      parent: mainWindow,
      modal: true,
    });

    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { if (!resolved) { resolved = true; resolve({ error: 'Окно закрыто' }); } });

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      try { win.close(); } catch {}
      resolve(result);
    };

    const handleRedirect = async (url) => {
      if (!url.startsWith('https://login.live.com/oauth20_desktop.srf')) return false;
      const parsed = new URL(url);
      const code   = parsed.searchParams.get('code');
      const scode  = parsed.searchParams.get('state');
      if (!code) { done({ error: 'Код авторизации не получен' }); return true; }
      if (scode !== state) { done({ error: 'Неверный state' }); return true; }

      try {
        // Step 1: MS access token
        const msToken = await postForm('login.live.com', '/oauth20_token.srf', {
          client_id:    CLIENT_ID,
          code,
          grant_type:   'authorization_code',
          redirect_uri: REDIRECT,
          scope:        SCOPE,
        });
        if (msToken.error) { done({ error: msToken.error_description || msToken.error }); return true; }

        // Step 2: Xbox Live
        const xblResp = await postJson('user.auth.xboxlive.com', '/user/authenticate', {
          Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msToken.access_token },
          RelyingParty: 'http://auth.xboxlive.com',
          TokenType: 'JWT',
        });
        const xblToken = xblResp.Token;
        const userHash = xblResp.DisplayClaims?.xui?.[0]?.uhs;

        // Step 3: XSTS
        const xstsResp = await postJson('xsts.auth.xboxlive.com', '/xsts/authorize', {
          Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
          RelyingParty: 'rp://api.minecraftservices.com/',
          TokenType: 'JWT',
        });
        if (xstsResp.XErr) {
          const XERRS = {
            2148916233: 'Нет аккаунта Xbox. Зарегистрируйтесь на xbox.com',
            2148916235: 'Xbox недоступен в вашей стране',
            2148916238: 'Аккаунт несовершеннолетнего — добавьте в семью Xbox',
          };
          done({ error: XERRS[xstsResp.XErr] || 'Ошибка Xbox: ' + xstsResp.XErr });
          return true;
        }
        const xstsToken = xstsResp.Token;

        // Step 4: Minecraft token
        const mcAuth = await postJson('api.minecraftservices.com', '/authentication/login_with_xbox', {
          identityToken: 'XBL3.0 x=' + userHash + ';' + xstsToken,
        });
        if (!mcAuth.access_token) { done({ error: 'Не удалось получить токен Minecraft' }); return true; }

        // Step 5: Check ownership
        const ownership = await new Promise((res, rej) => {
          https.get({ hostname: 'api.minecraftservices.com', path: '/entitlements/mcstore',
            headers: { Authorization: 'Bearer ' + mcAuth.access_token } },
            r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} }); }).on('error', rej);
        });
        const hasGame = ownership.items?.some(i => ['game_minecraft','product_minecraft'].includes(i.name));
        if (!hasGame) { done({ error: 'Minecraft не куплен на этом аккаунте' }); return true; }

        // Step 6: Profile
        const profile = await new Promise((res, rej) => {
          https.get({ hostname: 'api.minecraftservices.com', path: '/minecraft/profile',
            headers: { Authorization: 'Bearer ' + mcAuth.access_token } },
            r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} }); }).on('error', rej);
        });
        if (!profile.name) { done({ error: 'Не удалось получить профиль игрока' }); return true; }

        done({ username: profile.name, uuid: profile.id, accessToken: mcAuth.access_token, refreshToken: msToken.refresh_token });
      } catch(e) {
        console.error('[MS OAuth]', e);
        done({ error: 'Ошибка: ' + e.message });
      }
      return true;
    };

    win.webContents.on('will-redirect', (event, url) => {
      if (url.startsWith('https://login.live.com/oauth20_desktop.srf')) {
        event.preventDefault();
        handleRedirect(url);
      }
    });

    win.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('https://login.live.com/oauth20_desktop.srf')) {
        event.preventDefault();
        handleRedirect(url);
      }
    });

    win.loadURL(authUrl);
    setTimeout(() => done({ error: 'Время ожидания истекло (10 мин)' }), 10 * 60 * 1000);
  });
});

// ═══════════════════════════════════════════════════
// IPC: LOADER VERSIONS
// ═══════════════════════════════════════════════════
ipcMain.handle('get-loader-versions', async (_, { loader, mcVersion }) => {
  try {
    if (loader === 'fabric') {
      const d = await fetchJSON('https://meta.fabricmc.net/v2/versions/loader/' + mcVersion);
      return (d||[]).map(v => v.loader.version);
    }
    if (loader === 'quilt') {
      const d = await fetchJSON('https://meta.quiltmc.org/v3/versions/loader/' + mcVersion);
      return (d||[]).map(v => v.loader.version);
    }
    if (loader === 'neoforge') {
      const parts = mcVersion.split('.');
      const prefix = parts.length >= 3 ? parts[1] + '.' + parts[2] + '.' : parts[1] + '.';
      try {
        const d = await fetchJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
        const v = (d.versions||[]).filter(v => v.startsWith(prefix) && !v.includes('beta') && !v.includes('alpha'))
          .sort((a,b) => b.localeCompare(a, undefined, {numeric:true}));
        if (v.length) return v;
      } catch {}
      const xml = await new Promise((res,rej) => {
        https.get('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
          { headers:{'User-Agent':'MyLauncher/1.0'} }, r => {
            let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d));
          }).on('error', rej);
      });
      const m = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(x=>x[1]);
      return m.filter(v => v.startsWith(prefix) && !v.includes('beta') && !v.includes('alpha'))
        .sort((a,b) => b.localeCompare(a, undefined, {numeric:true}));
    }
    if (loader === 'forge') {
      const d = await fetchJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const out = [];
      const rec = d.promos[mcVersion + '-recommended'];
      const lat = d.promos[mcVersion + '-latest'];
      if (rec) out.push(rec);
      if (lat && lat !== rec) out.push(lat);
      return out;
    }
    return [];
  } catch { return []; }
});
// ═══════════════════════════════════════════════════
// OPEN EXTERNAL URL
// ═══════════════════════════════════════════════════
ipcMain.handle('open-external', (_, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) shell.openExternal(url);
});

// ═══════════════════════════════════════════════════
// MODS SEARCH — Modrinth + CurseForge
// ═══════════════════════════════════════════════════
const CURSEFORGE_KEY = '$2a$10$bL4bIL5pUWqfcO7KwI8VLOE2gTKjl63O3o3HQyJB7nPDvXxDMnAQK';

function fetchJSONEx(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'MyLauncher/1.0', ...extraHeaders } };
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(fetchJSONEx(res.headers.location, extraHeaders));
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

let _cfAvailable = null;
async function isCFAvailable() {
  if (_cfAvailable !== null) return _cfAvailable;
  try {
    await fetchJSONEx('https://api.curseforge.com/v1/games/432', { 'x-api-key': CURSEFORGE_KEY });
    _cfAvailable = true;
  } catch { _cfAvailable = false; }
  return _cfAvailable;
}

async function searchModrinth({ query='', type='mod', limit=20, offset=0, gameVersion='', sort='downloads', loaders=[], categories=[], environment='' }) {
  const LOADER_CATS = new Set(['fabric','forge','quilt','neoforge','vanilla','datapack']);
  const facets = [[`project_type:${type}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loaders.length) facets.push(loaders.map(l => `categories:${l}`));
  categories.forEach(c => { if (!LOADER_CATS.has(c)) facets.push([`categories:${c}`]); });
  if (environment === 'client') facets.push(['client_side:required','client_side:optional']);
  if (environment === 'server') facets.push(['server_side:required','server_side:optional']);
  const indexMap = { downloads:'downloads', newest:'newest', relevance:'relevance' };
  const index = query ? (indexMap[sort]||'relevance') : (indexMap[sort]||'downloads');
  const params = new URLSearchParams({
    limit, offset, index,
    facets: JSON.stringify(facets),
    ...(query ? { query } : {}),
  });
  const data = await fetchJSONEx(`https://api.modrinth.com/v2/search?${params}`);
  return (data.hits || []).map(p => ({
    id: p.project_id, slug: p.slug, title: p.title,
    desc: (p.description||'').slice(0,120), icon: p.icon_url||'',
    downloads: p.downloads, updated: p.date_modified, author: p.author,
    source: 'modrinth',
    url: `https://modrinth.com/${type}/${p.slug}`,
    gameVersions: p.versions || [],
    loaders: (p.categories||[]).filter(c => LOADER_CATS.has(c)),
    categories: (p.categories||[]).filter(c => !LOADER_CATS.has(c)),
    projectType: type,
    clientSide: p.client_side || 'unknown',
    serverSide: p.server_side || 'unknown',
  }));
}

async function searchCurseForge({ query='', classId=6, limit=20, offset=0, gameVersion='', sort='downloads' }) {
  const sortFieldMap = { downloads:2, newest:1, relevance:1 };
  const params = new URLSearchParams({
    gameId:432, classId, pageSize:limit, index:offset,
    sortField: query ? 1 : (sortFieldMap[sort]||2), sortOrder:'desc',
    ...(query ? { searchFilter:query } : {}),
    ...(gameVersion ? { gameVersion } : {}),
  });
  const data = await fetchJSONEx(`https://api.curseforge.com/v1/mods/search?${params}`, { 'x-api-key': CURSEFORGE_KEY });
  return (data.data||[]).map(p => ({
    id: p.id, slug: p.slug||String(p.id), title: p.name,
    desc: (p.summary||'').slice(0,120), icon: p.logo?.thumbnailUrl||'',
    downloads: p.downloadCount, updated: p.dateModified, author: p.authors?.[0]?.name||'',
    source: 'curseforge',
    url: p.links?.websiteUrl||`https://www.curseforge.com/minecraft/mc-mods/${p.slug}`,
  }));
}

ipcMain.handle('cf-available', async () => { _cfAvailable = null; return isCFAvailable(); });

ipcMain.handle('search-mods', async (_, { query, category, limit, offset, gameVersion, sort='downloads', loaders=[], categories=[], environment='' }) => {
  const mrType   = { mod:'mod', resourcepack:'resourcepack', shader:'shader', modpack:'modpack', datapack:'datapack' }[category]||'mod';
  const cfClass  = { mod:6, resourcepack:12, shader:6552, modpack:4471, datapack:5816 }[category]||6;
  const cfOk = await isCFAvailable();
  const mrLimit  = cfOk ? Math.ceil(limit/2)  : limit;
  const cfLimit  = cfOk ? Math.floor(limit/2) : 0;

  const [mr, cf] = await Promise.all([
    searchModrinth({ query, type:mrType, limit:mrLimit, offset, gameVersion, sort, loaders, categories, environment }).catch(()=>[]),
    cfOk ? searchCurseForge({ query, classId:cfClass, limit:cfLimit, offset, gameVersion, sort }).catch(()=>[]) : Promise.resolve([]),
  ]);

  const merged = [];
  const max = Math.max(mr.length, cf.length);
  for (let i=0; i<max; i++) {
    if (mr[i]) merged.push(mr[i]);
    if (cf[i]) merged.push(cf[i]);
  }
  // Re-sort merged results so interleaving doesn't break user-selected sort
  if (sort === 'downloads') {
    merged.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  } else if (sort === 'newest') {
    merged.sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0));
  }
  return { items: merged, cfAvailable: cfOk };
});

ipcMain.handle('get-mod-versions', async (_, { source, slug }) => {
  if (source !== 'modrinth') return [];
  const versions = await fetchJSONEx(`https://api.modrinth.com/v2/project/${slug}/version`);
  return (versions||[]).map(v => ({
    id: v.id, name: v.name,
    gameVersions: v.game_versions, loaders: v.loaders,
    changelog: v.changelog || '',
    datePublished: v.date_published || '',
    files: (v.files||[]).map(f => ({ url:f.url, filename:f.filename, primary:f.primary, size:f.size||0 })),
    dependencies: (v.dependencies||[]).map(d=>({ projectId:d.project_id, dependencyType:d.dependency_type })),
  }));
});

ipcMain.handle('get-mod-details', async (_, { source, slug }) => {
  if (source !== 'modrinth') return null;
  try {
    const [proj, members] = await Promise.all([
      fetchJSONEx(`https://api.modrinth.com/v2/project/${slug}`),
      fetchJSONEx(`https://api.modrinth.com/v2/project/${slug}/members`).catch(()=>[]),
    ]);
    const LOADER_CATS = new Set(['fabric','forge','quilt','neoforge','vanilla','datapack']);
    return {
      id: proj.id, slug: proj.slug,
      title: proj.title,
      description: proj.description,
      body: proj.body || '',
      icon: proj.icon_url || '',
      gallery: (proj.gallery||[]).map(g => ({ url: g.url, title: g.title||'' })),
      downloads: proj.downloads,
      follows: proj.followers,
      updated: proj.updated,
      published: proj.published,
      source: 'modrinth',
      url: `https://modrinth.com/mod/${slug}`,
      gameVersions: proj.game_versions || [],
      loaders: (proj.categories||[]).filter(c => LOADER_CATS.has(c)),
      categories: (proj.categories||[]).filter(c => !LOADER_CATS.has(c)),
      projectType: proj.project_type,
      license: proj.license?.name || '',
      author: members.find(m => m.role === 'Owner')?.user?.username || proj.team || '',
      clientSide: proj.client_side || 'unknown',
      serverSide: proj.server_side || 'unknown',
    };
  } catch { return null; }
});

ipcMain.handle('download-mod', async (event, { fileUrl, filename, category, destDir: overrideDestDir, instanceName }) => {
  const folderMap         = { mod:'mods', resourcepack:'resourcepacks', shader:'shaderpacks', modpack:'modpacks', datapack:'datapacks' };
  const instanceFolderMap = { mod:'mods', resourcepack:'resourcepacks', shader:'shaderpacks', modpack:'modpacks', datapack:'datapacks' };
  const folder   = (instanceName ? instanceFolderMap[category] : folderMap[category]) || 'mods';
  const settings = readConfig().settings || {};
  const mcRoot   = settings.gameDir ? path.join(settings.gameDir, 'minecraft') : path.join(USER_DATA, 'minecraft');

  let destDir;
  if (overrideDestDir) {
    // Caller passed explicit path — use it as-is (absolute) or relative to mcRoot
    destDir = path.isAbsolute(overrideDestDir)
      ? path.normalize(overrideDestDir)
      : path.join(mcRoot, overrideDestDir);
  } else if (instanceName) {
    // Belongs to a modpack instance — put in its versioned folder
    const safeName = instanceName.replace(/[\/\\:*?"<>|]/g, '_').trim();
    destDir = path.join(mcRoot, 'versions', safeName, folder);
  } else {
    // Standalone download — global folder
    destDir = path.join(mcRoot, folder);
  }
  const destFile = path.join(destDir, filename);
  fs.mkdirSync(destDir, { recursive:true });
  const send = (ch, v) => { try { if (!mainWindow.isDestroyed()) mainWindow.webContents.send(ch, v); } catch {} };
  try {
    await downloadFile(fileUrl, destFile, (dl, total) => {
      if (total) send('mod-download-progress', { filename, pct: Math.round((dl/total)*100) });
    });
    send('mod-download-done', { filename, success:true });
    return { success:true, path:destFile };
  } catch(e) {
    send('mod-download-done', { filename, success:false, error:e.message });
    return { success:false, error:e.message };
  }
});

// ═══════════════════════════════════════════════════
// SKIN LOADER (bypasses CORS in renderer)
// ═══════════════════════════════════════════════════
ipcMain.handle('fetch-skin', async (_, { username, type }) => {
  try {
    const url = type === 'elyby'
      ? `https://skinsystem.ely.by/skins/${username}.png`
      : type === 'ms'
        ? `https://minotar.net/skin/${username}`
        : `https://minotar.net/skin/${username}`;
    const data = await new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'User-Agent': 'MyLauncher/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // follow redirect
          const rmod = res.headers.location.startsWith('https') ? https : http;
          rmod.get(res.headers.location, { headers: { 'User-Agent': 'MyLauncher/1.0' } }, res2 => {
            const chunks = [];
            res2.on('data', c => chunks.push(c));
            res2.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    return 'data:image/png;base64,' + data.toString('base64');
  } catch { return null; }
});
// ═══════════════════════════════════════════════════
// MODPACK CONTENTS (via Modrinth dependencies API)
// ═══════════════════════════════════════════════════
ipcMain.handle('get-modpack-mods', async (_, { source, slug, versionId }) => {
  if (source !== 'modrinth') return [];
  try {
    // Get versions, pick specific one if versionId given
    const versions = await fetchJSONEx(`https://api.modrinth.com/v2/project/${slug}/version`);
    if (!versions?.length) return [];
    let ver = versionId ? versions.find(v => v.id === versionId) : null;
    if (!ver) ver = versions[0];
    const mrpackFile = (ver.files||[]).find(f => f.filename && f.filename.endsWith('.mrpack'));
    if (!mrpackFile) return [];
    const tmpFile = path.join(os.tmpdir(), `mrpack_${Date.now()}.zip`);
    await downloadFile(mrpackFile.url, tmpFile);
    let indexData;
    try {
      const zip = new AdmZip(tmpFile);
      const entry = zip.getEntry('modrinth.index.json');
      if (!entry) { try { fs.unlinkSync(tmpFile); } catch {} return []; }
      indexData = JSON.parse(entry.getData().toString('utf8'));
    } catch (e2) { try { fs.unlinkSync(tmpFile); } catch {} return []; }
    try { fs.unlinkSync(tmpFile); } catch {}
    // Extract direct download URLs for mods from indexData
    const modFiles = [];
    for (const f of (indexData.files || [])) {
      if ((f.env || {}).client === 'unsupported') continue;
      const url = (f.downloads || [])[0];
      if (!url) continue;
      const filename = f.path ? f.path.split('/').pop() : url.split('/').pop().split('?')[0];
      // Extract modrinth project id from URL if available
      const m = url.match(/cdn\.modrinth\.com\/data\/([A-Za-z0-9]+)\/versions/);
      modFiles.push({ url, filename, projectId: m ? m[1] : null });
    }
    if (!modFiles.length) return [];
    // Batch-fetch project details for named display
    const pids = [...new Set(modFiles.map(f => f.projectId).filter(Boolean))].slice(0, 200);
    let projectMap = {};
    if (pids.length) {
      const projs = await fetchJSONEx(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(pids))}`);
      if (Array.isArray(projs)) projs.forEach(p => { projectMap[p.id] = p; });
    }
    const LOADER_CATS = new Set(['fabric','forge','quilt','neoforge','vanilla','datapack']);
    return modFiles.map(f => {
      const p = projectMap[f.projectId];
      return {
        name: p ? (p.title || p.slug) : f.filename,
        slug: p ? p.slug : null,
        source: 'modrinth',
        url: p ? `https://modrinth.com/mod/${p.slug}` : f.url,
        fileUrl: f.url,
        filename: f.filename,
        loaders: p ? (p.categories||[]).filter(c=>LOADER_CATS.has(c)) : [],
      };
    });
  } catch (e) { console.error('get-modpack-mods error:', e.message); return []; }
});

// ═══════════════════════════════════════════════════
// FILE BROWSER
// ═══════════════════════════════════════════════════
const MC_ROOT = path.join(USER_DATA, 'minecraft');

ipcMain.handle('fs-list', async (_, dirPath) => {
  try {
    // Ensure MC_ROOT exists
    if (!fs.existsSync(MC_ROOT)) fs.mkdirSync(MC_ROOT, { recursive: true });
    // Normalize: use MC_ROOT if no path given, else sanitize
    let fullPath = MC_ROOT;
    if (dirPath && typeof dirPath === 'string') {
      // Accept absolute paths that are inside MC_ROOT
      fullPath = path.normalize(dirPath);
    }
    // Security: must stay within MC_ROOT
    const relative = path.relative(MC_ROOT, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { error: 'Доступ запрещён' };
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      return { path: fullPath, entries: [] };
    }
    const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
    const result = [];
    for (const e of entries) {
      try {
        const ep = path.join(fullPath, e.name);
        const stat = await fsPromises.stat(ep);
        result.push({
          name: e.name,
          path: ep,
          isDir: e.isDirectory(),
          size: e.isFile() ? stat.size : 0,
          mtime: stat.mtimeMs,
          ext: e.isFile() ? path.extname(e.name).toLowerCase() : '',
        });
      } catch {}
    }
    result.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'ru');
    });
    const isRoot = path.normalize(fullPath) === path.normalize(MC_ROOT);
    const parent = isRoot ? null : path.dirname(fullPath);
    return { path: fullPath, parent, entries: result, mcRoot: MC_ROOT, isRoot };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('fs-delete', async (_, filePath) => {
  try {
    const fullPath = path.resolve(filePath);
    if (!fullPath.startsWith(MC_ROOT)) return { error: 'Доступ запрещён' };
    const stat = await fsPromises.stat(fullPath);
    if (stat.isDirectory()) await fsPromises.rm(fullPath, { recursive: true });
    else await fsPromises.unlink(fullPath);
    return { success: true };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('fs-open', async (_, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('fs-open-folder', async (_, dirPath) => {
  try {
    await shell.openPath(dirPath || MC_ROOT);
    return { success: true };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('open-mp-folder', async (_, { safeName }) => {
  try {
    const cfg = readConfig();
    const mcRoot = cfg.settings?.gameDir
      ? path.join(cfg.settings.gameDir, 'minecraft')
      : path.join(USER_DATA, 'minecraft');
    const folderPath = path.join(mcRoot, 'versions', safeName);
    fs.mkdirSync(folderPath, { recursive: true });
    await shell.openPath(folderPath);
    return { success: true };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('fs-rename', async (_, { oldPath, newName }) => {
  try {
    const fullOld = path.resolve(oldPath);
    if (!fullOld.startsWith(MC_ROOT)) return { error: 'Доступ запрещён' };
    const newPath = path.join(path.dirname(fullOld), newName);
    await fsPromises.rename(fullOld, newPath);
    return { success: true, newPath };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('fs-copy-file', async (_, { srcPath, destDir }) => {
  try {
    const fullDest = path.resolve(destDir);
    if (!fullDest.startsWith(MC_ROOT)) return { error: 'Доступ запрещён' };
    const filename = path.basename(srcPath);
    fs.mkdirSync(fullDest, { recursive: true });
    await fsPromises.copyFile(srcPath, path.join(fullDest, filename));
    return { success: true };
  } catch(e) { return { error: e.message }; }
});
// ═══════════════════════════════════════════════════
// SOCIAL API (proxy to local server on port 3747)
// ═══════════════════════════════════════════════════
const SOCIAL_BASE = process.env.SOCIAL_URL || 'https://weqeecharm8y5g-production.up.railway.app';

function socialRequest({ method = 'GET', path: urlPath, token, body }) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(SOCIAL_BASE + urlPath); }
    catch(e) { return reject(new Error('Invalid SOCIAL_BASE URL: ' + SOCIAL_BASE)); }

    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'MidLauncher/1.0' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const port = url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80);

    const req = mod.request({
      hostname: url.hostname,
      port,
      path: url.pathname + url.search,
      method,
      headers,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let data; try { data = JSON.parse(d); } catch { data = d; }
        console.log('[social]', method, urlPath, '→', res.statusCode, typeof data === 'object' ? JSON.stringify(data).slice(0,200) : String(data).slice(0,200));
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

ipcMain.handle('social-register',      async (_, { username, displayName, password }) => {
  try { return await socialRequest({ method:'POST', path:'/auth/register', body:{ username, displayName, password } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-login',         async (_, { username, password }) => {
  try { return await socialRequest({ method:'POST', path:'/auth/login', body:{ username, password } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-oauth-login',   async (_, { type, externalId, externalUsername }) => {
  try { return await socialRequest({ method:'POST', path:'/auth/oauth-login', body:{ type, externalId, externalUsername } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-change-username', async (_, { token, username }) => {
  try { return await socialRequest({ method:'POST', path:'/auth/change-username', token, body:{ username } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-change-display-name', async (_, { token, displayName }) => {
  try { return await socialRequest({ method:'POST', path:'/auth/change-display-name', token, body:{ displayName } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-link',          async (_, { token, type, externalId, externalUsername }) => {
  try { return await socialRequest({ method:'POST', path:'/auth/link', token, body:{ type, externalId, externalUsername } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-unlink',        async (_, { token, type }) => {
  try { return await socialRequest({ method:'DELETE', path:'/auth/link/'+type, token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-me',          async (_, { token }) => {
  try { return await socialRequest({ method:'GET', path:'/me', token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-friends',     async (_, { token }) => {
  try { return await socialRequest({ method:'GET', path:'/friends', token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-add-friend',  async (_, { token, username }) => {
  try { return await socialRequest({ method:'POST', path:'/friends/add', token, body:{ username } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-accept',      async (_, { token, userId }) => {
  try { return await socialRequest({ method:'POST', path:'/friends/accept', token, body:{ userId } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-remove',      async (_, { token, userId }) => {
  try { return await socialRequest({ method:'DELETE', path:`/friends/${userId}`, token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-search',      async (_, { token, query }) => {
  try { return await socialRequest({ method:'GET', path:`/users/search?q=${encodeURIComponent(query||'')}`, token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-resend-code',  async (_, { email }) => {
  try { return await socialRequest({ method:'POST', path:'/auth/resend-code', body:{ email } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-messages',    async (_, { token, friendId, limit, before }) => {
  try {
    let p = `/messages/${friendId}`;
    const params = []; if (limit) params.push('limit='+limit); if (before) params.push('before='+before);
    if (params.length) p += '?' + params.join('&');
    return await socialRequest({ method:'GET', path:p, token });
  } catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-change-password', async (_, { token, password }) => {
  try { return await socialRequest({ method:'POST', path:'/auth/change-password', token, body:{ password } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-delete-account', async (_, { token, password }) => {
  try { return await socialRequest({ method:'DELETE', path:'/auth/account', token, body:{ password } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-block',              async (_, { token, userId }) => {
  try { return await socialRequest({ method:'POST', path:'/users/block', token, body:{ userId } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-unblock',            async (_, { token, userId }) => {
  try { return await socialRequest({ method:'DELETE', path:'/users/block/'+userId, token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-report',             async (_, { token, userId, reason, text }) => {
  try { return await socialRequest({ method:'POST', path:'/reports', token, body:{ userId, reason, text } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-stats',        async (_, { token }) => {
  try { return await socialRequest({ method:'GET', path:'/admin/stats', token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-users',        async (_, { token, query }) => {
  try { return await socialRequest({ method:'GET', path:'/admin/users?q='+encodeURIComponent(query||''), token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-reports',      async (_, { token }) => {
  try { return await socialRequest({ method:'GET', path:'/admin/reports', token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-ban',          async (_, { token, userId }) => {
  try { return await socialRequest({ method:'POST', path:'/admin/users/'+userId+'/ban', token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-unban',        async (_, { token, userId }) => {
  try { return await socialRequest({ method:'POST', path:'/admin/users/'+userId+'/unban', token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-delete-user',  async (_, { token, userId }) => {
  try { return await socialRequest({ method:'DELETE', path:'/admin/users/'+userId, token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-dismiss-report', async (_, { token, reportId }) => {
  try { return await socialRequest({ method:'DELETE', path:'/admin/reports/'+reportId, token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-grant-admin',  async (_, { token, userId }) => {
  try { return await socialRequest({ method:'POST', path:'/admin/users/'+userId+'/grant-admin', token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-revoke-admin', async (_, { token, userId }) => {
  try { return await socialRequest({ method:'POST', path:'/admin/users/'+userId+'/revoke-admin', token }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
ipcMain.handle('social-admin-change-id', async (_, { token, userId, newId }) => {
  try { return await socialRequest({ method:'POST', path:'/admin/users/'+userId+'/change-id', token, body:{ newId } }); }
  catch(e) { return { status:0, data:{ error:e.message } }; }
});
