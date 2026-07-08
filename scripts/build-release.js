'use strict';
// ============ BiliMusic 版本构建脚本 ============
// 用法:
//   node scripts/build-release.js            → 自动递增次版本号 (2.0 → 2.1)
//   node scripts/build-release.js 3.0         → 指定版本号
//   node scripts/build-release.js --minor     → 递增次版本 (2.0 → 2.1)
//   node scripts/build-release.js --major     → 递增主版本 (2.0 → 3.0)
//
// 产出:
//   dist_installer/BiliMusic Setup X.X.exe    ← 不覆盖旧文件
//   dist/BiliMusic/                           ← 便携版 (覆盖)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG_JSON = path.join(ROOT, 'package.json');
const BUILD_MANUAL = path.join(ROOT, 'build-manual.js');
const DIST_INSTALLER = path.join(ROOT, 'dist_installer');
const DIST = path.join(ROOT, 'dist');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

// ======== 版本管理 ========

// 显示版本: "3.0"  →  semver: "3.0.0"
// 用户传入 "3.0"   →  内部存 "3.0.0"
function parseDisplayVersion(v) {
  const parts = v.trim().split('.');
  return { major: parseInt(parts[0]) || 0, minor: parseInt(parts[1]) || 0, patch: 0 };
}

function parseSemver(v) {
  const parts = v.trim().split('.');
  return { major: parseInt(parts[0]) || 0, minor: parseInt(parts[1]) || 0, patch: parseInt(parts[2]) || 0 };
}

function toDisplay(v) {
  return `${v.major}.${v.minor}`;
}

function toSemver(v) {
  return `${v.major}.${v.minor}.${v.patch || 0}`;
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PKG_JSON, 'utf-8'));
}

function writePackageJson(pkg) {
  fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n');
}

function getCurrentVersion() {
  const pkg = readPackageJson();
  return parseSemver(pkg.version);
}

function bumpVersion(current, mode) {
  if (mode === '--major') {
    return { major: current.major + 1, minor: 0, patch: 0 };
  } else {
    return { major: current.major, minor: current.minor + 1, patch: 0 };
  }
}

function resolveVersion(argv) {
  // 检查是否传入了版本号参数 (如 "3.0")
  const versionArg = argv.find(a => /^\d+\.\d+(\.\d+)?$/.test(a));
  if (versionArg) {
    if (versionArg.split('.').length === 3) return parseSemver(versionArg);
    return parseDisplayVersion(versionArg);
  }
  // 检查是否是 --major / --minor
  const mode = argv.find(a => a === '--major' || a === '--minor');
  if (mode) {
    const current = getCurrentVersion();
    return bumpVersion(current, mode);
  }
  // 默认：自动递增次版本
  const current = getCurrentVersion();
  return bumpVersion(current, '--minor');
}

// ======== 更新版本号 ========

function updateVersions(version) {
  const verDisplay = toDisplay(version);
  const verSemver = toSemver(version);
  console.log(`[release] 版本: ${verDisplay}`);

  // 1. 更新 package.json
  const pkg = readPackageJson();
  pkg.version = verSemver;
  pkg.description = `BiliMusic Aurora v${verDisplay} - 哔哩哔哩音乐播放器 (Electron 桌面版)`;
  writePackageJson(pkg);
  console.log(`  ✅ package.json → v${verSemver}`);

  // 2. 更新 build-manual.js 注释中的版本号（实际版本从 package.json 读取）
  let bm = fs.readFileSync(BUILD_MANUAL, 'utf-8');
  bm = bm.replace(/产出:.*/, `// 产出: dist/BiliMusic/ 便携目录 + dist/BiliMusic Setup ${verDisplay}.exe 安装包`);
  fs.writeFileSync(BUILD_MANUAL, bm);
  console.log(`  ✅ build-manual.js → v${verDisplay}`);
}

// ======== 构建 ========

