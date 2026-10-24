'use strict';
// ============ BiliMusic 主进程 ============
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const paths = require('./paths');
const biliApi = require('./bili-api');
const wbi = require('./wbi');
const login = require('./login');
const qr = require('./qr');

// 开发时 = 仓库根; 打包后 = resources 目录(asar 的同级)
const REPO_ROOT = path.join(__dirname, '..');

// 打包判定不能只看 app.isPackaged: 本项目的可执行文件仍叫 electron.exe,
// 实测在这种布局下 app.isPackaged 依旧是 false。这里按"主脚本是否在 app.asar 里"
// 以及"resourcesPath 是否就是应用根"来识别, 两种情况都能覆盖。
const IN_ASAR = /[\\/]app\.asar([\\/]|$)/.test(__dirname);
const IS_PACKAGED = app.isPackaged || IN_ASAR || process.resourcesPath === REPO_ROOT;

// 冒烟测试: 不显示窗口 + 使用临时数据目录, 由 scripts/smoke 驱动后自动退出
const SMOKE = !!process.env.BILIMUSIC_SMOKE;
// 仅隐藏窗口(打包版自检用, 数据目录仍走真实路径)
const HIDDEN = !!process.env.BILIMUSIC_HIDDEN;

// ============ 数据目录 ============
// 打包后写 %APPDATA%\BiliMusic, 不再写进安装目录(否则卸载会丢歌单/登录态)
const USER_DATA_DIR = SMOKE
  ? path.join(require('os').tmpdir(), 'bilimusic-smoke')   // 冒烟测试: 用临时目录, 不碰真实数据
  : paths.resolveUserDataDir({
    isPackaged: IS_PACKAGED,
    appData: app.getPath('appData'),
    repoRoot: REPO_ROOT,
  });
app.setPath('userData', USER_DATA_DIR);
app.setPath('sessionData', path.join(USER_DATA_DIR, 'Session'));
app.setPath('cache', path.join(USER_DATA_DIR, 'Cache'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.disableHardwareAcceleration();

// 一次性迁移旧版本数据(仅在目标目录为空时执行; 冒烟测试跳过)
try {
  const legacyDirs = SMOKE ? [] : paths.legacyDataDirs({
    isPackaged: IS_PACKAGED,
    resourcesPath: process.resourcesPath,
    repoRoot: REPO_ROOT,
  });
  const from = paths.shouldMigrate({ targetDir: USER_DATA_DIR, legacyDirs });
  if (from) {
    const r = paths.migrateLegacyData(from, USER_DATA_DIR);
    console.log(`  📦 已迁移旧数据: ${from} → ${USER_DATA_DIR} (${r.copied} 个文件, 跳过 ${r.skipped} 个缓存目录)`);
  }
} catch (e) {
  console.warn('  ⚠️ 迁移旧数据失败:', e.message);
}
console.log(`  📁 数据目录: ${USER_DATA_DIR}`);

let mainWindow = null;
let playerView = null;
let playerVisible = false;
let hasTray = false;
let _currentBvid = null;
let _currentUrl = '';
let _volume = 0.8;            // 内嵌播放器音量(0~1)
let _volumeUserSet = false;   // 用户是否手动调过(调过才在加载后强制应用)
let tray = null;
let isQuitting = false;
let resizeTimer = null;

// 封面图缓存: 同一 URL 只下载一次(渲染进程每次重绘都会重新请求封面)
const IMG_CACHE = new Map();
const IMG_CACHE_MAX = 240;

// ============ 窗口 ============
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: 'BiliMusic', backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    show: !SMOKE && !HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,          // preload 只用 contextBridge/ipcRenderer, 不需要 Node
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 本地界面不允许被导航到别处
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  playerView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
  playerView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  mainWindow.contentView.addChildView(playerView);

  playerView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 页面加载完成后再应用用户设定过的音量(等 B 站播放器初始化完)
  playerView.webContents.on('did-finish-load', () => {
    if (!_volumeUserSet) return;
    setTimeout(() => applyVolume(), 1500);
  });
  // 加载失败时通知渲染进程显示兜底提示, 否则中间栏只会一片空白
  playerView.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;   // -3 = ERR_ABORTED, 属于正常中断
    if (mainWindow) {
      mainWindow.webContents.send('player:failed', {
        url: validatedURL || _currentUrl, code: errorCode, message: errorDescription || '加载失败',
      });
    }
  });

  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { mainWindow && mainWindow.webContents.send('player:relayout'); }, 50);
  });

  mainWindow.on('close', (event) => {
    // 只有托盘可用时才最小化到托盘, 否则关窗即退出(避免"窗口没了但还在放歌")
    if (!isQuitting && hasTray) { event.preventDefault(); mainWindow.hide(); return; }
    isQuitting = true;
    mainWindow = null;
    playerView = null;
  });
}

