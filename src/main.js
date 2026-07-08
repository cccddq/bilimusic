'use strict';
// ============ BiliMusic 主进程 ============
//
// 职责:
//   1. 创建主 BrowserWindow，加载 renderer/index.html (三栏 UI 外壳)
//   2. 创建一个独立的 WebContentsView 作为「内嵌播放器」，叠加在主窗口中间列上
//      —— 它是独立渲染进程，不受 X-Frame-Options 限制，能加载完整 bilibili 视频页
//   3. 监听前端 IPC，根据「播放区在窗口里的实际坐标」实时调整播放器视图位置/大小
//      (窗口 resize / 滚动 / 布局变化都会通知主进程重算)
//   4. 把后端能力 (搜索/BV/登录/WBI) 通过 IPC 暴露给前端
//
// 关键设计: 播放器视图始终「跟随」前端中间列占位 div 的屏幕坐标，
// 视觉上就是内嵌在窗口里，而不是弹出独立窗口。

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// 把 userData 设到项目本地，避免系统目录权限问题
app.setPath('userData', path.join(__dirname, '..', '.electron-data'));
app.setPath('sessionData', path.join(__dirname, '..', '.electron-data', 'Session'));
app.setPath('cache', path.join(__dirname, '..', '.electron-data', 'Cache'));

// 关闭 GPU 磁盘缓存 (本机该目录无写权限，反复报 cache_util_win 拒绝访问并导致渲染进程崩溃)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.disableHardwareAcceleration();

const biliApi = require('./bili-api');
const wbi = require('./wbi');
const login = require('./login');

let mainWindow = null;
let playerView = null;   // WebContentsView 播放器
let playerVisible = false;
let tray = null;          // 系统托盘
let isQuitting = false;   // 标记是否真的要退出

