'use strict';
// ============ 预加载脚本: 在渲染进程暴露安全 API ============
//
// 开启 contextIsolation 后，渲染进程拿不到 Node 能力。
// 这里用 contextBridge 把一组白名单 API 注入到 window.bili，
// 渲染进程只能通过这些接口与主进程通信。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bili', {
  // ---- B 站 API ----
  search: (keyword, page = 1, order = 'totalrank') =>
    ipcRenderer.invoke('bili:search', { keyword, page, order }),
  hot: () => ipcRenderer.invoke('bili:hot'),
  pages: (bvid) => ipcRenderer.invoke('bili:pages', { bvid }),
  getView: (bvid) =>
    ipcRenderer.invoke('bili:getView', { bvid }),
  img: (url) =>
    ipcRenderer.invoke('bili:img', { url }),

  // ---- 登录 ----
  generateQR: () => ipcRenderer.invoke('login:generateQR'),
  genQR: (url) => ipcRenderer.invoke('login:genQR', { url }),
  poll: (qrcodeKey) => ipcRenderer.invoke('login:poll', { qrcodeKey }),
  loginStatus: () => ipcRenderer.invoke('login:status'),
  logout: () => ipcRenderer.invoke('login:logout'),

  // ---- 内嵌播放器 ----
  playerLoad: (bvid, t = 0, p = 0) => ipcRenderer.invoke('player:load', { bvid, t, p }),
  playerReload: (bvid, t = 0) => ipcRenderer.invoke('player:reload', { bvid, t }),
  playerPause: () => ipcRenderer.invoke('player:pause'),
  playerResume: () => ipcRenderer.invoke('player:resume'),
  playerStatus: () => ipcRenderer.invoke('player:status'),
  playerSeek: (bvid, t, p = 0) => ipcRenderer.invoke('player:seek', { bvid, t, p }),
  playerHide: () => ipcRenderer.send('player:hide'),
  playerSetBounds: (rect) => ipcRenderer.send('player:setBounds', rect),
  playerSetVolume: (volume) => ipcRenderer.invoke('player:setVolume', { volume }),
  playerGetVolume: () => ipcRenderer.invoke('player:getVolume'),
  playerPageFullscreen: () => ipcRenderer.send('player:pageFullscreen'),

  // ---- 导入歌单 ----
  importOpenFile: () => ipcRenderer.invoke('import:openFile'),
  getRandomSongs: (count = 7) => ipcRenderer.invoke('import:getRandomSongs', { count }),

  // ---- 监听主进程事件 ----
  onRelayout: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('player:relayout', handler);
    return () => ipcRenderer.removeListener('player:relayout', handler);
  },
});
