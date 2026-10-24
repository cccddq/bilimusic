# 🎵 BiliMusic Aurora

**BiliMusic** — 哔哩哔哩音乐播放器桌面版 (Electron)

用 `WebContentsView` 把 B 站官方播放器页嵌进窗口中间列（绕过 `X-Frame-Options`），
不弹独立窗口；歌单、搜索、导入导出、扫码登录全部本地完成。

![version](https://img.shields.io/badge/version-7.6-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-33-green)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

---

## ✨ 特性

- 🖥️ **独立桌面应用** — 不依赖浏览器，双击即用
- 🎬 **播放器内嵌** — B 站视频页直接嵌在窗口中间列（`WebContentsView`）
- 📋 **多歌单管理** — 创建、拖拽排序、重命名、整体 JSON 备份/恢复
- 🔍 **搜索** — 分页加载、搜索历史、快速标签
- 🔐 **扫码登录** — B 站 App 扫码，Cookie 持久化；**二维码本地生成，不外发**
- 📥 **TXT 歌单导入** — 自动识别 UTF-8 / GBK / Big5 编码，随机展示、点击即搜
- 🎚️ **音量控制** — 底栏滑块与 B 站播放器双向同步
- 🖼️ **网页全屏 / 应用全屏** — 播放时自动进入 B 站网页全屏模式
- 🪟 **系统托盘** — 关闭窗口最小化到托盘，不中断播放（图标缺失时自动降级为关窗退出）
- 🎯 **合集支持** — 多 P 视频自动识别，可展开/收起子集目录
- 🖼️ **歌单专注视图** — 一键让整个界面只显示歌单，卡片形式铺开（播放不中断）
- 🎨 **多套皮肤** — 极光 / 深海 / 松林 / 日落 / 石墨 / 樱花（浅色）6 套主题随意切换，选择自动记住

## 📥 安装

### 方式一：下载安装包

从 [Releases](https://github.com/cccddq/bilimusic/releases) 下载最新 `BiliMusic Setup X.X.exe`。

### 方式二：源码运行

```bash
npm install
npm start
```

### 方式三：自行打包

```bash
npm run build              # 自动递增次版本 → 便携版 + 安装包
npm run build:portable     # 只出便携版(快, 用于自测)
node scripts/build-release.js 7.5 --no-installer
```

产物：`dist/BiliMusic/`（便携版）、`dist_installer/BiliMusic Setup X.X.exe`（安装包）。

## 🎨 界面设计系统

界面不是一堆 CSS 堆出来的，而是有一套最小但完整的设计系统（`src/renderer/style.css` 顶部是全部 token）：

| 维度 | 规则 |
| --- | --- |
| 颜色 | 中性面 4 档（`--s0`~`--s4`）+ **单一强调色**（`--accent`），强调色只给主操作/激活态/进度条用 |
| 文字 | 6 档字号（12/13/14/16/20/28），正文 ≥12px，时间与序号用等宽数字（`tabular-nums`） |
| 间距 | 4px 栅格（`--sp-1`~`--sp-8`） |
| 圆角 | 3 档：控件 8 / 卡片 12 / 浮层 16（另外胶囊 999） |
| 标高 | 3 档阴影（`--e1`~`--e3`），只有浮层（弹窗/下拉/皮肤面板）才有实阴影，面板之间只用 1px 描边 |
| 动效 | 3 档时长（120/200/320ms）+ 1 条标准缓动，`prefers-reduced-motion` 下全部关掉 |
| 图标 | 43 个 24×24 描边图标，SVG sprite + `currentColor`，跟随主题变色（不再用 emoji） |
| 状态 | 骨架屏（加载）/ 空态（图标 + 说明）/ 错误态（可重试）三态齐备 |
| 可达性 | 文字对比度 ≥4.5:1、键盘焦点环、`aria-hidden` 装饰图标、触控目标 ≥28px |

几个约定：

- **图标只有一个来源**：`src/renderer/icons.js` 里的 `ICONS`，HTML 写 `<span data-icon="play">`，JS 模板串用 `icon("play")`；
- **强调色预算**：一屏只允许一个主色块，其余全用中性面 + 描边，避免"每个按钮都在喊"；
- **舞台取色**：播放时用封面主色算 `--tint` / `--tint-2` 给中间列做氛围底光（`setStageTint()`），空闲时回落到强调色的微光；
- **播放器画面是原生视图**（`WebContentsView`），DOM 盖不住它，所以"屏幕"效果靠中间列的内边距 + 描边 + 底光来做，不要指望给它加圆角或阴影。
- **右侧是队列，不是搜索结果**：搜索走 `Ctrl+K` 命令面板（或顶栏搜索框），结果放在右栏第二个标签里；
- **中间是首页**：没在播放时显示"继续播放 / 最近添加 / 每日推荐"，播放时被原生播放器画面覆盖；
- **键盘**：`Ctrl+K`（`Ctrl+P` 同效）打开命令面板、`↑↓` 选择、`Enter` 执行、`Esc` 关闭。

命令面板 = 搜索 + 常用命令（播放/暂停、上下首、队列、专注视图、皮肤、导入导出、设置），
输入即搜（280ms 防抖），命令名和搜索结果一起列出来，回车执行。

## 🗂️ 数据目录

| 运行方式 | 位置 |
| --- | --- |
| 安装版 | `%APPDATA%\BiliMusic`（登录 cookie、导入歌单、歌单 localStorage） |
| 源码运行 | `<仓库>/.electron-data` |
| 冒烟测试 | `%TEMP%\bilimusic-smoke`（临时，不碰真实数据） |

> 7.4 之前安装版把数据写在**安装目录**的 `resources\.electron-data`，卸载或覆盖安装会
> 连歌单一起删掉，装到 `C:\Program Files` 时还会因为没有写权限导致登录/导入静默失败。
>
> 升级到 7.4 后首次启动会自动把旧目录里的用户数据（cookie / 导入歌单 / 歌单 localStorage）
> 搬到新位置，缓存目录不搬；**只有当新目录里还没有这些数据时才会搬**，所以不会覆盖你已经用
> 7.4 产生的数据。为了能顺利搬迁，**首次运行 7.4 前请先完全退出旧版本**。
>
> 判定用的是"有没有本应用数据"而不是"目录是否为空"：老版本遗留在
> `%APPDATA%\BiliMusic` 下的空壳 profile 不会阻止搬迁。

## 🏗️ 项目结构

```
bilibili-music-app/
├── package.json                 # 依赖 + 脚本 + electron-builder 配置
├── build-manual.js              # 旧构建入口(已转发到 scripts/build-release.js)
├── scripts/
│   ├── build-release.js         # 版本构建: 暂存 asar → 便携版 → NSIS 安装包
│   ├── check.js                 # 静态检查: IPC 一致性 / 第三方依赖 / 语法 / 回归项
│   ├── verify-qr.js             # 二维码编码器验证(对照 node-qrcode + jsqr 解码)
│   └── smoke.js                 # 运行时冒烟测试(真实 Electron, 隐藏窗口)
├── src/
│   ├── main.js                  # 主进程: 窗口 / WebContentsView / IPC / 托盘 / 数据目录
│   ├── preload.js               # contextBridge 白名单 API
│   ├── paths.js                 # 路径解析 + 旧数据迁移(纯函数, 有单测)
│   ├── qr.js                    # 零依赖二维码编码器(SVG data URL)
│   ├── wbi.js                   # WBI 签名
│   ├── bili-api.js              # B 站 API 请求封装(Node https)
│   ├── login.js                 # 二维码登录 + cookie 持久化
│   └── renderer/
│       ├── index.html           # 三栏 UI
│       ├── style.css            # Aurora 深色主题(系统字体, 无外链)
│       └── renderer.js          # 播放/搜索/歌单/导入逻辑
├── build/                       # 应用图标
└── design/                      # 视觉设计展示(独立于项目代码)
```

**运行时没有任何第三方依赖**：打包只把 `src/` 放进 `app.asar`，所以 `src/` 里
`require` 非内置模块会在安装版直接报 `Cannot find module`（7.3 的扫码登录就是这样坏的）。
`npm run check` 会强制这条约束。

## ✅ 开发校验

```bash
npm run check       # 静态: IPC 通道是否两边都有 / 是否引入第三方依赖 / 语法 / 回归项
npm run verify:qr   # 二维码: 与参考实现逐模块比对 + jsqr 真实解码
npm run smoke       # 运行时: 真实 Electron 跑一遍关键链路(隐藏窗口, 用临时数据目录)
npm test            # 三个都跑
```

## 🚀 版本构建

```bash
npm run build:minor      # 7.4 → 7.5 (默认)
npm run build:major      # 7.4 → 8.0
node scripts/build-release.js 7.4.1   # 指定版本
```

安装包按显示版本命名且**不会覆盖旧版**：

```
dist_installer/
├── BiliMusic Setup 7.3.exe
└── BiliMusic Setup 7.4.exe   ← 最新
```

## 📝 更新记录

### 7.6

界面（不改动播放与数据逻辑）：

- 顶部新增 **「🎨 皮肤」** 按钮，打开面板即可在 **6 套主题** 间切换：极光（默认）、深海、
  松林、日落、石墨、樱花（浅色）。每套主题都覆盖了背景、面板、卡片、文字、边框、阴影、
  磨砂玻璃、播放器舞台底色以及强调色/危险色；切换带轻微淡入，选择记在 localStorage 里，
  重启后保持。
- 为此把原先写死在样式里的粉色强调色、红色危险色、面板底色抽成了语义变量
  （`--accent-*` / `--danger*` / `--panel-tint*` / `--stage`），默认值与原来的 Aurora 配色完全一致，
  不选皮肤时观感不变；顺带修掉了 `var(--red)` 未定义导致删除按钮没有颜色的问题。
- Esc 现在会优先关闭皮肤面板/退出专注视图，再处理全屏与停止播放。

### 7.5

界面（不改动播放与数据逻辑）：

- 新增**歌单专注视图**：顶部「🎵 歌单视图」按钮可让整个界面只显示歌单，并以卡片网格铺开；
  播放器列、搜索列与底部播放栏自动隐藏，音乐继续播放不受影响。再点一次按钮或按 `Esc` 返回，
  进入前的卡片/列表模式会原样还原。按钮在专注状态下高亮显示为「✕ 退出歌单视图」。

### 7.4

修复：

- **扫码登录彻底不可用**：`main.js` 里 `require('qrcode')` 但该依赖既没声明也不在打包范围内，
  安装版必然 `Cannot find module`。改为自研零依赖二维码编码器 `src/qr.js`（SVG data URL），
  并通过 `scripts/verify-qr.js` 对照参考实现逐模块验证。二维码不再交给第三方服务生成。
- **3 个 IPC 通道没有主进程实现**：`player:reload`（登录后刷新播放器）、`player:getVolume`
  （音量回显）、`bili:getView`；现在全部补上，`npm run check` 会拦住这类不一致。
- **"停止播放"不静音**：视图缩成 0×0 不会停止 HTML5 音频，Esc / 删除正在播放的歌 /
  切换或清空歌单后声音仍在放且无法暂停；现在隐藏播放器前会显式 `pause()`。
- **托盘图标在安装版失效**：图标路径解析成 `resources\build\icon.ico`（不存在）；现在从
  `resources\icon.ico` 查找，构建脚本也会把图标复制进去；找不到图标时降级为关窗退出。
- **数据写进安装目录**：改用 `%APPDATA%\BiliMusic` 并自动迁移旧数据。
- **进度条每秒一次跨进程注入**：`Math.floor(Date.now()/3000) !== (...-1 || 0)` 恒为真，
  实际每秒都执行一次 `executeJavaScript`；改为每 3 个 tick 同步一次。
- **`app.getVersion()` 一直是 1.0.0**：asar 内 `package.json` 取自 `src/package.json` 的占位版本；
  构建脚本改为在暂存目录写正确版本再打包，并自检产物。
- **登录态重启后失效**：启动时只从文件加载 cookie 却没同步进 Electron session。
- 外链 Google Fonts（国内不可达且阻塞首屏）改为系统字体；`sandbox` 打开、权限请求默认拒绝、
  禁止本地界面被导航；加入单实例锁；请求超时后主动销毁 socket；封面图加内存缓存；
  TXT 导入支持 GBK/GB18030/Big5/UTF-16；导出导入覆盖全部歌单；播放器加载失败有提示与重试。

安全：

- `escapeHtml` 以前不转义引号（视频标题里的 `"` 可注入 HTML 属性），`escapeAttr` 不转义反斜杠；
  现在统一转义，且所有 `data-*` 参数走**事件委托**，不再把内容拼进内联 `onclick`。

工程：

- 三套重复构建脚本合并为 `scripts/build-release.js`，新增 `check` / `verify:qr` / `smoke` 校验。

## 📜 开源协议

[MIT](LICENSE)
