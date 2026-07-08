# 🎵 BiliMusic Aurora

**BiliMusic** — 哔哩哔哩音乐播放器桌面版 (Electron)

基于原 `bilibili payer` 项目重写：从 Python + 浏览器架构迁移到 **Electron**，用 `WebContentsView` 内嵌完整 B 站视频页，不再弹独立窗口。

![version](https://img.shields.io/badge/version-4.3-blue)
![Electron](https://img.shields.io/badge/Electron-33-green)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

---

## ✨ 特性

- 🖥️ **独立桌面应用** — 不依赖浏览器，双击即用
- 🎬 **播放器内嵌** — B 站视频页直接嵌在窗口中间列（用 `WebContentsView` 绕过 X-Frame-Options）
- 📋 **多歌单管理** — 创建、拖拽排序、重命名、JSON 导入导出
- 🔍 **搜索** — 分页加载、搜索历史、快速标签
- 🔐 **扫码登录** — B 站 App 扫码，Cookie 持久化保存
- 📥 **TXT 歌单导入** — 导入歌曲名列表，随机展示，点击即搜
- 🎚️ **音量控制** — 底栏滑块实时调节 B 站播放器音量
- 🖼️ **网页全屏** — 播放时自动进入 B 站网页全屏模式
- 🪟 **系统托盘** — 关闭窗口最小化到托盘，不中断播放
- 🎯 **合集支持** — 多 P 视频自动识别，可展开/收起子集目录

## 📥 安装

### 方式一：下载安装包

从 [Releases](https://github.com/cccddq/bilimusic/releases) 下载最新 `BiliMusic Setup X.X.exe`，运行安装即可。

### 方式二：源码运行

```bash
# 安装依赖
npm install

# 启动
npm start
```

### 方式三：自行打包

```bash
# 自动递增版本号并构建
npm run build

# 或指定版本号
node scripts/build-release.js 4.0
```

## 🏗️ 项目结构

```
bilibili-music-app/
├── package.json               # 配置 + electron-builder 打包
├── build-manual.js            # 手动构建脚本
├── scripts/
│   └── build-release.js       # 版本构建工具（自动递增 + 打包）
├── src/
│   ├── main.js                # 主进程：窗口、WebContentsView、IPC、托盘
│   ├── preload.js             # contextBridge 暴露安全 API
│   ├── wbi.js                 # WBI 签名
│   ├── bili-api.js            # B 站 API 请求封装
│   ├── login.js               # 二维码登录 + cookie 持久化
│   └── renderer/
│       ├── index.html         # 三栏 UI
│       ├── style.css          # Aurora 深色主题
│       └── renderer.js        # 播放/搜索/歌单/导入逻辑
├── build/                     # 应用图标
│   └── icon.ico
└── design/                    # 视觉设计展示（独立于项目代码）
    └── index.html
```

## 🖥️ 界面概览

```
┌──────────────────────────────────────────┐
│  BiliMusic Aurora           [模式][导入] │
├──────────┬───────────────────┬───────────┤
│          │                   │           │
│ 📋 歌单   │  🔍 B站播放器     │ 🔍 搜索   │
│          │  (WebContentsView)│           │
│ 1. 晴天  │                   │ 📋 我的歌单│
│ 2. 七里香│                   │ [周杰伦]  │
│ 3. 稻香  │                   │ [陈奕迅]  │
│          │                   │ 🔥 推荐   │
├──────────┴───────────────────┴───────────┤
│  ▶ 晴天          ━━━━━━━━━    🔊 ═══     │
└──────────────────────────────────────────┘
```

## 🚀 版本构建

修改代码后，一键构建新版：

```bash
# 自动递增次版本 (4.3 → 4.4)
npm run build

# 递增主版本 (4.3 → 5.0)
npm run build:major

# 指定特定版本
node scripts/build-release.js 5.0
```

安装包输出到 `dist_installer/`，**旧版本不会覆盖**：

```
dist_installer/
├── BiliMusic Setup 2.0.0.exe
├── BiliMusic Setup 3.0.exe
├── BiliMusic Setup 4.3.exe   ← 最新版本
```

## 📜 开源协议

[MIT](LICENSE)
