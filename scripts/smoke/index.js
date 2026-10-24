'use strict';
// ============ 运行时冒烟测试 (npm run smoke) ============
//
// 用真实 Electron 跑一遍主进程 + 渲染进程, 重点验证那些"静态检查看不出来"的东西:
//   · preload 暴露的每个通道在主进程都有实现(调用不会 No handler registered)
//   · 登录二维码能在本地生成(7.3 因缺 qrcode 依赖必然失败)
//   · 数据目录可写、导入歌单能落盘
//   · 渲染进程初始化没有报错
//
// 全程使用临时目录作为 userData, 不会碰真实数据。窗口不会显示。
// 用法: npm run smoke   或   electron scripts/smoke.js

process.env.BILIMUSIC_SMOKE = '1';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const USER_DATA = path.join(os.tmpdir(), 'bilimusic-smoke');
const results = [];
let consoleErrors = [];

function pass(name, detail) { results.push({ name, pass: true }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { results.push({ name, pass: false }); console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function warn(name, detail) { results.push({ name, pass: true, warn: true }); console.log(`  ! ${name}${detail ? ' — ' + detail : ''}`); }

// 每次从干净的临时目录开始
try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }

let win = null;
app.on('browser-window-created', (_e, w) => {
  if (win) return;
  win = w;
  w.webContents.on('console-message', (...args) => {
    // Electron 33: (event, level, message, line, sourceId); 新版本是对象
    const first = args[0];
    let level; let message;
    if (first && typeof first === 'object' && 'level' in first) { level = first.level; message = first.message; }
    else { level = args[1]; message = args[2]; }
    const isError = level === 3 || level === 'error';
    if (isError) consoleErrors.push(String(message));
  });
  w.webContents.on('render-process-gone', (_ev, details) => consoleErrors.push('render-process-gone: ' + JSON.stringify(details)));
});

require('../../src/main.js');   // 注册全部 IPC 并创建隐藏窗口

const timeout = setTimeout(() => {
  console.error('\n冒烟测试超时');
  app.exit(2);
}, 60000);

/**
 * 截一张图存到临时数据目录, 便于人工核对布局。
 * 注意: 隐藏窗口只会保留首帧, capturePage 拿到的可能是过期画面,
 * 所以这里把窗口移出屏幕并设为全透明后显示一下(用户看不到), 等它真正重绘再抓。
 */
async function captureShot(name) {
  const guard = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  try {
    win.setPosition(20000, 20000);
    win.setOpacity(0);
    win.showInactive();
    await new Promise((r) => setTimeout(r, 900));
    // 等两帧确保重绘; 透明窗口有时不触发 rAF, 所以加超时兜底
    await guard(
      win.webContents.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))'
      ).catch(() => null),
      1500, null
    );
    await guard(win.webContents.capturePage(), 4000, null);   // 丢弃可能过期的一帧
    await new Promise((r) => setTimeout(r, 250));
    const img = await guard(win.webContents.capturePage(), 5000, null);
    if (!img) return 0;
    const buf = img.toPNG();
    fs.writeFileSync(path.join(USER_DATA, name), buf);
    return buf.length;
  } catch (e) {
    return 0;
  }
}

function rendererEval(expr, timeoutMs = 8000) {
  return Promise.race([
    win.webContents.executeJavaScript(
      `(async () => { try { return { ok: true, value: await (${expr}) }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()`
    ),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'IPC 调用超时' }), timeoutMs)),
  ]);
}