// ============ 创建主窗口 ============
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'BiliMusic',
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 让外部链接在系统浏览器打开 (B 站页内的跳转等)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 创建内嵌播放器视图
  playerView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 默认隐藏 (size=0)，等前端通知「播放」时才显示并定位
  playerView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  mainWindow.contentView.addChildView(playerView);

  // 播放器内点击链接默认会在 playerView 内导航；强制外链走系统浏览器
  playerView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  // 窗口大小变化时，通知前端重算播放区坐标
  mainWindow.on('resize', () => {
    // debounce: 等 resize 事件平息后让前端重新汇报位置
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      mainWindow && mainWindow.webContents.send('player:relayout');
    }, 50);
  });

  mainWindow.on('closed', () => {
    console.log('  [main] window closed');
    mainWindow = null;
    playerView = null;
  });

  // 捕获渲染进程崩溃/退出，便于诊断「无声退出」问题
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log('  ⚠️ [main] render-process-gone:', JSON.stringify(details));
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.log('  ⚠️ [main] window unresponsive');
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`  ⚠️ [main] did-fail-load code=${code} desc=${desc} url=${url}`);
  });
  mainWindow.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    console.log(`  [renderer:${level}] ${msg} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('crashed', () => {
    console.log('  ⚠️ [main] renderer crashed');
  });

  // 关闭按钮改为隐藏到系统托盘
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    // isQuitting = true 时正常关闭
    mainWindow = null;
    playerView = null;
  });
}

// ============ 系统托盘 ============
function createTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  // 缩小到托盘合适尺寸
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('BiliMusic');
  tray.setContextMenu(contextMenu);

  // 左键点击托盘图标显示窗口
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  console.log('  ✅ 系统托盘已创建');
}

let resizeTimer = null;

// ============ 播放器视图位置同步 ============
// 前端把中间列占位 div 的「窗口内像素坐标」发过来，主进程据此 setBounds。
// 坐标已是相对于窗口内容区的 (getBoundingClientRect + window 内边距)。
function applyPlayerBounds(rect) {
  if (!playerView || !mainWindow) return;
  // 收紧为合法值
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(0, Math.round(rect.width));
  const h = Math.max(0, Math.round(rect.height));
  playerView.setBounds({ x, y, width: w, height: h });
}

// ============ IPC: 后端能力 ============
ipcMain.handle('bili:search', async (_e, { keyword, page, order }) => {
  try {
    return { ok: true, data: await biliApi.searchVideo(keyword, page || 1, order || 'totalrank') };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('bili:hot', async () => {
  try {
    return { ok: true, data: await biliApi.getHotMusic() };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('bili:pages', async (_e, { bvid }) => {
  try {
    return { ok: true, data: await biliApi.getVideoPages(bvid) };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('bili:getView', async (_e, { bvid }) => {
  try {
    return { ok: true, data: await biliApi.getView(bvid) };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('bili:img', async (_e, { url }) => {
  try {
    let realUrl = url;
    if (realUrl.startsWith('//')) realUrl = 'https:' + realUrl;
    if (!/^https?:\/\//.test(realUrl)) return { ok: false };
    console.log('  [img] 代理图片:', realUrl.slice(0, 80));
    const { data, contentType } = await biliApi.requestBuffer(realUrl);
    const base64 = data.toString('base64');
    console.log('  [img] 成功, size:', data.length, 'contentType:', contentType);
    return { ok: true, dataUrl: `data:${contentType};base64,${base64}` };
  } catch (e) {
    console.log('  [img] 失败:', e.message);
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('login:generateQR', async () => {
  try {
    console.log('  [login] 开始生成二维码...');
    const { url, qrcodeKey } = await login.generateQRCode();
    console.log('  [login] 二维码URL获取成功, qrcodeKey:', qrcodeKey, 'url长度:', url.length);
    return { ok: true, url, qrcodeKey };
  } catch (e) {
    console.log('  [login] 二维码生成失败:', e.message);
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('login:genQR', async (_e, { url }) => {
  // 把 B 站登录 URL 通过 qrserver.com 转成二维码 PNG 图片
  try {
    const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
    const { data, contentType } = await biliApi.requestBuffer(qrApi);
    const base64 = data.toString('base64');
    return { ok: true, dataUrl: `data:${contentType || 'image/png'};base64,${base64}` };
  } catch (e) {
    console.log('  [login] QR图片生成失败:', e.message);
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('login:poll', async (_e, { qrcodeKey }) => {
  try {
    return { ok: true, data: await login.pollLogin(qrcodeKey) };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('login:status', async () => {
  try {
    const isLogin = login.isLoggedIn();
    if (!isLogin) return { ok: true, data: { isLogin: false } };
    return { ok: true, data: await login.getUserInfo() };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('login:logout', async () => {
  try { await login.logout(); return { ok: true }; }
  catch (e) { return { ok: false, message: e.message }; }
});

// ============ IPC: 播放器视图控制 ============
// 前端通知播放区坐标 (用于把 playerView 贴上去)
ipcMain.on('player:setBounds', (_e, rect) => {
  applyPlayerBounds(rect);
});

// 登录后重新加载内嵌播放器 (让 B 站页面感知到新 cookie)
ipcMain.handle('player:reload', async (_e, { bvid, t }) => {
  if (!playerView || !bvid) return { ok: false };
  const seek = Math.floor(t || 0);
  const url = `https://www.bilibili.com/video/${bvid}`;
  try {
    await playerView.webContents.loadURL(url);
    console.log('  [player] 登录后重新加载:', bvid, 't=', seek);
    const js = `setTimeout(() => {
      var v = document.querySelector('video');
      if (v) { v.currentTime = ${seek}; if (v.paused) v.play(); }
    }, 2500)`;
    playerView.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try { playerView.webContents.executeJavaScript(js).catch(() => {}); } catch(e) {}
      }, 2500);
    });
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 加载某 BV 视频到内嵌播放器
ipcMain.handle('player:load', async (_e, { bvid, t, p }) => {
  if (!playerView) return { ok: false };
  // 多P跳转用 ?p=N (B站原生支持，比 ?t= 更可靠)
  // 单P用 ?t=seek
  let url;
  if (p && p > 1) {
    url = `https://www.bilibili.com/video/${bvid}?p=${p}`;
  } else {
    const seek = Math.floor(t || 0);
    url = `https://www.bilibili.com/video/${bvid}?t=${seek}`;
  }
  playerView.webContents.loadURL(url);
  playerVisible = true;
  return { ok: true };
});

// B 站播放器网页全屏 (点击全屏按钮左边的"网页全屏"按钮)
ipcMain.on('player:pageFullscreen', () => {
  if (!playerView) return;
  const doFullscreen = () => {
    setTimeout(() => {
      try {
        playerView.webContents.executeJavaScript(`
          // 网页全屏按钮就在全屏按钮左边
          var fullBtn = document.querySelector('.bpx-player-ctrl-full');
          if (fullBtn) {
            var prev = fullBtn.previousElementSibling;
            if (prev) prev.click();
          }
        `).catch(() => {});
      } catch(e) {}
    }, 2000);
  };

  if (playerView.webContents.isLoading()) {
    playerView.webContents.once('did-finish-load', doFullscreen);
  } else {
    doFullscreen();
  }
});

// 暂停 / 隐藏播放器 (把视图缩到 0)
ipcMain.on('player:hide', () => {
  if (!playerView) return;
  playerVisible = false;
  playerView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  // 停止播放: 加载空白
  try { playerView.webContents.stop(); } catch (e) {}
});

