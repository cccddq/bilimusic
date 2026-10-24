// ============ BiliMusic 渲染进程逻辑 ============
//
// 与原项目的核心差异:
//   - 所有 B 站请求走 window.bili.* IPC (主进程 net 模块，无同源限制)
//   - 播放不再 window.open 弹窗，而是通知主进程把内嵌 WebContentsView
//     加载到对应 BV 页，并实时把「中间列占位区」的屏幕坐标同步给主进程，
//     让播放器视图精确覆盖在中间列上 —— 视觉上即「内嵌」。
//   - 进度条仍用 setTimeout 模拟计时 (B 站播放器跨域，读不到真实进度)。

const PLAYLISTS_KEY = 'bilimusic_playlists';
const PLAYLIST_ORDER_KEY = 'bilimusic_playlist_order';
const CURRENT_PLAYLIST_KEY = 'bilimusic_current_playlist';
const HISTORY_KEY = 'bilimusic_search_history';
const MAX_HISTORY = 20;

// 多歌单系统
let playlists = {};         // id -> { id, name, songs: [...] }
let playlistOrder = [];     // ['default', 'favorites', ...]
let currentPlaylistId = '';
// 全局 playlist 始终指向当前歌单的 songs 数组 (方便原有代码不改)
let playlist = [];

let currentIndex = -1;
let isPlaying = false;
let playMode = 'list-loop';
let progressTimer = null;
let progressTickFunc = null;
let elapsedSeconds = 0;
let currentDuration = 0;
let playbackStartTime = 0;
let playbackStartOffset = 0;
let searchQuery = '';
let searchPage = 1;
let searchHasMore = false;
let loginPollTimer = null;
let loginUserInfo = null;
let dragIdx = -1;
let _hasSearched = false;
let _videoPages = [];           // 当前视频的分集信息
let _expandedItems = {};        // 歌单中已展开的多P视频索引
let _currentPageIndex = -1;     // 当前播放的子集索引 (-1 = 不是子集)
let _pageStartTime = 0;         // 子集起始偏移秒数
let _playerSuppressBounds = false; // 临时阻止发送坐标到播放器视图
let _playerFullscreen = false;   // 应用级全屏：播放器覆盖整个窗口
let _playlistViewMode = 'card'; // 歌单显示模式: 'card' (卡片) 或 'list' (列表)
let _playlistFocus = false;        // 专注视图: 全界面只显示歌单(卡片形式)
let _viewModeBeforeFocus = 'card'; // 进入专注视图前的显示模式, 退出时还原

// ---- 皮肤(主题) ----
// bg/surface/accent/accent2/blue 只用于面板里的色块预览, 真正生效的调色板在 style.css
const THEME_KEY = 'bilimusic_theme';
const THEMES = [
  { id: 'aurora', name: '极光', desc: '粉紫霓虹', bg: '#0a0a18', surface: '#161630', accent: '#FB7299', accent2: '#7C5CFC', blue: '#00D4FF' },
  { id: 'midnight', name: '深海', desc: '冷调蓝青', bg: '#070C16', surface: '#122036', accent: '#38BDF8', accent2: '#6366F1', blue: '#22D3EE' },
  { id: 'forest', name: '松林', desc: '青绿松针', bg: '#06120E', surface: '#123026', accent: '#34D399', accent2: '#0EA5A5', blue: '#A3E635' },
  { id: 'sunset', name: '日落', desc: '暖橙玫红', bg: '#140A0B', surface: '#33191D', accent: '#FB923C', accent2: '#F43F5E', blue: '#FACC15' },
  { id: 'mono', name: '石墨', desc: '银灰极简', bg: '#0B0B0D', surface: '#1C1C21', accent: '#D4D4D8', accent2: '#8A8F98', blue: '#A1A1AA' },
  { id: 'sakura', name: '樱花', desc: '浅色亮色', bg: '#FBF5F7', surface: '#FFFFFF', accent: '#E4597F', accent2: '#9B6BF0', blue: '#7C6BF5' },
];
let _theme = 'aurora';
let _themePanelOpen = false;

// 尽早写入 body, 避免启动时先闪一下默认配色(此时脚本在 body 末尾, body 已存在)
(function applyThemeEarly() {
  let saved = 'aurora';
  try { saved = localStorage.getItem(THEME_KEY) || 'aurora'; } catch (e) { /* ignore */ }
  if (!THEMES.some(t => t.id === saved)) saved = 'aurora';
  _theme = saved;
  if (document.body) document.body.dataset.theme = saved;
})();

const MODE_ICONS = { 'list-loop': 'repeat', 'single-loop': 'repeat-one', 'random': 'shuffle', 'sequential': 'sequential' };
const MODE_LABELS = { 'list-loop': '列表循环', 'single-loop': '单曲循环', 'random': '随机播放', 'sequential': '顺序播放' };

// 注意: 这些 declare 必须在 init() 调用之前求值。
// 下面几个变量原先声明在文件后半部分, 但 init() 在文件中间就执行了,
// 于是 init() 里一读就抛 "Cannot access 'xxx' before initialization",
// 导致 init() 后半段(keyboard/清空按钮/导入歌单初始化)全部没执行。
let _importedRefreshTimer = null;   // 导入歌单的定时刷新句柄
let contextMenuTarget = null;       // 右键菜单当前目标
let _placeholderHtml = null;        // 播放器占位区原始 HTML
// 统一转义表: 文本节点与双引号属性都适用
// (旧实现不转义引号, B 站视频标题里的 " 可以注入属性)
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// ============ 歌单管理 (多列表) ============

/** 获取当前歌单的歌曲数组 */
function getPlaylist() { return playlists[currentPlaylistId] ? playlists[currentPlaylistId].songs : []; }

/** 同步 playlist 全局变量指向当前歌单 */
function syncPlaylistRef() {
  playlist = getPlaylist();
}

/** 从旧版本迁移 (单 playlist) */
function migrateOldPlaylist() {
  try {
    const old = localStorage.getItem('bilimusic_playlist');
    if (old) {
      const arr = JSON.parse(old);
      if (Array.isArray(arr) && arr.length > 0) {
        playlists.default.songs = arr;
        console.log('[playlist] 已从旧版本迁移', arr.length, '首歌曲');
      }
      localStorage.removeItem('bilimusic_playlist');
    }
  } catch(e) { /* ignore */ }
}

/** 加载所有歌单 */
function loadPlaylists() {
  try {
    const saved = localStorage.getItem(PLAYLISTS_KEY);
    if (saved) {
      playlists = JSON.parse(saved);
      playlistOrder = JSON.parse(localStorage.getItem(PLAYLIST_ORDER_KEY)) || Object.keys(playlists);
      currentPlaylistId = localStorage.getItem(CURRENT_PLAYLIST_KEY) || playlistOrder[0] || 'default';
    }
  } catch(e) { playlists = {}; }
  // 确保默认歌单存在
  if (!playlists.default) playlists.default = { id: 'default', name: '默认歌单', songs: [] };
  if (!playlists.favorites) playlists.favorites = { id: 'favorites', name: '我喜欢的', songs: [] };
  // 确保 order 中包含所有歌单
  for (const id of Object.keys(playlists)) {
    if (!playlistOrder.includes(id)) playlistOrder.push(id);
  }
  // 确保 currentPlaylistId 有效
  if (!playlists[currentPlaylistId]) currentPlaylistId = 'default';
  // 迁移旧数据
  migrateOldPlaylist();
  // 同步全局 playlist 引用
  syncPlaylistRef();
}

/** 保存所有歌单 */
function savePlaylists() {
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
  localStorage.setItem(PLAYLIST_ORDER_KEY, JSON.stringify(playlistOrder));
  localStorage.setItem(CURRENT_PLAYLIST_KEY, currentPlaylistId);
  renderPlaylistSelector();
}

/** 新建歌单(不弹提示, 供导入复用) */
function createPlaylistSilently(name) {
  const id = 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  playlists[id] = { id, name, songs: [] };
  playlistOrder.push(id);
  return id;
}

/** 新建歌单 */
function createPlaylist(name) {
  const id = createPlaylistSilently(name);
  savePlaylists();
  showToast('已创建歌单: ' + name, 'success');
  return id;
}

/** 删除歌单 */
function deletePlaylist(id) {
  if (id === 'default' || id === 'favorites') { showToast('默认歌单和我喜欢的不能删除', 'error'); return; }
  if (!confirm('确认删除歌单「' + (playlists[id]?.name || '') + '」？')) return;
  delete playlists[id];
  playlistOrder = playlistOrder.filter(i => i !== id);
  if (currentPlaylistId === id) switchPlaylist('default');
  else savePlaylists();
  showToast('已删除歌单');
}

/** 切换到指定歌单 */
function switchPlaylist(id) {
  if (!playlists[id]) return;
  // 如果当前有播放中，先停止
  if (isPlaying) stopPlayback();
  currentPlaylistId = id;
  currentIndex = playlists[id].songs.length > 0 ? 0 : -1;
  syncPlaylistRef();
  savePlaylists();
  renderPlaylist();
  renderPlaylistSelector();
  updatePlayerUI();
}

/** 添加到「我喜欢的」歌单 */
function addToFavorites(bvid, title, author, duration, cover) {
  if (playlists.favorites.songs.some(p => p.bvid === bvid)) {
    showToast('已在「我喜欢的」中', 'error');
    return false;
  }
  playlists.favorites.songs.push({ bvid, title, author, duration, cover });
  savePlaylists();
  showToast('已添加到「我喜欢的」', 'success');
  return true;
}

/** 弹出新建歌单对话框 */
function showCreatePlaylistDialog() {
  const modal = document.getElementById('newPlaylistModal');
  const input = document.getElementById('newPlaylistInput');
  if (modal && input) {
    input.value = '';
    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 100);
  }
}

function closeNewPlaylistModal() {
  document.getElementById('newPlaylistModal').style.display = 'none';
}

function confirmNewPlaylist() {
  const input = document.getElementById('newPlaylistInput');
  const name = input.value.trim();
  if (!name) { showToast('请输入歌单名称', 'error'); return; }
  createPlaylist(name);
  switchPlaylist(playlistOrder[playlistOrder.length - 1]);
  closeNewPlaylistModal();
}

// ============ 歌单字体大小调节 ============
const FONT_SIZE_KEY = 'bilimusic_playlist_font_size';
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 20;
const FONT_SIZE_DEFAULT = 12;

function getPlaylistFontSize() {
  try { return parseInt(localStorage.getItem(FONT_SIZE_KEY)) || FONT_SIZE_DEFAULT; }
  catch(e) { return FONT_SIZE_DEFAULT; }
}

function setPlaylistFontSize(size) {
  const s = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
  localStorage.setItem(FONT_SIZE_KEY, String(s));
  document.documentElement.style.setProperty('--playlist-font-size', s + 'px');
  document.documentElement.style.setProperty('--playlist-meta-font-size', Math.max(8, s - 2) + 'px');
}

function increaseFontSize() {
  setPlaylistFontSize(getPlaylistFontSize() + 1);
}

function decreaseFontSize() {
  setPlaylistFontSize(getPlaylistFontSize() - 1);
}

// ============ INIT ============
function init() {
  loadPlaylists();
  renderPlaylist();
  renderPlaylistSelector();
  updatePlayerUI();
  // 音量滑块: 回显播放器真实音量, 变化时防抖同步给播放器
  const volumeSlider = document.getElementById('volumeSlider');
  let volumeTimer = null;
  volumeSlider.addEventListener('input', () => {
    const vol = parseInt(volumeSlider.value) / 100;
    // 防抖：停止滑动 150ms 后发送
    if (volumeTimer) clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => { window.bili.playerSetVolume(vol); }, 150);
  });
  syncVolumeFromPlayer();

  checkLoginStatus();

  // 把「播放器占位区」的坐标同步给主进程，并随窗口变化重新同步
  relayoutPlayerView();
  window.addEventListener('resize', relayoutPlayerView);

  // 主进程在窗口 resize 后会通知这里重新计算坐标
  window.bili.onRelayout(() => relayoutPlayerView());

  // 播放器页加载失败时给出提示(否则中间栏会一直空白)
  window.bili.onPlayerFailed((info) => showPlayerError(info));

  // 右侧默认展示播放队列, 中间舞台展示首页
  switchPanelTab('queue');
  renderHome();
  loadHotMusic();

  // 初始化导入歌单（加载随机歌名 + 启动定时刷新）
  initImportedSongs();

  // 初始化歌单字体大小
  const savedSize = getPlaylistFontSize();
  setPlaylistFontSize(savedSize);

  // 初始化歌单显示模式
  _playlistViewMode = localStorage.getItem('bilimusic_playlist_view') || 'card';

  // 「关于」里的版本号与数据目录
  loadAppInfo();

  // 皮肤: 顶部按钮提示与面板内容同步到已保存的选择(配色在脚本开头就已应用)
  applyTheme(_theme, { silent: true });
}
init();

