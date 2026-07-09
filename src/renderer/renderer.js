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
let _searchResultsHtml = '';   // 缓存搜索结果 HTML，用于 tab 切换
let _hasSearched = false;
let _videoPages = [];           // 当前视频的分集信息
let _expandedItems = {};        // 歌单中已展开的多P视频索引
let _currentPageIndex = -1;     // 当前播放的子集索引 (-1 = 不是子集)
let _pageStartTime = 0;         // 子集起始偏移秒数
let _playerSuppressBounds = false; // 临时阻止发送坐标到播放器视图

const MODE_ICONS = { 'list-loop': '🔁', 'single-loop': '🔂', 'random': '🔀', 'sequential': '➡️' };
const MODE_LABELS = { 'list-loop': '列表循环', 'single-loop': '单曲循环', 'random': '随机播放', 'sequential': '顺序播放' };

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

/** 新建歌单 */
function createPlaylist(name) {
  const id = 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  playlists[id] = { id, name, songs: [] };
  playlistOrder.push(id);
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
  showToast('❤️ 已添加到「我喜欢的」', 'success');
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
  document.getElementById('volumeSlider').value = 80;

  // 音量滑块控制 B 站播放器音量
  const volumeSlider = document.getElementById('volumeSlider');
  let volumeTimer = null;
  volumeSlider.addEventListener('input', () => {
    const vol = parseInt(volumeSlider.value) / 100;
    // 防抖：停止滑动 150ms 后发送
    if (volumeTimer) clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => {
      window.bili.playerSetVolume(vol);
    }, 150);
  });

  checkLoginStatus();

  // 把「播放器占位区」的坐标同步给主进程，并随窗口变化重新同步
  relayoutPlayerView();
  window.addEventListener('resize', relayoutPlayerView);

  // 主进程在窗口 resize 后会通知这里重新计算坐标
  window.bili.onRelayout(() => relayoutPlayerView());

  // 加载推荐歌曲（初始显示推荐 tab）
  switchSearchTab('hot');

  // 初始化导入歌单（加载随机歌名 + 启动定时刷新）
  initImportedSongs();

  // 初始化歌单字体大小
  const savedSize = getPlaylistFontSize();
  setPlaylistFontSize(savedSize);
}
init();

// ============ 推荐歌曲 ============
async function loadHotMusic() {
  const listEl = document.getElementById('hotList');
  if (!listEl) return;
  // 显示加载中
  listEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-secondary);font-size:12px;">⏳ 加载推荐...</div>';
  try {
    const resp = await window.bili.hot();
    if (!resp.ok || !resp.data || !resp.data.length) throw new Error('no data');
    renderHotList(resp.data);
  } catch(e) {
    listEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-secondary);font-size:12px;">加载失败，<a href="#" onclick="loadHotMusic()" style="color:var(--pink);">点击重试</a></div>';
  }
}

function renderHotList(songs) {
  const listEl = document.getElementById('hotList');
  if (!listEl) return;
  let html = '';
  songs.forEach((v, i) => {
    const idxClass = i < 3 ? `top${i+1}` : '';
    html += `
      <div class="hot-item" onclick="addToPlaylist({bvid:'${escapeAttr(v.bvid)}',title:'${escapeAttr(v.title)}',author:'${escapeAttr(v.author)}',duration:${v.duration||0},cover:'${escapeAttr(v.cover||'')}'},true)">
        <span class="hi-idx ${idxClass}">${i + 1}</span>
        <span class="hi-title">${escapeHtml(v.title)}</span>
        <span class="hi-meta">${v.author ? escapeHtml(v.author) : ''}</span>
        <span class="hi-play">▶</span>
      </div>`;
  });
  listEl.innerHTML = html;
}

// ============ Tab 切换: 推荐歌曲 / 搜索结果 ============
function showWelcomeScreen() {
  const area = document.getElementById('resultsArea');
  // 显示欢迎页（隐藏搜索结果容器）
  const welcome = document.getElementById('welcomeScreen');
  const searchResults = document.getElementById('searchResultsContainer');
  if (welcome) welcome.style.display = '';
  if (searchResults) searchResults.style.display = 'none';
  // 确保导入歌单已初始化
  initImportedSongs();
  // 加载推荐歌曲
  loadHotMusic();
}

