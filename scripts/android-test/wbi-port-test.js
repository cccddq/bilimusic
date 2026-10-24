'use strict';
// ============ WBI 移植一致性测试 (npm run test:wbi) ============
//
// 安卓端把 src/wbi.js 用 Java 重写了一遍, 签名算错的话搜索会全军覆没。
// 这里做两件事:
//   1) 逐项比对两边的打乱表 MIXIN_KEY_ENC_TAB
//   2) 用固定的 wts + 密钥, 让「真实的 src/wbi.js」和「Java 的 Wbi.java」
//      对同一批 URL 各算一次签名, 要求完全一致
//
// 需要 JDK(默认 D:\AndroidToolchain\jdk, 可用环境变量 BILIMUSIC_JDK 覆盖)。

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const ANDROID = path.join(REPO, 'android');
const WORK = path.join(os.tmpdir(), 'bilimusic-wbi-test');
const JAVA_DIR = process.env.BILIMUSIC_JDK || 'D:\\AndroidToolchain\\jdk';
const JAVAC = path.join(JAVA_DIR, 'bin', 'javac.exe');
const JAVA = path.join(JAVA_DIR, 'bin', 'java.exe');

const WBI_JS = path.join(REPO, 'src', 'wbi.js');
const WBI_JAVA = path.join(ANDROID, 'app', 'src', 'main', 'java', 'com', 'bilimusic', 'app', 'Wbi.java');
const SELF_TEST = path.join(ANDROID, 'tools', 'WbiSelfTest.java');

const FIXED_WTS = 1700000000;
const FIXED_MIX_KEY = 'ea1db124af3c7062474693fa704f4ff8';
const IMG_URL = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB_URL = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';

const TEST_URLS = [
  'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=test&page=1&order=totalrank',
  'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6+%E6%99%B4%E5%A4%A9&page=2&order=click',
  "https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=a!b'c(d)e*f&page=1&order=totalrank",
  'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=A~B%20C&page=3&order=pubdate',
  'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=%E7%BA%AF%E9%9F%B3%E4%B9%90&page=1',
  'https://api.bilibili.com/x/web-interface/wbi/search/type',
];

const failures = [];

// ---------- 1. 打乱表比对 ----------
const jsSrc = fs.readFileSync(WBI_JS, 'utf8');
const javaSrc = fs.readFileSync(WBI_JAVA, 'utf8');
const jsTableText = (jsSrc.match(/MIXIN_KEY_ENC_TAB = \[([\s\S]*?)\]/) || [])[1];
const javaTableText = (javaSrc.match(/MIXIN_KEY_ENC_TAB = \{([\s\S]*?)\}/) || [])[1];
const nums = (s) => (s || '').match(/\d+/g) ? (s.match(/\d+/g)).map(Number) : [];
const jsTable = nums(jsTableText);
const javaTable = nums(javaTableText);

console.log(`打乱表: JS ${jsTable.length} 项 / Java ${javaTable.length} 项`);
if (jsTable.length !== 64 || javaTable.length !== 64) {
  failures.push(`打乱表项数异常 (JS=${jsTable.length}, Java=${javaTable.length}, 期望 64)`);
} else if (jsTable.join(',') !== javaTable.join(',')) {
  const diff = jsTable.map((v, i) => (v === javaTable[i] ? null : `${i}:${v}≠${javaTable[i]}`)).filter(Boolean);
  failures.push('打乱表不一致: ' + diff.join(' '));
} else {
  console.log('✅ 打乱表逐项一致');
}

// ---------- 2. 真实 src/wbi.js 对比 Java ----------
// 在 vm 里加载 wbi.js 并额外导出内部函数/状态, 不修改仓库文件
const patchedJs = jsSrc + '\nmodule.exports.__test = { setKeys, getMixKey, signWbi, _wbiKeys };';
const moduleShim = { exports: {} };
const sandboxDate = { now: () => FIXED_WTS * 1000 };
const sandbox = {
  module: moduleShim,
  exports: moduleShim.exports,
  console: { log: () => {}, warn: () => {}, error: () => {} },
  URL,
  Date: sandboxDate,
  crypto,
  require: (id) => (id.startsWith('.') ? require(path.join(REPO, 'src', id)) : require(id)),
  __dirname: path.join(REPO, 'src'),
  Buffer,
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(patchedJs, sandbox, { filename: 'wbi.js' });
const jsWbi = moduleShim.exports.__test;
jsWbi.setKeys(IMG_URL, SUB_URL);

// 独立的 JS 参考实现(照抄 src/wbi.js 的签名逻辑), 用来比对"待签名字符串"
function jsCanonical(url, wts) {
  const u = new URL(url);
  const params = u.searchParams;
  params.set('wts', String(wts));
  const sorted = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const filterVal = (v) => v.replace(/[!'()*]/g, '');
  return sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(filterVal(v))}`).join('&');
}

// 编译 Java 侧
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
if (!fs.existsSync(JAVAC)) {
  console.error(`找不到 javac: ${JAVAC}\n用 BILIMUSIC_JDK 指定 JDK 目录后重试。`);
  process.exit(2);
}
try {
  execFileSync(JAVAC, ['-encoding', 'UTF-8', '-nowarn', '-d', WORK, WBI_JAVA, SELF_TEST], { stdio: 'pipe' });
} catch (e) {
  console.error('javac 编译失败:\n' + (e.stderr || e.stdout || e.message).toString());
  process.exit(2);
}

let checked = 0;
for (const url of TEST_URLS) {
  // Java 侧
  let out;
  try {
    out = execFileSync(JAVA, ['-cp', WORK, 'com.bilimusic.app.WbiSelfTest', url, String(FIXED_WTS), FIXED_MIX_KEY], { stdio: 'pipe' })
      .toString().trim().split(/\r?\n/);
  } catch (e) {
    failures.push(`Java 运行失败 (${url.slice(0, 60)}…): ${(e.stderr || e.message).toString().slice(0, 200)}`);
    continue;
  }
  const [javaCanonical, javaWrid, javaMixKey, javaSignedUrl] = out;

  // JS 侧(真实实现)
  const jsSignedUrl = jsWbi.signWbi(url);
  const jsCanonicalRef = jsCanonical(url, FIXED_WTS);
  const jsWrid = crypto.createHash('md5').update(jsCanonicalRef + FIXED_MIX_KEY).digest('hex');

  checked++;
  if (javaCanonical !== jsCanonicalRef) failures.push(`待签名串不一致:\n    JS   ${jsCanonicalRef}\n    Java ${javaCanonical}`);
  if (javaWrid !== jsWrid) failures.push(`w_rid 不一致: JS ${jsWrid} / Java ${javaWrid}`);
  if (javaSignedUrl !== jsSignedUrl) failures.push(`最终 URL 不一致:\n    JS   ${jsSignedUrl}\n    Java ${javaSignedUrl}`);

  // 打乱表推导出的 mixKey 也要一致(JS 内部状态 vs Java)
  const jsMixKey = jsWbi._wbiKeys.mixKey;
  if (javaMixKey !== jsMixKey) failures.push(`mixKey 不一致: JS ${jsMixKey} / Java ${javaMixKey}`);
}

console.log(`逐项比对: ${checked} 个 URL × (待签名串 + w_rid + 最终 URL + mixKey)`);
if (failures.length) {
  console.error(`\n失败 ${failures.length} 项:`);
  for (const f of failures.slice(0, 10)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✅ WBI 移植与桌面端实现完全一致');