// 暂停 B 站播放器 (不隐藏窗口，只暂停 video)
ipcMain.handle('player:pause', async () => {
  if (!playerView) return { ok: false };
  try {
    await playerView.webContents.executeJavaScript(`
      var v = document.querySelector('video');
      if (v && !v.paused) v.pause();
    `).catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 恢复 B 站播放器
ipcMain.handle('player:resume', async () => {
  if (!playerView) return { ok: false };
  try {
    await playerView.webContents.executeJavaScript(`
      var v = document.querySelector('video');
      if (v) { if (v.paused) v.play(); }
    `).catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 查询 B 站播放器真实状态 (是否暂停、当前时间)
ipcMain.handle('player:status', async () => {
  if (!playerView) return { ok: false, data: { paused: true } };
  try {
    const info = await playerView.webContents.executeJavaScript(`
      var v = document.querySelector('video');
      if (v) { JSON.stringify({ paused: v.paused, currentTime: v.currentTime, duration: v.duration }); }
      else { 'null'; }
    `).catch(() => null);
    if (info) {
      const parsed = typeof info === 'string' ? JSON.parse(info) : info;
      return { ok: true, data: parsed };
    }
    return { ok: false, data: { paused: true } };
  } catch (e) { return { ok: false, message: e.message }; }
});

// seek: 重新加载并跳转到指定时间
ipcMain.handle('player:seek', async (_e, { bvid, t, p }) => {
  if (!playerView) return { ok: false };
  const seek = Math.floor(t);
  const url = p && p > 1
    ? `https://www.bilibili.com/video/${bvid}?p=${p}&t=${seek}`
    : `https://www.bilibili.com/video/${bvid}?t=${seek}`;
  playerView.webContents.loadURL(url);
  return { ok: true };
});

// 设置 B 站播放器音量 (0.0 ~ 1.0)
ipcMain.handle('player:setVolume', async (_e, { volume }) => {
  if (!playerView) return { ok: false };
  const v = Math.max(0, Math.min(1, volume));
  try {
    await playerView.webContents.executeJavaScript(`
      var v = document.querySelector('video');
      if (v) v.volume = ${v};
    `).catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 获取 B 站播放器当前音量
ipcMain.handle('player:getVolume', async () => {
  if (!playerView) return { ok: false, volume: 0.8 };
  try {
    const vol = await playerView.webContents.executeJavaScript(`
      var v = document.querySelector('video');
      v ? v.volume : 0.8;
    `).catch(() => 0.8);
    return { ok: true, volume: vol };
  } catch (e) { return { ok: false, volume: 0.8 }; }
});

// ============ 导入歌单存储 ============
const SONGS_FILE = path.join(app.getPath('userData'), 'imported_songs.json');

/** 读取已导入的歌单歌曲名列表 */
function loadImportedSongs() {
  try {
    if (fs.existsSync(SONGS_FILE)) {
      const data = fs.readFileSync(SONGS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) { console.log('  ⚠️ 读取歌单文件失败:', e.message); }
  return [];
}

/** 追加写入歌曲名 */
function appendImportedSongs(names) {
  const songs = loadImportedSongs();
  for (const n of names) {
    const trimmed = n.trim();
    if (trimmed && !songs.includes(trimmed)) {
      songs.push(trimmed);
    }
  }
  try {
    fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2), 'utf-8');
    console.log('  ✅ 已追加', names.length, '首歌到存储文件');
  } catch (e) { console.log('  ⚠️ 写入歌单文件失败:', e.message); }
}

// 打开文件选择对话框，导入 TXT 歌单
ipcMain.handle('import:openFile', async () => {
  if (!mainWindow) return { ok: false };
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入歌单',
      filters: [{ name: '文本文件', extensions: ['txt'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    // 追加到存储
    appendImportedSongs(lines);
    return { ok: true, count: lines.length };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

// 获取 N 首随机歌曲名
ipcMain.handle('import:getRandomSongs', async (_e, { count }) => {
  const songs = loadImportedSongs();
  const n = Math.min(count || 7, songs.length);
  // Fisher-Yates 洗牌取前 n 个
  const shuffled = [...songs];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { ok: true, songs: shuffled.slice(0, n), total: songs.length };
});

// ============ 应用生命周期 ============
app.whenReady().then(() => {
  // 加载已保存的 cookie (登录态持久化)
  login.loadCookies();

  // 先创建窗口 (不阻塞)
  createMainWindow();

  // 创建系统托盘
  createTray();

  // 后台异步获取 WBI 密钥 (不阻塞窗口显示)
  // 注意 refreshWbiKeys 内部已 try/catch，返回 true/false 表示是否真正拿到密钥
  wbi.refreshWbiKeys().then((ok) => {
    if (ok) console.log('  ✅ WBI 密钥就绪');
    else console.log('  ⚠️ WBI 密钥未获取到，将在首次搜索时重试');
  }).catch((e) => {
    console.log('  ⚠️ 启动时 WBI 获取异常:', e.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  // 关闭到托盘时不退出，除非 isQuitting
  if (!isQuitting) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tray) { tray.destroy(); tray = null; }
});
