'use strict';
// ============ BiliMusic 版本构建脚本 ============
//
// 用法:
//   node scripts/build-release.js                 自动递增次版本 → 便携版 + 安装包
//   node scripts/build-release.js 7.4             指定版本
//   node scripts/build-release.js --major         递增主版本
//   node scripts/build-release.js --minor         递增次版本
//   node scripts/build-release.js --no-installer  只出便携版(快)
//   node scripts/build-release.js --no-bump       不改版本号, 用当前 package.json 的版本
//   node scripts/build-release.js --out <目录>    便携版输出目录(默认 dist)
//   node scripts/build-release.js --keep-stage    保留 dist_tmp 暂存目录便于排查
//
// 与旧脚本的关键差别:
//   1. 先在 dist_tmp/ 搭暂存目录, 写入**带正确版本号**的 package.json 再打 asar。
//      旧脚本直接 pack src/(里面是 version 1.0.0 的占位 package.json),
//      导致安装版 app.getVersion() 一直是 1.0.0。
//   2. icon.ico 同时放到「应用根目录」和「resources/」——打包后托盘图标必须在
//      resources 下才找得到(旧脚本只放在应用根目录, 运行时托盘图标是空的)。
//   3. 便携版先在暂存目录装配好, 最后整体 rename 就位; 目标目录删不掉时
//      自动换名输出, 不会留下半成品目录。
//   4. 打包完自动校验产物(asar 内版本号 / 图标位置 / 入口文件)。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG_JSON = path.join(ROOT, 'package.json');
const SRC = path.join(ROOT, 'src');
const BUILD_DIR = path.join(ROOT, 'build');
const STAGE = path.join(ROOT, 'dist_tmp');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const ELECTRON_FILES = [
  'electron.exe', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll',
  'd3dcompiler_47.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
  'vulkan-1.dll', 'resources.pak', 'icudtl.dat',
  'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'chrome_100_percent.pak', 'chrome_200_percent.pak',
];

