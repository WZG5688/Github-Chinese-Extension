/**
 * GitHub 汉化助手 - 内容脚本
 * 特点：
 * 1. 词库层只翻译精确的界面文案，不翻译反馈正文、评论、代码和用户昵称。
 * 2. MutationObserver 增量跟随 GitHub 的动态渲染。
 * 3. 监听 history API，兼容 GitHub 站内单页导航。
 * 4. 关闭开关时把页面还原成英文。
 * 5. 「补充翻译」独立于词库，默认关闭；开启后调用在线公共接口翻译未被词库覆盖的界面英文。
 */
(function () {
  'use strict';

  const DICT = window.GHCN_DICT;
  if (!DICT) return;

  const RULES = window.GHCN_RULES || [];
  const ATTR_DICT = window.GHCN_ATTR_DICT || {};

  // ── 扩展上下文安全 ─────────────────────────────────────────
  // 扩展被重新加载后，页面里残留的旧内容脚本持有的扩展上下文会失效，
  // 此时调用 chrome.runtime.sendMessage 会抛 "Extension context invalidated."
  // 且回调不再触发。统一在这里守卫，避免未捕获异常与 Promise 永久挂起。
  function contextAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) { return false; }
  }
  // 安全发消息：任何情况下都 resolve（不会 reject、不抛异常、不永久挂起）。
  // 失败时返回 null，调用方据此进入降级分支。
  function sendMessageSafe(msg, timeoutMs) {
    return new Promise(function (resolve) {
      if (!contextAlive()) { resolve(null); return; }
      let settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      const timer = setTimeout(function () { done(null); }, timeoutMs || 20000);
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          // 必须先读 lastError 以清除它，否则控制台会出现警告
          if (chrome.runtime && chrome.runtime.lastError) { done(null); return; }
          done(res);
        });
      } catch (_) {
        done(null);
      }
      // 超时定时器在完成后无需显式 clear（setTimeout 句柄短生命周期），
      // done 的 settled 守卫保证不会重复 resolve。
    });
  }

  // 忽略这些标签内部的内容：代码、表单值、用户可编辑区域等
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP',
    'TEXTAREA', 'INPUT', 'SELECT', 'IFRAME', 'CANVAS', 'SVG'
  ]);

  // 忽略用户生成内容与代码高亮区域（合并为一个选择器，减少逐节点匹配开销）。
  // 注意：contenteditable 只跳过真正可编辑的（true 或空值），
  // GitHub 大量元素带 contenteditable="false"，用 [contenteditable] 会误伤整页。
  const SKIP_SELECTOR = [
    '.markdown-body',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '.react-code-lines',
    '.blob-code',
    '.blob-code-inner',
    '[data-ghcn-skip]'
  ].join(', ');

  // README 文档容器：补充翻译会放行这里的正文（词库层仍跳过，不动原文结构）。
  // 覆盖 GitHub 旧版 #readme 与新版 [data-testid="readme"]，并含直接打开 .md 的场景。
  const README_SELECTOR = [
    '#readme',
    '[data-testid="readme"]',
    '[data-testid="readme-content"]',
    '.repository-readme',
    '.readme-holder',
    '#repo-readme',
    'article.markdown-body'
  ].join(', ');

  // 这些是用户对话正文，即便套着 markdown-body / article 也不能当 README 翻译
  const NOT_DOC_SELECTOR = [
    '.comment-body',
    '.js-comment-body',
    '.timeline-comment',
    '[data-testid="comment-body"]',
    '[data-testid="issue-body"]',
    '[data-testid="discussion-body"]',
    '.js-issue-body'
  ].join(', ');

  // 补充翻译额外跳过的区域（Issues 标题与正文由 inIssue 单独放行）：
  // 其他评论、用户正文等仍不翻译。
  const ONLINE_SKIP_SELECTOR = [
    SKIP_SELECTOR,
    '.js-issue-title',
    '.js-comment-body',
    '.comment-body',
    '.timeline-comment',
    '[data-testid="issue-title"]',
    '[data-testid="comment-body"]',
    '[data-testid="markdown-body"]'
  ].join(', ');

  function inDoc(el) {
    if (!el || !el.tagName) return false;
    try {
      if (el.closest(NOT_DOC_SELECTOR)) return false;
      return !!el.closest(README_SELECTOR);
    } catch (_) { return false; }
  }

  // Issues 标题与帖子正文容器：补充翻译会放行这里的英文（词库层仍跳过）。
  // 覆盖新旧版选择器：
  // - 标题：.js-issue-title / [data-testid="issue-title"] / .gh-header-title
  // - 原帖：.js-issue-body / [data-testid="issue-body"]
  // - 他人回复（新版 React 界面）：div.react-issue-comment（整卡）、
  //   [class*="IssueCommentBody"]（新版评论正文 CSS module 类）、
  //   [data-testid="markdown-body"]（新版统一 markdown 正文容器）、
  //   以及旧版 .js-comment-body / .comment-body / .timeline-comment。
  const ISSUE_SELECTOR = [
    '.js-issue-title',
    '[data-testid="issue-title"]',
    '.gh-header-title',
    '.js-issue-body',
    '[data-testid="issue-body"]',
    '[data-testid="issue-viewer-issue-container"]',
    '.js-comment-body',
    '.comment-body',
    '.timeline-comment',
    '[data-testid="comment-body"]',
    '[data-testid="comment-viewer-container"]',
    // 新版 GitHub 评论（他人回复）：关键是这几个，否则回复正文被 .markdown-body 挡掉
    '.react-issue-comment',
    '[class*="IssueCommentBody"]',
    '[data-testid="markdown-body"]',
    '[data-testid="issue-comment"]',
    '[data-testid="comment-header"]'
  ].join(', ');

  function inIssue(el) {
    if (!el || !el.tagName) return false;
    try {
      return !!el.closest(ISSUE_SELECTOR);
    } catch (_) { return false; }
  }

  // 预建小写索引，支持 "Issues" / "issues" 等大小写差异
  const LOWER = Object.create(null);
  Object.keys(DICT).forEach(function (k) { LOWER[k.toLowerCase()] = DICT[k]; });

  // 预建「规范化索引」：统一弯引号为直引号 + 压缩连续空白。
  function normalize(s) {
    return String(s)
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const NORM = Object.create(null);
  Object.keys(DICT).forEach(function (k) {
    const n = normalize(k);
    if (!(n in NORM)) NORM[n] = DICT[k];
  });
  const NORM_RULES = RULES.map(function (r) {
    return [new RegExp(r[0].source, r[0].flags.replace('g', '')), r[1]];
  });

  const ATTR_LOWER = Object.create(null);
  Object.keys(ATTR_DICT).forEach(function (attr) {
    const m = Object.create(null);
    Object.keys(ATTR_DICT[attr]).forEach(function (k) { m[k.toLowerCase()] = ATTR_DICT[attr][k]; });
    ATTR_LOWER[attr] = m;
  });
  const ATTR_NAMES = Object.keys(ATTR_DICT);

  // ── 左上角 GitHub Logo 替换 ───────────────────────────────
  // 汉化开启时，把顶栏首页链接里的 GitHub 图标换成用户自定义图标
  // （红色圆底 + 黄色 GitHub 猫）；关闭汉化后还原原始图标。
  // 只跟随「启用汉化」开关，与「补充翻译」无关。
  const CUSTOM_LOGO_INNER =
    '<path style="fill:#e60000;fill-opacity:1" d="M512,256c0,117.67-79.41,216.81-187.56,246.75-2.57-1.9-4.71-5.5-4.71-12.15,0-16.47-.67-81.38-.67-81.38s-2.64-22.35-15.43-32.57c0,0,0,0,0,0,2.5,0,96.9-1.73,112.94-90.59,0,0,16.26-58.42-23.06-102.11,0,0,12.52-30.31-2.64-66.55,0,0-29-2-69.17,26.36,0,0-43.77-8.57-65.7-8.57s-65.7,8.57-65.7,8.57c-40.19-28.33-69.17-26.36-69.17-26.36-15.16,36.24-2.64,66.55-2.64,66.55C79.17,227.6,95.43,286,95.43,286c16,88.86,110.44,90.56,112.94,90.59,0,0,0,0,0,0-12.79,10.22-15.43,32.57-15.43,32.57s-35.57,24.39-68.52-10.75c0,0-17.57-43.93-57.1-32.51,0,0-3.51,8.36,14.06,15.38,0,0,19.32,16,24.15,36.12,0,0,21.19,49.1,87,32.84-.14,16.37-.27,33.05-.27,40.3,0,6.65-2.14,10.25-4.71,12.15C79.41,472.81,0,373.67,0,256,0,114.62,114.62,0,256,0S512,114.62,512,256Z"/>' +
    '<path style="fill-rule:nonzero;fill:#ffff00;fill-opacity:1" d="M416.57,286c-16,88.86-110.44,90.56-112.94,90.59,0,0,0,0,0,0,12.79,10.22,15.43,32.57,15.43,32.57s.67,64.91.67,81.38c0,6.65,2.14,10.25,4.71,12.15a257.82,257.82,0,0,1-136.88,0c2.57-1.9,4.71-5.5,4.71-12.15,0-7.25.13-23.93.27-40.3-65.82,16.26-87-32.84-87-32.84-4.83-20.09-24.15-36.12-24.15-36.12C63.81,374.32,67.32,366,67.32,366c39.53-11.42,57.1,32.51,57.1,32.51,33,35.14,68.52,10.75,68.52,10.75s2.64-22.35,15.43-32.57c0,0,0,0,0,0-2.5,0-96.9-1.73-112.94-90.59,0,0-16.26-58.42,23.06-102.11,0,0-12.52-30.31,2.64-66.55,0,0,29-2,69.17,26.36,0,0,43.77-8.57,65.7-8.57s65.7,8.57,65.7,8.57c40.19-28.33,69.17-26.36,69.17-26.36,15.16,36.24,2.64,66.55,2.64,66.55C432.83,227.6,416.57,286,416.57,286Z"/>';

  const LOGO_SELECTORS = [
    'header svg[class*="octicon-mark-github"]',
    'header a[href="/"] svg.octicon',
    '[data-testid="header-home-link"] svg',
    '.HeaderMenu-logo svg',
    'header svg.octicon-mark-github'
  ].join(', ');
  // 新 svg -> 原始 svg 的 outerHTML，用于关闭时还原
  const logoOriginals = new WeakMap();

  function findHeaderLogos() {
    const out = [];
    let nodes;
    try { nodes = document.querySelectorAll(LOGO_SELECTORS); } catch (_) { return out; }
    for (let i = 0; i < nodes.length; i++) {
      const svg = nodes[i];
      if (svg.getAttribute('data-ghcn-logo') === '1') continue;
      if (logoOriginals.has(svg)) continue;
      out.push(svg);
    }
    // 兜底：若新版 header 结构变化，取页面第一个 octicon-mark-github（通常是顶栏）
    if (!out.length) {
      try {
        const all = document.querySelectorAll('svg[class*="octicon-mark-github"]');
        if (all.length && !logoOriginals.has(all[0]) && all[0].getAttribute('data-ghcn-logo') !== '1') out.push(all[0]);
      } catch (_) { /* ignore */ }
    }
    return out;
  }

  function applyLogo() {
    if (!enabled) return;
    const logos = findHeaderLogos();
    if (!logos.length) return;
    logos.forEach(function (svg) {
      const width = svg.getAttribute('width') || '';
      const height = svg.getAttribute('height') || '';
      // 保留原 svg 上除 octicon 尺寸类以外的自定义类，避免破坏布局
      const cls = (svg.getAttribute('class') || '')
        .replace(/\bocticon-mark-github(?:-\d+)?\b/g, '')
        .replace(/\bocticon\b/g, '')
        .trim();
      const oldOuter = svg.outerHTML;
      const replacement =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"' +
        (width ? ' width="' + width + '"' : '') +
        (height ? ' height="' + height + '"' : '') +
        (cls ? ' class="' + cls + '"' : '') +
        ' aria-hidden="true" data-ghcn-logo="1" data-ghcn-skip>' + CUSTOM_LOGO_INNER + '</svg>';
      const wrap = document.createElement('div');
      wrap.innerHTML = replacement;
      const fresh = wrap.firstChild;
      logoOriginals.set(fresh, oldOuter);
      svg.parentNode.replaceChild(fresh, svg);
    });
  }

  function restoreLogo() {
    logoOriginals.forEach(function (oldOuter, svg) {
      if (!svg.parentNode) return;
      const wrap = document.createElement('div');
      wrap.innerHTML = oldOuter;
      svg.parentNode.replaceChild(wrap.firstChild, svg);
    });
    logoOriginals.clear();
  }

  // ── 词库翻译层状态 ─────────────────────────────────────────
  let enabled = false;
  let count = 0;
  let observer = null;
  let pending = false;

  // node -> 最后写入的词库译文（判断外部是否改回了英文）
  let state = new WeakMap();
  // 记录原文，供关闭词库汉化时还原
  const originals = new Map();
  const attrOriginals = new Map();

  // ── 补充翻译层状态（独立、默认关闭）─────────────────────────
  let suppEnabled = false;
  let suppPending = false;
  let suppCount = 0;
  let suppError = '';
  let suppState = new WeakMap();
  const suppOriginals = new Map();
  const suppAttrOriginals = new Map();
  let suppAttrState = new WeakMap();

  function isSkipped(el) {
    if (!el || !el.tagName || SKIP_TAGS.has(el.tagName)) return true;
    try {
      if (el.closest(SKIP_SELECTOR)) return true;
    } catch (_) { /* 某些节点不支持 closest，忽略 */ }
    return false;
  }

  function lookup(text) {
    if (Object.prototype.hasOwnProperty.call(DICT, text)) return DICT[text];
    const lower = text.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LOWER, lower)) return LOWER[lower];

    const norm = normalize(text);
    if (norm !== text && Object.prototype.hasOwnProperty.call(NORM, norm)) return NORM[norm];

    const withCount = text.match(/^([A-Za-z][A-Za-z ]+?)\s+([\d,.]+[kKmM]?)$/);
    if (withCount) {
      const base = lookup(withCount[1]);
      if (base) return base + ' ' + withCount[2];
    }

    for (let i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(text)) return text.replace(RULES[i][0], RULES[i][1]);
    }
    if (norm !== text) {
      for (let i = 0; i < NORM_RULES.length; i++) {
        if (NORM_RULES[i][0].test(norm)) return norm.replace(NORM_RULES[i][0], NORM_RULES[i][1]);
      }
    }
    return null;
  }

  function translateTextNodes(root) {
    if (!root || !root.querySelectorAll) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        const raw = node.nodeValue;
        if (!raw || !raw.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || isSkipped(parent)) return NodeFilter.FILTER_REJECT;
        if (state.get(node) === raw) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue;
      const last = state.get(node);
      if (last !== undefined && last !== raw) state.delete(node);

      const replacement = lookup(raw.trim());
      if (!replacement || replacement === raw.trim()) continue;

      if (!originals.has(node)) originals.set(node, raw);
      node.nodeValue = raw.replace(raw.trim(), replacement);
      state.set(node, node.nodeValue);
      count++;
    }
  }

  function isSkippedOnline(el) {
    if (!el || !el.tagName || SKIP_TAGS.has(el.tagName)) return true;
    try {
      // README / 文档 / Issues 标题与帖子正文放行：即便落在 markdown-body 里
      // 也交给在线翻译。代码块、代码高亮行、行内 code 仍然跳过。
      if (inDoc(el) || inIssue(el)) {
        if (el.closest('code, pre, .react-code-lines, .blob-code, .blob-code-inner')) return true;
        return false;
      }
      if (el.closest(ONLINE_SKIP_SELECTOR)) return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  function isSkippedForAttr(el, forOnline) {
    if (!el || !el.tagName) return true;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS'].indexOf(el.tagName) !== -1) return true;
    try {
      if (forOnline && (inDoc(el) || inIssue(el))) return false;
      if (el.closest('.markdown-body, [contenteditable="true"], [contenteditable=""], [data-ghcn-skip]')) return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  function translateAttributes(root) {
    let elements;
    if (root && root.nodeType === 1) {
      elements = [root];
      if (root.querySelectorAll) elements = elements.concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    } else if (root && root.querySelectorAll) {
      elements = Array.prototype.slice.call(root.querySelectorAll('*'));
    } else {
      return;
    }

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (isSkippedForAttr(el)) continue;

      let attrMap = attrOriginals.get(el);
      for (let j = 0; j < ATTR_NAMES.length; j++) {
        const attr = ATTR_NAMES[j];
        if (!el.hasAttribute(attr)) continue;
        const raw = el.getAttribute(attr);
        const trimmed = raw.trim();
        const replacement = ATTR_DICT[attr][trimmed] || ATTR_LOWER[attr][trimmed.toLowerCase()];
        if (!replacement || replacement === trimmed) continue;

        if (!attrMap) { attrMap = new Map(); attrOriginals.set(el, attrMap); }
        if (!attrMap.has(attr)) attrMap.set(attr, raw);
        el.setAttribute(attr, replacement);
        count++;
      }
      if (!attrMap) attrOriginals.delete(el);
    }
  }

  // ── 补充翻译：候选筛选 ─────────────────────────────────────
  // 只把「词库没覆盖、看起来是界面英文」的文案送去在线翻译。
  function isOnlineCandidate(text, inDocContent) {
    const t = String(text).trim();
    // 文档类内容（README / Issues 标题与正文）允许更长的段落
    const maxLen = inDocContent ? 2000 : 300;
    if (t.length < 2 || t.length > maxLen) return false;
    if (!/[A-Za-z]/.test(t)) return false;
    // 纯邮箱 / 链接 / @用户名 / 提交哈希 / 纯数字或符号：跳过
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return false;
    if (/^https?:\/\/\S+$/.test(t)) return false;
    if (/^@[\w-]+$/.test(t)) return false;
    if (/^[0-9a-f]{7,40}$/i.test(t)) return false;
    if (/^[\d.,%+\-:$/\\#()]+$/.test(t)) return false;
    // 词库能处理的交给词库层，不重复调用在线接口；
    // README 例外：词库层不会进入 markdown-body，必须靠在线翻译。
    if (!inDocContent && lookup(t)) return false;
    // 避免把夹带中文的用户内容整段送去翻译
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    if (letters < 2 || (cjk > 0 && cjk >= letters)) return false;
    return true;
  }

  function collectOnlineCandidates() {
    const textTargets = [];
    const attrTargets = [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        const raw = node.nodeValue;
        if (!raw || !raw.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || isSkippedOnline(parent)) return NodeFilter.FILTER_REJECT;
        if (suppState.get(node) === raw) return NodeFilter.FILTER_REJECT;
        // 词库层已写入的译文不再交给在线接口（如 "Pages 页面" 含少量字母）
        if (state.get(node) === raw) return NodeFilter.FILTER_REJECT;
        const doc = inDoc(parent) || inIssue(parent);
        if (!isOnlineCandidate(raw.trim(), doc)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      textTargets.push({ node: node, raw: node.nodeValue, text: node.nodeValue.trim() });
    }

    const els = document.body.querySelectorAll('*');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (isSkippedForAttr(el, true)) continue;
      const written = suppAttrState.get(el);
      const doc = inDoc(el) || inIssue(el);
      for (let j = 0; j < ATTR_NAMES.length; j++) {
        const attr = ATTR_NAMES[j];
        if (!el.hasAttribute(attr)) continue;
        const raw = el.getAttribute(attr);
        const t = raw.trim();
        if (written && written[attr] === raw) continue;
        // 词库层已翻译过的属性跳过
        const dictAttrs = attrOriginals.get(el);
        if (dictAttrs && dictAttrs.has(attr)) continue;
        if (!doc && (ATTR_DICT[attr][t] || ATTR_LOWER[attr][t.toLowerCase()])) continue;
        if (!isOnlineCandidate(t, doc)) continue;
        attrTargets.push({ el: el, attr: attr, raw: raw, text: t });
      }
    }
    return { textTargets: textTargets, attrTargets: attrTargets };
  }

  async function runSupplement() {
    if (!suppEnabled || suppPending) return;
    suppPending = true;
    try {
      const collected = collectOnlineCandidates();
      const byText = new Map();
      collected.textTargets.concat(collected.attrTargets).forEach(function (item) {
        if (!byText.has(item.text)) byText.set(item.text, []);
        byText.get(item.text).push(item);
      });
      const texts = Array.from(byText.keys());
      if (!texts.length) return;

      const CHUNK = 100;
      for (let i = 0; i < texts.length; i += CHUNK) {
        const chunk = texts.slice(i, i + CHUNK);
        const reply = await sendMessageSafe({ type: 'GHCN_TRANSLATE', texts: chunk }, 25000);
        if (!reply || !reply.ok || !reply.translations) {
          suppError = !contextAlive()
            ? '扩展已更新，请刷新本页后再使用补充翻译'
            : (reply && reply.error) || '翻译接口暂不可用，请稍后重试';
          break;
        }
        suppError = '';
        chunk.forEach(function (t) {
          const zh = reply.translations[t];
          if (!zh || zh === t) return;
          (byText.get(t) || []).forEach(function (item) {
            if (item.node) {
              if (item.node.nodeValue !== item.raw) return;
              if (!suppOriginals.has(item.node)) suppOriginals.set(item.node, item.raw);
              const replacement = item.raw.replace(item.text, zh);
              item.node.nodeValue = replacement;
              suppState.set(item.node, replacement);
              suppCount++;
            } else {
              const el = item.el;
              if (el.getAttribute(item.attr) !== item.raw) return;
              if (!suppAttrOriginals.has(el)) suppAttrOriginals.set(el, Object.create(null));
              const map = suppAttrOriginals.get(el);
              if (!(item.attr in map)) map[item.attr] = item.raw;
              const replacement = item.raw.replace(item.text, zh);
              el.setAttribute(item.attr, replacement);
              if (!suppAttrState.has(el)) suppAttrState.set(el, Object.create(null));
              suppAttrState.get(el)[item.attr] = replacement;
              suppCount++;
            }
          });
        });
      }
    } catch (_) {
      // 任何异常都在这里收敛，绝不向外抛出未捕获的 Promise rejection
      // （扩展重载后旧的上下文会触发这类异常）
      suppError = !contextAlive()
        ? '扩展已更新，请刷新本页后再使用补充翻译'
        : '补充翻译出错，请刷新本页重试';
    } finally {
      suppPending = false;
    }
  }

  // ── 调度与观察 ─────────────────────────────────────────────
  function run() {
    if (enabled) {
      translateTextNodes(document.body);
      translateAttributes(document.body);
    }
    applyLogo();
    if (suppEnabled) {
      // fire-and-forget：runSupplement 内部已 catch，这里再兜一层，
      // 保证即使未来改动引入同步异常也不会冒泡成未捕获 rejection
      try { Promise.resolve(runSupplement()).catch(function () {}); }
      catch (_) { /* ignore */ }
    }
  }

  function schedule() {
    if ((!enabled && !suppEnabled) || pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      run();
    });
    setTimeout(function () {
      if (pending) { pending = false; run(); }
    }, 200);
  }

  function relevantChange(el) {
    if (!el) return false;
    if (!isSkipped(el)) return true;
    // README / Issues 内容动态加载时也要触发补充翻译重扫
    return !!(suppEnabled && (inDoc(el) || inIssue(el)));
  }

  function isRelevant(records) {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r.type === 'characterData') {
        const p = r.target.parentElement;
        if (relevantChange(p)) return true;
      } else {
        const added = r.addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (n.nodeType === 1) {
            // 顶栏 logo 是 SVG（翻译层跳过），但要为它单独触发一次替换
            if (needsLogoReplace(n)) return true;
            if (relevantChange(n)) return true;
          }
          if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) {
            const p = n.parentElement;
            if (relevantChange(p)) return true;
          }
        }
      }
    }
    return false;
  }

  // 判断节点自身或其后代是否存在尚未替换的顶栏 logo
  function needsLogoReplace(el) {
    if (!enabled) return false;
    try {
      if (el.matches && el.matches(LOGO_SELECTORS) && !el.hasAttribute('data-ghcn-logo')) return true;
      if (el.querySelectorAll) {
        const found = el.querySelectorAll(LOGO_SELECTORS);
        for (let i = 0; i < found.length; i++) {
          if (!found[i].hasAttribute('data-ghcn-logo')) return true;
        }
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      if (isRelevant(records)) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function maybeDisconnectObserver() {
    if (!enabled && !suppEnabled && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // ── 词库层开关 ─────────────────────────────────────────────
  function start() {
    if (enabled) return;
    enabled = true;
    ensureObserver();
    run();
  }

  function stop() {
    if (!enabled) return;
    enabled = false;
    restoreLogo();

    originals.forEach(function (raw, node) { node.nodeValue = raw; });
    attrOriginals.forEach(function (attrs, el) {
      attrs.forEach(function (raw, attr) { el.setAttribute(attr, raw); });
    });
    originals.clear();
    attrOriginals.clear();
    state = new WeakMap();
    count = 0;

    maybeDisconnectObserver();
    if (suppEnabled) schedule(); // 还原成英文后，让补充翻译接管
  }

  // ── 补充翻译开关 ───────────────────────────────────────────
  function startSupp() {
    if (suppEnabled) return;
    suppEnabled = true;
    ensureObserver();
    run();
  }

  function stopSupp() {
    if (!suppEnabled) return;
    suppEnabled = false;

    suppOriginals.forEach(function (raw, node) { node.nodeValue = raw; });
    suppAttrOriginals.forEach(function (map, el) {
      Object.keys(map).forEach(function (attr) { el.setAttribute(attr, map[attr]); });
    });
    suppOriginals.clear();
    suppAttrOriginals.clear();
    suppState = new WeakMap();
    suppAttrState = new WeakMap();
    suppCount = 0;
    suppError = '';

    maybeDisconnectObserver();
    if (enabled) schedule(); // 让词库层重新翻译还原后的英文
  }

  // GitHub 站内导航（pushState / replaceState）后重新扫描
  const nativePush = history.pushState;
  const nativeReplace = history.replaceState;
  history.pushState = function () {
    const result = nativePush.apply(this, arguments);
    setTimeout(schedule, 0);
    return result;
  };
  history.replaceState = function () {
    const result = nativeReplace.apply(this, arguments);
    setTimeout(schedule, 0);
    return result;
  };
  window.addEventListener('popstate', schedule);
  document.addEventListener('pjax:end', schedule);
  document.addEventListener('turbo:load', schedule);

  chrome.runtime.onMessage.addListener(function (msg, _sender, reply) {
    if (msg && msg.type === 'GHCN_STATS') {
      reply({
        count: count,
        enabled: enabled,
        suppCount: suppCount,
        suppEnabled: suppEnabled,
        suppError: suppError
      });
    } else if (msg && msg.type === 'GHCN_SUPP_RETRY') {
      // 手动重新翻译：先还原上一轮在线结果，再重新扫描
      suppOriginals.forEach(function (raw, node) { node.nodeValue = raw; });
      suppAttrOriginals.forEach(function (map, el) {
        Object.keys(map).forEach(function (attr) { el.setAttribute(attr, map[attr]); });
      });
      suppOriginals.clear();
      suppAttrOriginals.clear();
      suppState = new WeakMap();
      suppAttrState = new WeakMap();
      suppCount = 0;
      suppError = '';
      ensureObserver();
      try { Promise.resolve(runSupplement()).catch(function () {}); }
      catch (_) { /* ignore */ }
      reply({ ok: true });
      return true;
    }
  });

  if (contextAlive()) {
    try {
      chrome.storage.sync.get({ enabled: true, supplementEnabled: false }, function (data) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (!data) return;
        if (data.enabled) start();
        if (data.supplementEnabled) startSupp();
      });
    } catch (_) { /* 上下文失效时静默跳过 */ }
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    if (changes.enabled) {
      if (changes.enabled.newValue) start();
      else stop();
    }
    if (changes.supplementEnabled) {
      if (changes.supplementEnabled.newValue) startSupp();
      else stopSupp();
    }
  });
})();