/** 骨架屏行(加载态) */
function skeletonRows(count, withThumb) {
  let html = '';
  for (let i = 0; i < (count || 5); i++) {
    html += '<div class="sk-row">'
      + (withThumb === false ? '' : '<div class="skeleton sk-thumb"></div>')
      + '<div style="flex:1;display:flex;flex-direction:column;gap:6px;">'
      + '<div class="skeleton sk-line w60"></div>'
      + '<div class="skeleton sk-line w40"></div>'
      + '</div></div>';
  }
  return html;
}

/**
 * 用当前歌曲封面给舞台算一个主色, 写到 --tint / --tint-2,
 * 让中间列的背景跟着封面走(Apple Music 那种氛围感)。
 * 取 24×24 缩略图的平均色, 跳过极暗/极亮像素, 避免整块发灰。
 */
function setStageTint(coverUrl) {
  const stage = document.getElementById('playerCol');
  if (!stage) return;
  if (!coverUrl) {
    stage.style.removeProperty('--tint');
    stage.style.removeProperty('--tint-2');
    return;
  }
  proxyImg(coverUrl).then(function (dataUrl) {
    if (!dataUrl) return;
    const img = new Image();
    img.onload = function () {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
          if (lum < 20 || lum > 238) continue;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
        }
        if (!count) return;
        r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
        stage.style.setProperty('--tint', 'rgba(' + r + ',' + g + ',' + b + ',.42)');
        stage.style.setProperty('--tint-2',
          'rgba(' + Math.min(255, r + 26) + ',' + Math.min(255, g + 6) + ',' + Math.min(255, b + 44) + ',.28)');
      } catch (e) { /* 画布不可用时静默忽略 */ }
    };
    img.src = dataUrl;
  });
}

