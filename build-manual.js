'use strict';
// ============ 旧的手动构建入口(已废弃) ============
//
// 原先这里有一套独立实现(自己复制 electron 运行时 + 可选 makensis), 与
// scripts/build-release.js 大量重复且行为不一致, 现在统一由后者负责。
// 保留本文件只是为了兼容老的命令行习惯。

console.log('[build] build-manual.js 已废弃, 转发到 scripts/build-release.js');
console.log('[build] 推荐直接用: npm run build  (或 npm run build:portable)');
require('./scripts/build-release.js');
