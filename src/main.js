'use strict';
// BiliMusic 主进程
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(__dirname, '..', '.electron-data'));
app.setPath('sessionData', path.join(__dirname, '..', '.electron-data', 'Session'));
app.setPath('cache', path.join(__dirname, '..', '.electron-data', 'Cache'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.disableHardwareAcceleration();

const biliApi = require('./bili-api');
const wbi = require('./wbi');
const login = require('./login');

let mainWindow = null;
let playerView = null;
let playerVisible = false;
let _currentBvid = null;
let tray = null;
let isQuitting = false;
let resizeTimer = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: 'BiliMusic', backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  playerView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
  playerView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  mainWindow.contentView.addChildView(playerView);

  playerView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) { shell.openExternal(url); }
    return { action: 'deny' };
  });

  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { mainWindow && mainWindow.webContents.send('player:relayout'); }, 50);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); mainWindow.hide(); return; }
    mainWindow = null; playerView = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('BiliMusic');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { if (mainWindow) mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show(); });
}

function applyPlayerBounds(rect) {
  if (!playerView || !mainWindow) return;
  playerView.setBounds({ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) });
}

// IPC
ipcMain.handle('bili:search', async (_e, { keyword, page, order }) => {
  try { return { ok: true, data: await biliApi.searchVideo(keyword, page || 1, order || 'totalrank') }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('bili:hot', async () => {
  try { return { ok: true, data: await biliApi.getHotMusic() }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('bili:pages', async (_e, { bvid }) => {
  try { return { ok: true, data: await biliApi.getVideoPages(bvid) }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('bili:img', async (_e, { url }) => {
  try {
    let u = url; if (u.startsWith('//')) u = 'https:' + u;
    const { data, contentType } = await biliApi.requestBuffer(u);
    return { ok: true, dataUrl: `data:${contentType};base64,${data.toString('base64')}` };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('login:generateQR', async () => { try { return { ok: true, ...(await login.generateQRCode()) }; } catch(e) { return { ok: false, message: e.message }; } });
ipcMain.handle('login:genQR', async (_e, { url }) => {
  try {
    const dataUrl = await require('qrcode').toDataURL(url, { margin: 1, width: 240 });
    return { ok: true, dataUrl };
  } catch(e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('login:poll', async (_e, { qrcodeKey }) => { try { return { ok: true, data: await login.pollLogin(qrcodeKey) }; } catch(e) { return { ok: false, message: e.message }; } });
ipcMain.handle('login:status', async () => {
  try { return login.isLoggedIn() ? { ok: true, data: await login.getUserInfo() } : { ok: true, data: { isLogin: false } }; } catch(e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('login:logout', async () => { try { await login.logout(); return { ok: true }; } catch(e) { return { ok: false, message: e.message }; } });

ipcMain.on('player:setBounds', (_e, rect) => { applyPlayerBounds(rect); });
ipcMain.handle('player:load', async (_e, { bvid, t, p }) => {
  if (!playerView) return { ok: false };
  _currentBvid = bvid;
  let url = `https://www.bilibili.com/video/${bvid}`;
  if (p && p > 1) url += `?p=${p}`;
  else url += `?t=${Math.floor(t || 0)}`;
  playerView.webContents.loadURL(url);
  playerVisible = true;
  return { ok: true };
});
ipcMain.on('player:pageFullscreen', () => {
  if (!playerView) return;
  const doIt = () => setTimeout(() => { playerView.webContents.executeJavaScript(`var b=document.querySelector('.bpx-player-ctrl-full');if(b){var p=b.previousElementSibling;if(p)p.click();}`).catch(()=>{}); }, 2000);
  playerView.webContents.isLoading() ? playerView.webContents.once('did-finish-load', doIt) : doIt();
});
ipcMain.on('player:hide', () => { if (playerView) { playerVisible = false; _currentBvid = null; playerView.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } });
ipcMain.handle('player:pause', async () => {
  if (!playerView) return { ok: false };
  try { await playerView.webContents.executeJavaScript(`var v=document.querySelector('video');if(v&&!v.paused)v.pause();`).catch(()=>{}); return { ok: true }; } catch(e) { return { ok: false }; }
});
ipcMain.handle('player:resume', async () => {
  if (!playerView) return { ok: false };
  try { await playerView.webContents.executeJavaScript(`var v=document.querySelector('video');if(v&&v.paused)v.play();`).catch(()=>{}); return { ok: true }; } catch(e) { return { ok: false }; }
});
ipcMain.handle('player:status', async () => {
  if (!playerView) return { ok: false, data: { paused: true } };
  try {
    const info = await playerView.webContents.executeJavaScript(`var v=document.querySelector('video');v?JSON.stringify({paused:v.paused,currentTime:v.currentTime,duration:v.duration}):'null';`).catch(()=>null);
    return info ? { ok: true, data: JSON.parse(info) } : { ok: false, data: { paused: true } };
  } catch(e) { return { ok: false, data: { paused: true } }; }
});
ipcMain.handle('player:seek', async (_e, { bvid, t, p }) => {
  if (!playerView) return { ok: false };
  if (playerVisible && _currentBvid === bvid) {
    try { await playerView.webContents.executeJavaScript(`var v=document.querySelector('video');if(v)v.currentTime=${Math.floor(t)};`).catch(()=>{}); return { ok: true, inPlace: true }; } catch(e) {}
  }
  let url = p && p > 1 ? `https://www.bilibili.com/video/${bvid}?p=${p}&t=${Math.floor(t)}` : `https://www.bilibili.com/video/${bvid}?t=${Math.floor(t)}`;
  _currentBvid = bvid;
  playerView.webContents.loadURL(url);
  return { ok: true };
});
ipcMain.handle('player:setVolume', async (_e, { volume }) => {
  if (!playerView) return { ok: false };
  try { await playerView.webContents.executeJavaScript(`var v=document.querySelector('video');if(v)v.volume=${Math.max(0,Math.min(1,volume))};`).catch(()=>{}); return { ok: true }; } catch(e) { return { ok: false }; }
});

const SONGS_FILE = path.join(app.getPath('userData'), 'imported_songs.json');
function loadSongs() { try { return fs.existsSync(SONGS_FILE) ? JSON.parse(fs.readFileSync(SONGS_FILE, 'utf-8')) : []; } catch(e) { return []; } }
ipcMain.handle('import:openFile', async () => {
  if (!mainWindow) return { ok: false };
  const r = await dialog.showOpenDialog(mainWindow, { title: '导入歌单', filters: [{ name: '文本', extensions: ['txt'] }], properties: ['openFile'] });
  if (r.canceled) return { ok: false, canceled: true };
  const lines = fs.readFileSync(r.filePaths[0], 'utf-8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const songs = loadSongs();
  for (const n of lines) { if (!songs.includes(n)) songs.push(n); }
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2), 'utf-8');
  return { ok: true, count: lines.length };
});
ipcMain.handle('import:getRandomSongs', async (_e, { count }) => {
  const songs = loadSongs();
  const n = Math.min(count || 7, songs.length);
  const shuffled = [...songs].sort(() => Math.random() - 0.5);
  return { ok: true, songs: shuffled.slice(0, n), total: songs.length };
});

app.whenReady().then(() => {
  login.loadCookies();
  createMainWindow();
  createTray();
  wbi.refreshWbiKeys().then(ok => console.log('WBI:', ok ? 'OK' : 'retry'));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { if (!isQuitting) return; if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { isQuitting = true; if (tray) { tray.destroy(); tray = null; } });
