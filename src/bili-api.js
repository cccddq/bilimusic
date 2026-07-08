'use strict';
// ============ B 站 API 请求层 (主进程) ============
//
// 使用 Node 原生 https 模块发起请求 (而非 Electron net 模块)。
// 原因: net 模块走 Chromium 网络栈，在本机会卡住/失败;
//       Node 原生模块更可靠，且主进程本就无同源限制。
//
// Cookie 由 login.js 独立管理 (内存 dict, 启动时从文件加载)。

const https = require('https');
const http = require('http');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 全局 cookie 存储 (由 login.js 维护)
let _cookieStr = '';
function setCookieStr(s) { _cookieStr = s || ''; }
function getCookieStr() { return _cookieStr; }

/**
 * 通用请求，返回 { status, headers, body:Buffer }。Node 原生 https，自动跟随重定向。
 */
function requestRaw(targetUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    let reqUrl = targetUrl;
    const wbi = require('./wbi');

    if (opts.sign) {
      if (!wbi.hasMixKey()) return reject(new Error('WBI 密钥未就绪'));
      reqUrl = wbi.signWbi(targetUrl);
    }

    const timeout = (opts.timeout || 15) * 1000;
    let timer = null;
    const baseHeaders = Object.assign({
      'User-Agent': UA,
      'Referer': 'https://www.bilibili.com',
      'Origin': 'https://www.bilibili.com',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, opts.headers || {});

    function doRequest(currentUrl, depth = 0) {
      if (depth > 5) { if (timer) clearTimeout(timer); return reject(new Error('重定向次数过多')); }

      const cu = new URL(currentUrl);
      const headers = Object.assign({}, baseHeaders);
      if (_cookieStr) headers['Cookie'] = _cookieStr;

      const r = (cu.protocol === 'http:' ? http : https).request({
        hostname: cu.hostname,
        port: cu.port || (cu.protocol === 'http:' ? 80 : 443),
        path: cu.pathname + cu.search,
        method: opts.method || 'GET',
        headers,
      }, (res) => {
        // 跟随重定向
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          let loc = res.headers.location;
          if (loc.startsWith('/')) loc = `${cu.protocol}//${cu.host}${loc}`;
          return doRequest(loc, depth + 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (timer) clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      });
      r.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
      if (opts.body) r.write(opts.body);
      r.end();
    }

    timer = setTimeout(() => reject(new Error(`请求超时: ${reqUrl.slice(0, 80)}`)), timeout);
    doRequest(reqUrl);
  });
}

async function requestJson(url, opts = {}) {
  const { body } = await requestRaw(url, opts);
  const text = body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败: ${e.message}; body=${text.slice(0, 200)}`);
  }
}

async function getJson(url, opts) {
  return requestJson(url, opts || {});
}

// ============ 业务接口 ============

/**
 * 搜索视频 (走 WBI 签名路径)
 */
async function searchVideo(keyword, page = 1, order = 'totalrank') {
  await require('./wbi').autoRefreshWbi();
  const u = new URL('https://api.bilibili.com/x/web-interface/wbi/search/type');
  u.searchParams.set('search_type', 'video');
  u.searchParams.set('keyword', keyword);
  u.searchParams.set('page', String(page));
  u.searchParams.set('order', order);

  const data = await requestJson(u.toString(), { sign: true });
  if (data.code !== 0) throw new Error(`[${data.code}] ${data.message || ''}`);

  const result = (data.data && data.data.result) || [];
  const results = result.map((r) => ({
    bvid: r.bvid,
    aid: r.aid,
    title: (r.title || '').replace(/<em class="keyword">|<\/em>/g, ''),
    author: r.author,
    duration: parseDuration(r.duration),
    cover: r.pic || '',
    play: r.play,
  }));
  return { results, hasMore: page < ((data.data && data.data.numPages) || 1) };
}

/**
 * 获取热门推荐歌曲（随机关键词搜索，打乱后返回 10 首）
 * 用于首页推荐歌单展示
 */
const HOT_KEYWORDS = [
  '热门歌曲', '新歌榜', '华语金曲', '抖音热门', 'BGM',
  '治愈系音乐', '纯音乐', '电音', '日语歌', '经典老歌',
  '网络热歌', '翻唱', '流行歌曲', '伤感歌曲', '说唱',
];
async function getHotMusic() {
  // 随机选关键词和页数
  const kw = HOT_KEYWORDS[Math.floor(Math.random() * HOT_KEYWORDS.length)];
  const page = Math.floor(Math.random() * 3) + 1; // 1-3 页
  try {
    const { results } = await searchVideo(kw, page, 'click');
    // 打乱顺序
    for (let i = results.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [results[i], results[j]] = [results[j], results[i]];
    }
    return results.slice(0, 10);
  } catch (e) {
    // 兜底: 换关键词重试一次
    const kw2 = HOT_KEYWORDS[Math.floor(Math.random() * HOT_KEYWORDS.length)];
    const page2 = Math.floor(Math.random() * 3) + 1;
    const { results } = await searchVideo(kw2, page2, 'click');
    for (let i = results.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [results[i], results[j]] = [results[j], results[i]];
    }
    return results.slice(0, 10);
  }
}

/**
 * 通过 BV 号获取视频详情
 */
async function getView(bvid) {
  const u = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const data = await requestJson(u);
  if (data.code !== 0) throw new Error(data.message || '获取失败');
  const v = data.data;
  return {
    bvid,
    title: v.title,
    author: (v.owner && v.owner.name) || '',
    duration: v.duration,
    cover: v.pic || '',
  };
}

/**
 * 获取视频的分集信息 (多P列表 / 章节)
 * 返回 [{ part, duration, startTime }] 按顺序排列
 *   - part: 分段标题
 *   - duration: 本段时长 (秒)
 *   - startTime: 本段起始时间 (秒) — 根据前面各段总和计算
 */
async function getVideoPages(bvid) {
  const data = await requestJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (data.code !== 0) throw new Error(data.message || '获取失败');
  
  const pages = (data.data && data.data.pages) || [];
  if (!pages.length) return [];
  
  let cumulativeTime = 0;
  const result = [];
  for (const p of pages) {
    result.push({
      cid: p.cid,
      page: p.page,
      part: p.part || '',
      duration: p.duration || 0,
      startTime: cumulativeTime,
    });
    cumulativeTime += (p.duration || 0);
  }
  return result;
}

/**
 * 获取当前登录用户信息 (nav)
 */
async function getNav() {
  return requestJson('https://api.bilibili.com/x/web-interface/nav');
}

/**
 * 获取二进制数据 (图片代理)。返回 { data: Buffer, contentType: string }
 */
async function requestBuffer(url) {
  const { headers, body } = await requestRaw(url);
  return { data: body, contentType: (headers['content-type'] || 'image/jpeg').split(';')[0] };
}

function parseDuration(d) {
  if (!d) return 0;
  if (typeof d === 'number') return d;
  const m = String(d).match(/(\d+):(\d+)/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : (parseInt(d, 10) || 0);
}

module.exports = {
  requestRaw,
  requestJson,
  requestBuffer,
  getJson,
  searchVideo,
  getHotMusic,
  getView,
  getVideoPages,
  getNav,
  parseDuration,
  setCookieStr,
  getCookieStr,
};