function switchSearchTab(tab) {
  const tabHot = document.getElementById('tabHot');
  const tabSearch = document.getElementById('tabSearch');
  if (!tabHot) return;

  if (tab === 'hot') {
    tabHot.classList.add('st-active');
    tabSearch.classList.remove('st-active');
    showWelcomeScreen();
  } else if (tab === 'search') {
    tabHot.classList.remove('st-active');
    tabSearch.classList.add('st-active');
    // 隐藏欢迎页，显示搜索结果
    const welcome = document.getElementById('welcomeScreen');
    const searchResults = document.getElementById('searchResultsContainer');
    if (welcome) welcome.style.display = 'none';
    if (searchResults) searchResults.style.display = '';
  }
}

// ============ 播放器视图坐标同步 ============
// 把中间列占位区相对窗口内容区的坐标发给主进程，让 WebContentsView 精确覆盖。
function relayoutPlayerView() {
  if (_playerSuppressBounds) return;
  const el = document.getElementById('playerFrameWrap');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  window.bili.playerSetBounds({
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

// ============ PLAYLIST ============
// 所有 playlist 操作自动使用当前活跃歌单，由 getPlaylist() / syncPlaylistRef() 管理

function savePlaylist() { savePlaylists(); }

function clearPlaylist() {
  if (confirm('确认清空当前歌单「' + (playlists[currentPlaylistId]?.name || '') + '」？')) {
    getPlaylist().length = 0;
    currentIndex = -1;
    savePlaylist(); renderPlaylist(); updatePlayerUI();
    showToast('歌单已清空');
  }
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
  const container = document.getElementById('playlist');
  const empty = document.getElementById('emptyPlaylist');
  const songs = getPlaylist();
  document.getElementById('playlistCount').textContent = `(${songs.length})`;

  if (songs.length === 0) {
    empty.style.display = 'block';
    container.querySelectorAll('.pl-item, .pl-subitem').forEach(el => el.remove());
    return;
  }
  empty.style.display = 'none';

  let html = '';
  songs.forEach((item, i) => {
    const hasPages = item.pages && item.pages.length > 1;
    const isExpanded = _expandedItems[i];
    const active = i === currentIndex && isPlaying ? ' active' : '';
    const multiIcon = hasPages ? (isExpanded ? '📂' : '📁') : '';
    
    html += `
      <div class="pl-item${active}" draggable="true"
           ondragstart="handleDragStart(event, ${i})" ondragend="handleDragEnd(event)"
           oncontextmenu="showPlaylistContextMenu(event, ${i})">
        <span class="pl-idx">${i + 1}</span>
        <img class="pl-thumb" data-src="${escapeAttr(item.cover || '')}" alt="">
        <div class="pl-info" ondblclick="playByIndex(${i})">
          <div class="pl-title" title="${escapeAttr(item.title || '未知')}">${multiIcon ? multiIcon + ' ' : ''}${escapeHtml(item.title || '未知')}</div>
          <div class="pl-meta">${escapeHtml(item.author || '')} · ${formatDuration(item.duration || 0)}${hasPages ? ' · ' + item.pages.length + 'P' : ''}</div>
        </div>
        ${hasPages ? `<button class="pl-expand" onclick="event.stopPropagation();togglePlaylistExpand(${i})" title="${isExpanded ? '收起' : '展开'}子集">${isExpanded ? '▲' : '▼'}</button>` : ''}
        <button class="pl-del" onclick="removeFromPlaylist(${i})" title="移除">✕</button>
      </div>`;

    // 展开的子集
    if (hasPages && isExpanded) {
      item.pages.forEach((page, pi) => {
        html += `
          <div class="pl-subitem" onclick="playPage(${i}, ${pi})" oncontextmenu="event.stopPropagation();showPlaylistContextMenu(event, ${i})">
            <span class="pl-sidx">${pi + 1}</span>
            <div class="pl-info">
              <div class="pl-title" title="${escapeAttr(page.part || '第' + (pi + 1) + '段')}">${escapeHtml(page.part || '第' + (pi + 1) + '段')}</div>
              <div class="pl-meta">${formatDuration(page.duration)}</div>
            </div>
          </div>`;
      });
    }
  });

  container.querySelectorAll('.pl-item, .pl-subitem').forEach(el => el.remove());
  const temp = document.createElement('div');
  temp.innerHTML = html;
  while (temp.firstChild) container.appendChild(temp.firstChild);

  // 异步加载缩略图
  container.querySelectorAll('.pl-thumb').forEach(img => {
    const src = img.getAttribute('data-src');
    if (src) proxyImg(src).then(d => { if (d) img.src = d; });
  });
}

/** 滚动歌单到指定索引的歌曲并高亮 */
function scrollPlaylistToItem(index) {
  const container = document.getElementById('playlist');
  if (!container) return;
  const items = container.querySelectorAll('.pl-item');
  if (index >= 0 && index < items.length) {
    const target = items[index];
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // 临时高亮动画
    target.style.transition = 'background 0.3s';
    target.style.background = 'rgba(251,114,153,0.2)';
    setTimeout(() => { target.style.background = ''; }, 1500);
  }
}

/** 展开/收起多P视频的子集目录 */
function togglePlaylistExpand(index) {
  if (_expandedItems[index]) {
    delete _expandedItems[index];
  } else {
    _expandedItems[index] = true;
  }
  renderPlaylist();
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
  renderPlaylist();
  renderPlaylist();
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
  const target = e.target.closest('.pl-item');
  if (!target || dragIdx < 0) return;
  const items = [...document.querySelectorAll('.pl-item')];
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
  let html = `<button class="ps-current" onclick="togglePlaylistDropdown(event)">
    ${(current?.icon || '🎵')} ${escapeHtml(current?.name || '歌单')}
    <span style="font-size:10px;margin-left:4px;">▼</span>
  </button>`;
  html += `<div class="ps-dropdown" id="playlistDropdown" style="display:none;">`;
  for (const id of playlistOrder) {
    const pl = playlists[id];
    if (!pl) continue;
    const active = id === currentPlaylistId ? ' ps-active' : '';
    const icon = id === 'favorites' ? '❤️' : (id === 'default' ? '🎵' : '📁');
    html += `<div class="ps-item${active}" onclick="switchPlaylist('${id}');hidePlaylistDropdown()">
      ${icon} ${escapeHtml(pl.name)} <span class="ps-count">${pl.songs.length}</span>
      ${(id !== 'default' && id !== 'favorites') ? `<span class="ps-del" onclick="event.stopPropagation();deletePlaylist('${id}')" title="删除">✕</span>` : ''}
    </div>`;
  }
  html += `<div class="ps-item ps-new" onclick="showCreatePlaylistDialog();hidePlaylistDropdown()">➕ 新建歌单</div>`;
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
let contextMenuTarget = null;

function showPlaylistContextMenu(e, index) {
  e.preventDefault();
  const songs = getPlaylist();
  if (!songs[index]) return;
  const item = songs[index];
  const menu = document.getElementById('contextMenu');
  const menuItem = document.getElementById('contextFav');
  // 检查是否已在「我喜欢的」中
  const inFav = playlists.favorites.songs.some(p => p.bvid === item.bvid);
  menuItem.textContent = inFav ? '❤️ 已在「我喜欢的」' : '❤️ 添加到「我喜欢的」';
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
  document.getElementById('btnPlay').textContent = isPlaying ? '⏸' : '▶';
  if (!video) document.getElementById('npThumb').style.display = 'none';
  updateProgressUI();
  document.getElementById('modeLabel').textContent = MODE_ICONS[playMode] + ' ' + MODE_LABELS[playMode];
}

function updateProgressUI() {
  const pct = currentDuration > 0 ? Math.min(100, (elapsedSeconds / currentDuration) * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('npTime').textContent = formatDuration(elapsedSeconds);
  document.getElementById('npDuration').textContent = formatDuration(currentDuration);
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

  progressTickFunc = () => {
    // 调试: 确认 tick 在跑
    // console.log('[tick] elapsed=', elapsedSeconds, 'dur=', currentDuration);
    
    // 每 3 秒从 B 站播放器同步一次真实进度 (纠正模拟计时误差)
    if (isPlaying && Math.floor(Date.now() / 3000) !== (Math.floor(Date.now() / 3000) - 1 || 0)) {
      window.bili.playerStatus().then(r => {
        if (r.ok && r.data && !r.data.paused && r.data.currentTime > 0) {
          const ct = Math.floor(r.data.currentTime);
          // 用 ?p=N 加载子集时，video.currentTime 是相对当前段的
          // 所以直接使用，不需要减去 _pageStartTime
          elapsedSeconds = ct;
          playbackStartTime = Date.now();
          playbackStartOffset = ct;
        }
      }).catch(() => {});
    }

    const realElapsed = playbackStartOffset + Math.floor((Date.now() - playbackStartTime) / 1000);
    // 如果模拟值偏差太大 (>3s)，强制用模拟值覆盖
    if (Math.abs(realElapsed - elapsedSeconds) > 3) {
      elapsedSeconds = realElapsed;
    }
    updateProgressUI();
    if (currentDuration > 0 && elapsedSeconds >= currentDuration) {
      onSongEnd();
    }
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
    html += `<div class="search-history-item" onmousedown="event.preventDefault();quickSearch('${escapeAttr(q)}')">
      <span class="hist-icon">🕐</span>
      <span class="hist-text">${escapeHtml(q)}</span>
      <button class="hist-del" onmousedown="event.stopPropagation();event.preventDefault();removeSearchHistory('${escapeAttr(q)}')" title="删除">✕</button>
    </div>`;
  });
  html += '<div class="search-history-clear" onmousedown="event.preventDefault();clearSearchHistory()">🗑️ 清除历史记录</div>';
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
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">🔍 搜索中...</div>';
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
        container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red);">搜索失败: ${escapeHtml(e.message)}<br><button onclick="doSearch('${escapeAttr(query)}')" style="margin-top:12px;background:var(--pink);color:#fff;border:none;padding:8px 20px;border-radius:20px;cursor:pointer;">重试</button></div>`;
      }
    } else { showToast('加载失败', 'error'); }
  }
}

