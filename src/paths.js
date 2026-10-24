'use strict';
// ============ 路径解析 (纯函数, 方便用普通 node 做单元测试) ============
//
// 背景: 7.3 及更早版本把 userData 指向 `<应用目录>/../.electron-data`,
// 打包后实际落在**安装目录**里(resources\.electron-data):
//   - 卸载/覆盖安装会连歌单、cookie 一起删掉
//   - 装到 C:\Program Files 时普通用户没有写权限, 登录和导入会静默失败
// 现在打包版统一改用 %APPDATA%\BiliMusic, 并做一次性迁移。

const path = require('path');
const fs = require('fs');

const APP_DIR_NAME = 'BiliMusic';

// 判断目录里是否已有"本应用数据"的标志物。
// 注意只认当前版本真正会写的位置: cookie、导入歌单、会话内的 localStorage(歌单就存在这里)。
// 老版本(≤7.1)没设置 sessionData, 数据在顶层 Local Storage 下, 那种空壳 profile 不该阻止迁移。
const USER_DATA_MARKERS = [
  'cookies.json',
  'imported_songs.json',
  path.join('Session', 'Local Storage', 'leveldb'),
];

// 只搬用户数据, 跳过纯缓存(体积大且没有迁移价值)
const SKIP_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'ShaderCache', 'GrShaderCache', 'Dictionaries', 'Shared Dictionary', 'VideoDecodeStats',
  'blob_storage', 'Crashpad', 'component_crx_cache', 'extensions_crx_cache',
]);

function defaultExists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

function defaultList(p) {
  try { return fs.readdirSync(p); } catch (e) { return []; }
}

/**
 * 用户数据目录。
 * @param {{isPackaged:boolean, appData:string, repoRoot:string}} opts
 * @returns {string}
 */
function resolveUserDataDir(opts) {
  const { isPackaged, appData, repoRoot } = opts || {};
  if (isPackaged) return path.join(appData, APP_DIR_NAME);
  return path.join(repoRoot, '.electron-data');
}

/**
 * 托盘图标: 返回第一个真实存在的候选, 都找不到返回 ''。
 * @param {{isPackaged:boolean, resourcesPath:string, repoRoot:string, exists?:Function}} opts
 * @returns {string}
 */
function resolveTrayIconPath(opts) {
  const { isPackaged, resourcesPath, repoRoot, exists } = opts || {};
  const has = exists || defaultExists;
  const candidates = isPackaged
    // 打包后 __dirname 是 app.asar, 图标必须放在 resources/ 或应用根目录
    ? [path.join(resourcesPath, 'icon.ico'), path.join(resourcesPath, '..', 'icon.ico')]
    // 开发时用仓库里的 build/icon.ico
    : [path.join(repoRoot, 'build', 'icon.ico'), path.join(repoRoot, 'icon.ico')];
  for (const c of candidates) {
    if (c && has(c)) return c;
  }
  return '';
}

/**
 * 旧数据目录候选(按优先级), 用于一次性迁移。
 * @param {{isPackaged:boolean, resourcesPath:string, repoRoot:string}} opts
 * @returns {string[]}
 */
function legacyDataDirs(opts) {
  const { isPackaged, resourcesPath, repoRoot } = opts || {};
  const dirs = [];
  if (isPackaged) dirs.push(path.join(resourcesPath, '.electron-data')); // ≤7.3 安装版
  dirs.push(path.join(repoRoot, '.electron-data'));                      // 开发版
  return dirs.filter(Boolean);
}

/**
 * 目录里是否已有本应用数据。
 * @param {string} dir
 * @param {Function} [exists] 可注入, 便于测试
 * @param {Function} [list]
 * @returns {boolean}
 */
function hasAppData(dir, exists, list) {
  const has = exists || defaultExists;
  const ls = list || defaultList;
  for (const rel of USER_DATA_MARKERS) {
    const p = path.join(dir, rel);
    if (!has(p)) continue;
    // leveldb 目录存在但为空不算数据
    if (rel.endsWith('leveldb')) {
      if (ls(p).length > 0) return true;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * 新数据目录里还没有本应用数据, 而某个旧目录里有 → 返回该旧目录。
 * @returns {string} 要迁移的源目录, 不需要迁移时返回 ''
 */
function shouldMigrate(opts) {
  const { targetDir, legacyDirs, exists, list } = opts || {};
  if (hasAppData(targetDir, exists, list)) return '';
  for (const d of legacyDirs || []) {
    if (!d || d === targetDir) continue;
    if (hasAppData(d, exists, list)) return d;
  }
  return '';
}

/**
 * 递归复制用户数据, 跳过缓存目录。任何单个文件失败都不影响整体。
 * @returns {{copied:number, skipped:number, failed:number}}
 */
function migrateLegacyData(fromDir, toDir) {
  const stat = { copied: 0, skipped: 0, failed: 0 };
  if (!fromDir || !toDir || !fs.existsSync(fromDir)) return stat;

  (function walk(src, dest) {
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { stat.failed++; return; }
    try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { /* 已存在 */ }
    for (const ent of entries) {
      if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) { stat.skipped++; continue; }
      const s = path.join(src, ent.name);
      const d = path.join(dest, ent.name);
      if (ent.isDirectory()) {
        walk(s, d);
      } else if (ent.isFile()) {
        try { fs.copyFileSync(s, d); stat.copied++; } catch (e) { stat.failed++; }
      }
    }
  })(fromDir, toDir);

  return stat;
}

module.exports = {
  APP_DIR_NAME,
  SKIP_DIRS,
  USER_DATA_MARKERS,
  resolveUserDataDir,
  resolveTrayIconPath,
  legacyDataDirs,
  hasAppData,
  shouldMigrate,
  migrateLegacyData,
};
