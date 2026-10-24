'use strict';
// ============ 图标系统 ============
//
// 之前全用 emoji 当图标(53 种), 跨平台渲染不一致、不跟主题色、字重不齐。
// 这里换成一套 24×24 描边图标(1.75 stroke, currentColor), 通过 SVG sprite 复用。
//
// 用法:
//   <span data-icon="play"></span>           ← 静态 HTML, 加载时自动填充
//   icon('play')                             ← JS 模板串里用, 返回 <svg ...>
//   icon('play', 'ic-lg')                    ← 附加 class
//
// 注意: sprite 必须用 createElementNS / DOMParser 构建。
// 直接给 <svg> 设 innerHTML 会把 <symbol>/<path> 建成 XHTML 命名空间,
// 那样 <use href="#..."> 什么也渲染不出来(踩过一次)。

(function () {
  var NS = 'http://www.w3.org/2000/svg';

  var ICONS = {
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 4.5h3v15H8zM14 4.5h3v15h-3z" fill="currentColor" stroke="none"/>',
    prev: '<path d="M18.5 4.5v15L7.5 12z" fill="currentColor" stroke="none"/><path d="M5.5 4.5v15"/>',
    next: '<path d="M5.5 4.5v15L16.5 12z" fill="currentColor" stroke="none"/><path d="M18.5 4.5v15"/>',
    repeat: '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M3.5 12V10a4 4 0 014-4h13"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 12v2a4 4 0 01-4 4h-13"/>',
    'repeat-one': '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M3.5 12V10a4 4 0 014-4h13"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 12v2a4 4 0 01-4 4h-13"/><path d="M11.5 14.5h1v5" stroke-width="2"/>',
    shuffle: '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M20.5 6H16l-9 12H3.5"/><path d="M3.5 6H7l2.2 2.9"/><path d="M14.2 15.4L16 18h4.5"/><path d="M20.5 21.5L17 18l3.5-3.5"/>',
    sequential: '<path d="M4 12h14"/><path d="M14 7l5 5-5 5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>',
    download: '<path d="M21 15.5v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3"/><path d="M7.5 11l4.5 4.5 4.5-4.5"/><path d="M12 3v12.5"/>',
    upload: '<path d="M21 15.5v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3"/><path d="M7.5 8l4.5-4.5L16.5 8"/><path d="M12 3.5v12.5"/>',
    settings: '<path d="M4 21v-6.5M4 10.5V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="9.5" r="2"/><circle cx="20" cy="14" r="2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21v-1a7.5 7.5 0 0115 0v1"/>',
    x: '<path d="M18.5 5.5l-13 13M5.5 5.5l13 13"/>',
    more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    'minus-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>',
    'plus-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
    trash: '<path d="M3.5 6.5h17"/><path d="M9 6.5V4.2c0-.4.3-.7.7-.7h4.6c.4 0 .7.3.7.7v2.3"/><path d="M18.5 6.5l-.9 13.1a1.8 1.8 0 01-1.8 1.7H8.2a1.8 1.8 0 01-1.8-1.7L5.5 6.5"/><path d="M10 11v6M14 11v6"/>',
    heart: '<path d="M12 20.5S3.5 15.6 3.5 9.9A4.9 4.9 0 0112 6.9a4.9 4.9 0 018.5 3c0 5.7-8.5 10.6-8.5 10.6z"/>',
    folder: '<path d="M3.5 7.5a2 2 0 012-2h3.2l2 2h7.8a2 2 0 012 2v9a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>',
    'folder-open': '<path d="M3.5 8.5V7a2 2 0 012-2h3.2l2 2h6.3a2 2 0 012 2v1.5"/><path d="M3.5 8.5h16.2a1.6 1.6 0 011.6 1.9l-1.2 7.2a2 2 0 01-2 1.7H5.2a1.7 1.7 0 01-1.7-1.5z"/>',
    music: '<path d="M9 18.5V5.2l11.5-2v12.3"/><circle cx="6.3" cy="18.6" r="2.7"/><circle cx="17.8" cy="15.6" r="2.7"/>',
    palette: '<path d="M12 21a9 9 0 110-18c4.9 0 9 3.4 9 7.7 0 2.2-1.8 4-4 4h-1.7a1.8 1.8 0 00-1.3 3 2 2 0 01-1.5 3.3z"/><circle cx="8" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="9.5" r="1.2" fill="currentColor" stroke="none"/>',
    list: '<path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12"/><circle cx="4" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="17.5" r="1.3" fill="currentColor" stroke="none"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    maximize: '<path d="M8.5 3.5H5.5a2 2 0 00-2 2v3M15.5 3.5h3a2 2 0 012 2v3M8.5 20.5H5.5a2 2 0 01-2-2v-3M15.5 20.5h3a2 2 0 002-2v-3"/>',
    'maximize-off': '<path d="M3.5 8.5h4v-4M20.5 8.5h-4v-4M3.5 15.5h4v4M20.5 15.5h-4v4"/>',
    volume: '<path d="M11 4.5L6 9H3v6h3l5 4.5z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 010 7"/><path d="M18.5 5.5a9 9 0 010 13"/>',
    'volume-mute': '<path d="M11 4.5L6 9H3v6h3l5 4.5z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
    check: '<path d="M20 6.5L9.5 17 4 11.5"/>',
    refresh: '<path d="M20.5 4.5v5h-5"/><path d="M3.5 19.5v-5h5"/><path d="M19.2 9.5a8 8 0 00-13.6-3.2L3.5 8.5"/><path d="M4.8 14.5a8 8 0 0013.6 3.2l2.1-2.2"/>',
    queue: '<path d="M3.5 6.5h12M3.5 12h12M3.5 17.5h7"/><path d="M17.5 13v7.5M14 16.5h7"/>',
    home: '<path d="M3.5 10.5L12 3.5l8.5 7v9a1.5 1.5 0 01-1.5 1.5H5a1.5 1.5 0 01-1.5-1.5z"/><path d="M9.5 21v-6.5h5V21"/>',
    'chevron-down': '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
    'chevron-up': '<path d="M6.5 14.5L12 9l5.5 5.5"/>',
    'chevron-right': '<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>',
    alert: '<path d="M12 3.5l9 16H3z"/><path d="M12 9.5v4.5M12 17h.01"/>',
    headphones: '<path d="M3.5 17.5v-5a8.5 8.5 0 0117 0v5"/><path d="M20.5 18.5a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3.5 18.5a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2h-3z"/>',
    sparkle: '<path d="M12 3.5l1.9 4.6L18.5 10l-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z"/><path d="M18 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    keyboard: '<rect x="2.5" y="6.5" width="19" height="11" rx="2.5"/><path d="M6.5 10h.01M10.5 10h.01M14.5 10h.01M18 10h.01M6.5 13.5h.01M18 13.5h.01M9.5 13.5h5"/>',
    external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M18 14v4.5a2 2 0 01-2 2H5.5a2 2 0 01-2-2V8a2 2 0 012-2H10"/>'
  };

  var sprite = null;
  var parser = null;

  function ensureSprite() {
    if (sprite) return sprite;
    if (!document.body) return null;
    if (!parser) parser = new DOMParser();

    sprite = document.createElementNS(NS, 'svg');
    sprite.setAttribute('aria-hidden', 'true');
    sprite.setAttribute('class', 'icon-sprite');
    var defs = document.createElementNS(NS, 'defs');
    sprite.appendChild(defs);

    Object.keys(ICONS).forEach(function (name) {
      var sym = document.createElementNS(NS, 'symbol');
      sym.setAttribute('id', 'ic-' + name);
      sym.setAttribute('viewBox', '0 0 24 24');
      sym.setAttribute('fill', 'none');
      sym.setAttribute('stroke', 'currentColor');
      sym.setAttribute('stroke-width', '1.75');
      sym.setAttribute('stroke-linecap', 'round');
      sym.setAttribute('stroke-linejoin', 'round');
      // 关键: 用 XML 解析器导入内容, 保证子节点在 SVG 命名空间里。
      // 注意必须用 adoptNode(移动)而不是 importNode(复制) —— 后者不会移除原节点,
      // while 循环会永远不结束, 直接把渲染进程内存撑爆。
      var doc = parser.parseFromString('<svg xmlns="' + NS + '">' + ICONS[name] + '</svg>', 'image/svg+xml');
      var frag = doc.documentElement;
      while (frag.firstChild) {
        sym.appendChild(document.adoptNode(frag.firstChild));
      }
      defs.appendChild(sym);
    });

    document.body.insertBefore(sprite, document.body.firstChild);
    return sprite;
  }

  /** 返回一个 <svg> 图标(用于模板串) */
  function icon(name, cls) {
    if (!ICONS[name]) name = 'music';
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">'
      + '<use href="#ic-' + name + '"></use></svg>';
  }

  /** 把 HTML 里的 <span data-icon="x"> 填上图标 */
  function hydrateIcons(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute('data-icon-done') === '1') continue;
      el.innerHTML = icon(el.getAttribute('data-icon'));
      el.setAttribute('data-icon-done', '1');
    }
  }

  function boot() {
    ensureSprite();
    hydrateIcons();
  }

  window.BMIcons = { icon: icon, hydrate: hydrateIcons, has: function (n) { return !!ICONS[n]; } };
  window.icon = icon;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
