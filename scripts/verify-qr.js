'use strict';
// ============ 二维码编码器验证 (npm run verify:qr) ============
//
// src/qr.js 是零依赖手写实现(打包只带 src/, 不能依赖 npm 包),
// 所以必须证明它真的产出合法二维码。这里做两件事:
//   1) 与参考实现 node-qrcode 逐模块比对(强制字节模式 + 强制掩码 0~7)
//   2) 用 jsqr 把渲染出的位图真实解码回来
// 这两个包只在开发期使用(devDependencies)。

const path = require('path');

let QRCode;
let jsQR;
try {
  QRCode = require('qrcode');
  jsQR = require('jsqr');
} catch (e) {
  console.error('缺少开发依赖, 先执行: npm install');
  console.error('(qrcode + jsqr 仅用于验证, 运行时不需要)');
  process.exit(2);
}

const mine = require(path.join(__dirname, '..', 'src', 'qr.js'));
const LEVELS = ['L', 'M', 'Q', 'H'];

function refSymbol(text, version, level, mask) {
  const opts = { version, errorCorrectionLevel: level };
  if (mask !== undefined) opts.maskPattern = mask;
  return QRCode.create([{ data: text, mode: 'byte' }], opts);
}

function diffMatrix(a, b) {
  if (a.size !== b.size) return `尺寸不一致 ${a.size} vs ${b.size}`;
  for (let r = 0; r < a.size; r++) {
    for (let c = 0; c < a.size; c++) {
      if (!!a.modules[r][c] !== !!b.get(r, c)) return `模块不一致 @(${r},${c})`;
    }
  }
  return null;
}

function rasterize(qr, scale, quiet) {
  const dim = (qr.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const mr = Math.floor(y / scale) - quiet;
      const mc = Math.floor(x / scale) - quiet;
      const dark = mr >= 0 && mc >= 0 && mr < qr.size && mc < qr.size && qr.modules[mr][mc];
      const v = dark ? 0 : 255;
      const i = (y * dim + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
}

// ---- 样本 ----
const samples = [
  'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=9f2c1b7ad4e83f5607c1ab29de34f801&from=',
  'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=' + 'a'.repeat(32) + '&from=',
  'HELLO WORLD', '1234567890', 'https://www.bilibili.com', 'a',
  'BiliMusic 哔哩哔哩音乐播放器', '中文测试：扫码登录二维码内容',
  'emoji 🎵🎧 混合 text 12345 !@#$%^&*()_+-=[]{}|;:",.<>/?',
  'x'.repeat(200), 'y'.repeat(500), 'z'.repeat(1200),
];
let seed = 20261011;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/?&=.-_~%+';
for (let i = 0; i < 24; i++) {
  const n = 8 + Math.floor(rnd() * 240);
  let s = '';
  for (let j = 0; j < n; j++) s += pool[Math.floor(rnd() * pool.length)];
  samples.push(s);
}

let checked = 0;
let maskAgree = 0;
let maskTotal = 0;
let decoded = 0;
const failures = [];

for (const text of samples) {
  const byteLen = new TextEncoder().encode(text).length;
  for (const level of LEVELS) {
    const version = mine.pickVersion(byteLen, level, 1, 40);
    if (!version) continue;
    for (let m = 0; m < 8; m++) {
      const diff = diffMatrix(mine.create(text, { ecc: level, version, mask: m }), refSymbol(text, version, level, m).modules);
      checked++;
      if (diff) failures.push(`[${level} v${version} mask${m}] ${diff} :: ${JSON.stringify(text.slice(0, 32))}`);
    }
    const myAuto = mine.create(text, { ecc: level, version });
    const refAuto = refSymbol(text, version, level, undefined);
    maskTotal++;
    if (myAuto.mask === refAuto.maskPattern) maskAgree++;
    const autoDiff = diffMatrix(myAuto, refAuto.modules);
    if (autoDiff) failures.push(`[${level} v${version} auto] ${autoDiff} :: ${JSON.stringify(text.slice(0, 32))}`);

    if (checked % 17 === 0) {
      const img = rasterize(myAuto, 6, 4);
      const res = jsQR(img.data, img.width, img.height);
      if (res && res.data === text) decoded++;
      else failures.push(`[jsqr ${level} v${version}] 解码不符: ${res ? JSON.stringify(res.data.slice(0, 32)) : 'null'}`);
    }
  }
}

const url = mine.toDataUrl('https://passport.bilibili.com/test');
const svg = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
if (!url.startsWith('data:image/svg+xml;base64,')) failures.push('toDataUrl 前缀不正确');
if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) failures.push('SVG 结构不正确');

console.log(`逐模块比对: ${checked} 组`);
console.log(`自动掩码与参考实现一致: ${maskAgree}/${maskTotal}`);
console.log(`jsqr 实际解码: ${decoded} 次`);
if (failures.length) {
  console.error(`\n失败 ${failures.length} 项:`);
  for (const f of failures.slice(0, 20)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✅ 二维码编码器验证通过');