/** 顶栏「更多」菜单: 导入 / 导出 / 字号 / 设置 */
function toggleMoreMenu(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const menu = document.getElementById('moreMenu');
  const btn = document.getElementById('moreBtn');
  if (!menu || !btn) return;
  if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
  const r = btn.getBoundingClientRect();
  menu.style.display = 'block';
  const w = menu.offsetWidth || 216;
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
}
function hideMoreMenu() {
  const menu = document.getElementById('moreMenu');
  if (menu) menu.style.display = 'none';
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#moreMenu') && !e.target.closest('#moreBtn')) hideMoreMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMoreMenu(); });

// ============ 推荐歌曲 ============
async function loadHotMusic() {
  const listEl = document.getElementById('hotList');
  if (!listEl) return;
  // 显示加载中
  listEl.innerHTML = skeletonRows(5);
  try {
    const resp = await window.bili.hot();
    if (!resp.ok || !resp.data || !resp.data.length) throw new Error('no data');
    renderHotList(resp.data);
  } catch(e) {
    listEl.innerHTML = '<div class="error-state"><div class="err-ico">' + icon('alert') + '</div><div>推荐加载失败</div><button class="btn-secondary" onclick="loadHotMusic()">重试</button></div>';
  }
}

function renderHotList(songs) {
  const listEl = document.getElementById('hotList');
  if (!listEl) return;
  let html = '';
  songs.forEach((v, i) => {
    const idxClass = i < 3 ? `top${i+1}` : '';
    // 参数走 data-*, 由统一的事件委托处理, 不再拼进内联 onclick
    html += `
      <div class="hot-item" data-action="play-hot" data-bvid="${escapeHtml(v.bvid)}" data-title="${escapeHtml(v.title)}" data-author="${escapeHtml(v.author)}" data-duration="${v.duration || 0}" data-cover="${escapeHtml(v.cover || '')}">
        <span class="hi-idx ${idxClass}">${i + 1}</span>
        <span class="hi-title">${escapeHtml(v.title)}</span>
        <span class="hi-meta">${v.author ? escapeHtml(v.author) : ''}</span>
        <span class="hi-play">${icon('play', 'ic-sm')}</span>
      </div>`;
  });
  listEl.innerHTML = html;
}

// ============ 右侧面板: 播放队列 / 搜索结果 ============
function switchPanelTab(tab) {
  const tabQueue = document.getElementById('tabQueue');
  const tabSearch = document.getElementById('tabSearch');
  const queuePane = document.getElementById('queuePane');
  const searchPane = document.getElementById('searchPane');
  const importedPane = document.getElementById('importedPane');
  const toggle = document.getElementById('importToggleBtn');
  if (!tabQueue || !queuePane) return;

  const isQueue = tab === 'queue';
  const isSearch = tab === 'search';
  const isImported = tab === 'imported';

  tabQueue.classList.toggle('st-active', isQueue);
  tabSearch.classList.toggle('st-active', isSearch);
  queuePane.style.display = isQueue ? '' : 'none';
  searchPane.style.display = isSearch ? '' : 'none';
  if (importedPane) importedPane.style.display = isImported ? '' : 'none';
  if (toggle) toggle.classList.toggle('is-active', isImported);

  if (isSearch) {
    const container = document.getElementById('searchResultsContainer');
    if (container && !container.innerHTML.trim()) {
      container.innerHTML = '<div class="empty-state"><div class="empty-ico">' + icon('search') + '</div>'
        + '<div class="empty-title">还没有搜索结果</div><div>用上方搜索框或 Ctrl+K 找歌</div></div>';
    }
  }
  if (isImported) refreshImportedSongs();
}

function switchSearchTab(tab) {
  switchPanelTab(tab === 'search' ? 'search' : 'queue');
}

/** 旧的欢迎页入口(推荐列表现在在首页), 保留以免其他调用点报错 */
function showWelcomeScreen() {
  initImportedSongs();
  loadHotMusic();
}

/** 渲染右侧播放队列: 正在播放 + 接下来 */
function renderQueue() {
  const nowEl = document.getElementById('queueNow');
  const listEl = document.getElementById('queueList');
  if (!nowEl || !listEl) return;

  const songs = getPlaylist();
  const cur = currentIndex >= 0 ? songs[currentIndex] : null;

  if (cur) {
    const page = _currentPageIndex >= 0 && cur.pages && cur.pages[_currentPageIndex] ? cur.pages[_currentPageIndex] : null;
    const pct = currentDuration > 0 ? Math.min(100, (elapsedSeconds / currentDuration) * 100) : 0;
    nowEl.innerHTML = '<div class="queue-now-card">'
      + '<div class="qn-kicker">' + (isPlaying ? '正在播放' : '已暂停') + '</div>'
      + '<div class="qn-title">' + escapeHtml(page ? (page.part || cur.title) : cur.title) + '</div>'
      + '<div class="qn-sub">' + escapeHtml(cur.author || '') + '</div>'
      + '<div class="qn-bar"><i style="width:' + pct.toFixed(2) + '%"></i></div>'
      + '</div>';
  } else {
    nowEl.innerHTML = '<div class="queue-empty">还没有在播放的歌曲<br>从歌单里双击一首开始</div>';
  }

  // 接下来: 当前索引之后的歌(不跨模式模拟, 只按列表顺序展示)
  const upcoming = [];
  const start = cur ? currentIndex + 1 : 0;
  for (let i = start; i < songs.length; i++) upcoming.push({ song: songs[i], index: i });
  if (cur && playMode !== 'sequential' && start >= songs.length) {
    // 循环模式下提示会回到开头
    upcoming.push({ wrap: true });
  }

  if (!upcoming.length) {
    listEl.innerHTML = cur ? '<div class="queue-empty">已经是这个歌单的最后一首</div>' : '';
    return;
  }

  let html = '<div class="palette-group-title">接下来 · ' + upcoming.length + ' 首</div>';
  upcoming.forEach((item, i) => {
    if (item.wrap) {
      html += '<div class="queue-empty">队列已到末尾，' + MODE_LABELS[playMode] + '会回到第一首</div>';
      return;
    }
    const song = item.song;
    html += '<div class="queue-item" onclick="playByIndex(' + item.index + ')" title="' + escapeAttr(song.title || '') + '">'
      + '<span class="qi-idx">' + (i + 1) + '</span>'
      + '<div class="qi-body">'
      + '<div class="qi-title">' + escapeHtml(song.title || '未知') + '</div>'
      + '<div class="qi-meta">' + escapeHtml(song.author || '') + '</div>'
      + '</div>'
      + '<span class="qi-dur num">' + formatDuration(song.duration || 0) + '</span>'
      + '</div>';
  });
  listEl.innerHTML = html;
}

/** 渲染首页: 继续播放 + 最近添加 */
function renderHome() {
  const heroEl = document.getElementById('homeHero');
  const rowEl = document.getElementById('homeRecent');
  if (!heroEl || !rowEl) return;

  const songs = getPlaylist();

  // 继续播放: 优先用上次播放的歌曲, 否则用歌单第一首
  let last = null;
  try {
    const saved = JSON.parse(localStorage.getItem('bilimusic_last_played') || 'null');
    if (saved && saved.bvid) {
      last = songs.find((s) => s.bvid === saved.bvid) || saved;
    }
  } catch (e) { /* ignore */ }
  if (!last && songs.length) last = songs[0];

  if (last) {
    heroEl.innerHTML = '<div class="home-hero">'
      + '<img class="hero-cover" alt="">'
      + '<div class="hero-body">'
      + '<div class="hero-kicker">继续播放</div>'
      + '<div class="hero-title">' + escapeHtml(last.title || '未知') + '</div>'
      + '<div class="hero-sub">' + escapeHtml(last.author || '') + '</div>'
      + '</div>'
      + '<div class="hero-actions">'
      + '<button class="btn-accent" onclick="playHomeHero()">' + icon('play', 'ic-sm') + '播放</button>'
      + '</div>'
      + '</div>';
    const img = heroEl.querySelector('.hero-cover');
    if (img) {
      if (last.cover) proxyImg(last.cover).then((d) => { if (d) img.src = d; });
      else img.style.opacity = '.25';
    }
  } else {
    heroEl.innerHTML = '<div class="home-hero">'
      + '<div class="hero-body">'
      + '<div class="hero-kicker">开始</div>'
      + '<div class="hero-title">还没有歌单内容</div>'
      + '<div class="hero-sub">搜索一首歌，加入歌单后就能在这里继续听</div>'
      + '</div>'
      + '<div class="hero-actions">'
      + '<button class="btn-accent" onclick="openPalette()">' + icon('search', 'ic-sm') + '搜索</button>'
      + '</div>'
      + '</div>';
  }

  // 最近添加: 取当前歌单最后 6 首
  if (!songs.length) {
    rowEl.innerHTML = '<div class="home-empty">歌单里还没有歌，按 Ctrl+K 搜索添加</div>';
    return;
  }
  const recent = songs.slice(-6).reverse();
  let html = '<div class="section-head"><span data-icon="clock"></span><span class="section-title">最近添加</span></div>'
    + '<div class="home-row">';
  recent.forEach((song) => {
    const idx = songs.indexOf(song);
    html += '<div class="home-tile" onclick="playByIndex(' + idx + ')" title="' + escapeAttr(song.title || '') + '">'
      + '<div class="tile-cover"><span>' + icon('music') + '</span></div>'
      + '<div class="tile-title">' + escapeHtml(song.title || '未知') + '</div>'
      + '<div class="tile-meta">' + escapeHtml(song.author || '') + '</div>'
      + '</div>';
  });
  html += '</div>';
  rowEl.innerHTML = html;
  if (window.BMIcons) window.BMIcons.hydrate(rowEl);

  rowEl.querySelectorAll('.home-tile').forEach((tile, i) => {
    const song = recent[i];
    const imgEl = tile.querySelector('.tile-cover');
    if (song && song.cover && imgEl) {
      proxyImg(song.cover).then((d) => { if (d) imgEl.innerHTML = '<img src="' + d + '" alt="">'; });
    }
  });
}

/** 首页主按钮: 播放上次那首 */
function playHomeHero() {
  const songs = getPlaylist();
  if (!songs.length) { openPalette(); return; }
  let index = 0;
  try {
    const saved = JSON.parse(localStorage.getItem('bilimusic_last_played') || 'null');
    if (saved && saved.bvid) {
      const i = songs.findIndex((s) => s.bvid === saved.bvid);
      if (i >= 0) index = i;
    }
  } catch (e) { /* ignore */ }
  playByIndex(index);
}

// ============ 命令面板 (Ctrl+K) ============
var _paletteItems = [];
var _paletteIndex = 0;
var _paletteTimer = null;
var _paletteSeq = 0;

const PALETTE_COMMANDS = [
  { id: 'play', title: '播放 / 暂停', meta: '播放控制', icon: 'play', run: function () { togglePlay(); } },
  { id: 'next', title: '下一首', meta: '播放控制', icon: 'next', run: function () { next(); } },
  { id: 'prev', title: '上一首', meta: '播放控制', icon: 'prev', run: function () { prev(); } },
  { id: 'queue', title: '查看播放队列', meta: '视图', icon: 'queue', run: function () { switchPanelTab('queue'); } },
  { id: 'focus', title: '歌单专注视图', meta: '视图', icon: 'grid', run: function () { togglePlaylistFocus(true); } },
  { id: 'theme', title: '更换皮肤', meta: '视图', icon: 'palette', run: function () { toggleThemePanel(); } },
  { id: 'import', title: '导入歌单 txt', meta: '数据', icon: 'download', run: function () { importPlaylistFile(); } },
  { id: 'export', title: '导出全部歌单', meta: '数据', icon: 'upload', run: function () { exportPlaylist(); } },
  { id: 'settings', title: '设置与关于', meta: '其他', icon: 'settings', run: function () { toggleSettings(); } }
];

function openPalette() {
  const el = document.getElementById('palette');
  if (!el) return;
  el.style.display = 'flex';
  const input = document.getElementById('paletteInput');
  if (input) { input.value = ''; input.focus(); }
  paletteRenderCommands();
}

function closePalette() {
  const el = document.getElementById('palette');
  if (el) el.style.display = 'none';
  _paletteSeq++;
}

function paletteRenderCommands() {
  _paletteItems = PALETTE_COMMANDS.map(function (c) {
    return { kind: 'cmd', cmd: c, title: c.title, meta: c.meta, icon: c.icon };
  });
  _paletteIndex = 0;
  palettePaint();
}

function palettePaint() {
  const list = document.getElementById('paletteList');
  if (!list) return;
  if (!_paletteItems.length) {
    list.innerHTML = '<div class="palette-empty">没有匹配的结果</div>';
    return;
  }
  let html = '';
  _paletteItems.forEach(function (item, i) {
    const active = i === _paletteIndex ? ' active' : '';
    if (item.kind === 'cmd') {
      html += '<div class="palette-item' + active + '" data-idx="' + i + '" onclick="paletteClick(' + i + ')">'
        + '<span class="pi-cmd">' + icon(item.icon) + '</span>'
        + '<div class="pi-body"><div class="pi-title">' + escapeHtml(item.title) + '</div>'
        + '<div class="pi-meta">' + escapeHtml(item.meta) + '</div></div>'
        + '<span class="pi-enter">' + (active ? 'Enter' : '') + '</span>'
        + '</div>';
    } else {
      html += '<div class="palette-item' + active + '" data-idx="' + i + '" onclick="paletteClick(' + i + ')">'
        + '<div class="pi-body"><div class="pi-title">' + escapeHtml(item.title) + '</div>'
        + '<div class="pi-meta">' + escapeHtml(item.meta) + '</div></div>'
        + '<span class="pi-enter">' + (active ? 'Enter' : '') + '</span>'
        + '</div>';
    }
  });
  list.innerHTML = html;
  const activeEl = list.querySelector('.palette-item.active');
  if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
}

function paletteOnInput() {
  const input = document.getElementById('paletteInput');
  if (!input) return;
  const q = input.value.trim();
  if (_paletteTimer) clearTimeout(_paletteTimer);
  if (!q) { paletteRenderCommands(); return; }

  // 先按命令名过滤, 立刻有反馈
  const matched = PALETTE_COMMANDS.filter(function (c) {
    return (c.title + c.meta).toLowerCase().indexOf(q.toLowerCase()) >= 0;
  });
  _paletteItems = matched.map(function (c) {
    return { kind: 'cmd', cmd: c, title: c.title, meta: c.meta, icon: c.icon };
  });
  _paletteIndex = 0;
  palettePaint();

  _paletteTimer = setTimeout(function () { paletteSearch(q); }, 280);
}

async function paletteSearch(q) {
  const seq = ++_paletteSeq;
  const list = document.getElementById('paletteList');
  if (list) list.innerHTML = '<div class="palette-loading">' + skeletonRows(3, false) + '</div>';
  try {
    const resp = await window.bili.search(q, 1);
    if (seq !== _paletteSeq) return;   // 已有更新的输入
    const results = (resp && resp.ok && resp.data && (resp.data.results || resp.data)) || [];
    const cmds = _paletteItems.filter(function (it) { return it.kind === 'cmd'; });
    const vids = results.slice(0, 8).map(function (v) {
      return {
        kind: 'video', video: v, title: v.title, icon: 'play',
        meta: (v.author || '') + (v.duration ? ' · ' + formatDuration(v.duration) : '')
      };
    });
    _paletteItems = vids.length ? vids.concat(cmds) : cmds;
    _paletteIndex = 0;
    if (!_paletteItems.length) {
      list.innerHTML = '<div class="palette-empty">没有找到「' + escapeHtml(q) + '」</div>';
      return;
    }
    palettePaint();
  } catch (e) {
    if (seq === _paletteSeq && list) list.innerHTML = '<div class="palette-empty">搜索失败，检查网络后重试</div>';
  }
}

function paletteOnKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (_paletteItems.length) { _paletteIndex = (_paletteIndex + 1) % _paletteItems.length; palettePaint(); }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (_paletteItems.length) { _paletteIndex = (_paletteIndex - 1 + _paletteItems.length) % _paletteItems.length; palettePaint(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    paletteRun(_paletteIndex);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
}

function paletteClick(i) { paletteRun(i); }

function paletteRun(i) {
  const item = _paletteItems[i];
  if (!item) return;
  closePalette();
  if (item.kind === 'cmd') {
    item.cmd.run();
  } else if (item.kind === 'video') {
    const v = item.video;
    addToPlaylist({ bvid: v.bvid, title: v.title, author: v.author, duration: v.duration, cover: v.cover }, true);
    addSearchHistory(item.title);
    showToast('开始播放：' + item.title, 'success');
  }
}

// Ctrl+K / Ctrl+P 打开命令面板; 面板开着时 Esc 关闭
document.addEventListener('keydown', function (e) {
  const palette = document.getElementById('palette');
  const isOpen = palette && palette.style.display !== 'none';
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    if (isOpen) closePalette(); else openPalette();
    return;
  }
  if (isOpen && e.key === 'Escape') { e.preventDefault(); closePalette(); }
});


// ============ 播放器视图坐标同步 ============
// 把中间列占位区相对窗口内容区的坐标发给主进程，让 WebContentsView 精确覆盖。
function relayoutPlayerView() {
  if (_playerSuppressBounds) return;
  let rect;
  if (_playlistFocus) {
    // 专注视图: 中间列已隐藏, 播放器视图整体收起(与是否全屏无关)
    rect = { x: 0, y: 0, width: 0, height: 0 };
  } else if (_playerFullscreen) {
    // 全屏：播放器覆盖整个窗口（保留底栏）
    const bar = document.getElementById('playerBar');
    const barH = bar ? bar.getBoundingClientRect().height : 80;
    rect = { x: 0, y: 0, width: window.innerWidth, height: Math.max(0, window.innerHeight - barH) };
  } else {
    const el = document.getElementById('playerFrameWrap');
    if (!el) return;
    const r = el.getBoundingClientRect();
    rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }
  window.bili.playerSetBounds(rect);
}

// ============ PLAYLIST ============
// 所有 playlist 操作自动使用当前活跃歌单，由 getPlaylist() / syncPlaylistRef() 管理

function savePlaylist() { savePlaylists(); }

function clearPlaylist() {
  if (!confirm('确认清空当前歌单「' + (playlists[currentPlaylistId]?.name || '') + '」？')) return;
  // 正在播放的歌也会被清掉, 必须先真正停下来, 否则音频会继续播放
  if (isPlaying || currentIndex >= 0) stopPlayback();
  getPlaylist().length = 0;
  currentIndex = -1;
  _currentPageIndex = -1;
  _pageStartTime = 0;
  savePlaylist(); renderPlaylist(); updatePlayerUI();
  showToast('歌单已清空');
}

function addToPlaylist(video, playNow = false) {
  const songs = getPlaylist();
  if (songs.some(p => p.bvid === video.bvid)) {
    showToast('已在歌单中', 'error'); return false;
  }
  // 为多P视频异步获取分集信息
  if (!video.pages) {
    window.bili.pages(video.bvid).then(resp => {
      if (resp.ok && resp.data && resp.data.length > 1) {
        video.pages = resp.data;
        // 更新总时长 (各段总和)
        const last = resp.data[resp.data.length - 1];
        video.duration = last.startTime + last.duration;
        renderPlaylist();
      }
    }).catch(() => {});
  }
  songs.push(video);
  savePlaylists();
  renderPlaylist();
  if (playNow) {
    playByIndex(songs.length - 1);
  } else {
    showToast('已添加到歌单', 'success');
  }
  renderPlaylistSelector();
  return true;
}

function removeFromPlaylist(index) {
  const songs = getPlaylist();
  if (index < 0 || index >= songs.length) return;
  
  // 删除的是当前播放的歌曲 → 停止播放并清理状态
  if (index === currentIndex) {
    _currentPageIndex = -1;
    _pageStartTime = 0;
    stopPlayback();
  } else if (index < currentIndex) {
    currentIndex--;
  }
  
  // 调整展开状态索引
  const newExpanded = {};
  for (const [k, v] of Object.entries(_expandedItems)) {
    const ki = parseInt(k);
    if (ki < index) newExpanded[ki] = v;
    else if (ki > index) newExpanded[ki - 1] = v;
    // ki === index → 被删除的项，丢弃
  }
  _expandedItems = newExpanded;
  
  songs.splice(index, 1);
  savePlaylists();
  renderPlaylist();
  updatePlayerUI();
}

function renderPlaylist() {
  renderQueue();
  renderHome();
  // 更新切换按钮图标
  const btn = document.getElementById('viewModeBtn');
  if (btn) btn.innerHTML = icon(_playlistViewMode === 'card' ? 'list' : 'grid');
  if (_playlistViewMode === 'list') renderPlaylistList();
  else renderPlaylistCards();
}

function themeById(id) {
  return THEMES.find(t => t.id === id) || THEMES[0];
}

/** 应用皮肤: 写入 body 上的 data-theme, 并记住选择 */
function applyTheme(id, opts) {
  const t = themeById(id);
  _theme = t.id;
  if (document.body) document.body.dataset.theme = t.id;
  try { localStorage.setItem(THEME_KEY, t.id); } catch (e) { /* ignore */ }
  const btn = document.getElementById('themeBtn');
  if (btn) btn.title = '更换皮肤（当前：' + t.name + '）';
  renderThemePanel();
  if (!opts || !opts.silent) showToast('已切换皮肤：' + t.name, 'success');
}

/** 渲染皮肤面板里的主题格子 */
function renderThemePanel() {
  const panel = document.getElementById('themePanel');
  if (!panel) return;
  const cur = themeById(_theme);
  let html = '<div class="tp-head"><span>选择皮肤</span><span class="tp-cur">当前：' + escapeHtml(cur.name) + '</span></div><div class="tp-grid">';
  for (const t of THEMES) {
    const active = t.id === _theme ? ' active' : '';
    html += '<button class="tp-tile' + active + '" data-action="set-theme" data-theme="' + escapeHtml(t.id) + '" title="' + escapeHtml(t.desc) + '">'
      + '<span class="tp-preview" style="background:' + escapeHtml(t.bg) + '">'
      + '<span class="tp-bar" style="background:linear-gradient(90deg,' + escapeHtml(t.accent) + ',' + escapeHtml(t.accent2) + ')"></span>'
      + '<span class="tp-dots"><i style="background:' + escapeHtml(t.accent) + '"></i><i style="background:' + escapeHtml(t.accent2) + '"></i><i style="background:' + escapeHtml(t.blue) + '"></i></span>'
      + '</span>'
      + '<span class="tp-name">' + escapeHtml(t.name) + '<em>' + escapeHtml(t.desc) + '</em></span>'
      + '</button>';
  }
  html += '</div>';
  panel.innerHTML = html;
}

/** 打开/收起皮肤面板 */
function toggleThemePanel(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const panel = document.getElementById('themePanel');
  if (!panel) return;
  _themePanelOpen = !_themePanelOpen;
  if (_themePanelOpen) {
    renderThemePanel();
    panel.classList.add('open');
  } else {
    panel.classList.remove('open');
  }
}

function hideThemePanel() {
  if (!_themePanelOpen) return;
  _themePanelOpen = false;
  const panel = document.getElementById('themePanel');
  if (panel) panel.classList.remove('open');
}

/** 切换歌单显示模式 */
function togglePlaylistViewMode() {
  _playlistViewMode = _playlistViewMode === 'card' ? 'list' : 'card';
  localStorage.setItem('bilimusic_playlist_view', _playlistViewMode);
  if (_playlistFocus) _viewModeBeforeFocus = _playlistViewMode;  // 专注视图里改了模式, 退出时以此为准
  renderPlaylist();
}

/**
 * 歌单专注视图: 全界面只显示歌单, 并以卡片形式铺开。
 * 只影响布局与显示, 播放行为完全不变(声音继续放, 只是把播放器视图收起来)。
 * 退出方式: 再点一次按钮, 或按 Esc。
 * @param {boolean} [force] 显式指定进入/退出
 */
function togglePlaylistFocus(force) {
  const next = (force === undefined) ? !_playlistFocus : !!force;
  if (next === _playlistFocus) return;
  _playlistFocus = next;

  if (_playlistFocus) {
    _viewModeBeforeFocus = _playlistViewMode;
    _playlistViewMode = 'card';        // 专注视图固定用卡片展示
  } else {
    _playlistViewMode = _viewModeBeforeFocus;
    localStorage.setItem('bilimusic_playlist_view', _playlistViewMode);
  }

  document.body.classList.toggle('playlist-focus', _playlistFocus);
  const btn = document.getElementById('focusBtn');
  if (btn) {
    btn.innerHTML = icon(_playlistFocus ? 'maximize-off' : 'grid');
  btn.title = _playlistFocus ? '退出歌单专注视图' : '歌单专注视图 (F)';
    btn.title = _playlistFocus ? '返回播放器界面' : '全界面只显示歌单（卡片视图）';
    btn.classList.toggle('active-view', _playlistFocus);
  }

  renderPlaylist();          // 切到卡片 / 还原原模式
  relayoutPlayerView();      // 中间列被隐藏后, 播放器视图同步收起/还原
}

function renderPlaylistCards() {
  const container = document.getElementById('playlist');
  const empty = document.getElementById('emptyPlaylist');
  const songs = getPlaylist();
  document.getElementById('playlistCount').textContent = `(${songs.length})`;

  if (songs.length === 0) {
    empty.style.display = 'block';
    container.querySelectorAll('.pl-card, .pl-card-grid, .pl-subitem, .pl-item, .pl-thumb, .pl-idx, .pl-expand').forEach(el => el.remove());
    return;
  }
  empty.style.display = 'none';

  let html = '';
  let gridOpen = false;

  function openGrid() { if (!gridOpen) { html += '<div class="pl-card-grid">'; gridOpen = true; } }
  function closeGrid() { if (gridOpen) { html += '</div>'; gridOpen = false; } }

  songs.forEach((item, i) => {
    const hasPages = item.pages && item.pages.length > 1;
    const isExpanded = _expandedItems[i];
    const active = i === currentIndex && isPlaying ? ' active' : '';
    const cover = item.cover || '';
    const pagesBadge = hasPages ? `<span class="pl-pages-badge">${icon(isExpanded ? 'folder-open' : 'folder', 'ic-sm')} ${item.pages.length} P</span>` : '';
    
    if (isExpanded && hasPages) {
      closeGrid();
      html += `<div style="margin:0 6px;">
        <div class="pl-card${active}" draggable="true"
             ondragstart="handleDragStart(event, ${i})" ondragend="handleDragEnd(event)"
             onclick="playByIndex(${i})" oncontextmenu="showPlaylistContextMenu(event, ${i})">
          <div class="pl-cover">
            ${cover ? `<img data-src="${escapeAttr(cover)}" loading="lazy">` : '<div class="cover-fallback">' + icon('music') + '</div>'}
            <span class="pl-index">${i + 1}</span>
            ${item.duration ? `<span class="pl-duration">${formatDuration(item.duration)}</span>` : ''}
            ${pagesBadge}
          </div>
          <button class="pl-del" onclick="event.stopPropagation();removeFromPlaylist(${i})" title="移除">${icon('x', 'ic-sm')}</button>
          <div class="pl-info">
            <div class="pl-title" title="${escapeAttr(item.title || '未知')}">${escapeHtml(item.title || '未知')}</div>
            <div class="pl-meta">${escapeHtml(item.author || '')}</div>
            <button class="pl-expand-btn" onclick="event.stopPropagation();togglePlaylistExpand(${i})">${icon('chevron-up', 'ic-sm')} 收起 ${item.pages.length} P</button>
          </div>
        </div>`;
      item.pages.forEach((page, pi) => {
        html += `<div class="pl-subitem pl-subitem-spring" onclick="playPage(${i}, ${pi})" oncontextmenu="event.stopPropagation();showPlaylistContextMenu(event, ${i})">
            <span class="pl-sidx">${pi + 1}</span>
            <div class="pl-info"><div class="pl-title" title="${escapeAttr(page.part || '第'+(pi+1)+'段')}">${escapeHtml(page.part || '第'+(pi+1)+'段')}</div><div class="pl-meta">${formatDuration(page.duration)}</div></div>
          </div>`;
      });
      html += `</div>`;
    } else {
      openGrid();
      html += `<div class="pl-card${active}" draggable="true"
           ondragstart="handleDragStart(event, ${i})" ondragend="handleDragEnd(event)"
           onclick="playByIndex(${i})" oncontextmenu="showPlaylistContextMenu(event, ${i})">
        <div class="pl-cover">
          ${cover ? `<img data-src="${escapeAttr(cover)}" loading="lazy">` : '<div class="cover-fallback">' + icon('music') + '</div>'}
          <span class="pl-index">${i + 1}</span>
          ${item.duration ? `<span class="pl-duration">${formatDuration(item.duration)}</span>` : ''}
          ${pagesBadge}
        </div>
        <button class="pl-del" onclick="event.stopPropagation();removeFromPlaylist(${i})" title="移除">${icon('x', 'ic-sm')}</button>
        <div class="pl-info">
          <div class="pl-title" title="${escapeAttr(item.title || '未知')}">${escapeHtml(item.title || '未知')}</div>
          <div class="pl-meta">${escapeHtml(item.author || '')}</div>
          ${hasPages ? `<button class="pl-expand-btn" onclick="event.stopPropagation();togglePlaylistExpand(${i})">${icon('chevron-down', 'ic-sm')} 展开 ${item.pages.length} P</button>` : ''}
        </div>
      </div>`;
    }
  });
  closeGrid();

  container.querySelectorAll('.pl-card, .pl-card-grid, .pl-subitem, .pl-item, .pl-thumb, .pl-idx, .pl-expand').forEach(el => el.remove());
  const temp = document.createElement('div');
  temp.innerHTML = html;
  while (temp.firstChild) container.appendChild(temp.firstChild);

  container.querySelectorAll('.pl-cover img[data-src]').forEach(img => {
    const src = img.getAttribute('data-src');
    if (src) proxyImg(src).then(d => { if (d) img.src = d; });
  });
}

function renderPlaylistList() {
  const container = document.getElementById('playlist');
  const empty = document.getElementById('emptyPlaylist');
  const songs = getPlaylist();
  document.getElementById('playlistCount').textContent = `(${songs.length})`;

  if (songs.length === 0) {
    empty.style.display = 'block';
    container.querySelectorAll('.pl-card, .pl-card-grid, .pl-subitem, .pl-item, .pl-thumb, .pl-idx, .pl-expand').forEach(el => el.remove());
    return;
  }
  empty.style.display = 'none';

  let html = '';
  songs.forEach((item, i) => {
    const hasPages = item.pages && item.pages.length > 1;
    const isExpanded = _expandedItems[i];
    const active = i === currentIndex && isPlaying ? ' active' : '';
    const multiIcon = hasPages ? icon(isExpanded ? 'folder-open' : 'folder', 'ic-sm') + ' ' : '';
    
    html += `<div class="pl-item${active}" draggable="true"
         ondragstart="handleDragStart(event, ${i})" ondragend="handleDragEnd(event)"
         oncontextmenu="showPlaylistContextMenu(event, ${i})">
      <span class="pl-idx">${i + 1}</span>
      <div class="pl-thumb"><span class="thumb-fb">${icon('music', 'ic-sm')}</span>${item.cover ? `<img data-src="${escapeAttr(item.cover)}" loading="lazy" onerror="this.remove()">` : ''}</div>
      <div class="pl-info" ondblclick="playByIndex(${i})">
        <div class="pl-title" title="${escapeAttr(item.title || '未知')}">${multiIcon ? multiIcon + ' ' : ''}${escapeHtml(item.title || '未知')}</div>
        <div class="pl-meta">${escapeHtml(item.author || '')} · ${formatDuration(item.duration || 0)}${hasPages ? ' · ' + item.pages.length + 'P' : ''}</div>
      </div>
      ${hasPages ? `<button class="pl-expand" onclick="event.stopPropagation();togglePlaylistExpand(${i})" title="${isExpanded ? '收起' : '展开'}子集">${icon(isExpanded ? 'chevron-up' : 'chevron-down', 'ic-sm')}</button>` : ''}
      <button class="pl-del" onclick="removeFromPlaylist(${i})" title="移除">${icon('x', 'ic-sm')}</button>
    </div>`;

    if (hasPages && isExpanded) {
      item.pages.forEach((page, pi) => {
        html += `<div class="pl-subitem" onclick="playPage(${i}, ${pi})" oncontextmenu="event.stopPropagation();showPlaylistContextMenu(event, ${i})">
          <span class="pl-sidx">${pi + 1}</span>
          <div class="pl-info">
            <div class="pl-title" title="${escapeAttr(page.part || '第' + (pi + 1) + '段')}">${escapeHtml(page.part || '第' + (pi + 1) + '段')}</div>
            <div class="pl-meta">${formatDuration(page.duration)}</div>
          </div>
        </div>`;
      });
    }
  });

  container.querySelectorAll('.pl-card, .pl-card-grid, .pl-subitem, .pl-item, .pl-thumb, .pl-idx, .pl-expand').forEach(el => el.remove());
  const temp = document.createElement('div');
  temp.innerHTML = html;
  while (temp.firstChild) container.appendChild(temp.firstChild);

  container.querySelectorAll('.pl-thumb img[data-src]').forEach(img => {
    const src = img.getAttribute('data-src');
    if (src) proxyImg(src).then(d => { if (d) img.src = d; });
  });
}

/** 滚动歌单到指定索引的歌曲并高亮 */
function scrollPlaylistToItem(index) {
  const container = document.getElementById('playlist');
  if (!container) return;
  const items = container.querySelectorAll('.pl-card, .pl-item');
  if (index >= 0 && index < items.length) {
    const target = items[index];
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.style.transition = 'box-shadow 0.3s, border-color 0.3s';
    target.style.borderColor = 'var(--pink)';
    target.style.boxShadow = '0 0 12px var(--pink-glow)';
    setTimeout(() => { target.style.borderColor = ''; target.style.boxShadow = ''; }, 1500);
  }
}

/** 展开/收起多P视频的子集目录 */
function togglePlaylistExpand(index) {
  const wasExpanded = !!_expandedItems[index];
  if (wasExpanded) {
    delete _expandedItems[index];
  } else {
    _expandedItems[index] = true;
  }
  renderPlaylist();

  // 展开后：把该卡片滚动到歌单顶部，子集像弹簧一样展开
  if (!wasExpanded) {
    setTimeout(() => {
      const container = document.getElementById('playlist');
      if (!container) return;
      const cards = container.querySelectorAll('.pl-card');
      if (cards[index]) {
        cards[index].scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      // 给所有子集添加展开动画类
      container.querySelectorAll('.pl-subitem').forEach(el => {
        el.classList.add('pl-subitem-spring');
      });
    }, 50);
  }
}

/** 播放多P视频中的某一分集 */
function playPage(parentIndex, pageIndex) {
  _playerSuppressBounds = false;
  const songs = getPlaylist();
  const item = songs[parentIndex];
  if (!item || !item.pages) return;
  const page = item.pages[pageIndex];
  if (!page) return;

  currentIndex = parentIndex;
  _currentPageIndex = pageIndex;
  _pageStartTime = page.startTime;
  isPlaying = true;
  currentDuration = page.duration;        // 进度条显示当前段时长
  elapsedSeconds = 0;                      // 相对当前段起始 0 秒
  updatePlayerBar(item);
  startProgressTimer();
  
  // 加载视频，用 ?p=N 跳转到对应分集（B站原生支持多P跳转）
  console.log('[playPage] page', page.page, 'startTime', page.startTime, 'for', item.bvid);
  // 用 page+1 因为 B 站的 ?p= 是 1-indexed
  window.bili.playerLoad(item.bvid, 0, page.page);
  document.getElementById('playerPlaceholder').style.display = 'none';
  relayoutPlayerView();
  
  updatePlayerUI();  // 自动显示子集标题
  showToast(`▶ ${page.part || '第' + (pageIndex + 1) + '段'}`, '');

  // 进入播放器全屏（隐藏左右侧栏）
  enterPlayerFullscreen();
}

// ============ DRAG & DROP ============
function handleDragStart(e, idx) { dragIdx = idx; e.dataTransfer.effectAllowed = 'move'; e.target.classList.add('drag-ghost'); }
function handleDragEnd(e) { e.target.classList.remove('drag-ghost'); dragIdx = -1; }
function handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function handleDrop(e) {
  e.preventDefault();
  const target = e.target.closest('.pl-card, .pl-item');
  if (!target || dragIdx < 0) return;
  const items = [...document.querySelectorAll('.pl-card, .pl-item')];
  const dropIdx = items.indexOf(target);
  if (dropIdx < 0 || dropIdx === dragIdx) return;
  const songs = getPlaylist();
  const [item] = songs.splice(dragIdx, 1);
  songs.splice(dropIdx, 0, item);
  if (currentIndex === dragIdx) currentIndex = dropIdx;
  else if (dragIdx < currentIndex && dropIdx >= currentIndex) currentIndex--;
  else if (dragIdx > currentIndex && dropIdx <= currentIndex) currentIndex++;
  savePlaylists();
  renderPlaylist();
}

// ============ 歌单选择器 (左栏顶部) ============
function renderPlaylistSelector() {
  const el = document.getElementById('playlistSelector');
  if (!el) return;
  const current = playlists[currentPlaylistId];
  const iconOf = (id) => (id === 'favorites' ? 'heart' : id === 'default' ? 'music' : 'folder');
  let html = `<button class="ps-current" onclick="togglePlaylistDropdown(event)">
    ${icon(iconOf(currentPlaylistId))} ${escapeHtml(current?.name || '歌单')}
    <span class="ps-chev">${icon('chevron-down', 'ic-sm')}</span>
  </button>`;
  html += `<div class="ps-dropdown" id="playlistDropdown" style="display:none;">`;
  for (const id of playlistOrder) {
    const pl = playlists[id];
    if (!pl) continue;
    const active = id === currentPlaylistId ? ' ps-active' : '';
    html += `<div class="ps-item${active}" data-action="switch-playlist" data-plid="${escapeHtml(id)}">
      <span class="ps-ico">${icon(iconOf(id))}</span> ${escapeHtml(pl.name)} <span class="ps-count">${pl.songs.length}</span>
      ${(id !== 'default' && id !== 'favorites') ? `<span class="ps-del" data-action="delete-playlist" data-plid="${escapeHtml(id)}" title="删除">${icon('x', 'ic-sm')}</span>` : ''}
    </div>`;
  }
  html += `<div class="ps-item ps-new" onclick="showCreatePlaylistDialog();hidePlaylistDropdown()">${icon('plus', 'ic-sm')} 新建歌单</div>`;
  html += `</div>`;
  el.innerHTML = html;
}

function togglePlaylistDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('playlistDropdown');
  const show = dd.style.display !== 'block';
  dd.style.display = show ? 'block' : 'none';
}
function hidePlaylistDropdown() {
  const dd = document.getElementById('playlistDropdown');
  if (dd) dd.style.display = 'none';
}
// 点击外部关闭下拉
document.addEventListener('click', (e) => {
  if (!e.target.closest('#playlistSelector')) hidePlaylistDropdown();
});

// ============ 右键菜单: 添加到「我喜欢的」 ============
function showPlaylistContextMenu(e, index) {
  e.preventDefault();
  const songs = getPlaylist();
  if (!songs[index]) return;
  const item = songs[index];
  const menu = document.getElementById('contextMenu');
  const menuItem = document.getElementById('contextFav');
  // 检查是否已在「我喜欢的」中
  const inFav = playlists.favorites.songs.some(p => p.bvid === item.bvid);
  menuItem.innerHTML = icon('heart', 'ic-sm') + (inFav ? ' 已在「我喜欢的」' : ' 添加到「我喜欢的」');
  menuItem.className = inFav ? 'cm-item cm-disabled' : 'cm-item';
  contextMenuTarget = item;
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
}

// 点击右键菜单项
function contextAddToFavorites() {
  if (!contextMenuTarget) return;
  const item = contextMenuTarget;
  addToFavorites(item.bvid, item.title, item.author, item.duration, item.cover);
  hideContextMenu();
}

/** 右键: 把这首歌挪到当前播放的下一首(播放队列就是歌单顺序) */
function contextAddToQueue() {
  const item = contextMenuTarget;
  hideContextMenu();
  if (!item) return;
  const songs = getPlaylist();
  const from = songs.findIndex((s) => s.bvid === item.bvid);
  if (from < 0) { showToast('这首歌不在当前歌单里', 'error'); return; }
  if (from === currentIndex) { showToast('这首歌正在播放', 'error'); return; }

  const moved = songs.splice(from, 1)[0];
  if (from < currentIndex) currentIndex--;
  const at = currentIndex < 0 ? songs.length : currentIndex + 1;
  songs.splice(at, 0, moved);

  savePlaylists();
  renderPlaylist();
  renderQueue();
  showToast('已加入播放队列：' + (moved.title || ''), 'success');
}

function hideContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
  contextMenuTarget = null;
	}

