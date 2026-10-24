'use strict';
// ============ 零依赖 QR Code 编码器 (主进程) ============
//
// 为什么不用 npm 的 `qrcode`: 打包脚本只把 src/ 放进 app.asar,
// 运行时不带 node_modules, 任何第三方 require 都会在安装版里报
// "Cannot find module"。所以二维码必须自己生成。
//
// 实现范围: 字节模式(UTF-8)、纠错等级 L/M/Q/H、版本 1~40、掩码自动优选。
// 依据 ISO/IEC 18004: 数据分段 -> Reed-Solomon 纠错 -> 交织 ->
// 功能图形 -> 数据填充 -> 掩码惩罚评分 -> 格式/版本信息。
//
// 正确性由 scripts/verify-qr.js 验证(与 node-qrcode 参考实现逐模块比对,
// 并用 jsqr 真实解码)。修改本文件后请务必跑 `npm run verify:qr`。

const EC_LEVELS = {
  L: { col: 0, bits: 1 },
  M: { col: 1, bits: 0 },
  Q: { col: 2, bits: 3 },
  H: { col: 3, bits: 2 },
};

// 每个版本的总码字数(数据+纠错)
const CODEWORDS_COUNT = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733,
  815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051,
  2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

// ---------- 标准常量表 (ISO/IEC 18004, 与 node-qrcode 参考实现一致) ----------
// 每版本 4 个值, 顺序 L, M, Q, H
const EC_BLOCKS = [
    1,   1,   1,   1,   // v1
    1,   1,   1,   1,   // v2
    1,   1,   2,   2,   // v3
    1,   2,   2,   4,   // v4
    1,   2,   4,   4,   // v5
    2,   4,   4,   4,   // v6
    2,   4,   6,   5,   // v7
    2,   4,   6,   6,   // v8
    2,   5,   8,   8,   // v9
    4,   5,   8,   8,   // v10
    4,   5,   8,  11,   // v11
    4,   8,  10,  11,   // v12
    4,   9,  12,  16,   // v13
    4,   9,  16,  16,   // v14
    6,  10,  12,  18,   // v15
    6,  10,  17,  16,   // v16
    6,  11,  16,  19,   // v17
    6,  13,  18,  21,   // v18
    7,  14,  21,  25,   // v19
    8,  16,  20,  25,   // v20
    8,  17,  23,  25,   // v21
    9,  17,  23,  34,   // v22
    9,  18,  25,  30,   // v23
   10,  20,  27,  32,   // v24
   12,  21,  29,  35,   // v25
   12,  23,  34,  37,   // v26
   12,  25,  34,  40,   // v27
   13,  26,  35,  42,   // v28
   14,  28,  38,  45,   // v29
   15,  29,  40,  48,   // v30
   16,  31,  43,  51,   // v31
   17,  33,  45,  54,   // v32
   18,  35,  48,  57,   // v33
   19,  37,  51,  60,   // v34
   19,  38,  53,  63,   // v35
   20,  40,  56,  66,   // v36
   21,  43,  59,  70,   // v37
   22,  45,  62,  74,   // v38
   24,  47,  65,  77,   // v39
   25,  49,  68,  81,   // v40
];

// 每版本 4 个值, 顺序 L, M, Q, H
const EC_CODEWORDS = [
    7,  10,  13,  17,   // v1
   10,  16,  22,  28,   // v2
   15,  26,  36,  44,   // v3
   20,  36,  52,  64,   // v4
   26,  48,  72,  88,   // v5
   36,  64,  96, 112,   // v6
   40,  72, 108, 130,   // v7
   48,  88, 132, 156,   // v8
   60, 110, 160, 192,   // v9
   72, 130, 192, 224,   // v10
   80, 150, 224, 264,   // v11
   96, 176, 260, 308,   // v12
  104, 198, 288, 352,   // v13
  120, 216, 320, 384,   // v14
  132, 240, 360, 432,   // v15
  144, 280, 408, 480,   // v16
  168, 308, 448, 532,   // v17
  180, 338, 504, 588,   // v18
  196, 364, 546, 650,   // v19
  224, 416, 600, 700,   // v20
  224, 442, 644, 750,   // v21
  252, 476, 690, 816,   // v22
  270, 504, 750, 900,   // v23
  300, 560, 810, 960,   // v24
  312, 588, 870, 1050,   // v25
  336, 644, 952, 1110,   // v26
  360, 700, 1020, 1200,   // v27
  390, 728, 1050, 1260,   // v28
  420, 784, 1140, 1350,   // v29
  450, 812, 1200, 1440,   // v30
  480, 868, 1290, 1530,   // v31
  510, 924, 1350, 1620,   // v32
  540, 980, 1440, 1710,   // v33
  570, 1036, 1530, 1800,   // v34
  570, 1064, 1590, 1890,   // v35
  600, 1120, 1680, 1980,   // v36
  630, 1204, 1770, 2100,   // v37
  660, 1260, 1860, 2220,   // v38
  720, 1316, 1950, 2310,   // v39
  750, 1372, 2040, 2430,   // v40
];


