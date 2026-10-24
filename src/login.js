'use strict';
// ============ B 站扫码登录 (主进程) ============
//
// 由于改用 Node 原生 https (不走 Electron session)，cookie 不能再用
// session.cookies 管理。这里用独立的内存 dict + 文件持久化方案:
//   - 启动时从 userData/cookies.json 加载
//   - 登录成功时写入 dict 并保存文件
//   - bili-api 通过 getCookieStr() 读取
//
// 这与原 server.py 的 BiliCookieJar 思路一致，更可控。

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const biliApi = require('./bili-api');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 内存 cookie 存储: name -> value
const _cookies = {};
let _cookieFile = '';
let _loaded = false;

function cookieFilePath() {
  if (_cookieFile) return _cookieFile;
  try {
    const dir = app.getPath('userData');
    _cookieFile = path.join(dir, 'cookies.json');
  } catch (e) {
    _cookieFile = path.join(__dirname, '..', '.electron-data', 'cookies.json');
  }
  return _cookieFile;
}

/** 从文件加载已保存的 cookie */
function loadCookies() {
  if (_loaded) return;
  _loaded = true;
  try {
    const f = cookieFilePath();
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      Object.assign(_cookies, data);
      console.log(`  🍪 从文件加载 ${Object.keys(_cookies).length} 个 cookie`);
      syncToBiliApi();
    }
  } catch (e) {
    console.log(`  ⚠️ 加载 cookie 失败: ${e.message}`);
  }
}

/** 保存 cookie 到文件 */
function saveCookies() {
  try {
    const dir = path.dirname(cookieFilePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cookieFilePath(), JSON.stringify(_cookies, null, 2));
  } catch (e) {
    console.log(`  ⚠️ 保存 cookie 失败: ${e.message}`);
  }
}

/** 同步内存 cookie 到 bili-api (作为请求头) */
function syncToBiliApi() {
  const parts = [];
  for (const [name, value] of Object.entries(_cookies)) {
    parts.push(`${name}=${value}`);
  }
  biliApi.setCookieStr(parts.join('; '));
}

/** 从 Set-Cookie 头解析并写入内存 */
function absorbSetCookies(setCookieHeaders) {
  if (!setCookieHeaders) return 0;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  let count = 0;
  for (const header of headers) {
    const m = String(header).split(';')[0].match(/^([^=]+)=(.*)$/);
    if (m) {
      _cookies[m[1].trim()] = m[2].trim();
      count++;
    }
  }
  if (count) { syncToBiliApi(); saveCookies(); }
  return count;
}

// ============ 登录流程 ============

/**
 * 步骤1: 生成登录二维码。返回 { url, qrcodeKey }
 * 同时吸收响应里的 Set-Cookie (buvid3 等)。
 */
async function generateQRCode() {
  const { headers, body } = await biliApi.requestRaw(
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
  );
  absorbSetCookies(headers['set-cookie']);
  const data = JSON.parse(body.toString('utf8'));
  if (data.code !== 0) throw new Error(data.message || '生成二维码失败');
  return { url: data.data.url, qrcodeKey: data.data.qrcode_key };
}

/**
 * 步骤2: 轮询登录状态。
 * 返回 { code, message, url? }
 */
async function pollLogin(qrcodeKey) {
  const { headers, body } = await biliApi.requestRaw(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`
  );
  absorbSetCookies(headers['set-cookie']);

  const data = JSON.parse(body.toString('utf8'));
  // B站 passport API 响应有两层 code:
  //   顶层 data.code = 0 表示"API 调用成功"
  //   内层 data.data.code 才是真正的扫码状态:
  //      86101 = 未扫码, 86090 = 已扫码待确认, 86038 = 已过期, 0 = 扫码成功
  // 所以我们取内层的 code 返回给前端
  const inner = (data && data.data) || {};
  const scanCode = (inner.code !== undefined) ? inner.code : (data.code || -1);
  const result = { code: scanCode, message: inner.message || data.message || '' };

  if (scanCode === 0) {
    const redirectUrl = inner.url || '';
    result.url = redirectUrl;
    // 从 data 直接补 cookie (兜底)
    setCookiesFromData(inner);
    // 跟随 redirect_url 拿 SESSDATA
    if (redirectUrl) await followRedirectForCookie(redirectUrl);
    // 同步到 Electron session (让内嵌播放器也登录)
    await syncCookiesToElectronSession();
  }
  return result;
}

/**
 * 跟随 redirect_url，吸收过程中所有 Set-Cookie
 */
async function followRedirectForCookie(url) {
  try {
    const { headers } = await biliApi.requestRaw(url, { timeout: 10 });
    const sc = headers['set-cookie'];
    if (sc) {
      const n = absorbSetCookies(sc);
      console.log(`  🍪 登录重定向吸收 ${n} 个 cookie`);
    }
  } catch (e) {
    console.log(`  ⚠️ 跟随登录重定向失败: ${e.message}`);
  }
}

/** 从 poll 响应 data 直接补 cookie */
function setCookiesFromData(data) {
  const fields = [
    ['sessdata', 'SESSDATA'], ['SESSDATA', 'SESSDATA'],
    ['DedeUserID', 'DedeUserID'], ['dedeuserid', 'DedeUserID'],
    ['bili_jct', 'bili_jct'],
  ];
  let added = 0;
  for (const [field, name] of fields) {
    const val = data[field];
    if (val) { _cookies[name] = String(val); added++; }
  }
  if (added) { syncToBiliApi(); saveCookies(); }
}

/** 是否已登录 (内存里有 SESSDATA) */
function isLoggedIn() {
  return !!_cookies['SESSDATA'];
}

/**
 * 登录成功后，把 cookie 同步到 Electron 默认 session。
 * 这样内嵌播放器 (WebContentsView) 里的 B 站页面也能识别已登录。
 */
async function syncCookiesToElectronSession() {
  try {
    const { session } = require('electron');
    const ses = session.defaultSession;
    for (const [name, value] of Object.entries(_cookies)) {
      try {
        await ses.cookies.set({
          url: 'https://www.bilibili.com',
          name,
          value: String(value),
          domain: '.bilibili.com',
          path: '/',
          secure: true,
          httpOnly: name === 'SESSDATA' || name === 'bili_jct',
        });
      } catch (e) { /* 单条 cookie 设置失败不阻塞 */ }
    }
    console.log(`  🍪 已同步 ${Object.keys(_cookies).length} 个 cookie 到 Electron session`);
  } catch (e) {
    console.log(`  ⚠️ 同步 cookie 到 session 失败: ${e.message}`);
  }
}

/** 获取登录用户信息 (nav) */
async function getUserInfo() {
  try {
    const data = await biliApi.getNav();
    if (data.code === 0 && data.data && data.data.isLogin) {
      return {
        isLogin: true,
        uid: String(data.data.mid || ''),
        uname: data.data.uname || '',
        face: data.data.face || '',
      };
    }
  } catch (e) { /* ignore */ }
  return { isLogin: false };
}

/** 登出 */
function logout() {
  for (const k of Object.keys(_cookies)) delete _cookies[k];
  syncToBiliApi();
  try { fs.unlinkSync(cookieFilePath()); } catch (e) {}
}

module.exports = {
  loadCookies,
  // 启动时把已保存的 cookie 同步进 Electron session(否则重启后内嵌播放器是未登录)
  syncCookiesToElectronSession,
  generateQRCode,
  pollLogin,
  isLoggedIn,
  getUserInfo,
  logout,
};
