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
    let activeReq = null;   // 超时时要主动 destroy, 否则 socket 会一直挂着
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
          activeReq = null;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      });
      activeReq = r;
      r.on('error', (err) => { if (timer) clearTimeout(timer); activeReq = null; reject(err); });
      if (opts.body) r.write(opts.body);
      r.end();
    }

    timer = setTimeout(() => {
      const msg = `请求超时: ${reqUrl.slice(0, 80)}`;
      if (activeReq) { try { activeReq.destroy(new Error(msg)); } catch (e) { /* ignore */ } }
      reject(new Error(msg));
    }, timeout);
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


/* ============ B 站收藏夹(供「同步到 bilimusic」使用) ============ */
const FAV_TITLE = 'bilimusic';

function cookieValue(name) {
  const m = String(_cookieStr || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function csrfToken() { return cookieValue('bili_jct'); }
const favSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function favFolders(mid) {
  const json = await requestJson('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + encodeURIComponent(mid) + '&jsonp=jsonp', { timeout: 15, sign: true });
  if (!json || json.code !== 0) throw new Error('读取收藏夹列表失败：' + ((json && json.message) || '未知错误'));
  const list = (json.data && json.data.list) || [];
  return list.map((f) => ({ id: f.id, title: f.title, count: f.media_count }));
}

async function favCreate(title) {
  const body = 'title=' + encodeURIComponent(title) + '&privacy=0&csrf=' + encodeURIComponent(csrfToken());
  const json = await requestJson('https://api.bilibili.com/x/v3/fav/folder/add', {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20,
  });
  if (!json || json.code !== 0) throw new Error('创建收藏夹失败：' + ((json && json.message) || '未知错误'));
  return json.data && json.data.id;
}

async function favResourceIds(mediaId) {
  const json = await requestJson('https://api.bilibili.com/x/v3/fav/resource/ids?media_id=' + encodeURIComponent(mediaId) + '&platform=web', { timeout: 15, sign: true });
  if (!json || json.code !== 0) throw new Error('读取收藏夹内容失败：' + ((json && json.message) || '未知错误'));
  return (json.data || []).map((x) => String(x.id));
}

async function bvidToAid(bvid) {
  try {
    const json = await requestJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { timeout: 15, sign: true });
    if (!json || json.code !== 0 || !json.data) return 0;
    return Number(json.data.aid) || 0;
  } catch (e) {
    return 0;
  }
}

async function aidToVideo(aid) {
  try {
    const json = await requestJson('https://api.bilibili.com/x/web-interface/view?aid=' + encodeURIComponent(aid), { timeout: 15, sign: true });
    if (!json || json.code !== 0 || !json.data) return null;
    const d = json.data;
    return {
      bvid: d.bvid,
      title: d.title,
      author: (d.owner && d.owner.name) || '',
      duration: Number(d.duration) || 0,
      cover: d.pic || '',
    };
  } catch (e) {
    return null;
  }
}

/**

 * 把参数签名后返回可直接作为 x-www-form-urlencoded body 的字符串。
 * POST 接口(收藏夹写入/创建)要求 wts 与 w_rid 出现在表单里, 而不是 URL 上,
 * 否则服务端会判定参数非法(-400)。
 */
function signForm(baseUrl, params) {
  const wbi = require('./wbi');
  if (!wbi.hasMixKey()) throw new Error('WBI 密钥未就绪，请稍后重试');
  const qs = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])))
    .join('&');
  const signed = wbi.signWbi(baseUrl + '?' + qs);
  const q = signed.indexOf('?');
  return q >= 0 ? signed.slice(q + 1) : qs;
}

let _lastFavPlan = null;