async function run() {
  console.log('\n== BiliMusic 冒烟测试 ==');

  // 1. 数据目录
  if (fs.existsSync(USER_DATA) && fs.statSync(USER_DATA).isDirectory()) pass('数据目录已创建', USER_DATA);
  else fail('数据目录未创建', USER_DATA);
  try {
    fs.writeFileSync(path.join(USER_DATA, 'probe.tmp'), 'ok');
    fs.unlinkSync(path.join(USER_DATA, 'probe.tmp'));
    pass('数据目录可写');
  } catch (e) { fail('数据目录不可写', e.message); }

  // 2. 渲染进程初始化没有报错
  if (consoleErrors.length) fail('渲染进程有报错', consoleErrors.slice(0, 3).join(' | '));
  else pass('渲染进程无报错');

  // 3. API 面
  const apiList = await rendererEval('Object.keys(window.bili).filter(k => typeof window.bili[k] === "function")');
  if (apiList.ok && apiList.value.length >= 20) pass('preload 暴露 API', apiList.value.length + ' 个');
  else fail('preload 暴露 API 异常', JSON.stringify(apiList));

  // 4. 本地生成登录二维码(7.3 的核心故障点)
  const qrResp = await rendererEval('window.bili.genQR("https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=smoke")');
  if (qrResp.ok && qrResp.value && qrResp.value.ok && /^data:image\/svg\+xml;base64,/.test(qrResp.value.dataUrl)) {
    const svg = Buffer.from(qrResp.value.dataUrl.split(',')[1], 'base64').toString('utf8');
    if (svg.startsWith('<svg') && svg.includes('<path')) pass('本地生成登录二维码', qrResp.value.dataUrl.length + ' 字符');
    else fail('二维码 SVG 内容异常', svg.slice(0, 80));
  } else {
    fail('本地生成登录二维码失败', JSON.stringify(qrResp).slice(0, 200));
  }

  // 5. 应用信息(版本 / 是否打包 / 数据目录)
  const info = await rendererEval('window.bili.appInfo()');
  if (info.ok && info.value && info.value.ok) {
    pass('app:info', `v${info.value.version} packaged=${info.value.packaged} tray=${info.value.hasTray}`);
    if (info.value.userData !== USER_DATA) fail('userData 与预期不一致', info.value.userData);
  } else fail('app:info 失败', JSON.stringify(info).slice(0, 200));

  // 6. 导入歌单落盘(以前主进程读 txt, 现在渲染进程解码后回传)
  const imp = await rendererEval('window.bili.importSongs(["冒烟测试歌曲A","冒烟测试歌曲B"])');
  if (imp.ok && imp.value && imp.value.ok && imp.value.added === 2) pass('导入歌单落盘', `total=${imp.value.total}`);
  else fail('导入歌单失败', JSON.stringify(imp).slice(0, 200));
  const rnd = await rendererEval('window.bili.getRandomSongs(2)');
  if (rnd.ok && rnd.value && rnd.value.ok && rnd.value.songs.length === 2) pass('随机歌名读取');
  else fail('随机歌名读取失败', JSON.stringify(rnd).slice(0, 200));

  // 7. 播放器通道(以前 player:getVolume / player:reload 没有实现)
  const vol = await rendererEval('window.bili.playerGetVolume()');
  if (vol.ok && vol.value && vol.value.ok && typeof vol.value.volume === 'number') pass('playerGetVolume', 'volume=' + vol.value.volume);
  else fail('playerGetVolume 失败', JSON.stringify(vol).slice(0, 200));

  const setVol = await rendererEval('window.bili.playerSetVolume(0.42)');
  if (setVol.ok && setVol.value && setVol.value.ok) pass('playerSetVolume');
  else fail('playerSetVolume 失败', JSON.stringify(setVol).slice(0, 200));

  const reload = await rendererEval('window.bili.playerReload("BV1xx411c7mD")');
  if (reload.ok && reload.value && reload.value.ok) pass('playerReload(通道已实现)');
  else fail('playerReload 失败', JSON.stringify(reload).slice(0, 200));

  const hide = await rendererEval('(window.bili.playerHide(), window.bili.playerStatus())');
  if (hide.ok) pass('playerHide + playerStatus');
  else fail('播放器隐藏/状态失败', JSON.stringify(hide).slice(0, 200));

  // 8. 网络相关(不阻塞结论)
  const net = await rendererEval('window.bili.pages("BV1xx411c7mD")');
  if (net.ok && net.value && net.value.ok) pass('bili:pages(WBI 签名链路)');
  else warn('bili:pages 网络请求未成功', JSON.stringify(net).slice(0, 160));
  const view = await rendererEval('window.bili.getView("BV1xx411c7mD")');
  if (view.ok && view.value && view.value.ok) pass('bili:getView');
  else warn('bili:getView 网络请求未成功', JSON.stringify(view).slice(0, 160));
  const loginQr = await rendererEval('window.bili.generateQR()');
  if (loginQr.ok && loginQr.value && loginQr.value.ok && loginQr.value.qrcodeKey) pass('B 站二维码接口连通');
  else warn('B 站二维码接口未连通(离线环境属正常)', JSON.stringify(loginQr).slice(0, 160));

  // 9. 歌单专注视图(界面功能): 卡片展示 / 其他面板隐藏 / 播放器视图收起 / 退出还原
  const focusOn = await rendererEval(`(function(){
    const titles = ['晴天','七里香','稻香','夜曲','告白气球','以父之名','龙卷风','简单爱','安静'];
    const authors = ['周杰伦','陈奕迅','Beyond'];
    const demo = titles.map((t, i) => ({ bvid: 'BVsmoke' + (i + 1), title: t, author: authors[i % 3], duration: 180 + i * 13, cover: '' }));
    demo[2].pages = [
      { cid: 1, page: 1, part: '第一段', duration: 100, startTime: 0 },
      { cid: 2, page: 2, part: '第二段', duration: 120, startTime: 100 },
    ];
    playlists[currentPlaylistId].songs = demo;
    _playlistViewMode = 'list';          // 先设成列表模式, 验证进入专注会切卡片
    renderPlaylist();
    togglePlaylistFocus(true);
    const grid = getComputedStyle(document.querySelector('.pl-card-grid')).gridTemplateColumns;
    return {
      focused: document.body.classList.contains('playlist-focus'),
      viewMode: _playlistViewMode,
      searchHidden: getComputedStyle(document.querySelector('.col-search')).display === 'none',
      playerColHidden: getComputedStyle(document.querySelector('.col-player')).display === 'none',
      barHidden: getComputedStyle(document.querySelector('.player-bar')).display === 'none',
      playerWidth: Math.round(document.getElementById('playerFrameWrap').getBoundingClientRect().width),
      cards: document.querySelectorAll('.pl-card').length,
      columns: grid.trim().split(/\\s+/).length,
      button: document.getElementById('focusBtn').textContent.trim(),
    };
  })()`);
  if (focusOn.ok && focusOn.value.focused && focusOn.value.viewMode === 'card'
      && focusOn.value.searchHidden && focusOn.value.playerColHidden && focusOn.value.barHidden
      && focusOn.value.playerWidth === 0 && focusOn.value.cards === 9 && focusOn.value.columns >= 3) {
    pass('专注视图: 只显示歌单 + 卡片网格', `${focusOn.value.cards} 张卡片 / ${focusOn.value.columns} 列`);
  } else {
    fail('专注视图状态不正确', JSON.stringify(focusOn).slice(0, 260));
  }
  const focusIcon = await rendererEval('(document.querySelector("#focusBtn use") || {}).getAttribute ? document.querySelector("#focusBtn use").getAttribute("href") : ""');
  if (focusIcon.ok && String(focusIcon.value).includes('maximize-off')) pass('专注按钮图标已切换 — ' + focusIcon.value);
  else fail('专注按钮图标未切换', JSON.stringify(focusIcon).slice(0, 160));

  const shotFocus = await captureShot('shot-focus.png');
  if (shotFocus > 30000) pass('截图: 专注视图', shotFocus + ' 字节');
  else warn('专注视图截图可能为空', String(shotFocus));

  const focusOff = await rendererEval(`(function(){
    togglePlaylistFocus(false);
    return {
      focused: document.body.classList.contains('playlist-focus'),
      viewMode: _playlistViewMode,
      searchVisible: getComputedStyle(document.querySelector('.col-search')).display !== 'none',
      barVisible: getComputedStyle(document.querySelector('.player-bar')).display !== 'none',
      playerWidth: Math.round(document.getElementById('playerFrameWrap').getBoundingClientRect().width),
      button: document.getElementById('focusBtn').textContent.trim(),
    };
  })()`);
  if (focusOff.ok && !focusOff.value.focused && focusOff.value.viewMode === 'list'
      && focusOff.value.searchVisible && focusOff.value.barVisible && focusOff.value.playerWidth > 200) {
    pass('退出专注视图后完整还原', '模式还原为 ' + focusOff.value.viewMode);
  } else {
    fail('退出专注视图未正确还原', JSON.stringify(focusOff).slice(0, 260));
  }
  const shotNormal = await captureShot('shot-normal.png');
  if (shotNormal > 30000) pass('截图: 普通视图', shotNormal + ' 字节');

  // 9.5 新结构: 播放队列 / 首页 / 命令面板
  const queueCheck = await rendererEval(`(function(){
    switchPanelTab('queue');
    return {
      list: document.querySelectorAll('#queueList .queue-item').length,
      now: ((document.getElementById('queueNow') || {}).textContent || '').trim().slice(0, 20),
      queueActive: document.getElementById('tabQueue').classList.contains('st-active'),
      searchHidden: document.getElementById('searchPane').style.display === 'none',
    };
  })()`);
  const q = queueCheck.ok ? queueCheck.value : {};
  if (q.queueActive && q.searchHidden) pass('右侧面板: 队列 / 搜索结果 可切换');
  else fail('右侧面板切换异常', JSON.stringify(q).slice(0, 200));
  if ((q.list || 0) > 0) pass('播放队列已渲染', q.list + ' 首待播');
  else warn('播放队列为空', q.now || '(歌单为空时正常)');

  const homeCheck = await rendererEval(`(function(){
    renderHome();
    return {
      hero: ((document.getElementById('homeHero') || {}).textContent || ''),
      tiles: document.querySelectorAll('#homeRecent .home-tile').length,
      hot: document.querySelectorAll('#homeScreen #hotList .hot-item').length,
    };
  })()`);
  const h = homeCheck.ok ? homeCheck.value : {};
  if (/继续播放|开始/.test(String(h.hero))) pass('首页已渲染 — 推荐 ' + (h.hot || 0) + ' 条 / 最近 ' + (h.tiles || 0) + ' 首');
  else fail('首页未渲染', JSON.stringify(h).slice(0, 200));

  const paletteCheck = await rendererEval(`(async function(){
    openPalette();
    const visible = document.getElementById('palette').style.display !== 'none';
    const items = document.querySelectorAll('#paletteList .palette-item').length;
    document.getElementById('paletteInput').value = '晴天';
    paletteOnInput();
    await new Promise(function(r){ setTimeout(r, 700); });
    const after = document.querySelectorAll('#paletteList .palette-item').length;
    closePalette();
    return { visible: visible, items: items, after: after, closed: document.getElementById('palette').style.display === 'none' };
  })()`);
  const pl = paletteCheck.ok ? paletteCheck.value : {};
  if (pl.visible && pl.items > 0 && pl.after > 0 && pl.closed) pass('命令面板可用', '命令 ' + pl.items + ' 项 / 搜索后 ' + pl.after + ' 项');
  else fail('命令面板异常', JSON.stringify(pl).slice(0, 220));

  await rendererEval("switchPanelTab('imported')");
  await new Promise((r) => setTimeout(r, 800));
  const im = await rendererEval(`(function(){
    var btn = document.getElementById('importToggleBtn');
    var pane = document.getElementById('importedPane');
    var sbtn = document.querySelector('.btn-search');
    var bb = btn ? btn.getBoundingClientRect() : null;
    var sb = sbtn ? sbtn.getBoundingClientRect() : null;
    return {
      hasBtn: !!btn,
      iconOnly: btn ? (btn.textContent || '').trim() === '' : false,
      rightOfSearch: !!(bb && sb && bb.left >= sb.right - 1),
      sameRow: !!(bb && sb && Math.abs((bb.top + bb.height / 2) - (sb.top + sb.height / 2)) < 6),
      size: bb ? Math.round(bb.width) + 'x' + Math.round(bb.height) : '',
      hasPane: !!pane,
      paneVisible: !!(pane && pane.style.display !== 'none'),
      rows: document.querySelectorAll('#importedSongList .queue-item').length,
      empty: document.querySelectorAll('#importedSongList .empty-state').length
    };
  })()`);
  var imv = im && im.ok ? im.value : null;
  if (imv && imv.hasBtn && imv.iconOnly && imv.rightOfSearch && imv.sameRow && imv.hasPane && imv.paneVisible && (imv.rows > 0 || imv.empty > 0)) {
    pass('导入歌单: 搜索右侧图标按钮 + 队列式列表 — ' + imv.size + ' / ' + (imv.rows > 0 ? imv.rows + ' 行' : '空态'));
  } else {
    fail('导入歌单面板异常', JSON.stringify(im && (im.error || im.value || im)).slice(0, 220));
  }

  // 回到队列, 保持后续截图的状态稳定
  await rendererEval("switchPanelTab('queue')");

  // 10. 皮肤(主题): 面板 / 切换 / 选中态 / 刷新后保持
  const themePanel = await rendererEval(`(function(){
    hideThemePanel();
    toggleThemePanel();
    const panel = document.getElementById('themePanel');
    return {
      tiles: panel.querySelectorAll('.tp-tile').length,
      open: panel.classList.contains('open'),
      before: document.body.dataset.theme,
    };
  })()`);
  if (themePanel.ok && themePanel.value.tiles === 6 && themePanel.value.open) {
    pass('皮肤面板: 6 套主题可选', '原皮肤=' + themePanel.value.before);
  } else {
    fail('皮肤面板异常', JSON.stringify(themePanel).slice(0, 240));
  }

  // 真实点击面板里的「樱花」, 走事件委托那条路径
  const clickedTile = await rendererEval(`(function(){
    const tile = document.querySelector('#themePanel .tp-tile[data-theme="sakura"]');
    if (!tile) return { clicked: false };
    tile.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return { clicked: true, panelClosed: !document.getElementById('themePanel').classList.contains('open') };
  })()`);
  await new Promise((r) => setTimeout(r, 450));   // 等颜色过渡走完再读计算样式

  const themeApplied = await rendererEval(`(function(){
    const active = document.querySelector('#themePanel .tp-tile.active');
    return {
      theme: document.body.dataset.theme,
      stored: localStorage.getItem('bilimusic_theme'),
      bg: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      activeCount: document.querySelectorAll('#themePanel .tp-tile.active').length,
      activeId: active ? active.dataset.theme : null,
    };
  })()`);
  const sk = themeApplied.ok ? themeApplied.value : {};
  if (clickedTile.ok && clickedTile.value.clicked && clickedTile.value.panelClosed) {
    pass('点击主题块后自动收起面板');
  } else {
    fail('点击主题块未收起面板', JSON.stringify(clickedTile).slice(0, 200));
  }
  if (sk.theme === 'sakura' && sk.stored === 'sakura' && sk.activeId === 'sakura' && sk.activeCount === 1) {
    pass('切换皮肤并记住选择', 'active=' + sk.activeId);
  } else {
    fail('切换皮肤失败', JSON.stringify(sk).slice(0, 240));
  }
  if (sk.bg === 'rgb(246, 242, 245)' && sk.text === 'rgb(36, 29, 41)') {
    pass('浅色主题变量生效', sk.bg + ' / ' + sk.text);
  } else {
    fail('浅色主题未生效', JSON.stringify(sk).slice(0, 240));
  }

  await captureShot('theme-sakura.png');
  await rendererEval("applyTheme('midnight', { silent: true })");
  await new Promise((r) => setTimeout(r, 400));
  const logoCheck = await rendererEval(`(function(){
    const logo = document.querySelector('.logo');
    const stops = document.querySelectorAll('#logoGrad stop');
    return {
      gradient: getComputedStyle(logo).backgroundImage,
      stop0: stops[0] ? getComputedStyle(stops[0]).stopColor : null,
      stop1: stops[1] ? getComputedStyle(stops[1]).stopColor : null,
    };
  })()`);
  const logoMark = await rendererEval('(() => { const el = document.querySelector(".logo-mark"); if (!el) return null; const cs = getComputedStyle(el); return { grad: cs.backgroundImage, accent: getComputedStyle(document.body).getPropertyValue("--accent").trim(), theme: document.body.dataset.theme }; })()');
  const hexToRgb = (hex) => { const h = String(hex || '').replace('#', '').trim(); if (h.length < 6) return null; const n = parseInt(h.slice(0, 6), 16); return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255); };
  const lg = logoMark.ok ? logoMark.value : null;
  const accentRgb = lg ? hexToRgb(lg.accent) : null;
  if (lg && /gradient/.test(String(lg.grad)) && accentRgb && String(lg.grad).includes(accentRgb)) {
    pass('logo 渐变跟随主题 — ' + lg.theme + ' ' + accentRgb);
  } else {
    fail('logo 渐变未跟随主题', JSON.stringify(lg).slice(0, 240));
  }
  await captureShot('theme-midnight.png');
  await rendererEval("applyTheme('mono', { silent: true })");
  await captureShot('theme-mono.png');
  await rendererEval("applyTheme('forest', { silent: true })");
  await captureShot('theme-forest.png');
  await rendererEval("applyTheme('sunset', { silent: true })");
  await captureShot('theme-sunset.png');
  // 面板展开的样子(供人工核对)
  await rendererEval("applyTheme('aurora', { silent: true })");
  await rendererEval('toggleThemePanel()');
  await captureShot('theme-panel.png');
  await rendererEval('hideThemePanel()');

  // 刷新后皮肤仍然生效(持久化)
  await rendererEval("applyTheme('sakura', { silent: true })");
  win.webContents.reload();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 800));
  const themePersist = await rendererEval('({ theme: document.body.dataset.theme, stored: localStorage.getItem("bilimusic_theme") })');
  if (themePersist.ok && themePersist.value.theme === 'sakura' && themePersist.value.stored === 'sakura') {
    pass('刷新后皮肤保持');
  } else {
    fail('刷新后皮肤未保持', JSON.stringify(themePersist).slice(0, 200));
  }
  await rendererEval("applyTheme('aurora', { silent: true })");   // 冒烟用的临时 profile 复原

  // 11. 托盘
  if (info.ok && info.value && info.value.hasTray) pass('系统托盘已创建');
  else warn('未创建托盘(缺少图标时会自动降级为关窗即退出)');
}

app.whenReady().then(async () => {
  // 等主进程的 whenReady 回调把窗口建好
  await new Promise((r) => setTimeout(r, 300));
  if (!win) {
    console.error('  ✗ 主窗口未创建');
    app.exit(2);
    return;
  }
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  await new Promise((r) => setTimeout(r, 1200));   // 给渲染进程 init() 一点时间

  try {
    await run();
  } catch (e) {
    fail('冒烟测试异常', e && e.stack ? e.stack.split('\n')[0] : String(e));
  }

  const failed = results.filter((r) => !r.pass);
  const warned = results.filter((r) => r.warn);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过${warned.length ? `, ${warned.length} 项警告` : ''}`);
  // Windows 上 Electron 是 GUI 子系统程序, 控制台输出可能抓不到, 结果同时落盘
  try {
    fs.writeFileSync(path.join(USER_DATA, 'smoke-result.json'), JSON.stringify({ passed: results.length - failed.length, total: results.length, results }, null, 2));
  } catch (e) { /* ignore */ }
  clearTimeout(timeout);
  app.exit(failed.length ? 1 : 0);
});