// 点击页面空白关闭右键菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('#contextMenu')) hideContextMenu();
});

// ============ 播放器全屏模式 ============
// 让 B 站播放器进入网页全屏
function enterPlayerFullscreen() {
  window.bili.playerPageFullscreen();
}

// ============ 全屏（播放器覆盖窗口，保留底栏） ============
function togglePlayerFullscreen() {
  _playerFullscreen = !_playerFullscreen;
  const btn = document.getElementById('fullscreenBtn');
  if (btn) {
    btn.innerHTML = icon(_playerFullscreen ? 'maximize-off' : 'maximize');
  btn.title = _playerFullscreen ? '退出全屏' : '全屏';
    btn.title = _playerFullscreen ? '退出全屏' : '播放窗口全屏';
  }
  relayoutPlayerView();
}

// 以下已经整合进 relayoutPlayerView() 中：
// _playerFullscreen = true  → playerView 覆盖整个窗口（保留底栏）
// _playerFullscreen = false → playerView 显示在中间列

// ============ PLAYER (内嵌 WebContentsView) ============
function playByIndex(index) {
  if (index < 0 || index >= playlist.length) return;
  _playerSuppressBounds = false;

  currentIndex = index;
  _currentPageIndex = -1;
  _pageStartTime = 0;
  const video = playlist[index];

  // 通知主进程: 把内嵌播放器视图加载到该 BV 页
  window.bili.playerLoad(video.bvid, 0);

  // 隐藏欢迎占位，露出底层播放器视图并定位
  document.getElementById('playerPlaceholder').style.display = 'none';
  relayoutPlayerView();

  isPlaying = true;
  currentDuration = video.duration || 180;
  elapsedSeconds = 0;
  _videoPages = [];
  updatePlayerBar(video);
  startProgressTimer();
  updatePlayerUI();
  renderPlaylist();
  savePlaylist();
  showToast(`正在播放: ${video.title}`, 'success');

  // 异步获取分集/章节信息 (多P列表)
  loadVideoPages(video.bvid);

  // 进入播放器全屏（隐藏左右侧栏）
  enterPlayerFullscreen();
}

