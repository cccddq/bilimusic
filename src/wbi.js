'use strict';
// ============ WBI 签名 (从 server.py 等价移植) ============
// 参考: https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/misc/sign/wbi.md
//
// Electron 主进程模块。负责:
//   1. 从 B 站获取 img_key / sub_key
//   2. 计算混合密钥 mix_key (用打乱表重排)
//   3. 给 API 请求 URL 追加 wts(时间戳) 与 w_rid(MD5 签名)
//
// 与原 server.py 行为一致，密钥 4 小时自动刷新。

const crypto = require('crypto');
const biliApi = require('./bili-api');

// 打乱表 —— 与 server.py 完全一致，勿改
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// 内部状态
const _wbiKeys = { imgKey: '', subKey: '', mixKey: '', lastUpdate: 0 };

/**
 * 根据 img_key + sub_key 计算混合密钥 mix_key
 * 与 server.py get_mix_key() 等价
 */
function getMixKey(imgKey, subKey) {
  const s = imgKey + subKey;
  const chars = [];
  for (const i of MIXIN_KEY_ENC_TAB) {
    if (i < s.length) chars.push(s[i]);
  }
  return chars.join('').slice(0, 32);
}

/**
 * 从 WBI 密钥图片 URL 中提取 key 部分（取路径最后一段去掉扩展名）
 */
function extractKeyFromUrl(url) {
  const m = url.split('/').pop();
  return m ? m.split('.')[0] : '';
}

/**
 * 写入密钥并计算 mix_key
 */
function setKeys(imgUrl, subUrl) {
  const imgKey = extractKeyFromUrl(imgUrl);
  const subKey = extractKeyFromUrl(subUrl);
  if (imgKey && subKey) {
    _wbiKeys.imgKey = imgKey;
    _wbiKeys.subKey = subKey;
    _wbiKeys.mixKey = getMixKey(imgKey, subKey);
    _wbiKeys.lastUpdate = Date.now();
    console.log(`  🔑 WBI密钥已更新: mix_key前8位=${_wbiKeys.mixKey.slice(0, 8)}...`);
    return true;
  }
  console.log(`  ⚠️ 密钥提取失败: img=${imgKey} sub=${subKey}`);
  return false;
}

/**
 * 刷新 WBI 密钥。
 * 方式1: nav API 的 wbi_img 字段（最稳定）
 * 失败回退到首页 HTML 抓取（这里仅保留 nav，与原项目主路径一致）。
 */
async function refreshWbiKeys() {
  // 方式1: nav API
  // 注意: 未登录时 code=-101，但 wbi_img 字段仍然返回，所以不依赖 code===0
  try {
    const data = await biliApi.getJson('https://api.bilibili.com/x/web-interface/nav', { sign: false });
    const wbi = data && data.data && data.data.wbi_img;
    if (wbi && wbi.img_url && wbi.sub_url) {
      console.log('  🔑 从 nav API 获取到WBI密钥');
      return setKeys(wbi.img_url, wbi.sub_url);
    }
    console.log(`  ⚠️ nav 无 wbi_img 字段 (code=${data && data.code})`);
  } catch (e) {
    console.log(`  ⚠️ nav API 异常: ${e.message}`);
  }
  return false;
}

/**
 * 密钥超过 4 小时则自动刷新
 */
async function autoRefreshWbi() {
  if (Date.now() - (_wbiKeys.lastUpdate || 0) > 4 * 60 * 60 * 1000) {
    await refreshWbiKeys();
  }
}

function hasMixKey() {
  return !!_wbiKeys.mixKey;
}

/**
 * 为 B 站 API 请求 URL 添加 WBI 签名参数 (wts + w_rid)
 * 与 server.py sign_wbi() 等价。
 *
 * 注意编码细节: 值需按 server.py 的做法用 encodeURIComponent，但
 * WBI 规范要求某些特殊字符先过滤。这里保持与原项目一致(直接 urlencode)。
 *
 * @param {string} url 完整 URL
 * @returns {string} 已签名 URL
 */
function signWbi(url) {
  const u = new URL(url);
  const params = u.searchParams;

  // 添加时间戳
  params.set('wts', String(Math.floor(Date.now() / 1000)));

  // 按 key 排序，构建待签名字符串
  const sorted = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // 过滤特殊字符 (WBI 规范: 值中的 !()*-' 需移除) ——与官方实现一致
  const filterVal = (v) => v.replace(/[!'()*]/g, '');
  const query = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(filterVal(v))}`).join('&');

  // w_rid = md5(query + mix_key)
  const wRid = crypto.createHash('md5').update(query + _wbiKeys.mixKey).digest('hex');
  params.set('w_rid', wRid);

  u.search = params.toString();
  return u.toString();
}

module.exports = {
  refreshWbiKeys,
  autoRefreshWbi,
  signWbi,
  hasMixKey,
};
