(function () {
  'use strict';

  const toggle = document.getElementById('toggle');
  const countEl = document.getElementById('count');
  const reloadBtn = document.getElementById('reload');
  const logo = document.getElementById('logo');
  const statusEl = document.getElementById('status');
  const suppToggle = document.getElementById('suppToggle');
  const suppCard = document.getElementById('suppCard');
  const suppCountEl = document.getElementById('suppCount');
  const suppStatusEl = document.getElementById('suppStatus');
  const suppRetryBtn = document.getElementById('suppRetry');
  const clearCacheBtn = document.getElementById('clearCache');
  const dlToggle = document.getElementById('dlToggle');
  const dlCard = document.getElementById('dlCard');

  const ICONS_ON = { 16: 'icons/LOGO16.png', 48: 'icons/LOGO48.png', 128: 'icons/LOGO128.png' };
  const ICONS_OFF = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };

  function setIcon(enabled) {
    logo.src = enabled ? 'icons/LOGO48.png' : 'icons/icon48.png';
    chrome.action.setIcon({ path: enabled ? ICONS_ON : ICONS_OFF });
  }

  function currentTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return tabs && tabs[0];
    });
  }

  function refreshStats() {
    currentTab().then(function (tab) {
      if (!tab || !tab.url || !/github\.com/.test(tab.url)) {
        countEl.textContent = '0';
        countEl.className = 'off';
        return;
      }
      return chrome.tabs.sendMessage(tab.id, { type: 'GHCN_STATS' }).then(function (res) {
        countEl.textContent = res && res.count ? String(res.count) : '0';
        countEl.className = res && res.enabled ? '' : 'off';
        suppCountEl.textContent = res && res.suppCount ? String(res.suppCount) : '0';
        suppCountEl.className = res && res.suppEnabled ? '' : 'off';
        if (res && res.suppError) {
          suppStatusEl.textContent = res.suppError;
          suppStatusEl.hidden = false;
        } else {
          suppStatusEl.hidden = true;
        }
      }).catch(function () {
        countEl.textContent = '0';
        countEl.className = 'off';
        suppCountEl.textContent = '0';
        suppCountEl.className = 'off';
      });
    }).catch(function () { /* 扩展上下文刚更新时可忽略 */ });
  }

  chrome.storage.sync.get({ enabled: true, supplementEnabled: false, downloadButtonEnabled: true }, function (data) {
    toggle.checked = !!data.enabled;
    setIcon(toggle.checked);
    suppToggle.checked = !!data.supplementEnabled;
    suppCard.classList.toggle('on', suppToggle.checked);
    dlToggle.checked = !!data.downloadButtonEnabled;
    dlCard.classList.toggle('on', dlToggle.checked);
  });
  refreshStats();

  toggle.addEventListener('change', function () {
    setIcon(toggle.checked);
    chrome.storage.sync.set({ enabled: toggle.checked }, function () {
      currentTab().then(function (tab) {
        if (tab && tab.id) chrome.tabs.reload(tab.id);
      });
    });
  });

  function showStatus(text) {
    statusEl.textContent = text;
    statusEl.hidden = false;
  }

  suppToggle.addEventListener('change', function () {
    suppCard.classList.toggle('on', suppToggle.checked);
    chrome.storage.sync.set({ supplementEnabled: suppToggle.checked }, function () {
      // 无需刷新页面：内容脚本监听 storage.onChanged 即时生效
      setTimeout(refreshStats, 600);
    });
  });

  suppRetryBtn.addEventListener('click', function () {
    suppRetryBtn.disabled = true;
    suppRetryBtn.textContent = '翻译中…';
    currentTab().then(function (tab) {
      if (!tab || !tab.id || !tab.url || !/github\.com/.test(tab.url)) throw new Error('no tab');
      if (!suppToggle.checked) {
        showStatus('请先开启「补充翻译」开关。');
        throw new Error('supp off');
      }
      return chrome.tabs.sendMessage(tab.id, { type: 'GHCN_SUPP_RETRY' });
    }).then(function () {
      showStatus('已重新补充翻译本页。');
      setTimeout(refreshStats, 1200);
    }).catch(function (e) {
      if (e && e.message === 'supp off') return;
      showStatus('重新翻译失败：请先刷新 GitHub 页面再试。');
    }).then(function () {
      suppRetryBtn.disabled = false;
      suppRetryBtn.textContent = '重新补充翻译本页';
    });
  });

  dlToggle.addEventListener('change', function () {
    dlCard.classList.toggle('on', dlToggle.checked);
    chrome.storage.sync.set({ downloadButtonEnabled: dlToggle.checked }, function () {
      showStatus(dlToggle.checked ? '智能下载按钮已开启，仓库页将显示悬浮面板。' : '智能下载按钮已关闭，悬浮面板已隐藏。');
    });
  });

  clearCacheBtn.addEventListener('click', function () {
    try {
      chrome.runtime.sendMessage({ type: 'GHCN_CLEAR_CACHE' }, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          showStatus('扩展刚更新，请关闭并重新打开弹窗后再试。');
          return;
        }
        showStatus('在线翻译缓存已清空，下次翻译将重新请求接口。');
      });
    } catch (_) {
      showStatus('扩展刚更新，请关闭并重新打开弹窗后再试。');
    }
  });

  reloadBtn.addEventListener('click', function () {
    currentTab().then(function (tab) {
      if (tab && tab.id) chrome.tabs.reload(tab.id);
    });
  });
})();