/** 异步加载分集/章节信息，在进度条上显示标记 */
async function loadVideoPages(bvid) {
  try {
    const resp = await window.bili.pages(bvid);
    if (resp.ok && resp.data && resp.data.length > 1) {
      _videoPages = resp.data;
      // 同步到歌单项上（让歌单显示展开按钮）
      const songs = getPlaylist();
      const item = songs.find(s => s.bvid === bvid);
      if (item) item.pages = resp.data;
      // 用总时长校正 duration
      const last = _videoPages[_videoPages.length - 1];
      const total = last.startTime + last.duration;
      if (total > 0) currentDuration = total;
      renderPlaylist();
      updateProgressUI();
    } else {
      _videoPages = [];
    }
  } catch (e) {
    _videoPages = [];
  }
}

function updatePlayerBar(video) {
  // 播放栏 (底部) 的封面/标题
  setStageTint(video && video.cover);
  if (video && video.bvid) {
    try {
      localStorage.setItem('bilimusic_last_played', JSON.stringify({
        bvid: video.bvid, title: video.title, author: video.author, cover: video.cover || ''
      }));
    } catch (e) { /* ignore */ }
  }
  renderQueue();
  const thumb = document.getElementById('npThumb');
  if (video.cover) {
    proxyImg(video.cover).then(d => { if (d) { thumb.src = d; thumb.style.display = 'block'; } });
  } else {
    thumb.style.display = 'none';
  }
}

function togglePlay() {
  if (currentIndex < 0 && playlist.length > 0) { playByIndex(0); return; }
  if (currentIndex < 0) return;

  const video = playlist[currentIndex];
  if (isPlaying) {
    // 暂停: 直接暂停 B 站播放器的 video 元素 (不隐藏窗口、不重新加载)
    window.bili.playerPause();
    isPlaying = false;
    stopProgressTimer();
    showToast('播放已暂停');
  } else {
    // 继续播放: 直接恢复 B 站播放器的 video 元素
    window.bili.playerResume();
    document.getElementById('playerPlaceholder').style.display = 'none';
    isPlaying = true;
    // 用已记录的 elapsedSeconds 续接进度计时
    playbackStartTime = Date.now();
    playbackStartOffset = elapsedSeconds;
    startProgressTimer();
    showToast(`继续播放: ${video.title}`);
  }
  updatePlayerUI();
  renderPlaylist();
}

