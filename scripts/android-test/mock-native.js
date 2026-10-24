'use strict';
// 安卓原生层的 JS 模拟器(测试用 preload)。
//
// 用 contextIsolation:false 让本文件与页面同上下文, 于是:
//   - 页面脚本能拿到 window.BiliNative(等价于 Android 的 addJavascriptInterface)
//   - 我们能在页面上下文里回调 window.__bridgeResolve
// 这样就能在 Electron 里把「安卓版界面 + bili-bridge.js」完整跑一遍,
// 不需要真机或模拟器。

const calls = [];
let songs = [];

window.__mockCalls = calls;

const HOT = [
  { bvid: 'BVmock1', title: '晴天', author: '周杰伦', duration: 269, cover: '', play: 1234567 },
  { bvid: 'BVmock2', title: '七里香', author: '周杰伦', duration: 299, cover: '', play: 987654 },
  { bvid: 'BVmock3', title: '海阔天空', author: 'Beyond', duration: 326, cover: '', play: 765432 },
  { bvid: 'BVmock4', title: '富士山下', author: '陈奕迅', duration: 259, cover: '', play: 654321 },
  { bvid: 'BVmock5', title: '告白气球', author: '周杰伦', duration: 215, cover: '', play: 543210 },
  { bvid: 'BVmock6', title: '光辉岁月', author: 'Beyond', duration: 298, cover: '', play: 432109 },
  { bvid: 'BVmock7', title: '十年', author: '陈奕迅', duration: 205, cover: '', play: 321098 },
  { bvid: 'BVmock8', title: '稻香', author: '周杰伦', duration: 223, cover: '', play: 210987 },
  { bvid: 'BVmock9', title: '夜曲', author: '周杰伦', duration: 227, cover: '', play: 109876 },
  { bvid: 'BVmock10', title: '岁月如歌', author: '陈奕迅', duration: 254, cover: '', play: 98765 },
];

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function handle(method, p) {
  switch (method) {
    case 'app:info':
      return {
        ok: true,
        version: '7.6.0',
        packaged: true,
        userData: '/data/data/com.bilimusic.app/files',
        runtime: 'Android 14',
        electron: '14',
        playerVisible: false,
        hasTray: false,
      };
    case 'bili:hot':
      return { ok: true, data: HOT };
    case 'bili:search':
      return { ok: true, data: { results: HOT.slice(0, 5), hasMore: true } };
    case 'bili:pages':
      return {
        ok: true,
        data: [
          { cid: 1, page: 1, part: '第一段', duration: 120, startTime: 0 },
          { cid: 2, page: 2, part: '第二段', duration: 150, startTime: 120 },
        ],
      };
    case 'bili:getView':
      return { ok: true, data: { bvid: p.bvid, title: '模拟视频', author: 'UP主', duration: 200, cover: '' } };
    case 'bili:img':
      return { ok: true, dataUrl: TINY_PNG };
    case 'login:status':
      return { ok: true, data: { isLogin: false } };
    case 'login:generateQR':
      return { ok: true, url: 'https://passport.bilibili.com/h5-app/passport/login/scan?navid=1&qrcode_key=mockkey0123456789', qrcodeKey: 'mockkey0123456789' };
    case 'login:poll':
      return { ok: true, data: { code: 86101, message: '未扫码' } };
    case 'login:logout':
      return { ok: true };
    case 'player:getVolume':
      return { ok: true, volume: 0.8, source: 'main' };
    case 'player:status':
      return { ok: false, data: { paused: true } };
    case 'import:getRandomSongs':
      return { ok: true, songs: ['晴天 - 周杰伦', '七里香 - 周杰伦', '海阔天空 - Beyond'], total: 3 };
    case 'import:saveSongs': {
      const list = Array.isArray(p.songs) ? p.songs : [];
      let added = 0;
      list.forEach(function (n) { if (songs.indexOf(n) < 0) { songs.push(n); added++; } });
      return { ok: true, added: added, total: songs.length };
    }
    case 'file:saveText':
      return { ok: true, path: '/storage/emulated/0/Download/' + p.name };
    default:
      return { ok: true };
  }
}

window.BiliNative = {
  request: function (id, method, payloadJson) {
    let payload = {};
    try { payload = payloadJson ? JSON.parse(payloadJson) : {}; } catch (e) { /* ignore */ }
    calls.push({ method: method, payload: payload });
    let result;
    try {
      result = handle(method, payload);
    } catch (e) {
      result = { ok: false, message: String(e) };
    }
    // 模仿原生的异步回填
    setTimeout(function () {
      try { window.__bridgeResolve(id, JSON.stringify(result)); } catch (e) { /* ignore */ }
    }, 0);
  },
};
