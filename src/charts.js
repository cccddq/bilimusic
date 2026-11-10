'use strict';
// ============ 各音乐站榜单抓取(只取歌名/歌手, 不需要音源) ============
//
// 只做一件事: 把"某个站某个榜"的前 N 首变成 [{ title, artist }]。
// 三家接口形态差很多, 所以每家有独立的解析函数; 任何一家失败都不影响其他家。
//
//  网易云   music.163.com/api/playlist/detail?id=<歌单id>
//  QQ音乐   c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=<id>
//  酷狗     mobilecdn.kugou.com/api/v3/rank/song?rankid=<id>   (只支持 http, https 证书不匹配)
//
// 注意: 这些都是各站"公开榜单页"用的只读接口, 可能随时变动或限流。

const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 榜单目录: 页面上的"卡内切榜"就是在这里面轮换 */
const CHARTS = {
  netease: {
    label: '网易云',
    color: '#e94b4b',
    charts: [
      { key: 'hot', name: '热歌榜', id: 3778678 },
      { key: 'rise', name: '飙升榜', id: 19723756 },
      { key: 'new', name: '新歌榜', id: 3779629 },
    ],
  },
  qq: {
    label: 'QQ音乐',
    color: '#21b573',
    charts: [
      { key: 'hot', name: '热歌榜', id: 26 },
      { key: 'new', name: '新歌榜', id: 27 },
      { key: 'rise', name: '飙升榜', id: 62 },
      { key: 'index', name: '流行指数', id: 4 },
    ],
  },
  kugou: {
    label: '酷狗',
    color: '#2aa7f0',
    charts: [
      { key: 'top500', name: 'TOP500', id: 8888 },
    ],
  },
};

function request(url, headers, timeout = 12000) {
  const lib = url.startsWith('http:') ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      headers: Object.assign({
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
      }, headers || {}),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return resolve(request(next, headers, timeout));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

function parseJson(body) {
  try { return JSON.parse(body); } catch (e) { throw new Error('返回的不是 JSON'); }
}

/** 统一清洗: 去空白、去空项、去重复(歌名+歌手) */
function normalize(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const title = String(item.title == null ? '' : item.title).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const artist = String(item.artist == null ? '' : item.artist).replace(/\s+/g, ' ').trim();
    const id = title + '\u0000' + artist;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ title, artist });
  }
  return out;
}

/* ---------------- 网易云 ---------------- */
async function fetchNetease(id) {
  const r = await request('https://music.163.com/api/playlist/detail?id=' + encodeURIComponent(id) + '&n=1000', {
    Referer: 'https://music.163.com/',
  });
  if (r.status !== 200) throw new Error('网易云 HTTP ' + r.status);
  const j = parseJson(r.body);
  const tracks = (j.result && j.result.tracks) || [];
  if (!tracks.length) throw new Error('网易云没有返回歌曲');
  return normalize(tracks.map((t) => ({
    title: t.name,
    artist: (t.artists || t.ar || []).map((a) => a.name).join('/'),
  })));
}

/* ---------------- QQ 音乐 ---------------- */
async function fetchQQ(id) {
  const url = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=' + encodeURIComponent(id)
    + '&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
  const r = await request(url, { Referer: 'https://y.qq.com/' });
  if (r.status !== 200) throw new Error('QQ音乐 HTTP ' + r.status);
  const j = parseJson(r.body);
  const list = j.songlist || [];
  if (!list.length) throw new Error('QQ音乐没有返回歌曲');
  return normalize(list.map((x) => {
    const d = x.data || x;
    return { title: d.songname, artist: (d.singer || []).map((s) => s.name).join('/') };
  }));
}

/* ---------------- 酷狗 (必须 http, 且歌手在 authors 里) ---------------- */
async function fetchKugou(id) {
  const url = 'http://mobilecdn.kugou.com/api/v3/rank/song?rankid=' + encodeURIComponent(id)
    + '&page=1&pagesize=100&version=9108';
  const r = await request(url, { Referer: 'http://m.kugou.com/' });
  if (r.status !== 200) throw new Error('酷狗 HTTP ' + r.status);
  const j = parseJson(r.body);
  const info = (j.data && j.data.info) || [];
  if (!info.length) throw new Error('酷狗没有返回歌曲');
  return normalize(info.map((x) => ({
    title: x.songname || x.filename,
    artist: x.singername
      || (x.authors || []).map((a) => a.author_name || a.singername).filter(Boolean).join('/'),
  })));
}

/**
 * 抓一个榜。
 * @returns {Promise<{source,chart,name,label,color,songs,updatedAt}>}
 */
async function fetchChart(source, chartKey) {
  const src = CHARTS[source];
  if (!src) throw new Error('未知来源: ' + source);
  const chart = src.charts.find((c) => c.key === chartKey) || src.charts[0];

  let songs;
  if (source === 'netease') songs = await fetchNetease(chart.id);
  else if (source === 'qq') songs = await fetchQQ(chart.id);
  else if (source === 'kugou') songs = await fetchKugou(chart.id);
  else throw new Error('未知来源: ' + source);

  if (!songs.length) throw new Error('该榜单没有可用歌曲');
  return {
    source,
    chart: chart.key,
    name: chart.name,
    label: src.label,
    color: src.color,
    songs,
    updatedAt: Date.now(),
  };
}

/** 前端用的榜单目录(不含内部 id) */
function catalog() {
  return Object.keys(CHARTS).map((key) => ({
    key,
    label: CHARTS[key].label,
    color: CHARTS[key].color,
    charts: CHARTS[key].charts.map((c) => ({ key: c.key, name: c.name })),
  }));
}

module.exports = { fetchChart, catalog, CHARTS };