function stopPlayback() {
  setStageTint(null);
  _playerSuppressBounds = true;
  window.bili.playerHide();
  document.getElementById('playerPlaceholder').style.display = 'flex';
  isPlaying = false;
  stopProgressTimer();
  elapsedSeconds = 0;
  updatePlayerUI();
  renderPlaylist();
  // 延迟恢复坐标发送（等 re-render 完成）
  setTimeout(() => { _playerSuppressBounds = false; }, 500);
}

function updatePlayerUI() {
  const video = playlist[currentIndex];
  if (_currentPageIndex >= 0 && video && video.pages && video.pages[_currentPageIndex]) {
    // 子集: 显示当前段标题
    const page = video.pages[_currentPageIndex];
    document.getElementById('npTitle').textContent = page.part || video.title;
    document.getElementById('npAuthor').textContent = video.author;
  } else {
    document.getElementById('npTitle').textContent = video ? video.title : '未播放';
    document.getElementById('npAuthor').textContent = video ? video.author : '';
  }
  document.getElementById('btnPlay').innerHTML = icon(isPlaying ? 'pause' : 'play');
  if (!video) document.getElementById('npThumb').style.display = 'none';
  updateProgressUI();
  document.getElementById('modeLabel').innerHTML = icon(MODE_ICONS[playMode]) + '<span>' + MODE_LABELS[playMode] + '</span>';
  renderQueue();
}

function updateProgressUI() {
  const pct = currentDuration > 0 ? Math.min(100, (elapsedSeconds / currentDuration) * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('npTime').textContent = formatDuration(elapsedSeconds);
  document.getElementById('npDuration').textContent = formatDuration(currentDuration);
}

/** 收尾: 防止同一个 tick 里重复触发跳转 */
let _ending = false;
function finishSong() {
  if (_ending) return;
  _ending = true;
  setTimeout(() => { _ending = false; }, 1500);
  try { onSongEnd(); } catch (e) { /* ignore */ }
}

function onSongEnd() {
  if (playMode === 'single-loop') {
    if (_currentPageIndex >= 0 && playlist[currentIndex] && playlist[currentIndex].pages) {
      playPage(currentIndex, _currentPageIndex);
    } else {
      playByIndex(currentIndex);
    }
  } else {
    next();
  }
}

function startProgressTimer() {
  stopProgressTimer();
  playbackStartTime = Date.now();
  playbackStartOffset = elapsedSeconds;
  let tickCount = 0;

  progressTickFunc = () => {
    // 调试: 确认 tick 在跑
    // console.log('[tick] elapsed=', elapsedSeconds, 'dur=', currentDuration);
    
    // 每 3 秒从 B 站播放器同步一次真实进度 (纠正模拟计时误差)
    tickCount++;
    if (isPlaying && tickCount % 3 === 1) {
      window.bili.playerStatus().then(r => {
        if (!r.ok || !r.data) return;
        const d = r.data;
        const dur = Number(d.duration) || 0;
        const ct = Number(d.currentTime) || 0;
        // 页面可能已经跳到 B 站的"相关推荐"那一集, 时长对不上就别用来校准
        if (dur > 0 && currentDuration > 0 && Math.abs(dur - currentDuration) > 4) return;
        if (dur > 0 && !currentDuration) currentDuration = Math.round(dur);
        if (!d.paused && ct > 0) {
          elapsedSeconds = Math.floor(ct);
          playbackStartTime = Date.now();
          playbackStartOffset = elapsedSeconds;
        }
        // 已暂停且停在末尾(播完的那一刻), 或者进度到头 → 跳下一首
        if (dur > 0 && ct >= dur - 1.5) finishSong();
      }).catch(() => {});
    }

    // 模拟进度必须一直往前走。原来的写法只在"偏差 > 3s"时才更新,
    // 结果播到末尾时 elapsedSeconds 卡在 duration-2 左右, 永远到不了 duration,
    // onSongEnd() 也就永远不触发 —— 这就是"播完不跳下一首"的根因。
    const realElapsed = playbackStartOffset + Math.floor((Date.now() - playbackStartTime) / 1000);
    if (realElapsed > elapsedSeconds) elapsedSeconds = realElapsed;
    updateProgressUI();
    if (currentDuration > 0 && elapsedSeconds >= currentDuration - 0.5) finishSong();
  };

  // 递归 setTimeout，后台更可靠
  function scheduleTick() {
    if (!progressTickFunc) return;
    progressTickFunc();
    if (!progressTickFunc) return;
    progressTimer = setTimeout(scheduleTick, 1000);
  }
  scheduleTick();
}

function stopProgressTimer() {
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  progressTickFunc = null;
}

function seekProgress(e) {
  if (currentIndex < 0 || currentDuration <= 0) return;
  const bar = document.getElementById('progressOuter');
  const rect = bar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  elapsedSeconds = Math.floor(pct * currentDuration);
  playbackStartTime = Date.now();
  playbackStartOffset = elapsedSeconds;
  updateProgressUI();

  // 让内嵌播放器跳转到该时间点
  const video = playlist[currentIndex];
  if (isPlaying) {
    if (_pageStartTime > 0 && _currentPageIndex >= 0 && video && video.pages && video.pages[_currentPageIndex]) {
      // 子集: ?p=N&t=相对当前段的时间 (B站 currentTime 是相对段内)
      const pageNum = video.pages[_currentPageIndex].page;
      window.bili.playerSeek(video.bvid, elapsedSeconds, pageNum);
    } else {
      window.bili.playerSeek(video.bvid, elapsedSeconds);
    }
  }
}

function next() {
  if (playlist.length === 0) return;

  // 如果在子集中，优先在全集内跳转
  const p = getCurrentPages();
  if (p && _currentPageIndex >= 0) {
    let nextPageIdx;
    if (playMode === 'random') {
      nextPageIdx = Math.floor(Math.random() * p.length);
      if (p.length > 1 && nextPageIdx === _currentPageIndex) nextPageIdx = (nextPageIdx + 1) % p.length;
    } else if (playMode === 'sequential') {
      nextPageIdx = _currentPageIndex + 1;
      if (nextPageIdx >= p.length) {
        _currentPageIndex = -1;
        let nextIdx = currentIndex + 1;
        if (nextIdx >= playlist.length) { stopPlayback(); showToast('播放列表已结束'); return; }
        playByIndex(nextIdx);
        return;
      }
    } else {
      nextPageIdx = (_currentPageIndex + 1) % p.length;
    }
    playPage(currentIndex, nextPageIdx);
    return;
  }

  // 普通模式（不在子集中）
  let nextIndex;
  if (playMode === 'random') {
    nextIndex = Math.floor(Math.random() * playlist.length);
    if (playlist.length > 1 && nextIndex === currentIndex) nextIndex = (nextIndex + 1) % playlist.length;
  } else if (playMode === 'sequential') {
    nextIndex = currentIndex + 1;
    if (nextIndex >= playlist.length) { stopPlayback(); showToast('播放列表已结束'); return; }
  } else {
    nextIndex = (currentIndex + 1) % playlist.length;
  }
  playByIndex(nextIndex);
}

function prev() {
  if (playlist.length === 0) return;

  // 如果在子集中，优先在全集内跳转
  const p = getCurrentPages();
  if (p && _currentPageIndex >= 0) {
    let prevPageIdx = _currentPageIndex - 1;
    if (prevPageIdx < 0) prevPageIdx = p.length - 1;
    playPage(currentIndex, prevPageIdx);
    return;
  }

  // 普通模式
  let prevIndex = currentIndex - 1;
  if (prevIndex < 0) prevIndex = playlist.length - 1;
  playByIndex(prevIndex);
}

function getCurrentPages() {
  const item = playlist[currentIndex];
  return item && item.pages ? item.pages : null;
}

function toggleMode() {
  const modes = ['list-loop', 'single-loop', 'random', 'sequential'];
  const idx = modes.indexOf(playMode);
  playMode = modes[(idx + 1) % modes.length];
  updatePlayerUI();
  showToast('模式: ' + MODE_LABELS[playMode]);
}

// ============ SEARCH HISTORY ============
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch(e) { return []; }
}
function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}
function addSearchHistory(query) {
  if (!query) return;
  let history = getHistory();
  history = history.filter(h => h !== query);
  history.unshift(query);
  saveHistory(history);
}
function showSearchHistory() {
  const history = getHistory();
  if (history.length === 0) return;
  const el = document.getElementById('searchHistory');
  let html = '';
  history.forEach(q => {
    html += `<div class="search-history-item" data-action="quick-search" data-query="${escapeHtml(q)}">
      <span class="hist-icon">${icon('clock')}</span>
      <span class="hist-text">${escapeHtml(q)}</span>
      <button class="hist-del" data-action="del-history" data-query="${escapeHtml(q)}" title="删除">${icon('x', 'ic-sm')}</button>
    </div>`;
  });
  html += '<div class="search-history-clear" data-action="clear-history">' + icon('trash', 'ic-sm') + ' 清除历史记录</div>';
  el.innerHTML = html;
  el.style.display = 'block';
}
function hideSearchHistory() {
  document.getElementById('searchHistory').style.display = 'none';
}
function removeSearchHistory(query) {
  let history = getHistory().filter(h => h !== query);
  saveHistory(history);
  showSearchHistory();
}
function clearSearchHistory() {
  localStorage.removeItem(HISTORY_KEY);
  hideSearchHistory();
}

// ============ SEARCH ============
async function search() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) return;
  addSearchHistory(query);
  hideSearchHistory();
  searchPage = 1; searchQuery = query;
  await doSearch(query);
}
async function quickSearch(keyword) {
  document.getElementById('searchInput').value = keyword;
  addSearchHistory(keyword);
  hideSearchHistory();
  searchPage = 1; searchQuery = keyword;
  await doSearch(keyword);
}

async function doSearch(query) {
  const isFirstPage = (searchPage === 1);

  if (isFirstPage) {
    // 确保搜索结果容器存在
    let container = document.getElementById('searchResultsContainer');
    if (!container) {
      const area = document.getElementById('resultsArea');
      container = document.createElement('div');
      container.id = 'searchResultsContainer';
      area.appendChild(container);
    }
    container.innerHTML = skeletonRows(6);
    container.style.display = '';
    // 隐藏欢迎页
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) welcome.style.display = 'none';
  }

  try {
    const resp = await window.bili.search(query, searchPage);
    if (!resp.ok) throw new Error(resp.message || '搜索失败');
    searchHasMore = resp.data.hasMore;
    renderSearchResults(resp.data.results, isFirstPage);
    // 切到搜索 tab
    _hasSearched = true;
    switchSearchTab('search');
  } catch(e) {
    if (isFirstPage) {
      const container = document.getElementById('searchResultsContainer');
      if (container) {
        container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red);">搜索失败: ${escapeHtml(e.message)}<br><button data-action="retry-search" style="margin-top:12px;background:var(--pink);color:#fff;border:none;padding:8px 20px;border-radius:20px;cursor:pointer;">重试</button></div>`;
      }
    } else { showToast('加载失败', 'error'); }
  }
}

// ============ 导入歌单 ============

/**
 * 解码文本文件: 依次尝试 BOM / UTF-8(严格) / GB18030 / GBK / Big5。
 * 放在渲染进程做, 因为 Chromium 一定支持这些编码(主进程的 TextDecoder 不保证)。
 */
function decodeTextBuffer(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* 不是合法 UTF-8 */ }
  for (const enc of ['gb18030', 'gbk', 'big5']) {
    try { return new TextDecoder(enc).decode(bytes); } catch (e) { /* 试下一个 */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** 导入 TXT 歌单文件(自动识别 UTF-8 / GBK 等常见中文编码) */
function importPlaylistFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,text/plain';
  input.onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = decodeTextBuffer(await file.arrayBuffer());
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) throw new Error('文件里没有内容');
      const result = await window.bili.importSongs(lines);
      if (!result.ok) throw new Error(result.message || '保存失败');
      showToast(`已导入 ${result.added} 首新歌（库中共 ${result.total} 首）`, 'success');
      await refreshImportedSongs();
    } catch (err) {
      showToast('导入失败: ' + err.message, 'error');
    }
  };
  input.click();
}