// ---------- GF(256) ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 g(x) = ∏(x - α^i)，系数按最高次在前排列 */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 系统式 Reed-Solomon 编码，返回 degree 个纠错码字 */
function rsEncode(data, degree) {
  const gen = rsGeneratorPoly(degree);
  const buf = new Uint8Array(data.length + degree);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 1; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], factor);
  }
  return buf.subarray(data.length);
}

// ---------- 版本 / 分块参数 ----------
function ecInfo(version, level) {
  const i = (version - 1) * 4 + EC_LEVELS[level].col;
  return { blocks: EC_BLOCKS[i], ecTotal: EC_CODEWORDS[i] };
}

/** 该版本+等级下, 字节模式最多能放多少字节 */
function byteCapacity(version, level) {
  const dataCw = CODEWORDS_COUNT[version] - ecInfo(version, level).ecTotal;
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCw * 8 - 4 - countBits) / 8);
}

function pickVersion(byteLen, level, minVersion, maxVersion) {
  for (let v = Math.max(1, minVersion); v <= Math.min(40, maxVersion); v++) {
    if (byteLen <= byteCapacity(v, level)) return v;
  }
  return 0;
}

// ---------- 位缓冲 ----------
function BitBuffer() {
  this.bits = [];
}
BitBuffer.prototype.put = function (value, length) {
  for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
};
BitBuffer.prototype.length = function () { return this.bits.length; };
BitBuffer.prototype.toBytes = function () {
  const out = new Uint8Array(Math.ceil(this.bits.length / 8));
  for (let i = 0; i < this.bits.length; i++) {
    if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
};

/** 数据码字: 模式指示符 + 长度 + 字节 + 终止符 + 补齐 + 填充字节 */
function buildDataCodewords(bytes, version, level) {
  const { ecTotal } = ecInfo(version, level);
  const totalCw = CODEWORDS_COUNT[version];
  const dataCw = totalCw - ecTotal;
  const capacityBits = dataCw * 8;
  const countBits = version < 10 ? 8 : 16;

  const buf = new BitBuffer();
  buf.put(4, 4);                 // 0100 = 字节模式
  buf.put(bytes.length, countBits);
  for (const b of bytes) buf.put(b, 8);

  // 终止符: 最多 4 个 0, 不足则截短
  const remaining = capacityBits - buf.length();
  buf.put(0, Math.min(4, Math.max(0, remaining)));
  // 补齐到字节边界
  while (buf.length() % 8 !== 0) buf.put(0, 1);
  // 交替填充 0xEC / 0x11
  let pad = 0;
  while (buf.length() < capacityBits) buf.put(pad++ % 2 ? 0x11 : 0xEC, 8);

  const out = buf.toBytes();
  if (out.length !== dataCw) throw new Error('内部错误: 数据码字长度不符');
  return out;
}

/** 分块 + RS 纠错 + 交织, 返回最终码字序列 */
function buildCodewords(bytes, version, level) {
  const { blocks: blockCount, ecTotal } = ecInfo(version, level);
  const totalCw = CODEWORDS_COUNT[version];
  const dataCw = totalCw - ecTotal;
  const data = buildDataCodewords(bytes, version, level);

  const shortLen = Math.floor(dataCw / blockCount);
  const longCount = dataCw % blockCount;
  const shortCount = blockCount - longCount;
  const ecPerBlock = ecTotal / blockCount;
  if (!Number.isInteger(ecPerBlock)) throw new Error('内部错误: 纠错码字无法均分');

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const len = shortLen + (i >= shortCount ? 1 : 0);
    const block = data.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  const out = new Uint8Array(totalCw);
  let idx = 0;
  const maxLen = shortLen + (longCount > 0 ? 1 : 0);
  for (let i = 0; i < maxLen; i++) {
    for (const b of dataBlocks) if (i < b.length) out[idx++] = b[i];
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of ecBlocks) out[idx++] = b[i];
  }
  if (idx !== totalCw) throw new Error('内部错误: 交织后码字数量不符');
  return out;
}

