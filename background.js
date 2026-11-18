/**
 * GitHub 汉化助手 - 后台 service worker
 * 1. 按汉化开关切换工具栏图标（开→红色 LOGO，关→黑色 ICON）。
 * 2. 补充翻译：调用免费的谷歌 / 微软公共翻译接口。
 *    - 微软：POST https://edge.microsoft.com/translate/translatetext（免费、无需密钥、支持批量）
 *    - 谷歌：GET  https://translate.googleapis.com/translate_a/single（免费兜底）
 *    翻译结果缓存在 storage.local，避免同一句重复请求。
 * 3. 智能下载：调用 GitHub API 读取仓库最新 Release 的资源列表，
 *    缓存在 storage.local（10 分钟），供内容脚本按系统匹配安装包。
 */
(function () {
  'use strict';

  const ICONS_ON = {
    16: 'icons/LOGO16.png',
    48: 'icons/LOGO48.png',
    128: 'icons/LOGO128.png'
  };
  const ICONS_OFF = {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  };

  function applyIcon(enabled) {
    chrome.action.setIcon({ path: enabled ? ICONS_ON : ICONS_OFF });
  }

  function syncFromStorage() {
    chrome.storage.sync.get({ enabled: true }, function (data) {
      applyIcon(!!data.enabled);
    });
  }

  chrome.runtime.onInstalled.addListener(syncFromStorage);
  chrome.runtime.onStartup.addListener(syncFromStorage);
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync' && changes.enabled) {
      applyIcon(!!changes.enabled.newValue);
    }
  });

  // ── 翻译缓存 ───────────────────────────────────────────────
  const CACHE_KEY = 'ghcnTranslateCache';

  function getCache() {
    return new Promise(function (resolve) {
      chrome.storage.local.get({ [CACHE_KEY]: {} }, function (data) {
        resolve(data[CACHE_KEY] || {});
      });
    });
  }

  function setCache(cache) {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [CACHE_KEY]: cache }, resolve);
    });
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 12000);
    const opts = Object.assign({ signal: controller.signal }, options || {});
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  // 微软 Edge 免费翻译接口：一次请求可翻译一组文本，返回顺序与入参一致。
  // 该接口要求带浏览器 User-Agent；扩展后台的 fetch 自带 UA，无需手动设置。
  async function microsoftTranslate(texts) {
    const url = 'https://edge.microsoft.com/translate/translatetext?from=en&to=zh-Hans';
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(texts)
    }, 15000);
    if (!res.ok) throw new Error('Microsoft HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error('Microsoft 返回格式异常');
    }
    return data.map(function (item) {
      return item && item.translations && item.translations[0] && item.translations[0].text || '';
    });
  }

  // 谷歌免费接口：单条请求，结果在 data[0] 里按片段拼接。
  async function googleOne(text) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 12000);
    if (!res.ok) throw new Error('Google HTTP ' + res.status);
    const data = await res.json();
    const segs = data && data[0];
    if (!Array.isArray(segs)) throw new Error('Google 返回格式异常');
    return segs.map(function (s) { return s && s[0] || ''; }).join('');
  }

  // 并发限制，避免一次性发出过多请求。
  async function googleTranslate(texts) {
    const out = new Array(texts.length);
    let cursor = 0;
    const workers = [];
    const CONC = 4;
    for (let i = 0; i < Math.min(CONC, texts.length); i++) {
      workers.push((async function () {
        while (cursor < texts.length) {
          const idx = cursor++;
          try { out[idx] = await googleOne(texts[idx]); }
          catch (_) { out[idx] = ''; }
        }
      })());
    }
    await Promise.all(workers);
    if (!out.some(Boolean)) throw new Error('Google 翻译全部失败');
    return out;
  }

  async function translateRequest(texts) {
    const cache = await getCache();
    const pending = [];
    const seen = Object.create(null);
    const translations = {};

    texts.forEach(function (t) {
      if (typeof cache[t] === 'string') {
        translations[t] = cache[t];
      } else if (!seen[t]) {
        seen[t] = true;
        pending.push(t);
      }
    });

    let provider = 'cache';
    let error = '';
    if (pending.length) {
      let results = null;
      try {
        results = await microsoftTranslate(pending);
        provider = 'microsoft';
      } catch (e1) {
        try {
          results = await googleTranslate(pending);
          provider = 'google';
        } catch (e2) {
          error = '翻译接口不可用：' + (e1 && e1.message || e1) + '；' + (e2 && e2.message || e2);
        }
      }
      if (results) {
        pending.forEach(function (t, i) {
          const zh = (results[i] || '').trim();
          if (zh) { translations[t] = zh; cache[t] = zh; }
        });
        await setCache(cache);
      }
    }

    return {
      ok: !error,
      translations: translations,
      provider: provider,
      error: error,
      total: texts.length,
      cached: texts.length - pending.length
    };
  }

  // ── 智能下载：仓库最新 Release 资源 ───────────────────────
  const RELEASE_CACHE_KEY = 'ghcnReleaseCache';
  const RELEASE_TTL = 10 * 60 * 1000; // 10 分钟

  async function getReleaseData(owner, repo, force) {
    const key = owner + '/' + repo;
    let store = {};
    try {
      store = await new Promise(function (resolve) {
        chrome.storage.local.get({ [RELEASE_CACHE_KEY]: {} }, function (d) {
          resolve(d[RELEASE_CACHE_KEY] || {});
        });
      });
    } catch (_) { /* ignore */ }

    const hit = store[key];
    if (!force && hit && hit.assets && (Date.now() - (hit.ts || 0) < RELEASE_TTL)) {
      return { ok: true, assets: hit.assets, tag: hit.tag, name: hit.name, cached: true };
    }

    try {
      const url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/latest';
      const res = await fetchWithTimeout(url, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'GitHub-Chinese-Extension'
        }
      }, 15000);
      if (res.status === 404) {
        // 仓库没有 Release：返回过期缓存（如有）否则明确告知
        if (hit && hit.assets) {
          return { ok: true, assets: hit.assets, tag: hit.tag, name: hit.name, cached: true, stale: true };
        }
        return { ok: false, error: '该仓库暂无 Release' };
      }
      if (!res.ok) throw new Error('GitHub API HTTP ' + res.status);
      const data = await res.json();
      const assets = (Array.isArray(data.assets) ? data.assets : []).map(function (a) {
        return {
          name: a.name,
          size: a.size,
          downloads: a.download_count,
          url: a.browser_download_url
        };
      });
      const entry = { assets: assets, tag: data.tag_name || '', name: data.name || '', ts: Date.now() };
      store[key] = entry;
      try {
        await new Promise(function (resolve) {
          chrome.storage.local.set({ [RELEASE_CACHE_KEY]: store }, resolve);
        });
      } catch (_) { /* 缓存失败不影响本次结果 */ }
      return { ok: true, assets: assets, tag: entry.tag, name: entry.name, cached: false };
    } catch (e) {
      // 网络失败时回退到过期缓存
      if (hit && hit.assets) {
        return { ok: true, assets: hit.assets, tag: hit.tag, name: hit.name, cached: true, stale: true };
      }
      return { ok: false, error: '读取 Release 失败：' + (e && e.message || e) };
    }
  }

  // ── 消息处理 ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg) return false;

    // 智能下载：读取指定仓库最新 Release 的资源列表
    if (msg.type === 'GHCN_RELEASES') {
      const owner = String(msg.owner || '');
      const repo = String(msg.repo || '');
      if (!owner || !repo || !/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) {
        sendResponse({ ok: false, error: '无效的仓库地址' });
        return false;
      }
      getReleaseData(owner, repo, !!msg.force)
        .then(sendResponse)
        .catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        });
      return true;
    }

    // 补充翻译：内容脚本把需要翻译的英文文案发来
    if (msg.type === 'GHCN_TRANSLATE') {
      const texts = (Array.isArray(msg.texts) ? msg.texts : []).slice(0, 200);
      translateRequest(texts)
        .then(sendResponse)
        .catch(function (e) {
          sendResponse({ ok: false, translations: {}, error: String(e && e.message || e) });
        });
      return true;
    }

    // 清空在线翻译缓存
    if (msg.type === 'GHCN_CLEAR_CACHE') {
      chrome.storage.local.set({ [CACHE_KEY]: {} }, function () { sendResponse({ ok: true }); });
      return true;
    }

    // 查询缓存条数
    if (msg.type === 'GHCN_CACHE_COUNT') {
      getCache().then(function (c) { sendResponse({ count: Object.keys(c).length }); });
      return true;
    }

    return false;
  });

  syncFromStorage();
})();