/** 刷新随机歌名显示 */
async function refreshImportedSongs() {
  try {
    const result = await window.bili.getRandomSongs(7);
    const container = document.getElementById('importedSongList');
    if (!container) return;
    const list = (result && result.ok && result.songs) || [];
    const countEl = document.getElementById('importedCount');
    if (countEl) countEl.textContent = String((result && result.total) != null ? result.total : list.length);

    if (!list.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-ico">' + icon('download') + '</div>'
        + '<div class="empty-title">还没有导入歌单</div>'
        + '<div>选一个 txt（每行一首），这里就会随机显示歌名</div>'
        + '<button class="btn-secondary" onclick="importPlaylistFile()">选择文件</button></div>';
      return;
    }

    container.innerHTML = list.map(function (name, i) {
      // "歌名 - 歌手" 拆成两行, 和播放队列的行长得一致
      const parts = String(name).split(' - ');
      const title = parts.shift() || name;
      const artist = parts.join(' - ');
      return '<div class="queue-item imported-row" data-action="quick-search" data-query="' + escapeHtml(name) + '" title="点一下搜索「' + escapeAttr(name) + '」">'
        + '<span class="qi-idx">' + (i + 1) + '</span>'
        + '<div class="qi-body">'
        + '<div class="qi-title">' + escapeHtml(title) + '</div>'
        + (artist ? '<div class="qi-meta">' + escapeHtml(artist) + '</div>' : '')
        + '</div>'
        + '<span class="qi-go">' + icon('search', 'ic-sm') + '</span>'
        + '</div>';
    }).join('');
  } catch (e) {
    // ignore
  }
}

/** 加载并启动定时刷新（全局只启动一次） */
function initImportedSongs() {
  refreshImportedSongs();
  // 每隔 5 分钟自动刷新（只设置一次）
  if (!_importedRefreshTimer) {
    _importedRefreshTimer = setInterval(refreshImportedSongs, 5 * 60 * 1000);
  }
}

function renderSearchResults(results, isFirstPage = true) {
  // 使用 searchResultsContainer，不破坏 welcomeScreen
  let container = document.getElementById('searchResultsContainer');
  if (!container) {
    const area = document.getElementById('resultsArea');
    container = document.createElement('div');
    container.id = 'searchResultsContainer';
    area.appendChild(container);
  }
  
  if (isFirstPage && (!results || results.length === 0)) {
    container.innerHTML = '<div class="empty-state"><div class="empty-ico">' + icon('search') + '</div><div class="empty-title">没有找到结果</div><div>换个关键词试试</div></div>';
    return;
  }

  let html = '';
  if (isFirstPage) {
    html += `<div class="search-summary">“${escapeHtml(searchQuery)}” 的结果</div>`;
    html += '<div class="results-grid">';
  }

  results.forEach(v => {
    const inPl = playlist.some(p => p.bvid === v.bvid);
    html += `<div class="result-card" data-bvid="${escapeHtml(v.bvid)}" data-title="${escapeHtml(v.title)}" data-author="${escapeHtml(v.author)}" data-duration="${v.duration||0}" data-cover="${escapeHtml(v.cover||'')}" onclick="cardClick(this)">
      <div class="cover-wrap">
        <img class="card-cover" data-src="${escapeAttr(v.cover||'')}" onerror="this.style.display='none'" loading="lazy">
        ${v.duration ? `<span class="duration">${formatDuration(v.duration)}</span>` : ''}
        <button class="add-btn ${inPl?'added':''}" onclick="event.stopPropagation();cardToggle(this)" data-bvid="${escapeHtml(v.bvid)}" data-title="${escapeHtml(v.title)}" data-author="${escapeHtml(v.author)}" data-duration="${v.duration||0}" data-cover="${escapeHtml(v.cover||'')}">${inPl ? icon('check', 'ic-sm') : icon('plus', 'ic-sm')}</button>
      </div>
      <div class="card-info">
        <div class="card-title">${escapeHtml(v.title)}</div>
        <div class="card-meta">${icon('user', 'ic-sm')} ${escapeHtml(v.author)} ${v.play?'· '+formatCount(v.play):''}</div>
      </div>
    </div>`;
  });

  if (isFirstPage) {
    html += '</div>';
    container.innerHTML = html;
  } else {
    const grid = container.querySelector('.results-grid');
    if (grid) grid.insertAdjacentHTML('beforeend', html);
  }

  // 异步加载封面图
  container.querySelectorAll('.card-cover').forEach(img => {
    const src = img.getAttribute('data-src');
    if (src) proxyImg(src).then(d => { if (d) img.src = d; });
  });

  const oldBtn = container.querySelector('.load-more-area');
  if (oldBtn) oldBtn.remove();

  if (searchHasMore) {
    container.insertAdjacentHTML('beforeend', `<div class="load-more-area"><button onclick="loadMoreResults()">${icon('download', 'ic-sm')} 加载更多（第 ${searchPage + 1} 页）</button></div>`);
  } else if (!isFirstPage) {
    container.insertAdjacentHTML('beforeend', '<div class="end-of-list">— 已到底 —</div>');
  }
}

async function loadMoreResults() {
  const btn = document.querySelector('.load-more-area button');
  if (btn) { btn.textContent = '加载中…'; btn.disabled = true; }
  searchPage++;
  await doSearch(searchQuery);
}

function cardClick(card) {
  const bvid = card.dataset.bvid, title = card.dataset.title, author = card.dataset.author;
  const duration = parseInt(card.dataset.duration) || 0, cover = card.dataset.cover;
  
  // 检查是否已在歌单中
  const songs = getPlaylist();
  const existingIndex = songs.findIndex(p => p.bvid === bvid);
  if (existingIndex >= 0) {
    // 已在歌单 → 跳转到该歌曲并播放
    playByIndex(existingIndex);
    // 滚动歌单到该位置
    scrollPlaylistToItem(existingIndex);
    showToast(`已跳转到: ${title}`, '');
    return;
  }
  
  addToPlaylist({bvid, title, author, duration, cover}, true);
}

function cardToggle(btn) {
  const bvid = btn.dataset.bvid, title = btn.dataset.title, author = btn.dataset.author;
  const duration = parseInt(btn.dataset.duration) || 0, cover = btn.dataset.cover;
  if (playlist.some(p => p.bvid === bvid)) {
    showToast('已在当前歌单中', 'error');
  } else {
    const others = playlistNamesWith(bvid);
    addToPlaylist({bvid, title, author, duration, cover});
    btn.classList.add('added');
    btn.innerHTML = icon('check', 'ic-sm');
    if (others.length) showToast(`该视频也在「${others[0]}」中, 已加入当前歌单`);
  }
}

function toggleClearBtn() {
  document.getElementById('clearBtn').style.display = document.getElementById('searchInput').value ? 'block' : 'none';
}
function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('clearBtn').style.display = 'none';
  switchSearchTab('hot');
  document.getElementById('searchInput').focus();
}


// ============ 播放器辅助 ============
/** 该视频还在哪些(非当前)歌单里 */
function playlistNamesWith(bvid) {
  const names = [];
  for (const id of playlistOrder) {
    if (id === currentPlaylistId) continue;
    const pl = playlists[id];
    if (pl && pl.songs.some(s => s.bvid === bvid)) names.push(pl.name);
  }
  return names;
}

/** 读取播放器真实音量并回显到滑块 */
async function syncVolumeFromPlayer() {
  try {
    const resp = await window.bili.playerGetVolume();
    const slider = document.getElementById('volumeSlider');
    if (slider && resp && resp.ok && typeof resp.volume === 'number') {
      slider.value = Math.round(resp.volume * 100);
    }
  } catch (e) { /* 忽略 */ }
}

/** 播放器页加载失败: 中间栏显示可重试的提示 */
function showPlayerError(info) {
  const ph = document.getElementById('playerPlaceholder');
  if (!ph) return;
  if (_placeholderHtml === null) _placeholderHtml = ph.innerHTML;
  ph.style.display = 'flex';
  ph.innerHTML = `
    <div class="icon">⚠️</div>
    <p style="font-size:15px;">视频页加载失败</p>
    <p style="font-size:12px;color:var(--text-tertiary);">${escapeHtml((info && info.message) || '网络异常')} ${info && info.code ? '(' + escapeHtml(String(info.code)) + ')' : ''}</p>
    <button onclick="retryPlayer()" style="margin-top:12px;padding:6px 18px;border-radius:10px;background:var(--card);border:1px solid var(--border);color:var(--text);cursor:pointer;font-family:inherit;">${icon('refresh', 'ic-sm')} 重试</button>`;
  showToast('播放器加载失败, 可点击重试', 'error');
}

/** 重新加载当前歌曲 */
function retryPlayer() {
  const ph = document.getElementById('playerPlaceholder');
  const video = playlist[currentIndex];
  if (!video) return;
  const pageNum = (_currentPageIndex >= 0 && video.pages && video.pages[_currentPageIndex]) ? video.pages[_currentPageIndex].page : 0;
  if (_placeholderHtml !== null) ph.innerHTML = _placeholderHtml;
  ph.style.display = 'none';
  window.bili.playerReload(video.bvid, elapsedSeconds, pageNum);
  relayoutPlayerView();
}

/** 填充「关于」: 真实版本号与数据目录 */
async function loadAppInfo() {
  try {
    const resp = await window.bili.appInfo();
    if (!resp || !resp.ok) return;
    const ver = document.getElementById('aboutVersion');
    const runtime = resp.runtime || ('Electron ' + resp.electron);
    if (ver) ver.textContent = `v${resp.version}${resp.packaged ? '' : ' (开发模式)'} · ${runtime}`;
    const dir = document.getElementById('aboutDataDir');
    if (dir) dir.textContent = `数据目录: ${resp.userData}`;
  } catch (e) { /* 忽略 */ }
}

// ============ LOGIN ============
async function toggleLogin() {
  const modal = document.getElementById('loginModal');
  if (modal.style.display === 'flex') { closeLogin(); return; }
  modal.style.display = 'flex';
  document.getElementById('loginStatus').textContent = '加载二维码...';
  document.getElementById('loginActions').style.display = 'none';
  await generateQRCode();
}

function closeLogin() {
  document.getElementById('loginModal').style.display = 'none';
  if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
}

async function generateQRCode() {
  const img = document.getElementById('loginQrImg');
  const placeholder = document.getElementById('loginQrPlaceholder');
  try {
    const resp = await window.bili.generateQR();
    if (!resp.ok) throw new Error(resp.message || '');
    // qrcode_url 是 B 站登录页面 URL，需转为二维码图片
    // 调主进程: 去 api.qrserver.com 生成二维码 PNG，返回 dataUrl
    const qrResp = await window.bili.genQR(resp.url);
    if (!qrResp.ok) throw new Error(qrResp.message || '二维码生成失败');
    img.src = qrResp.dataUrl;
    img.style.display = 'block';
    placeholder.style.display = 'none';
    document.getElementById('loginStatus').textContent = '请用 B 站 App 扫码确认';
    document.getElementById('loginActions').style.display = 'block';
    startLoginPolling(resp.qrcodeKey);
  } catch(e) {
    placeholder.textContent = '获取失败';
    document.getElementById('loginStatus').textContent = '获取二维码失败: ' + e.message;
    document.getElementById('loginActions').style.display = 'block';
  }
}

function refreshQRCode() {
  if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
  generateQRCode();
}

