'use strict';
// ============ 静态一致性检查 (npm run check) ============
//
// 覆盖过去真实踩过的坑:
//   1. preload 暴露了通道但主进程没注册(调用直接 reject)
//   2. 渲染进程调了 window.bili.X 但 preload 没暴露
//   3. src 里 require 了第三方包(打包只带 src, 安装版必然 "Cannot find module")
//   4. 语法错误
//
// 退出码非 0 表示有问题, 可直接用于 CI。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const problems = [];
const notes = [];

function read(p) { return fs.readFileSync(p, 'utf8'); }
function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

const jsFiles = walk(SRC);
const scriptFiles = walk(path.join(ROOT, 'scripts'));

// ---- 1. 语法检查(用 vm 编译, 不依赖子进程) ----
for (const f of [...jsFiles, ...scriptFiles]) {
  try {
    new vm.Script(read(f), { filename: f });
  } catch (e) {
    problems.push(`语法错误: ${rel(f)} —— ${e.message}`);
  }
}

// ---- 2. IPC 通道一致性 ----
const mainSrc = read(path.join(SRC, 'main.js'));
const preloadSrc = read(path.join(SRC, 'preload.js'));

const handled = new Set();
for (const m of mainSrc.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)) handled.add(m[1]);
const exposed = new Set();
for (const m of preloadSrc.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)) exposed.add(m[1]);

for (const ch of exposed) if (!handled.has(ch)) problems.push(`preload 暴露了 '${ch}', 但 main.js 没有注册对应 handler`);
for (const ch of handled) if (!exposed.has(ch)) notes.push(`main.js 注册了 '${ch}', preload 未暴露(可能是内部通道)`);

// ---- 3. 渲染进程用到的 API 是否都暴露了 ----
const rendererSrc = read(path.join(SRC, 'renderer', 'renderer.js'));
const apiNames = new Set();
for (const m of preloadSrc.matchAll(/^\s{2}(\w+):/gm)) apiNames.add(m[1]);
const used = new Set();
for (const m of rendererSrc.matchAll(/window\.bili\.(\w+)/g)) used.add(m[1]);
for (const name of used) if (!apiNames.has(name)) problems.push(`渲染进程调用了 window.bili.${name}, 但 preload 未暴露`);

// ---- 4. 第三方 require ----
const BUILTIN = new Set(['fs', 'path', 'http', 'https', 'url', 'crypto', 'os', 'util', 'events', 'stream', 'zlib', 'child_process', 'electron']);
for (const f of jsFiles) {
  const t = read(f);
  for (const m of t.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
    const name = m[1];
    if (name.startsWith('.')) continue;
    if (BUILTIN.has(name) || name.startsWith('node:')) continue;
    problems.push(`${rel(f)} 依赖了第三方模块 '${name}' —— 打包只带 src/, 安装版会报 Cannot find module`);
  }
}

// ---- 5. 回归检查: 已修掉的问题不要复活 ----
const RENDERER = path.join(SRC, 'renderer', 'renderer.js');
const rendererNow = read(RENDERER);
if (/onmousedown\s*=/.test(rendererNow)) problems.push('回归: renderer.js 又出现内联 onmousedown');
if (/require\(\s*'qrcode'/.test(mainSrc)) problems.push("回归: main.js 又依赖第三方 'qrcode'");

// 内联 onclick 只允许拼接纯数字下标(如 playByIndex(${i})), 不允许拼接任何数据字段
const NUMERIC = /^(?:i|pi|index|idx)(?:\s*\+\s*\d+)?$/;
for (const m of rendererNow.matchAll(/onclick="([^"]*)"/g)) {
  for (const expr of m[1].matchAll(/\$\{([^}]*)\}/g)) {
    if (!NUMERIC.test(expr[1].trim())) {
      problems.push(`回归: 内联 onclick 里拼接了非数字表达式 \${${expr[1].trim()}} —— 请改用 data-* + 事件委托`);
    }
  }
}