// ---------- 矩阵 ----------
function makeMatrix(size, fill) {
  const m = new Array(size);
  for (let r = 0; r < size; r++) m[r] = new Array(size).fill(fill);
  return m;
}

function alignmentCoords(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const posCount = Math.floor(version / 7) + 2;
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
}

function setupFinderPatterns(mod, res, version) {
  const size = version * 4 + 17;
  const positions = [[0, 0], [size - 7, 0], [0, size - 7]];
  for (const [row, col] of positions) {
    for (let r = -1; r <= 7; r++) {
      if (row + r < 0 || row + r >= size) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c < 0 || col + c >= size) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        mod[row + r][col + c] = dark;
        res[row + r][col + c] = true;
      }
    }
  }
}

function setupTimingPattern(mod, res, version) {
  const size = version * 4 + 17;
  for (let r = 8; r < size - 8; r++) {
    const dark = r % 2 === 0;
    mod[r][6] = dark; res[r][6] = true;
    mod[6][r] = dark; res[6][r] = true;
  }
}

function setupAlignmentPatterns(mod, res, version) {
  const coords = alignmentCoords(version);
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // 三个角被定位图形占用
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      const row = coords[i];
      const col = coords[j];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          mod[row + r][col + c] = dark;
          res[row + r][col + c] = true;
        }
      }
    }
  }
}

function bchDigit(data) {
  let digit = 0;
  while (data !== 0) { digit++; data >>>= 1; }
  return digit;
}

const G15 = 0x537;
const G15_MASK = 0x5412;
const G18 = 0x1f25;

function formatInfoBits(level, mask) {
  const data = (EC_LEVELS[level].bits << 3) | mask;
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function versionInfoBits(version) {
  let d = version << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (version << 12) | d;
}

function setupFormatInfo(mod, res, size, level, mask) {
  const bits = formatInfoBits(level, mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    // 左上角竖排
    if (i < 6) { mod[i][8] = dark; res[i][8] = true; }
    else if (i < 8) { mod[i + 1][8] = dark; res[i + 1][8] = true; }
    else { mod[size - 15 + i][8] = dark; res[size - 15 + i][8] = true; }
    // 左上角横排 + 右上角
    if (i < 8) { mod[8][size - i - 1] = dark; res[8][size - i - 1] = true; }
    else if (i < 9) { mod[8][15 - i] = dark; res[8][15 - i] = true; }
    else { mod[8][15 - i - 1] = dark; res[8][15 - i - 1] = true; }
  }
  mod[size - 8][8] = true;  // 固定暗模块
  res[size - 8][8] = true;
}

function setupVersionInfo(mod, res, size, version) {
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 8 - 3;
    const dark = ((bits >> i) & 1) === 1;
    mod[row][col] = dark; res[row][col] = true;
    mod[col][row] = dark; res[col][row] = true;
  }
}

function setupData(mod, res, size, codewords) {
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;  // 跳过时序图案列
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (!res[row][cc]) {
          let dark = false;
          if (byteIndex < codewords.length) {
            dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          }
          mod[row][cc] = dark;
          bitIndex--;
          if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
        }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
}

function maskAt(pattern, i, j) {
  switch (pattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error('非法掩码: ' + pattern);
  }
}

function applyMask(mod, res, size, pattern) {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (res[row][col]) continue;
      if (maskAt(pattern, row, col)) mod[row][col] = !mod[row][col];
    }
  }
}

// 掩码惩罚评分(ISO/IEC 18004 四条规则)
function penaltyN1(mod, size) {
  let points = 0;
  for (let row = 0; row < size; row++) {
    let lastCol = null; let sameCol = 0;
    let lastRow = null; let sameRow = 0;
    for (let col = 0; col < size; col++) {
      const a = mod[row][col];
      if (a === lastCol) sameCol++;
      else { if (sameCol >= 5) points += 3 + (sameCol - 5); lastCol = a; sameCol = 1; }
      const b = mod[col][row];
      if (b === lastRow) sameRow++;
      else { if (sameRow >= 5) points += 3 + (sameRow - 5); lastRow = b; sameRow = 1; }
    }
    if (sameCol >= 5) points += 3 + (sameCol - 5);
    if (sameRow >= 5) points += 3 + (sameRow - 5);
  }
  return points;
}

function penaltyN2(mod, size) {
  let points = 0;
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const sum = mod[row][col] + mod[row][col + 1] + mod[row + 1][col] + mod[row + 1][col + 1];
      if (sum === 0 || sum === 4) points++;
    }
  }
  return points * 3;
}