// ============ 托盘 ============
function createTray() {
  const iconPath = paths.resolveTrayIconPath({
    isPackaged: IS_PACKAGED,
    resourcesPath: process.resourcesPath,
    repoRoot: REPO_ROOT,
  });
  let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (icon.isEmpty()) {
    console.warn(`  ⚠️ 托盘图标不可用(${iconPath || '无候选路径'}), 关闭窗口将直接退出应用`);
    return false;
  }
  icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('BiliMusic');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    else if (mainWindow.isVisible()) mainWindow.focus();
    else mainWindow.show();
  });
  return true;
}

// ============ 会话加固 ============
function setupSessionHardening() {
  const ses = session.defaultSession;
  const ALLOWED = new Set(['fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = ALLOWED.has(permission);
    if (!ok) console.log('  🚫 拒绝权限请求:', permission);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
}

// ============ 播放器 ============
function applyPlayerBounds(rect) {
  if (!playerView || !mainWindow) return;
  playerView.setBounds({
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  });
}

/** 组装视频地址; 不再产生无意义的 ?t=0 / ?p=1 */
function buildVideoUrl(bvid, t, p) {
  const sec = Math.floor(Number(t) || 0);
  const part = Math.floor(Number(p) || 0);
  const query = [];
  if (part > 1) query.push('p=' + part);
  if (sec > 0) query.push('t=' + sec);
  const base = 'https://www.bilibili.com/video/' + encodeURIComponent(String(bvid || ''));
  return query.length ? `${base}?${query.join('&')}` : base;
}

function loadPlayerUrl(url) {
  if (!playerView) return;
  _currentUrl = url;
  playerVisible = true;
  playerView.webContents.loadURL(url).catch(() => {});
}

function applyVolume() {
  if (!playerView) return;
  const v = Math.max(0, Math.min(1, _volume));
  playerView.webContents
    .executeJavaScript(`(function(){var v=document.querySelector('video');if(v)v.volume=${v};})()`)
    .catch(() => {});
}

function pausePlayer() {
  if (!playerView) return;
  playerView.webContents
    .executeJavaScript(`(function(){var v=document.querySelector('video');if(v&&!v.paused)v.pause();})()`)
    .catch(() => {});
}

function resumePlayer() {
  if (!playerView) return;
  playerView.webContents
    .executeJavaScript(`(function(){var v=document.querySelector('video');if(v&&v.paused)v.play();})()`)
    .catch(() => {});
}

/**
 * 在播放器页里执行脚本。
 * 页面还没加载时直接返回 null; 加了超时, 免得渲染进程的 invoke 永远等不到回包
 * (冒烟测试就是被这个卡住的)。
 */
async function evalInPlayer(code, timeoutMs = 3000) {
  if (!playerView || !playerView.webContents.getURL()) return null;
  return Promise.race([
    playerView.webContents.executeJavaScript(code).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// ============ IPC: B 站 API ============
ipcMain.handle('bili:search', async (_e, { keyword, page, order }) => {
  try { return { ok: true, data: await biliApi.searchVideo(keyword, page || 1, order || 'totalrank') }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('bili:hot', async () => {
  try { return { ok: true, data: await biliApi.getHotMusic() }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('bili:pages', async (_e, { bvid }) => {
  try { return { ok: true, data: await biliApi.getVideoPages(bvid) }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('bili:getView', async (_e, { bvid }) => {
  try { return { ok: true, data: await biliApi.getView(bvid) }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('bili:img', async (_e, { url }) => {
  try {
    if (!url) return { ok: false, message: '空 URL' };
    let u = url; if (u.startsWith('//')) u = 'https:' + u;
    const cached = IMG_CACHE.get(u);
    if (cached) return { ok: true, dataUrl: cached, cached: true };
    const { data, contentType } = await biliApi.requestBuffer(u);
    const dataUrl = `data:${contentType};base64,${data.toString('base64')}`;
    if (IMG_CACHE.size >= IMG_CACHE_MAX) IMG_CACHE.delete(IMG_CACHE.keys().next().value);
    IMG_CACHE.set(u, dataUrl);
    return { ok: true, dataUrl };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ============ IPC: 登录 ============
ipcMain.handle('login:generateQR', async () => { try { return { ok: true, ...(await login.generateQRCode()) }; } catch (e) { return { ok: false, message: e.message }; } });
ipcMain.handle('login:genQR', async (_e, { url }) => {
  try {
    // 本地生成二维码(零依赖), 不把登录 URL 交给第三方服务
    const dataUrl = qr.toDataUrl(url, { ecc: 'M', margin: 1, scale: 4 });
    return { ok: true, dataUrl };
  } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('login:poll', async (_e, { qrcodeKey }) => { try { return { ok: true, data: await login.pollLogin(qrcodeKey) }; } catch (e) { return { ok: false, message: e.message }; } });
ipcMain.handle('login:status', async () => {
  try { return login.isLoggedIn() ? { ok: true, data: await login.getUserInfo() } : { ok: true, data: { isLogin: false } }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('login:logout', async () => { try { await login.logout(); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; } });

// ============ IPC: 应用信息 ============
ipcMain.handle('app:info', async () => ({
  ok: true,
  version: app.getVersion(),
  packaged: IS_PACKAGED,
  userData: USER_DATA_DIR,
  electron: process.versions.electron,
  playerVisible,
  hasTray,
}));

// ============ IPC: 内嵌播放器 ============
ipcMain.on('player:setBounds', (_e, rect) => { applyPlayerBounds(rect); });

ipcMain.handle('player:load', async (_e, { bvid, t, p }) => {
  if (!playerView) return { ok: false };
  _currentBvid = bvid;
  loadPlayerUrl(buildVideoUrl(bvid, t, p));
  if (_volumeUserSet) setTimeout(() => applyVolume(), 2500);
  return { ok: true };
});

ipcMain.handle('player:reload', async (_e, { bvid, t, p }) => {
  if (!playerView) return { ok: false };
  if (bvid) _currentBvid = bvid;
  loadPlayerUrl(buildVideoUrl(_currentBvid, t, p));
  if (_volumeUserSet) setTimeout(() => applyVolume(), 2500);
  return { ok: true };
});

ipcMain.on('player:pageFullscreen', () => {
  if (!playerView) return;
  const doIt = () => setTimeout(() => { playerView.webContents.executeJavaScript(`var b=document.querySelector('.bpx-player-ctrl-full');if(b){var p=b.previousElementSibling;if(p)p.click();}`).catch(() => {}); }, 2000);
  playerView.webContents.isLoading() ? playerView.webContents.once('did-finish-load', doIt) : doIt();
});

ipcMain.on('player:hide', () => {
  if (!playerView) return;
  playerVisible = false;
  _currentBvid = null;
  _currentUrl = '';
  pausePlayer();            // 关键: 把视图缩成 0×0 不会停止 HTML5 音频
  playerView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
});

ipcMain.handle('player:pause', async () => {
  if (!playerView) return { ok: false };
  pausePlayer();
  return { ok: true };
});

ipcMain.handle('player:resume', async () => {
  if (!playerView) return { ok: false };
  resumePlayer();
  return { ok: true };
});

// ============ B 站收藏夹同步(默认歌单 → bilimusic) ============
ipcMain.handle('fav:plan', async (_e, bvids) => {
  try { return { ok: true, data: await biliApi.favPlan(bvids) }; }
  catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('fav:sync', async (_e, mode) => {
  try { return { ok: true, data: await biliApi.favSync(mode) }; }
  catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('player:status', async () => {
  const info = await evalInPlayer(`var v=document.querySelector('video');v?JSON.stringify({paused:v.paused,currentTime:v.currentTime,duration:v.duration}):'null';`);
  try { return info ? { ok: true, data: JSON.parse(info) } : { ok: false, data: { paused: true } }; } catch (e) { return { ok: false, data: { paused: true } }; }
});

ipcMain.handle('player:seek', async (_e, { bvid, t, p }) => {
  if (!playerView) return { ok: false };
  if (playerVisible && _currentBvid === bvid) {
    const done = await evalInPlayer(`var v=document.querySelector('video');if(v)v.currentTime=${Math.floor(t)};return 'ok';`);
    if (done) return { ok: true, inPlace: true };
  }
  _currentBvid = bvid;
  loadPlayerUrl(buildVideoUrl(bvid, t, p));
  return { ok: true };
});

ipcMain.handle('player:setVolume', async (_e, { volume }) => {
  _volume = Math.max(0, Math.min(1, Number(volume) || 0));
  _volumeUserSet = true;
  if (!playerView) return { ok: false };
  try { applyVolume(); return { ok: true, volume: _volume }; } catch (e) { return { ok: false }; }
});

ipcMain.handle('player:getVolume', async () => {
  const raw = await evalInPlayer(`(function(){var v=document.querySelector('video');return v?String(v.volume):'';})()`, 2000);
  const num = parseFloat(raw);
  if (!isNaN(num)) { _volume = num; return { ok: true, volume: num, source: 'player' }; }
  return { ok: true, volume: _volume, source: 'main' };
});

// ============ IPC: 导入歌单 ============
const SONGS_FILE = path.join(USER_DATA_DIR, 'imported_songs.json');
function loadSongs() { try { return fs.existsSync(SONGS_FILE) ? JSON.parse(fs.readFileSync(SONGS_FILE, 'utf-8')) : []; } catch (e) { return []; } }
function saveSongs(list) { try { fs.writeFileSync(SONGS_FILE, JSON.stringify(list, null, 2), 'utf-8'); } catch (e) { console.warn('  ⚠️ 保存歌单失败:', e.message); } }

// 文本解码放在渲染进程(Chromium 支持 gbk/gb18030), 这里只负责合并与持久化
ipcMain.handle('import:saveSongs', async (_e, { songs }) => {
  try {
    const list = Array.isArray(songs) ? songs.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!list.length) return { ok: false, message: '没有解析到歌曲名' };
    const existing = loadSongs();
    let added = 0;
    for (const name of list) { if (!existing.includes(name)) { existing.push(name); added++; } }
    saveSongs(existing);
    return { ok: true, added, total: existing.length };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('import:getRandomSongs', async (_e, { count }) => {
  const songs = loadSongs();
  const n = Math.min(count || 7, songs.length);
  const shuffled = [...songs].sort(() => Math.random() - 0.5);
  return { ok: true, songs: shuffled.slice(0, n), total: songs.length };
});

// ============ 启动 ============
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('  已有实例在运行, 退出本次启动');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    setupSessionHardening();
    login.loadCookies();
    // 上次登录的 cookie 也要同步进 Electron session, 否则重启后内嵌播放器仍是未登录状态
    try { await login.syncCookiesToElectronSession(); } catch (e) { /* ignore */ }

    createMainWindow();
    hasTray = createTray();

    wbi.refreshWbiKeys().then((ok) => console.log('  🔑 WBI:', ok ? 'OK' : '失败(搜索时会自动重试)'));
    console.log(`  ✅ BiliMusic ${app.getVersion()} 就绪 (${IS_PACKAGED ? '安装版' : '开发模式'}${hasTray ? '' : ', 无托盘'})`);

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
  });
}

app.on('window-all-closed', () => { if (!isQuitting) return; if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { isQuitting = true; if (tray) { tray.destroy(); tray = null; } });
