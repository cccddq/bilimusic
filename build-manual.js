'use strict';
// ============ BiliMusic 手动构建脚本 ============
// 不使用 electron-builder (绕开 winCodeSign 7zip 符号链接问题)
// // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // 产出: dist/BiliMusic/ 便携目录 + dist/BiliMusic Setup 7.1.exe 安装包

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, 'BiliMusic');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const VERSION = require('./package.json').version;

function copy(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copy(path.join(src, item), path.join(dest, item));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  console.log('[build] 清理 dist...');
  try {
    if (fs.existsSync(DIST)) {
      fs.rmSync(DIST, { recursive: true, force: true });
    }
  } catch (e) {
    console.log('  ⚠️ 清理失败（文件被锁定），跳过清理');
  }
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

  // 1. 打包 asar (从项目根目录打包)
  console.log('[build] 打包 asar...');
  const asarDest = path.join(DIST, 'app.asar');
  execSync(`npx asar pack "${ROOT}/src" "${asarDest}"`, { stdio: 'pipe' });

  // 2. 复制 electron 核心文件
  console.log('[build] 复制 electron 运行时...');
  if (!fs.existsSync(APP)) fs.mkdirSync(APP, { recursive: true });

  const resourcesDir = path.join(APP, 'resources');
  if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(asarDest, path.join(resourcesDir, 'app.asar'));

  // 复制 electron.exe + 必要的 DLL 和资源
  const electronFiles = [
    'electron.exe', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll',
    'd3dcompiler_47.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
    'vulkan-1.dll', 'resources.pak', 'icudtl.dat',
    'snapshot_blob.bin', 'v8_context_snapshot.bin',
  ];
  for (const f of electronFiles) {
    const src = path.join(ELECTRON_DIST, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(APP, f));
  }

  // 复制 locales (界面语言)
  copy(path.join(ELECTRON_DIST, 'locales'), path.join(APP, 'locales'));

  // 复制 chrome_* (UI 资源)
  if (fs.existsSync(path.join(ELECTRON_DIST, 'chrome_100_percent.pak')))
    fs.copyFileSync(path.join(ELECTRON_DIST, 'chrome_100_percent.pak'), path.join(APP, 'chrome_100_percent.pak'));
  if (fs.existsSync(path.join(ELECTRON_DIST, 'chrome_200_percent.pak')))
    fs.copyFileSync(path.join(ELECTRON_DIST, 'chrome_200_percent.pak'), path.join(APP, 'chrome_200_percent.pak'));

  // 复制图标
  const iconSrc = path.join(ROOT, 'build', 'icon.ico');
  if (fs.existsSync(iconSrc))
    fs.copyFileSync(iconSrc, path.join(APP, 'icon.ico'));

  // 3. 写入 package.json 给 electron 入口
  fs.writeFileSync(path.join(APP, 'resources', 'package.json'), JSON.stringify({
    name: 'bilimusic',
    version: VERSION,
    main: 'app.asar/src/main.js',
  }));

  // 4. 创建启动脚本
  const batContent = `@echo off
title BiliMusic
start "" "%~dp0electron.exe"
`;
  fs.writeFileSync(path.join(APP, 'BiliMusic.bat'), batContent);

  console.log('[build] ✅ 便携版构建完成!');
  console.log(`   目录: ${APP}`);
  console.log(`   运行 ${path.join(APP, 'BiliMusic.bat')} 启动`);

  // 5. 尝试用 NSIS 创建安装包 (如果 makensis 可用)
  try {
    execSync('makensis /?', { stdio: 'ignore' });
    console.log('[build] 发现 NSIS, 创建安装包...');
    await createInstaller();
  } catch (e) {
    console.log('[build] NSIS 不可用, 跳过安装包创建');
    console.log('[build] 如需安装包, 安装 NSIS 后重新运行此脚本');
  }
}

async function createInstaller() {
  const nsisScript = path.join(DIST, 'installer.nsi');
  const iconPath = path.join(ROOT, 'build', 'icon.ico');
  const hasIcon = fs.existsSync(iconPath);

  const script = `!include "MUI2.nsh"

Name "BiliMusic"
OutFile "BiliMusic Setup ${VERSION}.exe"
InstallDir "$PROGRAMFILES64\\\\BiliMusic"
RequestExecutionLevel admin

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${APP}\\\\*.*"
  CreateShortCut "$DESKTOP\\\\BiliMusic.lnk" "$INSTDIR\\\\electron.exe"
  CreateDirectory "$SMPROGRAMS\\\\BiliMusic"
  CreateShortCut "$SMPROGRAMS\\\\BiliMusic\\\\BiliMusic.lnk" "$INSTDIR\\\\electron.exe"
  WriteUninstaller "$INSTDIR\\\\Uninstall.exe"
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\\\\BiliMusic.lnk"
  RMDir /r "$SMPROGRAMS\\\\BiliMusic"
SectionEnd
`;

  fs.writeFileSync(nsisScript, script);
  execSync(`makensis "${nsisScript}"`, { cwd: DIST, stdio: 'inherit' });
  console.log('[build] ✅ 安装包构建完成!');
}

main().catch(e => { console.error('构建失败:', e.message); process.exit(1); });
