/**
 * GitHub 汉化助手 - 智能下载按钮（release-downloader.js）
 * 在仓库页右侧提供悬浮下载面板：Linux / macOS / Windows 三个按钮，
 * 自动识别当前系统与 CPU 架构，从该仓库最新 Release 中匹配对应的安装包。
 * 只读取公开的 GitHub API，不修改页面原有内容。
 */
(function () {
  'use strict';

  var PANEL_ID = 'ghcn-release-downloader';
  var STYLE_ID = 'ghcn-release-downloader-style';
  var RESERVED = {
    settings: 1, notifications: 1, marketplace: 1, explore: 1, orgs: 1, users: 1,
    sponsors: 1, collections: 1, events: 1, about: 1, pricing: 1, features: 1,
    topics: 1, login: 1, join: 1, search: 1, codespaces: 1, apps: 1, account: 1,
    profile: 1, new: 1, organizations: 1, security: 1, sitemap: 1, contact: 1,
    customer: 1, enterprise: 1, nonprofits: 1, education: 1, blog: 1, readme: 1
  };

  var enabled = true;
  var collapsed = false;        // 整个面板收起为小圆点
  var bodyCollapsed = false;    // 仅折叠平台下载按钮列表，默认展开
  var currentRepoKey = '';
  var currentSystem = null;
  var lastResult = null;
  var navTimer = null;

  // ── 仓库识别 ───────────────────────────────────────────────
  function getRepoKey() {
    if (/gist\.github\.com$/i.test(location.hostname)) return '';
    var parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    var owner = parts[0], repo = parts[1];
    if (RESERVED[owner.toLowerCase()]) return '';
    if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) return '';
    return owner + '/' + repo;
  }

  // ── 系统 / 架构检测 ────────────────────────────────────────
  async function detectSystem() {
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    var os = 'unknown';
    if (/Windows/i.test(platform) || /Windows NT/i.test(ua)) os = 'windows';
    else if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) os = 'macos';
    else if (/Linux/i.test(platform) || /Linux/i.test(ua)) os = 'linux';

    var arch = 'unknown';
    var uad = navigator.userAgentData;
    if (uad) {
      try {
        if (uad.architecture && uad.bitness) {
          arch = archFrom(uad.architecture, uad.bitness);
        } else if (uad.getHighEntropyValues) {
          var hints = await uad.getHighEntropyValues(['architecture', 'bitness']);
          if (hints && hints.architecture) arch = archFrom(hints.architecture, hints.bitness);
        }
      } catch (_) { /* 某些浏览器禁用 high entropy，忽略 */ }
    }
    if (arch === 'unknown') {
      if (/aarch64|arm64/i.test(ua) || /arm64/i.test(platform)) arch = 'arm64';
      else if (/x86_64|x64|amd64|Win64|WOW64/i.test(ua) || /x64|64/i.test(platform)) arch = 'x64';
      else if (os === 'macos') arch = 'universal';
    }
    // macOS 通用包同时兼容 Intel / Apple Silicon
    if (os === 'macos' && arch !== 'arm64') arch = 'universal';
    return { os: os, arch: arch };
  }

  function archFrom(architecture, bitness) {
    var a = String(architecture || '').toLowerCase();
    var b = String(bitness || '');
    if (a === 'arm' && b === '64') return 'arm64';
    if (a === 'x86' && b === '64') return 'x64';
    if (a === 'arm') return 'arm64';
    if (a === 'x86') return 'x64';
    return 'unknown';
  }

  // ── 安装包筛选与匹配 ───────────────────────────────────────
  function isHelperFile(name) {
    return /\.(asc|sig|zsync|sha256|md5|sbom)$/i.test(name) ||
      /sha256sums|checksums|release-signing-key|symbols|source-code|sbom/i.test(name) ||
      /^sha256sums/i.test(name);
  }

  function platformOf(name) {
    if (/android|\.apk$|\.aab$/i.test(name)) return 'android';
    if (/windows|win[_-]?x?64|\.msi$|\.exe$/i.test(name)) return 'windows';
    if (/macos|darwin|\.dmg$|\.pkg(?:$|\?)/i.test(name)) return 'macos';
    if (/linux|\.appimage$|\.deb$|\.rpm$|\.flatpak$|\.tar\.gz$|\.pkg\.tar\.zst$/i.test(name)) return 'linux';
    return '';
  }

  function archOf(name) {
    if (/aarch64|arm64|armv8/i.test(name)) return 'arm64';
    if (/riscv64/i.test(name)) return 'riscv64';
    if (/x86[_-]?64|x64|amd64|win64/i.test(name)) return 'x64';
    if (/universal|(^|[-_])all([-_.]|$)|any/i.test(name)) return 'universal';
    return 'unknown';
  }

  // 格式优先级（越小越优先）
  function formatScore(name, os) {
    var orders = {
      windows: [/\.msi$/i, /\.exe$/i, /portable.*\.zip$/i, /\.zip$/i],
      macos: [/\.dmg$/i, /\.pkg$/i, /\.zip$/i, /\.tar\.gz$/i],
      linux: [/\.appimage$/i, /\.deb$/i, /\.rpm$/i, /\.tar\.gz$/i, /\.flatpak$/i, /\.pkg\.tar\.zst$/i, /\.zst$/i],
      android: [/\.apk$/i, /\.aab$/i]
    };
    var list = orders[os] || [];
    for (var i = 0; i < list.length; i++) if (list[i].test(name)) return i;
    return 20;
  }

  // 架构匹配分：精确 0，通用 2，不匹配 10
  function archScore(fileArch, wanted) {
    if (!wanted || wanted === 'unknown') return 3;
    if (fileArch === wanted) return 0;
    if (fileArch === 'universal') return 2;
    if (wanted === 'universal') return 4;
    if (wanted === 'x64' && fileArch === 'arm64') return 10;
    if (wanted === 'arm64' && fileArch === 'x64') return 10;
    return 6;
  }

  function matchPackage(assets, os, wantedArch) {
    if (!Array.isArray(assets)) return null;
    var scored = [];
    assets.forEach(function (a) {
      var n = a.name || '';
      if (isHelperFile(n)) return;
      if (platformOf(n) !== os) return;
      var penalty = 0;
      if (/-cli[-_]|-web[-_]/i.test(n)) penalty += 30; // 独立 CLI / Web 包靠后
      if (/riscv|freebsd/i.test(n)) penalty += 25;      // 少见架构靠后
      var score = archScore(archOf(n), wantedArch) * 10 + formatScore(n, os) + penalty;
      scored.push({ asset: a, score: score });
    });
    if (!scored.length) return null;
    scored.sort(function (x, y) { return x.score - y.score; });
    return scored[0].asset;
  }

  function humanSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function defaultArchFor(os) {
    // macOS 通用包、Android APK 都不区分 CPU 架构
    if (os === 'macos' || os === 'android') return 'universal';
    return 'x64';
  }

  // ── 与后台通信 ─────────────────────────────────────────────
  function fetchReleases(key, force) {
    return new Promise(function (resolve) {
      var parts = key.split('/');
      // 扩展重载后旧内容脚本的上下文会失效，此时直接降级，
      // 避免 "Extension context invalidated." 未捕获异常与回调不触发导致的挂起。
      var alive = false;
      try { alive = !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { alive = false; }
      if (!alive) { resolve({ ok: false, error: '扩展已更新，请刷新本页' }); return; }
      var settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      setTimeout(function () { done({ ok: false, error: '后台无响应' }); }, 20000);
      try {
        chrome.runtime.sendMessage({
          type: 'GHCN_RELEASES', owner: parts[0], repo: parts[1], force: !!force
        }, function (res) {
          if (chrome.runtime && chrome.runtime.lastError) {
            done({ ok: false, error: '扩展已更新，请刷新本页' });
            return;
          }
          done(res || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        done({ ok: false, error: '扩展已更新，请刷新本页' });
      }
    });
  }

  // ── 面板 UI ────────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = '' +
      '#' + PANEL_ID + '{position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:2147483000;' +
      'width:264px;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'color:#1f2328;background:#f4f9ff;border:2px solid #a9cdf2;border-radius:10px;' +
      'box-shadow:0 3px 12px rgba(9,105,218,.14);overflow:hidden;}' +
      '#' + PANEL_ID + ' *{box-sizing:border-box;}' +
      '.ghcn-rd-head{display:flex;align-items:center;justify-content:space-between;' +
      'padding:9px 11px;background:#eaf4ff;border-bottom:1px solid #cfe3f7;cursor:pointer;}' +
      '.ghcn-rd-head b{font-size:13px;}' +
      '.ghcn-rd-head .ghcn-rd-tag{color:#656d76;font-weight:400;font-size:11px;margin-left:5px;}' +
      '.ghcn-rd-fold{border:0;background:transparent;color:#656d76;font-size:16px;cursor:pointer;line-height:1;padding:0 2px;}' +
      '.ghcn-rd-body{padding:9px;}' +
      '.ghcn-rd-tip{color:#656d76;font-size:11px;margin:0 0 8px;}' +
      '.ghcn-rd-tip.hl{color:#d1242f;font-weight:700;font-size:13px;text-align:center;}' +
      '.ghcn-rd-btn{display:block;width:100%;text-align:left;margin-bottom:6px;padding:7px 9px;' +
      'border:1px solid #d8dee4;border-radius:7px;background:#fff;color:#1f2328;cursor:pointer;' +
      'transition:border-color .15s,background .15s;}' +
      '.ghcn-rd-btn:hover:not(:disabled){border-color:#0969da;background:#f6f8fa;}' +
      '.ghcn-rd-btn:disabled{opacity:.55;cursor:default;}' +
      '.ghcn-rd-btn.cur{border-color:#0969da;background:#ddf4ff;}' +
      '.ghcn-rd-btn .ghcn-rd-name{font-weight:600;font-size:12px;}' +
      '.ghcn-rd-btn .ghcn-rd-cur{float:right;font-size:10px;color:#0969da;font-weight:600;}' +
      '.ghcn-rd-btn .ghcn-rd-file{display:block;color:#656d76;font-size:10.5px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}' +
      '.ghcn-rd-body.ghcn-rd-hidden,.ghcn-rd-msg.ghcn-rd-hidden{display:none;}' +
      '.ghcn-rd-foot{padding:0 9px 9px;}' +
      '.ghcn-rd-foot a{color:#0969da;font-size:11px;text-decoration:none;}' +
      '.ghcn-rd-foot a:hover{text-decoration:underline;}' +
      '.ghcn-rd-msg{padding:11px;color:#656d76;font-size:11px;}' +
      '.ghcn-rd-mini{width:42px;height:42px;border-radius:50%;right:16px;top:50%;transform:translateY(-50%);' +
      'display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;' +
      'background:#0969da;color:#fff;border:0;box-shadow:0 3px 10px rgba(9,105,218,.18);}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function removePanel() {
    var old = document.getElementById(PANEL_ID);
    if (old) old.parentNode.removeChild(old);
  }

  function getPanel() {
    var el = document.getElementById(PANEL_ID);
    if (!el) {
      injectStyle();
      el = document.createElement('div');
      el.id = PANEL_ID;
      el.setAttribute('data-ghcn-skip', ''); // 不让汉化/补充翻译处理本面板
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderPanel() {
    if (!enabled || !currentRepoKey) { removePanel(); return; }
    var el = getPanel();
    var sys = currentSystem || { os: 'unknown', arch: 'unknown' };
    var result = lastResult;

    if (collapsed) {
      el.className = 'ghcn-rd-mini';
      el.innerHTML = '<span title="展开下载面板">⬇</span>';
      el.onclick = function () { collapsed = false; renderPanel(); };
      return;
    }

    el.className = '';
    var head = '<div class="ghcn-rd-head"><div><b>⬇ 快速下载</b>' +
      (result && result.tag ? '<span class="ghcn-rd-tag">' + escapeHtml(result.tag) + '</span>' : '') +
      '</div><button class="ghcn-rd-fold" title="' + (bodyCollapsed ? '展开下载按钮' : '收起下载按钮') + '">' +
      (bodyCollapsed ? '+' : '−') + '</button></div>';

    var hideCls = bodyCollapsed ? ' ghcn-rd-hidden' : '';
    var body = '';
    if (!result) {
      body = '<div class="ghcn-rd-msg' + hideCls + '">正在读取最新版本…</div>';
    } else if (!result.ok) {
      body = '<div class="ghcn-rd-msg' + hideCls + '">' + escapeHtml(result.error || '读取失败') + '</div>';
    } else if (!result.assets || !result.assets.length) {
      body = '<div class="ghcn-rd-msg' + hideCls + '">该版本没有可用安装包。</div>';
    } else {
      var platforms = [
        { os: 'linux', label: '🐧 Linux' },
        { os: 'macos', label: '🍎 macOS' },
        { os: 'windows', label: '🪟 Windows' },
        { os: 'android', label: '🤖 Android' }
      ];
      body = '<div class="ghcn-rd-body' + (bodyCollapsed ? ' ghcn-rd-hidden' : '') + '"><div class="ghcn-rd-tip' + (sys.os === 'unknown' ? '' : ' hl') + '">' +
        (sys.os === 'unknown' ? '未能识别当前系统，已按常见架构推荐。' : '系统已识别，点击下载对应安装包。') +
        '</div>';
      platforms.forEach(function (p) {
        var isCur = p.os === sys.os;
        var arch = isCur ? (sys.arch === 'unknown' ? defaultArchFor(p.os) : sys.arch) : defaultArchFor(p.os);
        var pick = matchPackage(result.assets, p.os, arch);
        if (!pick) {
          body += '<button class="ghcn-rd-btn" disabled><span class="ghcn-rd-name">' + p.label + '</span>' +
            '<span class="ghcn-rd-cur">' + (isCur ? '当前系统' : '') + '</span>' +
            '<span class="ghcn-rd-file">该版本暂无对应安装包</span></button>';
        } else {
          body += '<button class="ghcn-rd-btn' + (isCur ? ' cur' : '') + '" data-url="' + escapeHtml(pick.url) + '">' +
            '<span class="ghcn-rd-name">' + p.label + '</span>' +
            '<span class="ghcn-rd-cur">' + (isCur ? '✓ 当前系统' : '') + '</span>' +
            '<span class="ghcn-rd-file">' + escapeHtml(pick.name) + ' · ' + humanSize(pick.size) + '</span></button>';
        }
      });
      body += '</div>';
    }

    var repoUrl = 'https://github.com/' + currentRepoKey + '/releases';
    var foot = '<div class="ghcn-rd-foot"><a href="' + escapeHtml(repoUrl) + '" target="_blank" rel="noopener">查看全部版本 →</a></div>';
    el.innerHTML = head + body + foot;

    // 点标题栏其它区域：整个面板收起为小圆点
    el.querySelector('.ghcn-rd-head').onclick = function () { collapsed = true; renderPanel(); };
    // 点右上角减号/加号：仅折叠或展开下发的平台下载按钮，阻止冒泡避免触发整面板收起
    var foldBtn = el.querySelector('.ghcn-rd-fold');
    if (foldBtn) {
      foldBtn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        bodyCollapsed = !bodyCollapsed;
        renderPanel();
      };
    }
    Array.prototype.forEach.call(el.querySelectorAll('.ghcn-rd-btn[data-url]'), function (btn) {
      btn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        var a = document.createElement('a');
        a.href = btn.getAttribute('data-url');
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };
    });
  }

  function refresh(force) {
    if (!enabled || !currentRepoKey) { removePanel(); return; }
    lastResult = null;
    renderPanel();
    fetchReleases(currentRepoKey, !!force).then(function (res) {
      lastResult = res;
      renderPanel();
    });
  }

  function initForCurrentPage(force) {
    var key = getRepoKey();
    if (key !== currentRepoKey) {
      currentRepoKey = key;
      collapsed = false;
      bodyCollapsed = false; // 新仓库页默认展开
      lastResult = null;
    }
    if (!currentRepoKey || !enabled) { removePanel(); return; }
    if (!currentSystem) {
      detectSystem().then(function (sys) {
        currentSystem = sys;
        refresh(force);
      });
    } else {
      refresh(force);
    }
  }

  // ── 初始化与监听 ───────────────────────────────────────────
  function start() {
    initForCurrentPage(false);
    if (navTimer) clearInterval(navTimer);
    navTimer = setInterval(function () {
      if (getRepoKey() !== currentRepoKey) initForCurrentPage(false);
    }, 1200);
    window.addEventListener('popstate', function () { setTimeout(function () { initForCurrentPage(false); }, 200); });
  }

  chrome.storage.sync.get({ downloadButtonEnabled: true }, function (data) {
    enabled = !!data.downloadButtonEnabled;
    if (enabled) start();
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync' || !changes.downloadButtonEnabled) return;
    enabled = !!changes.downloadButtonEnabled.newValue;
    if (enabled) start();
    else { removePanel(); if (navTimer) { clearInterval(navTimer); navTimer = null; } }
  });
})();
