'use strict';
// ============ 安卓侧自动化验证 (npm run smoke:android) ============
//
// 真机/模拟器不是随时都有, 但安卓版最关键的 JS 部分可以先在这里验证:
// 用 Electron 当无头浏览器, 注入一个"模拟原生层"(scripts/android-test/mock-native.js),
// 然后跑真实的共享界面 src/renderer/index.html —— 也就是说
// bili-bridge.js 的每条通道、二维码脚本加载路径、触摸样式、返回键处理都会被真执行。
//
// 用法: npm run smoke:android

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(os.tmpdir(), 'bilimusic-android-test');
const results = [];
let consoleErrors = [];

function pass(name, detail) { results.push({ name, pass: true }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { results.push({ name, pass: false }); console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function warn(name, detail) { results.push({ name, pass: true, warn: true }); console.log(`  ! ${name}${detail ? ' — ' + detail : ''}`); }

try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * 按 APK 的方式组装一份 assets/www:
 * Gradle 的 syncWebAssets 会把 src/renderer/** 和 src/qr.js 放进同一个目录,
 * 页面里的相对路径(qr.js)才找得到。这里照做, 顺便验证资源是否齐全。
 */
const WWW = path.join(OUT_DIR, 'www');
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(REPO, 'src', 'renderer'), WWW);
fs.copyFileSync(path.join(REPO, 'src', 'qr.js'), path.join(WWW, 'qr.js'));

const REQUIRED_ASSETS = ['index.html', 'style.css', 'renderer.js', 'bili-bridge.js', 'qr.js'];
const missingAssets = REQUIRED_ASSETS.filter((f) => !fs.existsSync(path.join(WWW, f)));

const timeout = setTimeout(() => {
  console.error('\n安卓侧自检超时');
  app.exit(2);
}, 60000);

app.whenReady().then(async () => {
  console.log('\n== 安卓侧(JS 桥 + 共享界面)自检 ==');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'mock-native.js'),
      contextIsolation: false,     // 让模拟原生层与页面同上下文(等价于 addJavascriptInterface)
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    let level; let message;
    if (first && typeof first === 'object' && 'level' in first) { level = first.level; message = first.message; }
    else { level = args[1]; message = args[2]; }
    if (level === 3 || level === 'error') consoleErrors.push(String(message));
  });

  await win.loadFile(path.join(WWW, 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));   // 等渲染进程 init() 跑完

  if (missingAssets.length === 0) pass('assets/www 资源齐全', REQUIRED_ASSETS.join(', '));
  else fail('assets/www 缺文件', missingAssets.join(', '));

  const evalJs = async (expr, timeoutMs = 8000) => Promise.race([
    win.webContents.executeJavaScript(
      `(async () => { try { return { ok: true, value: await (${expr}) }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()`
    ),
    new Promise((r) => setTimeout(() => r({ ok: false, error: '调用超时' }), timeoutMs)),
  ]);

  // 1. 桥是否接管了 window.bili(桌面端才由 preload 注入, 这里必须来自 bili-bridge.js)
  const api = await evalJs('Object.keys(window.bili).filter(k => typeof window.bili[k] === "function")');
  if (api.ok && api.value.length >= 26) pass('window.bili 由 JS 桥建立', api.value.length + ' 个方法');
  else fail('window.bili 未建立', JSON.stringify(api).slice(0, 200));

  const marks = await evalJs('({ touch: document.body.classList.contains("touch"), android: document.documentElement.classList.contains("android") })');
  if (marks.ok && marks.value.touch && marks.value.android) pass('触摸/安卓标记已加到 DOM');
  else fail('触摸标记缺失', JSON.stringify(marks).slice(0, 160));

  // 2. 原生化 app:info(关于对话框显示 Android x.y)
  const info = await evalJs('window.bili.appInfo()');
  if (info.ok && info.value && info.value.ok && info.value.runtime === 'Android 14') {
    pass('app:info 走原生', 'runtime=' + info.value.runtime + ' userData=' + info.value.userData);
  } else {
    fail('app:info 异常', JSON.stringify(info).slice(0, 220));
  }
  const about = await evalJs('(function(){ if (typeof loadAppInfo === "function") loadAppInfo(); return document.getElementById("aboutDataDir").textContent; })()');
  if (about.ok && String(about.value).indexOf('/data/data/com.bilimusic.app/files') >= 0) pass('关于对话框显示安卓数据目录');
  else warn('关于对话框未刷新', JSON.stringify(about).slice(0, 160));

  // 3. 二维码: 走 bili-bridge 里加载 src/qr.js 的那条路径(安卓登录的关键)
  const qr = await evalJs('window.bili.genQR("https://passport.bilibili.com/h5-app/passport/login/scan?navid=1&qrcode_key=mockkey0123456789")');
  if (qr.ok && qr.value && qr.value.ok && /^data:image\/svg\+xml;base64,/.test(qr.value.dataUrl)) {
    const svg = Buffer.from(qr.value.dataUrl.split(',')[1], 'base64').toString('utf8');
    if (svg.startsWith('<svg') && svg.includes('<path')) pass('二维码由 src/qr.js 本地生成', qr.value.dataUrl.length + ' 字符');
    else fail('二维码 SVG 内容异常', svg.slice(0, 80));
  } else {
    fail('二维码生成失败(检查 qr.js 加载路径)', JSON.stringify(qr).slice(0, 240));
  }

  // 4. 网络数据通道(用模拟原生层返回的数据)
  const hot = await evalJs('window.bili.hot()');
  if (hot.ok && hot.value && hot.value.ok && hot.value.data.length === 10) pass('bili:hot 通道', hot.value.data.length + ' 条');
  else fail('bili:hot 失败', JSON.stringify(hot).slice(0, 200));

  const rendered = await evalJs('(function(){ renderHotList(' + JSON.stringify(HOT_FOR_TEST()) + '); return document.querySelectorAll("#hotList .hot-item").length; })()');
  if (rendered.ok && rendered.value === 10) pass('推荐列表渲染正常');
  else warn('推荐列表渲染异常', JSON.stringify(rendered).slice(0, 160));

  // 5. 触摸适配: 悬停才出现的删除按钮应常显
  const touchCss = await evalJs(`(function(){
    playlists[currentPlaylistId].songs = [
      { bvid: 'BVt1', title: '晴天', author: '周杰伦', duration: 269, cover: '' },
      { bvid: 'BVt2', title: '七里香', author: '周杰伦', duration: 299, cover: '' }
    ];
    _playlistViewMode = 'card';
    renderPlaylist();
    const del = document.querySelector('.pl-card .pl-del');
    return { cards: document.querySelectorAll('.pl-card').length, opacity: del ? getComputedStyle(del).opacity : 'none' };
  })()`);
  if (touchCss.ok && touchCss.value.cards === 2 && touchCss.value.opacity === '1') {
    pass('触摸适配: 删除按钮常显', 'opacity=' + touchCss.value.opacity);
  } else {
    fail('触摸样式未生效', JSON.stringify(touchCss).slice(0, 200));
  }

  // 6. 导出拦截: Android WebView 不支持 blob 下载, 应改走原生保存
  const exportResult = await evalJs(`(function(){
    const blob = new Blob([JSON.stringify({hello:'world'})], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'bilimusic-test.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const saved = await evalJs('(window.__mockCalls || []).filter(c => c.method === "file:saveText").map(c => c.payload.name)');
  if (exportResult.ok && saved.ok && saved.value.length === 1 && saved.value[0] === 'bilimusic-test.json') {
    pass('导出改走原生保存', saved.value[0]);
  } else {
    fail('导出拦截未生效', JSON.stringify(saved).slice(0, 220));
  }

  // 7. 返回键: 未开浮层返回 false, 打开皮肤面板后返回 true
  const back1 = await evalJs('window.__androidBackPressed()');
  const back2 = await evalJs('(function(){ toggleThemePanel(); const handled = window.__androidBackPressed(); return { handled: handled, open: document.getElementById("themePanel").classList.contains("open") }; })()');
  if (back1.ok && back1.value === false && back2.ok && back2.value.handled === true && back2.value.open === false) {
    pass('返回键: 先关浮层再退出');
  } else {
    fail('返回键处理异常', JSON.stringify({ back1, back2 }).slice(0, 240));
  }

  // 8. 播放器通道(坐标/加载/暂停) —— 模拟原生层只记录调用
  const playerCalls = await evalJs(`(function(){
    window.bili.playerSetBounds({ x: 320, y: 52, width: 620, height: 676 });
    window.bili.playerLoad('BVmock1', 0, 0);
    window.bili.playerHide();
    return (window.__mockCalls || []).filter(c => c.method.indexOf('player:') === 0).map(c => c.method);
  })()`);
  if (playerCalls.ok && playerCalls.value.includes('player:setBounds') && playerCalls.value.includes('player:load') && playerCalls.value.includes('player:hide')) {
    pass('播放器通道可调用', playerCalls.value.join(' → '));
  } else {
    fail('播放器通道异常', JSON.stringify(playerCalls).slice(0, 220));
  }

  // 9. 渲染进程无报错
  if (consoleErrors.length) fail('渲染进程有报错', consoleErrors.slice(0, 2).join(' | '));
  else pass('渲染进程无报错');

  // 10. 截图: 平板横屏 1280x800 + 窄一些的 1024x768(看媒体查询)
  await shot(win, 'android-tablet-1280x800.png');
  win.setSize(1024, 768);
  await new Promise((r) => setTimeout(r, 700));
  await shot(win, 'android-tablet-1024x768.png');
  pass('已生成平板尺寸截图');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  try {
    fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify({ results }, null, 2));
  } catch (e) { /* ignore */ }
  clearTimeout(timeout);
  app.exit(failed.length ? 1 : 0);
});

/** 截图: 窗口透明+移出屏幕后强制重绘, 抓到真实画面(用户看不到) */
async function shot(win, name) {
  try {
    win.setPosition(20000, 20000);
    win.setOpacity(0);
    win.showInactive();
    await new Promise((r) => setTimeout(r, 900));
    await Promise.race([
      win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))').catch(() => null),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    await Promise.race([win.webContents.capturePage(), new Promise((r) => setTimeout(r, 4000))]);
    await new Promise((r) => setTimeout(r, 250));
    const img = await Promise.race([win.webContents.capturePage(), new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (!img) return 0;
    const buf = img.toPNG();
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    return buf.length;
  } catch (e) {
    return 0;
  }
}

/** 只给渲染用的示例数据(与 mock 层一致, 但避免依赖内部对象) */
function HOT_FOR_TEST() {
  return [
    { bvid: 'BVmock1', title: '晴天', author: '周杰伦', duration: 269, cover: '', play: 1234567 },
    { bvid: 'BVmock2', title: '七里香', author: '周杰伦', duration: 299, cover: '', play: 987654 },
    { bvid: 'BVmock3', title: '海阔天空', author: 'Beyond', duration: 326, cover: '', play: 765432 },
    { bvid: 'BVmock4', title: '富士山下', author: '陈奕迅', duration: 259, cover: '', play: 654321 },
    { bvid: 'BVmock5', title: '告白气球', author: '周杰伦', duration: 215, cover: '', play: 543210 },
    { bvid: 'BVmock6', title: '光辉岁月', author: 'Beyond', duration: 298, cover: '', play: 432109 },
    { bvid: 'BVmock7', title: '十年', author: '陈奕迅', duration: 205, cover: '', play: 321098 },
    { bvid: 'BVmock8', title: '稻香', author: '周杰伦', duration: 223, cover: '', play: 210987 },
    { bvid: 'BVmock9', title: '夜曲', author: '周杰伦', duration: 227, cover: '', play: 109876 },
    { bvid: 'BVmock10', title: '岁月如歌', author: '陈奕迅', duration: 254, cover: '', play: 98765 },
  ];
}
