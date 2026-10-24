# BiliMusic for Android（安卓平板版）

把桌面端 BiliMusic 完整搬到安卓平板的**外壳工程**。

> ⚠️ Electron 官方没有 Android 运行时，桌面端的 `electron.exe` 那套东西**无法直接打包成 APK**。
> 所以这里换了个思路：**界面代码完全复用桌面端**，把原来跑在 Electron 主进程里的能力
> 用 Java 重写一遍，播放器则用第二个 WebView 叠在界面上——和桌面端 `WebContentsView` 是同一个思路。

## 架构

```
┌─────────────────────────── 安卓 App (单个 Activity) ───────────────────────────┐
│  FrameLayout root                                                             │
│   ├── uiWeb     (WebView)  ← 加载 assets/www/index.html = 桌面端同一套界面      │
│   └── playerWeb (WebView)  ← 内嵌 B 站播放器, 由界面上报坐标决定位置/大小        │
│                                                                               │
│  Java 侧(替代 Electron 主进程)                                                │
│   ├── BiliApi   HTTP + Cookie 罐 + WBI 签名 + 扫码登录  ← 移植 bili-api.js/login.js│
│   ├── Wbi       打乱表与签名算法        ← 移植 src/wbi.js                      │
│   ├── Store     filesDir 下的 cookies.json / imported_songs.json, 导出到「下载」 │
│   ├── PlayerController  播放器 WebView: 加载/暂停/进度/音量/网页全屏/失败通知    │
│   └── Bridge    JS ←→ 原生 的通道, 方法名与桌面端 IPC 一一对应                  │
└───────────────────────────────────────────────────────────────────────────────┘
        ▲ window.bili.*                                    │ BiliNative.request()
        │                                                  ▼
   src/renderer/bili-bridge.js  ← 等价于桌面端的 preload.js（桌面端加载时直接 return）
```

**界面只有一份**：`app/build.gradle` 里的 `syncWebAssets` 任务会在构建时把
`../src/renderer/**` 和 `../src/qr.js` 复制进 `app/src/main/assets/www/`。
改桌面端的 HTML/CSS/JS，安卓端重新构建即同步生效，不需要两边维护。

二维码也复用了桌面端那套零依赖编码器（`src/qr.js` 输出 SVG data URL），
所以安卓侧没有引入任何二维码库。

## 构建

工具链默认放在 `D:\AndroidToolchain`（`jdk` / `gradle` / `sdk`），一条命令构建：

```powershell
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1            # debug, 可直接侧载
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Release   # release(用 debug 签名)
```

产物：

```
android/app/build/outputs/apk/debug/app-debug.apk
android/app/build/outputs/apk/release/app-release.apk
```

也可以直接用 Android Studio 打开 `android/` 目录，或者自己装好 JDK17 + SDK 后：

```bash
cd android
./gradlew assembleDebug          # 首次会自动生成 wrapper
```

版本号自动跟随桌面端 `package.json`（7.6.0 → versionName 7.6.0 / versionCode 70600），
也可以用 `-PversionName=7.7` 覆盖。

## 安装到平板

1. 把 APK 传到平板（微信/QQ/数据线/网盘都行）；
2. 平板上点开安装，按提示允许「安装未知来源应用」；
3. 首次启动会申请网络权限（其实 `INTERNET` 是普通权限，不弹窗）。

没有 adb 时只能这样侧载；如果平板开了 USB 调试，也可以用
`D:\AndroidToolchain\sdk\platform-tools\adb.exe install -r app-debug.apk`。

## 与桌面端的差异

| 能力 | 安卓端表现 |
| --- | --- |
| 内嵌播放器 | 第二个 WebView 覆盖在中间列上，坐标由界面实时上报（同桌面端） |
| 扫码登录 | 一致（本地生成二维码，不外发），登录后 cookie 同步给播放器 WebView |
| 搜索 / 歌单 / 导入导出 | 一致；数据在 `/data/data/com.bilimusic.app/files/`，文件名与桌面端相同 |
| TXT 导入 | 走系统文件选择器（复用界面里已有的 `<input type=file>` 与编码识别） |
| 导出歌单 | 保存到平板的「下载」目录（Android 10+ 走 MediaStore，不需要存储权限） |
| 皮肤 / 专注视图 | 一致，且额外做了触摸适配（悬停按钮常显、贴片间距、窄屏压缩侧栏） |
| 系统托盘 | 无（安卓没有托盘）；按返回键退到后台，播放不中断 |
| 全屏 | 界面里的 ⛶ 全屏照常；播放器网页全屏会进入系统级全屏并能按返回键退出 |
| 屏幕方向 | 锁定横屏（`sensorLandscape`）；要允许竖屏改 `AndroidManifest.xml` 里的 `screenOrientation` |

已知限制：

- 没有做前台服务/媒体通知，应用被系统回收后播放会停止；
- 只在 Android 8.0（API 26）及以上可用（WebView 的现代特性、MediaStore 导出）；
- 未做无障碍与键盘导航适配。

## 调试

- `chrome://inspect` 可以看到两个 WebView（debug 构建已开 `setWebContentsDebuggingEnabled`）；
- 界面里的 `console.log` 与原生日志都会打到 logcat，标签分别是 `BiliMusic` / `BiliMusicPlayer`：
  `D:\AndroidToolchain\sdk\platform-tools\adb.exe logcat -s BiliMusic BiliMusicPlayer`