function startLoginPolling(qrcodeKey) {
  if (loginPollTimer) clearInterval(loginPollTimer);
  loginPollTimer = setInterval(async () => {
    try {
      const resp = await window.bili.poll(qrcodeKey);
      if (!resp.ok) return;
      const code = resp.data.code;
      switch(code) {
        case 0:
          clearInterval(loginPollTimer);
          loginPollTimer = null;
          document.getElementById('loginStatus').textContent = '扫码成功，验证中…';
          await new Promise(r => setTimeout(r, 1500));
          await fetchLoginStatus();
          if (loginUserInfo?.isLogin) {
            document.getElementById('loginStatus').textContent = '登录成功，欢迎 ' + (loginUserInfo.uname||'');
            updateLoginUI();
            showToast('登录成功', 'success');
            // 登录后重载当前播放的视频 (让内嵌播放器中的 B 站页感知到登录态)
            if (currentIndex >= 0 && playlist[currentIndex]) {
              const v = playlist[currentIndex];
              window.bili.playerReload(v.bvid, Math.floor(elapsedSeconds));
            }
            setTimeout(closeLogin, 1500);
          } else {
            document.getElementById('loginStatus').textContent = '登录验证失败，请重试';
          }
          break;
        case 86101: document.getElementById('loginStatus').textContent = '等待扫码…'; break;
        case 86090: document.getElementById('loginStatus').textContent = '已扫码，请在 App 上确认'; break;
        case 86038:
          document.getElementById('loginStatus').textContent = '二维码已过期';
          document.getElementById('loginActions').style.display = 'block';
          break;
        default:
          document.getElementById('loginStatus').textContent = '扫描状态：' + code + '…';
          break;
      }
    } catch(e) {}
  }, 2000);
}

async function fetchLoginStatus() {
  try {
    const resp = await window.bili.loginStatus();
    if (resp.ok) loginUserInfo = resp.data;
    else loginUserInfo = { isLogin: false };
  } catch(e) { loginUserInfo = { isLogin: false }; }
  updateLoginUI();
}

async function checkLoginStatus() {
  await fetchLoginStatus();
}

function updateLoginUI() {
  const btn = document.getElementById('loginBtn');
  if (loginUserInfo?.isLogin) {
    btn.innerHTML = loginUserInfo.face
      ? `<img id="loginFace" style="width:18px;height:18px;border-radius:50%;"> ${escapeHtml(loginUserInfo.uname||'')}`
      : icon('user') + ' ' + escapeHtml(loginUserInfo.uname||'');
    if (loginUserInfo.face) {
      window.bili.img(loginUserInfo.face).then(d => {
        const f = document.getElementById('loginFace');
        if (f && d.ok) f.src = d.dataUrl;
      });
    }
  } else {
    btn.innerHTML = icon('user') + '<span>登录</span>';
  }
}

// ============ 同步到 B 站收藏夹 ============
const FAV_FOLDER_NAME = 'bilimusic';

/**
 * 把「默认歌单」同步到 B 站收藏夹「bilimusic」。
 * 两段式: 先让主进程算一遍计划(只读) → 确认框 → 再真正写入。
 */
let _favPlan = null;

/** 同步收藏夹: 先检查, 然后让用户选"以谁为母本" */
async function syncFavorites() {
  const songs = (playlists.default && playlists.default.songs) || [];
  const bvids = songs.map((s) => s.bvid).filter(Boolean);
  if (!bvids.length) { showToast('默认歌单里还没有歌', 'error'); return; }
  showToast('正在检查收藏夹（本地 ' + bvids.length + ' 首）…');
  try {
    const plan = await window.bili.favPlan(bvids);
    if (!plan || !plan.ok) { showToast((plan && plan.message) || '检查失败，请确认已登录 B 站', 'error'); return; }
    const d = plan.data;
    _favPlan = d;
    const pull = Array.isArray(d.toPull) ? d.toPull : [];
    const localOnly = Array.isArray(d.localOnly) ? d.localOnly : [];
    document.getElementById('favSyncSummary').textContent =
      (d.folderExists
        ? '收藏夹「' + FAV_FOLDER_NAME + '」现有 ' + d.folderCount + ' 首'
        : '收藏夹「' + FAV_FOLDER_NAME + '」还不存在，同步时会自动创建')
      + '；本地默认歌单 ' + d.total + ' 首。选一个方向对齐：';
    document.getElementById('fcLocalDesc').textContent =
      '推送 ' + d.toAdd + ' 首到收藏夹'
      + (d.folderOnly ? '，并删除收藏夹里多出的 ' + d.folderOnly + ' 首' : '')
      + '（本地不动）';
    document.getElementById('fcRemoteDesc').textContent =
      '取回 ' + pull.length + ' 首到本地'
      + (localOnly.length ? '，并移除本地多出的 ' + localOnly.length + ' 首' : '')
      + '（B 站不动）';
    document.getElementById('favSyncModal').style.display = 'flex';
  } catch (e) {
    showToast('检查失败：' + e.message, 'error');
  }
}

function closeFavSyncModal() {
  const m = document.getElementById('favSyncModal');
  if (m) m.style.display = 'none';
}

/** 执行对齐: local = 本地为母本(推送+删收藏夹); remote = 收藏夹为母本(取回+删本地) */
async function runFavSync(mode) {
  const d = _favPlan;
  closeFavSyncModal();
  if (!d) { showToast('请先检查一次', 'error'); return; }
  try {
    if (mode === 'local') {
      showToast('正在对齐到本地歌单，请稍候…');
      const res = await window.bili.favSync('local');
      if (!res || !res.ok) { showToast((res && res.message) || '同步失败', 'error'); return; }
      const r = res.data;
      showToast('已按本地歌单对齐：推送 ' + r.added + ' 首'
        + (r.removed ? '、删除收藏夹 ' + r.removed + ' 首' : '')
        + (r.created ? '（已创建收藏夹）' : ''), 'success');
      return;
    }

    // 收藏夹为母本: 本地歌单重建
    const keep = new Set(Array.isArray(d.keepBvids) ? d.keepBvids : []);
    const pulled = Array.isArray(d.toPull) ? d.toPull : [];
    const songs = playlists.default.songs || [];
    const kept = songs.filter((x) => keep.has(x.bvid));
    const removed = songs.length - kept.length;
    let added = 0;
    pulled.forEach((v) => {
      if (!v || !v.bvid) return;
      if (kept.some((x) => x.bvid === v.bvid)) return;
      kept.push({ bvid: v.bvid, title: v.title || '未知', author: v.author || '', duration: v.duration || 0, cover: v.cover || '' });
      added++;
    });
    playlists.default.songs = kept;
    if (typeof syncPlaylistRef === 'function') syncPlaylistRef();
    savePlaylists();
    renderPlaylist();
    renderQueue();
    renderHome();
    showToast('已按收藏夹对齐：取回 ' + added + ' 首' + (removed ? '、移除本地 ' + removed + ' 首' : ''), 'success');
  } catch (e) {
    showToast('同步失败：' + e.message, 'error');
  } finally {
    _favPlan = null;
  }
}

// ============ IMPORT / EXPORT ============
const BACKUP_FORMAT = 2;

function exportPlaylist() {
  const total = Object.values(playlists).reduce((n, p) => n + p.songs.length, 0);
  if (total === 0) { showToast('还没有任何歌曲'); return; }
  // 导出全部歌单(含顺序与当前选中), 便于整体备份/迁移
  const payload = {
    format: BACKUP_FORMAT,
    app: 'BiliMusic',
    exportedAt: new Date().toISOString(),
    currentPlaylistId,
    order: playlistOrder.slice(),
    playlists: playlistOrder.map(id => playlists[id]).filter(Boolean),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = 'bilimusic-backup-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast(`已导出 ${playlistOrder.length} 个歌单 / ${total} 首歌`);
}

function importPlaylist() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
  input.onchange = async e => {
    try {
      const text = await e.target.files[0].text();
      const data = JSON.parse(text);
      // 旧格式: 纯数组(视为当前歌单); 新格式: { format, playlists: [...] }
      const incoming = Array.isArray(data)
        ? [{ id: currentPlaylistId, name: playlists[currentPlaylistId]?.name || '导入歌单', songs: data }]
        : (Array.isArray(data.playlists) ? data.playlists : null);
      if (!incoming) throw new Error('格式错误');
      let count = 0;
      for (const pl of incoming) {
        let target = playlists[pl.id];
        if (!target) target = playlists[createPlaylistSilently(pl.name || '导入歌单')];
        for (const song of (pl.songs || [])) {
          if (song && song.bvid && !target.songs.some(p => p.bvid === song.bvid)) { target.songs.push(song); count++; }
        }
      }
      savePlaylists(); renderPlaylist(); updatePlayerUI();
      showToast(`导入 ${count} 首歌曲`, 'success');
    } catch(err) { showToast('导入失败: ' + err.message, 'error'); }
  };
  input.click();
}

// ============ SETTINGS ============
function toggleSettings() { document.getElementById('settingsModal').style.display = 'flex'; loadAppInfo(); }
function closeSettings() { document.getElementById('settingsModal').style.display = 'none'; }

// ============ UTILS ============
// 图片通过主进程代理，返回 dataUrl (规避前端跨域 + DNS 问题)
async function proxyImg(url) {
  if (!url) return '';
  const resp = await window.bili.img(url);
  return resp.ok ? resp.dataUrl : '';
}
function formatDuration(s) { if (!s||s<0) return '0:00'; const m=Math.floor(s/60), sec=Math.floor(s%60); return m+':'+String(sec).padStart(2,'0'); }
function formatCount(n) { if (n>=1e8) return (n/1e8).toFixed(1)+'亿'; if (n>=1e4) return (n/1e4).toFixed(1)+'万'; return String(n); }
function escapeHtml(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => HTML_ESCAPE_MAP[c]); }
function escapeAttr(s) { return escapeHtml(s); }

function showToast(msg, type='') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity 0.3s'; setTimeout(()=>t.remove(),300); }, 3000);
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  switch(e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); prev(); break;
    case 'ArrowRight': e.preventDefault(); next(); break;
    case 'm': case 'M': toggleMode(); break;
    case 'Escape':
      // 优先关掉浮层, 其次是退出专注视图(不打断播放)
      if (_themePanelOpen) hideThemePanel();
      else if (_playlistFocus) togglePlaylistFocus(false);
      else if (_playerFullscreen) togglePlayerFullscreen();
      else stopPlayback();
      break;
  }
});

// Global click to hide history
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-bar-wrap')) hideSearchHistory();
});

// 点击别处收起皮肤面板
document.addEventListener('click', (e) => {
  if (!e.target.closest('#themePanel') && !e.target.closest('#themeBtn')) hideThemePanel();
});

// ============ 事件委托: 所有 data-action 元素 ============
// 参数一律走 data-*, 不再把标题/关键词拼进内联 onclick, 从根上消除注入面
document.addEventListener('mousedown', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.getAttribute('data-action');
  if (action === 'quick-search' || action === 'del-history' || action === 'clear-history') {
    e.preventDefault();   // 别把搜索框的焦点抢走(原实现用 onmousedown 达到同样效果)
  }
  switch (action) {
    case 'play-hot':
      addToPlaylist({
        bvid: el.dataset.bvid,
        title: el.dataset.title,
        author: el.dataset.author,
        duration: parseInt(el.dataset.duration, 10) || 0,
        cover: el.dataset.cover,
      }, true);
      break;
    case 'quick-search': quickSearch(el.dataset.query); break;
    case 'del-history': removeSearchHistory(el.dataset.query); break;
    case 'clear-history': clearSearchHistory(); break;
    case 'retry-search': doSearch(searchQuery); break;
    case 'set-theme': applyTheme(el.dataset.theme); hideThemePanel(); break;
    case 'switch-playlist': switchPlaylist(el.dataset.plid); hidePlaylistDropdown(); break;
    case 'delete-playlist': deletePlaylist(el.dataset.plid); break;
    default: break;
  }
});

toggleClearBtn();

// 兜底: 若 HTML 里没有 #importedPane(历史版本/漏改), 运行时补一个, 保证功能可用
(function ensureImportedPane() {
  if (document.getElementById('importedPane')) return;
  var host = document.getElementById('resultsArea');
  if (!host) return;
  var pane = document.createElement('div');
  pane.id = 'importedPane';
  pane.style.display = 'none';
  pane.innerHTML = '<div class="imported-head">'
    + '<span class="section-title">导入歌单 · <span id="importedCount" class="num">0</span> 首</span>'
    + '<button class="ghost-btn" onclick="refreshImportedSongs()" title="换一批">换一批</button>'
    + '<button class="ghost-btn" onclick="importPlaylistFile()">导入 txt</button>'
    + '</div>'
    + '<div class="queue-list" id="importedSongList"></div>';
  host.appendChild(pane);
  if (typeof refreshImportedSongs === 'function') refreshImportedSongs();
})();