// ---- 6. CSS 合法性(括号平衡 / 自引用变量 / 未定义变量) ----
(function checkCss() {
  const cssPath = path.join(SRC, 'renderer', 'style.css');
  const css = read(cssPath);

  let depth = 0;
  let negativeAt = 0;
  css.split(/\r?\n/).forEach((l, i) => {
    depth += (l.match(/{/g) || []).length - (l.match(/}/g) || []).length;
    if (depth < 0 && !negativeAt) negativeAt = i + 1;
  });
  if (negativeAt) problems.push(`style.css 第 ${negativeAt} 行出现多余的 } (括号不平衡)`);
  else if (depth !== 0) problems.push(`style.css 花括号不平衡(最终深度 ${depth})`);

  const defined = new Set();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);

  for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    if (new RegExp('var\\(\\s*' + m[1] + '\\s*[,)]').test(m[2])) {
      problems.push(`style.css 变量 ${m[1]} 自引用, 该变量会失效`);
    }
  }

  // 运行时由 JS 写入的变量不算未定义
  const RUNTIME_VARS = new Set(['--playlist-font-size', '--playlist-meta-font-size']);
  for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (!defined.has(m[1]) && !RUNTIME_VARS.has(m[1])) problems.push(`style.css 引用了未定义的变量 ${m[1]}`);
  }
})();

// ---- 7. paths.js 纯函数单测 ----
const pathsMod = require(path.join(SRC, 'paths.js'));
function expectEq(label, actual, expected) {
  if (actual !== expected) problems.push(`paths 单测失败: ${label} => ${JSON.stringify(actual)}, 期望 ${JSON.stringify(expected)}`);
}
const roamin = path.join('C:', 'Users', 'x', 'AppData', 'Roaming');
expectEq('打包版 userData 在 %APPDATA%',
  pathsMod.resolveUserDataDir({ isPackaged: true, appData: roamin, repoRoot: path.join('C:', 'app', 'resources') }),
  path.join(roamin, 'BiliMusic'));
expectEq('开发版 userData 在仓库内',
  pathsMod.resolveUserDataDir({ isPackaged: false, appData: roamin, repoRoot: path.join('C:', 'repo') }),
  path.join('C:', 'repo', '.electron-data'));
expectEq('打包版托盘图标优先 resources/icon.ico',
  pathsMod.resolveTrayIconPath({ isPackaged: true, resourcesPath: 'R', repoRoot: 'X', exists: (p) => p === path.join('R', 'icon.ico') }),
  path.join('R', 'icon.ico'));
expectEq('开发版托盘图标用 build/icon.ico',
  pathsMod.resolveTrayIconPath({ isPackaged: false, resourcesPath: 'R', repoRoot: 'X', exists: (p) => p === path.join('X', 'build', 'icon.ico') }),
  path.join('X', 'build', 'icon.ico'));
expectEq('没有图标时返回空串',
  pathsMod.resolveTrayIconPath({ isPackaged: true, resourcesPath: 'R', repoRoot: 'X', exists: () => false }), '');
const sessionsLs = path.join('Session', 'Local Storage', 'leveldb');
expectEq('目标已有会话数据(歌单)则不迁移',
  pathsMod.shouldMigrate({
    targetDir: 'T', legacyDirs: ['L'],
    exists: (p) => p === 'L' || p === 'T' || p === path.join('T', sessionsLs),
    list: () => ['x'],
  }), '');
expectEq('目标只有旧版残留时仍迁移',
  pathsMod.shouldMigrate({
    targetDir: 'T', legacyDirs: ['L'],
    exists: (p) => p === 'T' || p === 'L' || p === path.join('L', sessionsLs) || p === path.join('T', 'Local Storage', 'leveldb'),
    list: () => ['x'],
  }), 'L');
expectEq('旧目录有 cookies.json 也算有数据',
  pathsMod.shouldMigrate({
    targetDir: 'T', legacyDirs: ['L'],
    exists: (p) => p === 'L' || p === path.join('L', 'cookies.json'),
    list: () => [],
  }), 'L');
expectEq('两边都没有应用数据则不迁移',
  pathsMod.shouldMigrate({ targetDir: 'T', legacyDirs: ['L'], exists: (p) => p === 'L' || p === 'T', list: () => ['x'] }), '');
expectEq('源与目标相同不迁移',
  pathsMod.shouldMigrate({ targetDir: 'T', legacyDirs: ['T'], exists: (p) => p === path.join('T', 'cookies.json'), list: () => [] }), '');
expectEq('空 leveldb 目录不算数据',
  pathsMod.hasAppData('T', (p) => p === path.join('T', sessionsLs), () => []), false);

// ---- 输出 ----
if (notes.length) {
  console.log('提示:');
  for (const n of notes) console.log('  · ' + n);
}
console.log(`检查文件: ${jsFiles.length} 个 src JS + ${scriptFiles.length} 个脚本, IPC 通道 ${handled.size} 个(暴露 ${exposed.size} 个)`);
if (problems.length) {
  console.error(`\n发现 ${problems.length} 个问题:`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('✅ 静态检查通过');