// ======== 版本管理 ========
function parseSemver(v) {
  const parts = String(v).trim().split('.');
  return { major: parseInt(parts[0], 10) || 0, minor: parseInt(parts[1], 10) || 0, patch: parseInt(parts[2], 10) || 0 };
}
const toDisplay = (v) => (v.patch ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}`);
const toSemver = (v) => `${v.major}.${v.minor}.${v.patch || 0}`;
const readPkg = () => JSON.parse(fs.readFileSync(PKG_JSON, 'utf-8'));
const writePkg = (pkg) => fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n');

function resolveVersion(argv) {
  const versionArg = argv.find((a) => /^\d+\.\d+(\.\d+)?$/.test(a));
  if (versionArg) {
    const parts = versionArg.split('.').map((n) => parseInt(n, 10) || 0);
    return { major: parts[0], minor: parts[1] || 0, patch: parts[2] || 0 };
  }
  const current = parseSemver(readPkg().version);
  if (argv.includes('--major')) return { major: current.major + 1, minor: 0, patch: 0 };
  return { major: current.major, minor: current.minor + 1, patch: 0 };
}

function updateVersions(version) {
  const verDisplay = toDisplay(version);
  const verSemver = toSemver(version);
  const pkg = readPkg();
  pkg.version = verSemver;
  pkg.description = `BiliMusic Aurora v${verDisplay} - 哔哩哔哩音乐播放器 (Electron 桌面版)`;
  writePkg(pkg);
  console.log(`  ✅ package.json → v${verSemver}`);
}

// ======== 工具 ========
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 读取 asar 归档根的 package.json(只解析头部, 不依赖 @electron/asar)。
 *
 * asar 头部实测布局:
 *   [0..3]   = 4
 *   [4..7]   = 头部 pickle 载荷长度 pickleSize
 *   [8..11]  = 4 + 对齐后的 JSON 长度
 *   [12..15] = jsonLen(JSON 实际字节数, 会补齐到 4 字节对齐)
 *   [16..]   = 头部 JSON
 * 文件数据区起点 = 8 + pickleSize, 每个文件的真实位置 = 数据区起点 + entry.offset。
 * 注意 jsonLen 可能是补齐前的长度, 所以统一按 [4..7] 推算数据区起点,
 * JSON 起点则按第一个 '{' 自行探测(不同 asar 版本都适用)。
 */
function readAsarPackageJson(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    const jsonStart = head.indexOf(0x7b);            // '{'
    if (jsonStart < 4) throw new Error('asar 头部结构无法识别');
    const jsonLen = head.readUInt32LE(jsonStart - 4);
    if (!jsonLen || jsonLen > 16 * 1024 * 1024) throw new Error(`asar 头部长度异常 (jsonLen=${jsonLen})`);

    const headerBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, headerBuf, 0, jsonLen, jsonStart);
    const header = JSON.parse(headerBuf.toString('utf8'));

    const entry = header.files && header.files['package.json'];
    if (!entry) return null;

    let dataBase = head.readUInt32LE(4) + 8;
    const jsonEnd = jsonStart + jsonLen;
    if (!(dataBase >= jsonEnd)) dataBase = jsonEnd + ((4 - (jsonLen % 4)) % 4);

    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, dataBase + parseInt(entry.offset, 10));
    // 兜底: 万一偏移仍有偏差, 直接截取最外层大括号之间的内容
    const text = buf.toString('utf8');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('无法从 asar 中解析 package.json');
    return JSON.parse(text.slice(start, end + 1));
  } finally {
    fs.closeSync(fd);
  }
}
/** 构建后自检: 之前踩过的坑都在这里兜住 */
function verifyPortable(appDir, version) {
  const problems = [];
  const asarPath = path.join(appDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    problems.push('缺少 resources/app.asar');
  } else {
    let pkg = null;
    try { pkg = readAsarPackageJson(asarPath); }
    catch (e) { problems.push('读取 asar 头部失败: ' + e.message); }
    if (pkg) {
      if (pkg.version !== toSemver(version)) problems.push(`asar 内版本号 ${pkg.version} != ${toSemver(version)}`);
      if (pkg.main !== 'main.js') problems.push(`asar 入口应为 main.js, 实际 ${pkg.main}`);
    } else if (!problems.length) {
      problems.push('asar 内没有 package.json');
    }
  }
  for (const rel of [path.join('resources', 'icon.ico'), 'icon.ico']) {
    if (!fs.existsSync(path.join(appDir, rel))) problems.push(`缺少图标 ${rel}`);
  }
  if (!fs.existsSync(path.join(appDir, 'electron.exe'))) problems.push('缺少 electron.exe');
  return problems;
}

// ======== 构建便携版 ========
function buildPortable(version, outDirArg) {
  const verDisplay = toDisplay(version);
  const outDir = outDirArg ? path.resolve(ROOT, outDirArg) : path.join(ROOT, 'dist');
  console.log(`\n[release] 构建便携版 → ${outDir}`);

  // 1. 暂存目录: src + 带正确版本号的 package.json
  fs.rmSync(STAGE, { recursive: true, force: true });
  const appStage = path.join(STAGE, 'app');
  copyDir(SRC, appStage);
  fs.writeFileSync(path.join(appStage, 'package.json'), JSON.stringify({
    name: 'bilimusic',
    productName: 'BiliMusic',
    version: toSemver(version),
    main: 'main.js',
  }, null, 2) + '\n');

  // 2. 打 asar
  console.log('  📦 打包 asar...');
  const asarPath = path.join(STAGE, 'app.asar');
  execSync(`npx asar pack "${appStage}" "${asarPath}"`, { stdio: 'inherit', cwd: ROOT });

  // 3. 装配便携目录
  console.log('  ⚡ 复制 electron 运行时...');
  const portableStage = path.join(STAGE, 'portable');
  const resourcesDir = path.join(portableStage, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(asarPath, path.join(resourcesDir, 'app.asar'));

  for (const f of ELECTRON_FILES) {
    const src = path.join(ELECTRON_DIST, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(portableStage, f));
  }
  copyDir(path.join(ELECTRON_DIST, 'locales'), path.join(portableStage, 'locales'));

  // 图标: 应用根目录(安装包/资源管理器) + resources(运行时托盘图标)
  const iconSrc = path.join(BUILD_DIR, 'icon.ico');
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(portableStage, 'icon.ico'));
    fs.copyFileSync(iconSrc, path.join(resourcesDir, 'icon.ico'));
  } else {
    console.log('  ⚠️  未找到 build/icon.ico, 托盘图标将不可用');
  }

  // 入口 package.json(Electron 实际读 asar 内那份, 这份给工具链看)
  fs.writeFileSync(path.join(resourcesDir, 'package.json'), JSON.stringify({
    name: 'bilimusic', version: toSemver(version), main: 'app.asar/main.js',
  }));

  // 启动脚本
  fs.writeFileSync(path.join(portableStage, 'BiliMusic.bat'),
    '@echo off\r\ntitle BiliMusic\r\nstart "" "%~dp0electron.exe"\r\n');

  // 4. 就位(整体 rename, 避免半成品目录)
  fs.mkdirSync(outDir, { recursive: true });
  let target = path.join(outDir, 'BiliMusic');
  if (fs.existsSync(target)) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (e) {
      target = path.join(outDir, `BiliMusic-${verDisplay}`);
      console.log(`  ⚠️  旧目录被占用, 本次输出到 ${path.basename(target)}`);
    }
  }
  fs.renameSync(portableStage, target);

  // 5. 自检
  const problems = verifyPortable(target, version);
  if (problems.length) {
    console.log('  ⚠️  产物自检发现问题:');
    for (const p of problems) console.log('     · ' + p);
  } else {
    console.log('  ✅ 产物自检通过(版本号/图标/入口)');
  }
  console.log(`  ✅ 便携版: ${target}`);
  return target;
}

// ======== 构建安装包 ========
function buildInstaller(version, portableDir) {
  const verDisplay = toDisplay(version);
  const installerDir = path.join(ROOT, 'dist_installer');
  console.log('\n[release] 构建 NSIS 安装包...');
  fs.mkdirSync(installerDir, { recursive: true });

  const finalName = `BiliMusic Setup ${verDisplay}.exe`;
  const finalPath = path.join(installerDir, finalName);
  if (fs.existsSync(finalPath)) {
    console.log(`  ⚠️  已存在 ${finalName}, 跳过(如需重建请先删除或改用更高版本号)`);
    return finalPath;
  }

  execSync(
    `npx electron-builder --prepackaged "${portableDir}" --win nsis` +
    ` --config.win.icon="${path.join(BUILD_DIR, 'icon.ico')}"` +
    ` --config.directories.output="${installerDir}"` +
    ' --config.productName="BiliMusic"' +
    ' --config.appId="com.bilimusic.app"' +
    ' --config.nsis.oneClick=false' +
    ' --config.nsis.perMachine=false' +
    ' --config.nsis.allowToChangeInstallationDirectory=true' +
    ' --config.nsis.createDesktopShortcut=true' +
    ' --config.nsis.createStartMenuShortcut=true' +
    ' --config.nsis.shortcutName="BiliMusic"',
    { stdio: 'inherit', cwd: ROOT }
  );

  // electron-builder 输出的是完整 semver 文件名, 统一改成显示版本
  const semverPath = path.join(installerDir, `BiliMusic Setup ${toSemver(version)}.exe`);
  if (!fs.existsSync(finalPath) && fs.existsSync(semverPath)) {
    fs.renameSync(semverPath, finalPath);
    const bmFrom = semverPath + '.blockmap';
    const bmTo = finalPath + '.blockmap';
    if (fs.existsSync(bmFrom)) fs.renameSync(bmFrom, bmTo);
    console.log(`  📝 重命名: ${path.basename(semverPath)} → ${finalName}`);
  }

  if (fs.existsSync(finalPath)) {
    console.log(`  ✅ 安装包: ${finalPath} (${(fs.statSync(finalPath).size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    console.log(`  ⚠️  未找到安装包, 请检查 ${installerDir}`);
  }
  return finalPath;
}

// ======== 主流程 ========
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
BiliMusic 构建工具
  node scripts/build-release.js [版本号] [选项]

  版本号         如 7.4 / 7.4.1; 省略则自动递增次版本
  --major        递增主版本
  --minor        递增次版本(默认)
  --no-bump      不修改 package.json 的版本号
  --no-installer 只构建便携版
  --out <目录>   便携版输出目录(默认 dist)
  --keep-stage   保留 dist_tmp 暂存目录
`);
    return;
  }

  const outIdx = argv.indexOf('--out');
  const outDirArg = outIdx >= 0 ? argv[outIdx + 1] : '';
  const noInstaller = argv.includes('--no-installer');
  const noBump = argv.includes('--no-bump');
  const keepStage = argv.includes('--keep-stage');

  const pkgBefore = readPkg().version;
  const version = noBump ? parseSemver(pkgBefore) : resolveVersion(argv);

  console.log('═══════════════════════════════════════');
  console.log('  BiliMusic 构建');
  console.log(`  ${toDisplay(parseSemver(pkgBefore))} → ${toDisplay(version)}${noBump ? ' (不改版本号)' : ''}`);
  console.log('═══════════════════════════════════════');

  if (!noBump) updateVersions(version);

  try {
    const portableDir = buildPortable(version, outDirArg);
    if (!noInstaller) buildInstaller(version, portableDir);
  } finally {
    if (!keepStage) fs.rmSync(STAGE, { recursive: true, force: true });
  }

  console.log('\n═══════════════════════════════════════');
  console.log(`  ✅ BiliMusic v${toDisplay(version)} 构建完成`);
  console.log('═══════════════════════════════════════\n');
}

main();
