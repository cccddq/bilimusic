'use strict';
// ============ 安卓桥 (仅安卓生效) ============
//
// 桌面端由 preload.js + ipcMain 提供 window.bili.*; 安卓端没有 preload,
// 这里用同一套方法名把 window.bili.* 建出来, 底层走原生注入的 BiliNative。
//
//   JS(renderer.js)  ->  window.bili.xxx()  ->  BiliNative.request(id, method, payload)
//   原生处理完       ->  window.__bridgeResolve(id, json)  ->  Promise resolve
//   原生主动通知     ->  window.__bridgeEvent(name, json)  ->  onXxx 回调
//
// 桌面端加载时 window.BiliNative 不存在, 本文件直接返回, 不影响 Electron 版本。

(function () {
  var native = window.BiliNative;
  if (!native || window.bili) return;

  // 让样式知道这是触摸设备(悬停控件要常显)
  try {
    document.documentElement.classList.add('android');
    if (document.body) document.body.classList.add('touch');
  } catch (e) { /* ignore */ }

  // qr.js 是 CommonJS 模块, 这里给它一个临时的 module
  window.module = window.module || { exports: {} };

  // ---------------- 调用原生 ----------------
  var seq = 0;
  var pending = new Map();

  window.__bridgeResolve = function (id, json) {
    var done = pending.get(id);
    if (!done) return;
    pending.delete(id);
    var data;
    try { data = JSON.parse(json); } catch (e) { data = { ok: false, message: '返回解析失败' }; }
    done(data);
  };

  function call(method, payload) {
    return new Promise(function (resolve) {
      var id = ++seq;
      pending.set(id, resolve);
      try {
        native.request(id, method, JSON.stringify(payload || {}));
      } catch (e) {
        pending.delete(id);
        resolve({ ok: false, message: String(e) });
      }
    });
  }

  /** 不需要返回值的高频调用(坐标同步等) */
  function send(method, payload) {
    try { native.request(++seq, method, JSON.stringify(payload || {})); } catch (e) { /* ignore */ }
  }

  // ---------------- 原生 -> 页面事件 ----------------
  var handlers = {};
  window.__bridgeEvent = function (name, json) {
    var list = handlers[name] || [];
    var payload = null;
    try { payload = JSON.parse(json); } catch (e) { payload = null; }
    list.forEach(function (fn) { try { fn(payload); } catch (e) { /* ignore */ } });
  };
  function on(name, cb) {
    if (!handlers[name]) handlers[name] = [];
    handlers[name].push(cb);
    return function () {
      handlers[name] = (handlers[name] || []).filter(function (f) { return f !== cb; });
    };
  }

  // ---------------- 二维码: 复用 src/qr.js ----------------
  var qrPromise = null;
  function loadQr() {
    if (qrPromise) return qrPromise;
    qrPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'qr.js';
      s.onload = function () {
        var mod = window.module && window.module.exports;
        if (mod && typeof mod.toDataUrl === 'function') resolve(mod);
        else reject(new Error('qr.js 未导出 toDataUrl'));
      };
      s.onerror = function () { reject(new Error('qr.js 加载失败')); };
      document.head.appendChild(s);
    });
    return qrPromise;
  }

  // ---------------- window.bili (与 preload 同名同参) ----------------
  window.bili = {
    search: function (keyword, page, order) {
      return call('bili:search', { keyword: keyword, page: page || 1, order: order || 'totalrank' });
    },
    hot: function () { return call('bili:hot'); },
    pages: function (bvid) { return call('bili:pages', { bvid: bvid }); },
    getView: function (bvid) { return call('bili:getView', { bvid: bvid }); },
    img: function (url) { return call('bili:img', { url: url }); },

    generateQR: function () { return call('login:generateQR'); },
    genQR: function (url) {
      // 与桌面端一致: 本地生成 SVG data URL, 不外发
      return loadQr().then(function (qr) {
        return { ok: true, dataUrl: qr.toDataUrl(url, { ecc: 'M', margin: 1, scale: 4 }) };
      });
    },
    poll: function (qrcodeKey) { return call('login:poll', { qrcodeKey: qrcodeKey }); },
    loginStatus: function () { return call('login:status'); },
    logout: function () { return call('login:logout'); },

    appInfo: function () { return call('app:info'); },

    playerLoad: function (bvid, t, p) { return call('player:load', { bvid: bvid, t: t || 0, p: p || 0 }); },
    playerReload: function (bvid, t, p) { return call('player:reload', { bvid: bvid, t: t || 0, p: p || 0 }); },
    playerPause: function () { return call('player:pause'); },
    playerResume: function () { return call('player:resume'); },
    playerStatus: function () { return call('player:status'); },
    playerSeek: function (bvid, t, p) { return call('player:seek', { bvid: bvid, t: t, p: p || 0 }); },
    playerHide: function () { send('player:hide', {}); },
    playerSetBounds: function (rect) { send('player:setBounds', rect); },
    playerSetVolume: function (volume) { return call('player:setVolume', { volume: volume }); },
    playerGetVolume: function () { return call('player:getVolume'); },
    playerPageFullscreen: function () { send('player:pageFullscreen', {}); },

    importSongs: function (songs) { return call('import:saveSongs', { songs: songs }); },
    getRandomSongs: function (count) { return call('import:getRandomSongs', { count: count || 7 }); },

    onRelayout: function (cb) { return on('player:relayout', cb); },
    onPlayerFailed: function (cb) { return on('player:failed', cb); },
  };

  // ---------------- 导出: Android WebView 不支持 blob: 下载, 改走原生保存 ----------------
  var rawCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    var url = rawCreateObjectURL(blob);
    pendingBlobs[url] = blob;
    return url;
  };
  var pendingBlobs = {};

  var rawClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      var href = this.getAttribute('href') || '';
      if (this.hasAttribute('download') && href.indexOf('blob:') === 0) {
        var name = this.getAttribute('download') || 'bilimusic-export.json';
        var blob = pendingBlobs[href];
        if (blob) {
          blob.text().then(function (text) {
            return call('file:saveText', { name: name, text: text });
          }).then(function (res) {
            if (typeof showToast === 'function') {
              if (res && res.ok) showToast('已保存到「下载」目录：' + name, 'success');
              else showToast('导出失败：' + ((res && res.message) || '未知错误'), 'error');
            }
          }).catch(function () {
            if (typeof showToast === 'function') showToast('导出失败', 'error');
          });
          delete pendingBlobs[href];
          return;
        }
      }
    } catch (e) { /* 落到原生行为 */ }
    return rawClick.apply(this, arguments);
  };

  // ---------------- 返回键 ----------------
  // 返回 true 表示页面已经处理(原生不再把应用切后台)
  window.__androidBackPressed = function () {
    try {
      var panel = document.getElementById('themePanel');
      if (panel && panel.classList.contains('open') && typeof hideThemePanel === 'function') {
        hideThemePanel();
        return true;
      }
      if (document.body.classList.contains('playlist-focus') && typeof togglePlaylistFocus === 'function') {
        togglePlaylistFocus(false);
        return true;
      }
      var login = document.getElementById('loginModal');
      if (login && login.style.display === 'flex' && typeof closeLogin === 'function') {
        closeLogin();
        return true;
      }
      var settings = document.getElementById('settingsModal');
      if (settings && settings.style.display === 'flex' && typeof closeSettings === 'function') {
        closeSettings();
        return true;
      }
      var np = document.getElementById('newPlaylistModal');
      if (np && np.style.display === 'flex' && typeof closeNewPlaylistModal === 'function') {
        closeNewPlaylistModal();
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  };
})();