// ============ 导入歌单 ============
let _importedRefreshTimer = null;

/** 导入 TXT 歌单文件 */
async function importPlaylistFile() {
  try {
    const result = await window.bili.importOpenFile();
    if (result.canceled) return;
    if (result.ok) {
      showToast(`✅ 已导入 ${result.count} 首歌`, 'success');
      await refreshImportedSongs();
    } else {
      showToast('导入失败: ' + (result.message || ''), 'error');
    }
  } catch (e) {
    showToast('导入失败: ' + e.message, 'error');
  }
}

/** 刷新随机歌名显示 */
async function refreshImportedSongs() {
  try {
    const result = await window.bili.getRandomSongs(7);
    const container = document.getElementById('importedSongList');
    if (!container) return;
    if (!result.ok || result.songs.length === 0) {
      container.innerHTML = '<span style="font-size:11px;color:var(--text-tertiary);padding:4px 0;">导入歌单后，这里会显示随机歌曲名</span>';
      return;
    }
    container.innerHTML = result.songs.map(name =>
      `<span class="imported-song-tag" onclick="clickImportedSong('${escapeAttr(name)}')">${escapeHtml(name)}</span>`
    ).join('');
  } catch (e) {
    // ignore
  }
}

/** 点击歌名触发搜索 */
function clickImportedSong(name) {
  quickSearch(name);
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
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">😕 没有找到结果</div>';
    return;
  }

  let html = '';
  if (isFirstPage) {
    html += `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">搜索 "${escapeHtml(searchQuery)}"</div>`;
    html += '<div class="results-grid">';
  }

  results.forEach(v => {
    const inPl = playlist.some(p => p.bvid === v.bvid);
    html += `<div class="result-card" data-bvid="${escapeHtml(v.bvid)}" data-title="${escapeHtml(v.title)}" data-author="${escapeHtml(v.author)}" data-duration="${v.duration||0}" data-cover="${escapeHtml(v.cover||'')}" onclick="cardClick(this)">
      <div class="cover-wrap">
        <img class="card-cover" data-src="${escapeAttr(v.cover||'')}" onerror="this.style.display='none'" loading="lazy">
        ${v.duration ? `<span class="duration">${formatDuration(v.duration)}</span>` : ''}
        <button class="add-btn ${inPl?'added':''}" onclick="event.stopPropagation();cardToggle(this)" data-bvid="${escapeHtml(v.bvid)}" data-title="${escapeHtml(v.title)}" data-author="${escapeHtml(v.author)}" data-duration="${v.duration||0}" data-cover="${escapeHtml(v.cover||'')}">${inPl?'✓':'+'}</button>
      </div>
      <div class="card-info">
        <div class="card-title">${escapeHtml(v.title)}</div>
        <div class="card-meta">👤 ${escapeHtml(v.author)} ${v.play?`· ▶ ${formatCount(v.play)}`:''}</div>
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
    container.insertAdjacentHTML('beforeend', `<div class="load-more-area"><button onclick="loadMoreResults()" style="background:var(--card);color:var(--pink);border:2px solid var(--pink);padding:8px 24px;border-radius:20px;cursor:pointer;font-size:13px;">📥 加载更多 (第${searchPage+1}页)</button></div>`);
  } else if (!isFirstPage) {
    container.insertAdjacentHTML('beforeend', '<div style="text-align:center;padding:12px;color:var(--text-secondary);font-size:12px;">— 已到底 —</div>');
  }
}

async function loadMoreResults() {
  const btn = document.querySelector('.load-more-area button');
  if (btn) { btn.textContent='⏳...'; btn.disabled=true; }
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
    showToast('已在歌单中', 'error');
  } else {
    addToPlaylist({bvid, title, author, duration, cover});
    btn.classList.add('added');
    btn.textContent = '✓';
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
    document.getElementById('loginStatus').textContent = '📱 请用B站App扫码确认';
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
          document.getElementById('loginStatus').textContent = '✅ 扫码成功，验证中...';
          await new Promise(r => setTimeout(r, 1500));
          await fetchLoginStatus();
          if (loginUserInfo?.isLogin) {
            document.getElementById('loginStatus').textContent = '✅ 登录成功！欢迎 ' + (loginUserInfo.uname||'');
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
        case 86101: document.getElementById('loginStatus').textContent = '📱 等待扫码...'; break;
        case 86090: document.getElementById('loginStatus').textContent = '📱 已扫码，请在App上确认'; break;
        case 86038:
          document.getElementById('loginStatus').textContent = '⏰ 二维码已过期';
          document.getElementById('loginActions').style.display = 'block';
          break;
        default:
          document.getElementById('loginStatus').textContent = '⏳ 扫描状态: ' + code + '...';
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
      : '👤 ' + escapeHtml(loginUserInfo.uname||'');
    if (loginUserInfo.face) {
      window.bili.img(loginUserInfo.face).then(d => {
        const f = document.getElementById('loginFace');
        if (f && d.ok) f.src = d.dataUrl;
      });
    }
  } else {
    btn.textContent = '🔐 登录';
  }
}

// ============ IMPORT / EXPORT ============
function exportPlaylist() {
  if (playlist.length === 0) { showToast('歌单为空'); return; }
  const blob = new Blob([JSON.stringify(playlist, null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'bilimusic-playlist-' + new Date().toISOString().slice(0,10) + '.json';
  a.click(); showToast('歌单已导出');
}

function importPlaylist() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
  input.onchange = async e => {
    try {
      const text = await e.target.files[0].text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('格式错误');
      let count = 0;
      data.forEach(v => { if (v.bvid && !playlist.some(p=>p.bvid===v.bvid)) { playlist.push(v); count++; } });
      savePlaylist(); renderPlaylist(); updatePlayerUI();
      showToast(`导入 ${count} 首歌曲`, 'success');
    } catch(err) { showToast('导入失败: ' + err.message, 'error'); }
  };
  input.click();
}

// ============ SETTINGS ============
function toggleSettings() { document.getElementById('settingsModal').style.display = 'flex'; }
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
function escapeHtml(s) { if(s==null)return''; const d=document.createElement('div'); d.textContent=String(s); return d.innerHTML; }
function escapeAttr(s) { if(s==null)return''; return String(s).replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

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
    case 'Escape': stopPlayback(); break;
  }
});

// Global click to hide history
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-bar-wrap')) hideSearchHistory();
});

toggleClearBtn();