/** 第一步: 只读检查(算清楚要加几首, 不写任何东西) */
async function favPlan(bvids) {
  const list = (Array.isArray(bvids) ? bvids : []).filter(Boolean).slice(0, 300);
  const mid = cookieValue('DedeUserID');
  if (!mid) throw new Error('还没登录 B 站（缺少 DedeUserID），请先扫码登录');
  if (!csrfToken()) throw new Error('登录凭证不完整（缺少 bili_jct），请重新登录');

  const folders = await favFolders(mid);
  const folder = folders.find((f) => String(f.title || '').toLowerCase() === FAV_TITLE) || null;
  const existed = folder ? await favResourceIds(folder.id) : [];
  const existedSet = new Set(existed);

  // 本地 → aid
  const aids = [];
  let failed = 0;
  for (const bvid of list) {
    const aid = await bvidToAid(bvid);
    if (aid) aids.push({ bvid: bvid, aid: aid }); else failed++;
    await favSleep(80);
  }
  const localAidSet = new Set(aids.map((x) => String(x.aid)));
  if (list.length > 0 && aids.length === 0) {
    throw new Error('取不到任何 aid（' + failed + ' 首失败）：视频信息接口被风控或登录已过期，请重新扫码登录后再试');
  }
  const toAdd = aids.filter((x) => !existedSet.has(String(x.aid)));
  const keepBvids = aids.filter((x) => existedSet.has(String(x.aid))).map((x) => x.bvid);
  const localOnly = toAdd.map((x) => x.bvid);
  const folderOnlyAids = existed.filter((id) => !localAidSet.has(String(id)));

  // 收藏夹里本地没有的 → 取回(最多 100 首)

  const toPull = [];
  let pullFailed = 0;
  for (const aid of folderOnlyAids.slice(0, 100)) {
    const v = await aidToVideo(aid);
    if (v && v.bvid) toPull.push(v); else pullFailed++;
    await favSleep(80);
  }

  _lastFavPlan = {
    at: Date.now(),
    folderId: folder ? folder.id : null,
    toAdd: toAdd,
    folderOnlyAids: folderOnlyAids,
    already: aids.length - toAdd.length,
    failed: failed,
    total: list.length,
  };
  return {
    total: list.length,
    folderExists: !!folder,
    folderId: folder ? folder.id : null,
    folderCount: existed.length,
    already: aids.length - toAdd.length,
    toAdd: toAdd.length,
    localOnly: localOnly,
    keepBvids: keepBvids,
    folderOnly: folderOnlyAids.length,
    toPull: toPull,
    pullFailed: pullFailed,
    failed: failed,
  };
}

/** 第二步: 真正写入(必须先调 favPlan) */
async function favSync(mode) {
  const plan = _lastFavPlan && Date.now() - _lastFavPlan.at < 300000 ? _lastFavPlan : null;
  if (!plan) throw new Error('请先执行一次检查');
  const dir = mode === 'local' ? 'local' : 'remote';

  // 收藏夹为母本: 不写 B 站, 由渲染层改本地歌单
  if (dir === 'remote') {
    return { mode: dir, added: 0, removed: 0, created: false, folderId: plan.folderId, already: plan.already };
  }

  let folderId = plan.folderId;
  let created = false;
  if (!folderId) {
    folderId = await favCreate(FAV_TITLE);
    created = true;
  }
  if (!folderId) throw new Error('没能拿到收藏夹 id');

  const dealUrl = 'https://api.bilibili.com/x/v3/fav/resource/deal';
  const hdrs = { 'Content-Type': 'application/x-www-form-urlencoded' };

  // 该接口一次只接受一个 rid(批量会 -400), 所以逐首发, 失败重试一次
  const dealOne = async (params, what) => {
    let json = null;
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await favSleep(900);
      try {
        json = await requestJson(dealUrl + '?' + signForm(dealUrl, params), { method: 'POST', headers: hdrs, timeout: 25 });
      } catch (e) {
        json = { code: -1, message: e.message };
      }
      if (json && json.code === 0) return true;
      lastErr = (json && json.code) + ' ' + ((json && json.message) || '');
    }
    throw new Error(what + '失败（' + lastErr + '）');
  };

  let added = 0;
  for (let i = 0; i < plan.toAdd.length; i++) {
    await dealOne({
      rid: String(plan.toAdd[i].aid), type: 2, add_media_ids: String(folderId), csrf: csrfToken(), platform: 'web',
    }, '推送第 ' + (i + 1) + '/' + plan.toAdd.length + ' 首');
    added++;
    await favSleep(350);
  }

  let removed = 0;
  const delList = plan.folderOnlyAids || [];
  for (let i = 0; i < delList.length; i++) {
    await dealOne({
      rid: String(delList[i]), type: 2, del_media_ids: String(folderId), csrf: csrfToken(), platform: 'web',
    }, '删除收藏夹第 ' + (i + 1) + '/' + delList.length + ' 首');
    removed++;
    await favSleep(350);
  }

  _lastFavPlan = null;
  return { mode: dir, folderId: folderId, created: created, added: added, removed: removed, already: plan.already, failed: plan.failed, total: plan.total };
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
  favPlan,
  favSync,
};