function buildPortable() {
  console.log('\n[release] 构建便携版...');

  let appDir = path.join(DIST, 'BiliMusic');
  // 如果旧目录被锁定，用临时目录
  if (fs.existsSync(appDir)) {
    try {
      fs.rmSync(appDir, { recursive: true, force: true });
    } catch (e) {
      // 目录被锁定，用临时目录替代
      appDir = appDir + '_' + Date.now();
      console.log(`  ⚠️  原目录被锁定，使用临时目录: ${path.basename(appDir)}`);
    }
  }
  fs.mkdirSync(appDir, { recursive: true });

  // 1. 打包 asar
  const asarDest = path.join(DIST, 'app.asar');
  console.log('  📦 打包 asar...');
  execSync(`npx asar pack "${path.join(ROOT, 'src')}" "${asarDest}"`, { stdio: 'pipe', cwd: ROOT });

  // 2. 复制 asar
  const resourcesDir = path.join(appDir, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(asarDest, path.join(resourcesDir, 'app.asar'));

  // 3. 复制 electron 运行时
  console.log('  ⚡ 复制 electron 运行时...');
  const electronFiles = [
    'electron.exe', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll',
    'd3dcompiler_47.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
    'vulkan-1.dll', 'resources.pak', 'icudtl.dat',
    'snapshot_blob.bin', 'v8_context_snapshot.bin',
  ];
  for (const f of electronFiles) {
    const src = path.join(ELECTRON_DIST, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, f));
  }

  // 4. 复制 locales
  copyDir(path.join(ELECTRON_DIST, 'locales'), path.join(appDir, 'locales'));

  // 5. 复制 chrome_* pak
  for (const f of ['chrome_100_percent.pak', 'chrome_200_percent.pak']) {
    const src = path.join(ELECTRON_DIST, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, f));
  }

  // 6. 复制图标
  const iconSrc = path.join(ROOT, 'build', 'icon.ico');
  if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(appDir, 'icon.ico'));

  // 7. 写入 package.json
  const pkg = readPackageJson();
  fs.writeFileSync(
    path.join(resourcesDir, 'package.json'),
    JSON.stringify({ name: 'bilimusic', version: pkg.version, main: 'app.asar/src/main.js' })
  );

  // 8. 创建启动脚本
  fs.writeFileSync(
    path.join(appDir, 'BiliMusic.bat'),
    `@echo off\ntitle BiliMusic\nstart "" "%~dp0electron.exe"\n`
  );

  // 清理临时 asar
  fs.rmSync(asarDest, { force: true });

  console.log(`  ✅ 便携版: ${appDir}`);
  return appDir;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item);
    const d = path.join(dest, item);
    if (fs.statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function buildInstaller(version, portableDir) {
  const verDisplay = toDisplay(version);
  console.log('\n[release] 构建 NSIS 安装包...');

  // 确保 dist_installer 存在
  if (!fs.existsSync(DIST_INSTALLER)) fs.mkdirSync(DIST_INSTALLER, { recursive: true });

  const appDir = portableDir || path.join(DIST, 'BiliMusic');
  const installerName = `BiliMusic Setup ${verDisplay}.exe`;
  const installerPath = path.join(DIST_INSTALLER, installerName);

  // 检查是否已存在
  if (fs.existsSync(installerPath)) {
    console.log(`  ⚠️  安装包已存在: ${installerName}`);
    console.log(`  ⚠️  如需重建请先手动删除旧文件`);
    console.log(`  ⚠️  或指定更高版本号`);
    return;
  }

  execSync(
    `npx electron-builder --prepackaged "${appDir}" --win nsis` +
    ` --config.win.icon="${path.join(ROOT, 'build', 'icon.ico')}"` +
    ` --config.directories.output="${DIST_INSTALLER}"` +
    ` --config.productName="BiliMusic"` +
    ` --config.appId="com.bilimusic.app"` +
    ` --config.nsis.oneClick=false` +
    ` --config.nsis.perMachine=false` +
    ` --config.nsis.allowToChangeInstallationDirectory=true` +
    ` --config.nsis.createDesktopShortcut=true` +
    ` --config.nsis.createStartMenuShortcut=true` +
    ` --config.nsis.shortcutName="BiliMusic"`,
    { stdio: 'inherit', cwd: ROOT }
  );

  // electron-builder 输出文件名包含完整 semver (如 "BiliMusic Setup 3.0.0.exe")
  // 而我们想要显示版本名 (如 "BiliMusic Setup 3.0.exe")
  const expectedName = `BiliMusic Setup ${verDisplay}.exe`;
  const finalPath = path.join(DIST_INSTALLER, expectedName);

  // 检查 electron-builder 的输出是否已存在（可能直接输出正确名称）
  if (!fs.existsSync(finalPath)) {
    // electron-builder 输出带完整 semver 的文件名
    const semverName = `BiliMusic Setup ${toSemver(version)}.exe`;
    const semverPath = path.join(DIST_INSTALLER, semverName);
    if (fs.existsSync(semverPath)) {
      // 重命名为简写版本号
      fs.renameSync(semverPath, finalPath);
      console.log(`  📝 重命名: ${semverName} → ${expectedName}`);

      // 也重命名对应的 blockmap
      const blockmapSemver = semverName + '.blockmap';
      const blockmapDisplay = expectedName + '.blockmap';
      const bmSemverPath = path.join(DIST_INSTALLER, blockmapSemver);
      const bmDisplayPath = path.join(DIST_INSTALLER, blockmapDisplay);
      if (fs.existsSync(bmSemverPath)) {
        fs.renameSync(bmSemverPath, bmDisplayPath);
      }
    }
  }

  if (fs.existsSync(finalPath)) {
    const size = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(1);
    console.log(`  ✅ 安装包: ${finalPath} (${size} MB)`);
  } else {
    console.log(`  ⚠️  安装包未找到，请检查 ${DIST_INSTALLER}/`);
  }
}

// ======== 主流程 ========

function main() {
  const args = process.argv.slice(2);
  const isHelp = args.includes('--help') || args.includes('-h');
  
  if (isHelp) {
    console.log(`
BiliMusic 版本构建工具
用法:
  node scripts/build-release.js            → 自动递增次版本号
  node scripts/build-release.js 3.0         → 指定版本号 (如 3.0)
  node scripts/build-release.js 3.0.1       → 指定完整 semver (如 3.0.1)
  node scripts/build-release.js --minor     → 递增次版本
  node scripts/build-release.js --major     → 递增主版本
  node scripts/build-release.js --help      → 显示帮助
`);
    return;
  }

  // 解析目标版本
  const newVersion = resolveVersion(args);
  const verDisplay = toDisplay(newVersion);
  const verSemver = toSemver(newVersion);
  const current = toDisplay(getCurrentVersion());

  console.log('═══════════════════════════════════════');
  console.log('  BiliMusic 版本构建');
  console.log(`  ${current} → ${verDisplay}`);
  console.log('═══════════════════════════════════════\n');

  // 1. 更新版本号
  updateVersions(newVersion);

  // 2. 构建便携版
  const portableDir = buildPortable();

  // 3. 构建安装包
  buildInstaller(newVersion, portableDir);

  console.log('\n═══════════════════════════════════════');
  console.log(`  ✅ BiliMusic v${verDisplay} 构建完成!`);
  console.log('═══════════════════════════════════════');
}

main();