function penaltyN3(mod, size) {
  let points = 0;
  for (let row = 0; row < size; row++) {
    let bitsCol = 0;
    let bitsRow = 0;
    for (let col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | (mod[row][col] ? 1 : 0);
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points++;
      bitsRow = ((bitsRow << 1) & 0x7ff) | (mod[col][row] ? 1 : 0);
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points++;
    }
  }
  return points * 40;
}

function penaltyN4(mod, size) {
  let dark = 0;
  const total = size * size;
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (mod[row][col]) dark++;
  const k = Math.abs(Math.ceil((dark * 100 / total) / 5) - 10);
  return k * 10;
}

function pickBestMask(mod, res, size, level) {
  let best = 0;
  let bestPenalty = Infinity;
  for (let pattern = 0; pattern < 8; pattern++) {
    setupFormatInfo(mod, res, size, level, pattern);
    applyMask(mod, res, size, pattern);
    const penalty = penaltyN1(mod, size) + penaltyN2(mod, size) + penaltyN3(mod, size) + penaltyN4(mod, size);
    applyMask(mod, res, size, pattern);   // 撤销
    if (penalty < bestPenalty) { bestPenalty = penalty; best = pattern; }
  }
  return best;
}

/**
 * 生成 QR 码。
 * @param {string} text 内容
 * @param {{ecc?:'L'|'M'|'Q'|'H', version?:number, mask?:number, minVersion?:number, maxVersion?:number}} [opts]
 * @returns {{version:number, size:number, ecc:string, mask:number, modules:boolean[][]}}
 */
function create(text, opts) {
  const o = opts || {};
  const level = String(o.ecc || 'M').toUpperCase();
  if (!EC_LEVELS[level]) throw new Error('不支持的纠错等级: ' + o.ecc);

  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = o.version ? Number(o.version) : 0;
  if (version) {
    if (version < 1 || version > 40) throw new Error('版本需在 1~40 之间');
    if (bytes.length > byteCapacity(version, level)) {
      throw new Error(`版本 ${version} 容量不足(等级 ${level}, 需要 ${bytes.length} 字节)`);
    }
  } else {
    version = pickVersion(bytes.length, level, o.minVersion || 1, o.maxVersion || 40);
    if (!version) throw new Error(`内容过长, 超出 QR 版本 40 容量(等级 ${level})`);
  }

  const size = version * 4 + 17;
  const mod = makeMatrix(size, false);
  const res = makeMatrix(size, false);

  setupFinderPatterns(mod, res, version);
  setupTimingPattern(mod, res, version);
  setupAlignmentPatterns(mod, res, version);
  setupFormatInfo(mod, res, size, level, 0);          // 先占位, 稍后写真实值
  if (version >= 7) setupVersionInfo(mod, res, size, version);

  const codewords = buildCodewords(bytes, version, level);
  setupData(mod, res, size, codewords);

  const mask = (o.mask === undefined || o.mask === null || isNaN(o.mask))
    ? pickBestMask(mod, res, size, level)
    : Number(o.mask);

  applyMask(mod, res, size, mask);
  setupFormatInfo(mod, res, size, level, mask);

  return { version, size, ecc: level, mask, modules: mod };
}

/** 渲染成 SVG 字符串 */
function toSvg(text, opts) {
  const o = opts || {};
  const qr = create(text, o);
  const scale = o.scale || 4;
  const margin = o.margin === undefined ? 2 : o.margin;   // 静区(模块数)
  const dim = (qr.size + margin * 2) * scale;
  const parts = [];
  for (let row = 0; row < qr.size; row++) {
    for (let col = 0; col < qr.size; col++) {
      if (!qr.modules[row][col]) continue;
      parts.push(`M${(col + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  const dark = o.dark || '#000000';
  const light = o.light || '#ffffff';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${parts.join('')}" fill="${dark}"/></svg>`;
}

function base64Encode(str) {
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
  return btoa(unescape(encodeURIComponent(str)));
}

/**
 * 生成可直接塞进 <img src> 的 data URL (SVG)。
 * 选 SVG 而不是 PNG: 无需引入 PNG 编码器, 且任意尺寸都清晰。
 */
function toDataUrl(text, opts) {
  return 'data:image/svg+xml;base64,' + base64Encode(toSvg(text, opts));
}

module.exports = { create, toSvg, toDataUrl, byteCapacity, pickVersion };
