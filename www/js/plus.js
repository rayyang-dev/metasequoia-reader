// 红杉 Plus —— 阅读器能力增强层（10 项改进 + 10 项新功能）
//
// 设计约束（与 pro.js 一致）：
//   * 只通过 ctx 注入的回调与主控通信，不直接改 ci/pi，不引入任何裸 @capacitor/* 导入
//   * 原生能力一律 window.Capacitor.Plugins.* 懒解析，读不到就降级
//   * 删除本文件 + css/plus.css + app.js 里 createPlusLayer 挂载即可完整回退
//   * 逻辑判定尽量放 plus-core.js（纯函数，可单测），本文件只管 DOM / 事件 / 编排
//
// 功能索引（对应产品路线图）
//  改进：1 阅读位置锚点  2 DOMParser 白名单净化(plus-core)  3 有效阅读统计
//        4 自动翻页章末/书末停  5 视线意图判定  6 按书独立排版
//        7 Regal 自适应  8 书架增强  9 章节刻度+剩余时长  10 SW 增量缓存(sw.js)
//  新增：1 全文搜索  2 TTS 朗读  3 摘录导出  4 阅读目标  5 划词查词
//        6 章节速览  7 会话恢复  8 横屏双页  9 字体/封面自定义  10 本地备份

import * as core from './plus-core.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const LS = {
  config: 'inkreader:plus:config',
  anchors: 'inkreader:plus:anchors',
  session: 'inkreader:plus:session',
  bookLayout: 'inkreader:plus:book-layout',
  globalLayout: 'inkreader:plus:global-layout',
  recent: 'inkreader:plus:recent',
  font: 'inkreader:plus:font',
  goalDone: 'inkreader:plus:goal-done',
};
const mem = new Map();
function readLS(key, fb) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : (mem.has(key) ? mem.get(key) : fb); }
  catch (e) { return mem.has(key) ? mem.get(key) : fb; }
}
function writeLS(key, v) {
  mem.set(key, v);
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
}

const DEFAULTS = {
  perBookLayout: false,
  effectiveReading: true,
  adaptiveRegal: true,
  chapterEndPause: true,
  gazeIntent: true,
  recentFirst: true,
  seriesGroup: false,
  showTicks: true,
  twoPage: false,
  dailyGoalMin: 20,
  ttsRate: 1,
  ttsAutoNext: false,
  restoreSession: true,
};

function download(name, text, mime) {
  try {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch (e) { return false; }
}
// Android WebView 默认不处理 blob: 下载，<a download> 点了不会抛错但也没文件。
// 有原生桥时把 UTF-8 文本转 base64 交给系统「下载」目录，浏览器 / PWA 仍走 Blob。
function nativeSave(name, text) {
  let bridge = null;
  try { bridge = window.InkTools; } catch (e) { return null; }
  if (!bridge || typeof bridge.save !== 'function') return null;
  try {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    bridge.save(name, btoa(bin));
    return 'native';
  } catch (e) { return null; }
}
async function shareOrDownload(name, text, mime) {
  const cap = (() => { try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share; } catch (e) { return null; } })();
  if (cap && typeof cap.share === 'function') {
    try { await cap.share({ title: name, text, dialogTitle: '导出' }); return 'share'; } catch (e) {}
  }
  return nativeSave(name, text) || (download(name, text, mime) ? 'download' : 'failed');
}
function saveResultToast(r, fallback) {
  if (r === 'failed') return '导出失败，请检查本机存储';
  if (r === 'native') return '已保存到系统「下载」目录';
  return fallback;
}
function pickFile(accept, onText, onDataUrl) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = accept;
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (f) {
      const r = new FileReader();
      r.onload = () => {
        if (onDataUrl) onDataUrl(String(r.result || ''), f);
        else onText(String(r.result || ''), f);
      };
      r.onerror = () => {};
      if (onDataUrl) r.readAsDataURL(f); else r.readAsText(f, 'utf-8');
    }
    inp.remove();
  });
  inp.click();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mountReaderPlus(ctx) {
  const config = Object.assign({}, DEFAULTS, readLS(LS.config, {}));
  const saveConfig = (k, v) => { config[k] = v; writeLS(LS.config, config); };

  const root = document.createElement('div');
  root.id = 'plus-root';
  root.innerHTML = `
    <div id="plus-pause-marker" class="panel" aria-hidden="true"></div>
    <div id="plus-ticks" aria-hidden="true"></div>
    <div id="plus-meta" aria-hidden="true"></div>
    <div id="plus-session" class="hidden">
      <span id="plus-session-text"></span>
      <button id="plus-session-go">继续</button>
      <button id="plus-session-x" aria-label="忽略">✕</button>
    </div>
    <div id="plus-endstop" class="hidden">
      <span id="plus-endstop-text"></span>
      <button id="plus-endstop-resume">继续自动翻页</button>
      <button id="plus-endstop-x" aria-label="关闭">✕</button>
    </div>
    <div id="plus-selbar" class="hidden">
      <button id="plus-sel-lookup">查词</button>
      <button id="plus-sel-excerpt">摘录</button>
      <button id="plus-sel-copy">复制</button>
    </div>
    <div id="plus-ttsbar" class="hidden">
      <span id="plus-tts-state">朗读</span>
      <button id="plus-tts-toggle">暂停</button>
      <button id="plus-tts-stop">停止</button>
    </div>

    <div id="plus-panel" class="hidden" role="dialog" aria-label="阅读工具箱">
      <div class="plus-head"><strong>工具箱</strong><button id="plus-close" aria-label="关闭">✕</button></div>
      <div id="plus-tabs">
        <button data-tab="search" class="active">搜索</button>
        <button data-tab="chapters">章节</button>
        <button data-tab="tools">工具</button>
        <button data-tab="stats">统计</button>
        <button data-tab="config">设置</button>
      </div>

      <div class="plus-pane" data-pane="search">
        <div class="plus-search-row">
          <input id="plus-q" type="search" placeholder="在本书中搜索词句…" autocomplete="off" />
          <button id="plus-search-go" class="plus-primary">搜索</button>
        </div>
        <div id="plus-search-out" class="plus-list"><p class="plus-empty">输入关键词，检索全书章节。</p></div>
      </div>

      <div class="plus-pane hidden" data-pane="chapters">
        <div id="plus-chapter-out" class="plus-list"></div>
      </div>

      <div class="plus-pane hidden" data-pane="tools">
        <h4>朗读</h4>
        <div class="plus-row"><span>本机 TTS</span><div class="plus-ctl">
          <button id="plus-tts-play">播放本页</button>
          <label class="plus-check"><input id="plus-tts-next" type="checkbox" /> 读完自动翻页</label>
        </div></div>
        <div class="plus-row"><span>语速</span><div class="plus-ctl">
          <input id="plus-tts-rate" type="range" min="0.6" max="1.8" step="0.1" />
          <span id="plus-tts-rate-val" class="plus-val">1.0×</span>
        </div></div>
        <h4>导出与备份</h4>
        <div class="plus-btn-grid">
          <button id="plus-export-md">摘录 · Markdown</button>
          <button id="plus-export-txt">摘录 · 纯文本</button>
          <button id="plus-backup-out">导出本地备份</button>
          <button id="plus-backup-in">导入本地备份</button>
        </div>
        <h4>外观</h4>
        <div class="plus-btn-grid">
          <button id="plus-font-in">导入字体</button>
          <button id="plus-font-clear">恢复默认字体</button>
          <button id="plus-cover-in">自定义本书封面</button>
          <button id="plus-cache-clean">清理旧离线缓存</button>
        </div>
        <label class="plus-check plus-block"><input id="plus-two-page" type="checkbox" /> 横屏时双页并排（需横屏且宽度 ≥ 640）</label>
        <p class="plus-note">全部数据只保存在本机；字体与封面随备份一起导出，不上传任何服务器。</p>
      </div>

      <div class="plus-pane hidden" data-pane="stats">
        <div class="plus-goal">
          <div id="plus-goal-ring"><span id="plus-goal-pct">0%</span></div>
          <div id="plus-goal-side">
            <div class="plus-goal-title">今日阅读目标</div>
            <div id="plus-goal-detail">—</div>
            <div class="plus-row plus-compact"><span>目标</span><div class="plus-ctl">
              <input id="plus-goal-min" type="range" min="5" max="120" step="5" />
              <span id="plus-goal-val" class="plus-val">20 分钟</span>
            </div></div>
          </div>
        </div>
        <div id="plus-stat-grid" class="plus-stat-grid"></div>
        <p class="plus-note">「有效阅读」只统计页面可见且近期有真实交互（翻页 / 触摸 / 按键）或自动翻页正在推进的时长，亮屏放置不计时。</p>
      </div>

      <div class="plus-pane hidden" data-pane="config">
        <div id="plus-switches"></div>
        <p class="plus-note">这些开关即时生效并保存在本机。关闭任一开关，对应能力即回到 v1.1.17 的原始行为。</p>
      </div>
    </div>`;
  document.body.appendChild(root);

  // 入口按钮挂到已有的 #pro-chip：复用其避让逻辑，不再新增一块可能遮挡控制条的浮层
  const entry = document.createElement('button');
  entry.id = 'plus-entry';
  entry.title = '阅读工具箱'; entry.setAttribute('aria-label', '阅读工具箱');
  entry.textContent = '✦';
  const chip = $('pro-chip');
  if (chip) chip.appendChild(entry); else root.appendChild(entry);

  // ---------------- 运行时状态 ----------------
  let bookId = null;
  let chapterStats = [];
  let totalChars = 0;
  let pendingAnchor = null;
  let lastActivityAt = Date.now();
  let lastTurnAt = 0;
  let lastManualTurnAt = 0;
  const turnTimes = [];
  let effectiveMs = 0;
  let readChars = 0;
  let lastPct = 0;
  let gazePhase = 'off';
  let lastAcceptedGazeAt = 0;
  let sessionShown = false;
  let twoPageNow = false;
  let ttsOn = false;
  let selText = '';
  let lastSearchResults = [];

  const now = () => Date.now();
  const book = () => ctx.getBook && ctx.getBook();
  const pos = () => (ctx.getPosition && ctx.getPosition()) || {};

  // ---------------- 改进 3：有效阅读打点 ----------------
  const noteActivity = () => { lastActivityAt = now(); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      if (!document.body.classList.contains('reader-active')) return;
      if (e.target && e.target.closest && e.target.closest('#plus-panel')) return;
      noteActivity();
    }, { passive: true });
  });
  function countThisTick(dt) {
    const ok = core.effectiveTick({
      enabled: config.effectiveReading,
      now: now(), lastActivityAt, lastTurnAt,
      autoActive: !!(ctx.turn && ctx.turn.getState && ctx.turn.getState().auto.active),
    });
    if (ok) { effectiveMs += Math.max(0, Number(dt) || 0); noteCharsOnTick(); }
    return ok;
  }
  function noteCharsOnTick() {
    // 用进度变化推算本次会话读过的字数，供剩余时长估算
    const p = Number(lastPct) || 0;
    if (p > 0 && totalChars > 0) readChars = Math.max(readChars, totalChars * p / 100);
  }

  // ---------------- 改进 1：阅读位置锚点 ----------------
  function saveAnchor(pageEl) {
    if (!bookId) return;
    const a = core.makeAnchor(pageEl, pos().ci);
    if (!a) return;
    const all = readLS(LS.anchors, {});
    all[bookId] = a;
    writeLS(LS.anchors, all);
  }
  function onPageRendered(pageEl) {
    saveAnchor(pageEl);
    if (ttsOn && config.ttsAutoNext) return; // 朗读模式下不打断
  }
  function anchorPi(pages, fallback) {
    if (!pendingAnchor) return fallback;
    const found = core.findPageByQuote(pages, pendingAnchor.quote);
    pendingAnchor = null;
    return found >= 0 ? found : fallback;
  }

  // ---------------- 改进 6：按书独立排版 ----------------
  function onOpenBook(b, prog) {
    if (!b) return null;
    bookId = b.id;
    chapterStats = core.chapterOverview(b);
    totalChars = chapterStats.reduce((s, c) => s + c.chars, 0);
    lastPct = 0; readChars = 0; effectiveMs = 0;
    lastActivityAt = now();
    hideSession();
    hideEndStop();
    stopTTS();
    const anchors = readLS(LS.anchors, {});
    pendingAnchor = anchors[b.id] || null;
    const recent = readLS(LS.recent, {});
    recent[b.id] = now();
    writeLS(LS.recent, recent);
    if (config.perBookLayout) {
      // 没有本书专属记录时回落到「全局默认」，而不是沿用上一本书的字号 ——
      // 否则「按书记忆」会退化成「跟着上一本走」。
      const layouts = readLS(LS.bookLayout, {});
      const target = layouts[b.id] || readLS(LS.globalLayout, null);
      if (target && ctx.applyLayout) ctx.applyLayout(target);
    }
    if (config.showTicks) buildTicks();
    if ($('plus-panel') && !$('plus-panel').classList.contains('hidden')) renderActivePane();
    return pendingAnchor && typeof pendingAnchor.ci === 'number' ? pendingAnchor.ci : null;
  }
  function saveBookLayout(k, v) {
    if (!config.perBookLayout || !bookId) return;
    const LAYOUT_KEYS = ['fontSize', 'lineHeight', 'margin', 'justify', 'letterSpacing',
      'paragraphSpacing', 'firstLineIndent', 'fontFamily', 'theme'];
    if (!LAYOUT_KEYS.includes(k)) return;
    const all = readLS(LS.bookLayout, {});
    all[bookId] = Object.assign({}, readLS(LS.globalLayout, {}), all[bookId], { [k]: v });
    writeLS(LS.bookLayout, all);
    // 同时更新全局默认：新导入的书、以及清空过专属记录的书有一个稳定的起点
    const g = Object.assign({}, readLS(LS.globalLayout, {}), { [k]: v });
    writeLS(LS.globalLayout, g);
  }

  // ---------------- 改进 9：章节刻度 + 剩余时长 ----------------
  function buildTicks() {
    const box = $('plus-ticks');
    if (!box) return;
    box.innerHTML = '';
    if (!config.showTicks || !totalChars || chapterStats.length < 2) return;
    let acc = 0;
    chapterStats.slice(0, -1).forEach((c) => {
      acc += c.chars;
      const t = document.createElement('i');
      t.className = 'plus-tick';
      t.style.left = (acc / totalChars * 100).toFixed(2) + '%';
      box.appendChild(t);
    });
  }
  function onProgress(o) {
    const p = o || {};
    lastPct = Number(p.pct) || 0;
    const remain = core.estimateRemainingMinutes({
      pct: lastPct, totalChars, readChars, effectiveMs,
    });
    const meta = $('plus-meta');
    if (meta) {
      meta.textContent = lastPct >= 100 ? '已读完' : `${lastPct.toFixed(0)}% · 约剩 ${core.formatMinutes(remain)}`;
      meta.classList.toggle('hidden', !document.body.classList.contains('reader-active'));
    }
    const ticks = $('plus-ticks');
    if (ticks) ticks.classList.toggle('hidden', !config.showTicks || !document.body.classList.contains('reader-active'));
  }

  // ---------------- 改进 7：Regal 自适应 / 改进 3：翻页打点 ----------------
  function onTurn(o) {
    const t = now();
    lastTurnAt = t;
    if (o && o.source && !['timed', 'adaptive', 'gaze'].includes(o.source)) lastManualTurnAt = t;
    turnTimes.push(t);
    while (turnTimes.length && t - turnTimes[0] > 4000) turnTimes.shift();
    noteActivity();
  }
  function shouldRegal(chapterChanged, turnCounter, N, theme, pageFlip) {
    return core.shouldRegalFlash({
      chapterChanged, turnCounter, N, theme, pageFlip,
      adaptive: config.adaptiveRegal,
      rapidTurns: turnTimes.length,
    });
  }

  // ---------------- 改进 4：章末 / 书末自动停 ----------------
  function beforeAutoTurn(dir, source) {
    if (!config.chapterEndPause) return true;
    const d = core.chapterEndDecision(pos(), dir, pageStep());
    if (!d.stop) return true;
    // 不能只 return false：编排层会不断重排下一次自动翻页，看起来像「卡住」。
    // 真正停掉自动翻页，并给出可继续的出口。
    try { if (ctx.stopAuto) ctx.stopAuto(); } catch (e) {}
    showEndStop(d.reason);
    return false;
  }
  function showEndStop(reason) {
    const el = $('plus-endstop');
    if (!el) return;
    $('plus-endstop-text').textContent = `${reason} · 自动翻页已暂停`;
    el.classList.remove('hidden');
  }
  function hideEndStop() { const el = $('plus-endstop'); if (el) el.classList.add('hidden'); }

  // ---------------- 改进 5：视线意图判定 ----------------
  function onGazeStatus(st) { if (st && st.phase) gazePhase = st.phase; }
  function acceptGazeSignal() {
    const sel = window.getSelection && window.getSelection();
    const ok = core.acceptGazeSignal({
      enabled: config.gazeIntent,
      phase: gazePhase,
      panelOpen: !!document.querySelector('.panel.open, #pro-panel.pro-on, #plus-panel:not(.hidden)'),
      selection: !!(sel && !sel.isCollapsed && sel.toString().trim()),
      hidden: document.hidden,
      now: now(), lastManualTurnAt, lastAcceptedAt: lastAcceptedGazeAt,
    });
    if (ok) lastAcceptedGazeAt = now();
    return ok;
  }

  // ---------------- 改进 8：书架增强 ----------------
  function sortShelf(list) {
    const recent = readLS(LS.recent, {});
    const recentId = Object.keys(recent).sort((a, b) => recent[b] - recent[a])[0] || null;
    return core.sortShelfList(list, { recentFirst: config.recentFirst, seriesGroup: config.seriesGroup, recentId });
  }
  function decorateShelf() {
    const host = $('book-list');
    if (!host) return;
    host.querySelectorAll('.book-card').forEach((card) => {
      const id = card.dataset.bookId;
      if (!id || card.querySelector('.plus-ring')) return;
      const p = ctx.getProgress ? ctx.getProgress(id) : null;
      let pct = p && typeof p.pct === 'number' && isFinite(p.pct) ? p.pct : 0;
      pct = clamp(Math.round(pct), 0, 100);
      const ring = document.createElement('div');
      ring.className = 'plus-ring';
      ring.style.setProperty('--pct', pct + '%');
      ring.title = `已读 ${pct}%`;
      ring.innerHTML = `<span>${pct}%</span>`;
      card.appendChild(ring);
      const recent = readLS(LS.recent, {});
      const topId = Object.keys(recent).sort((a, b) => recent[b] - recent[a])[0];
      if (topId && String(topId) === String(id)) {
        const badge = document.createElement('div');
        badge.className = 'plus-recent-badge';
        badge.textContent = '最近阅读';
        card.appendChild(badge);
      }
    });
  }
  // 书架是异步重绘的：用 MutationObserver 挂装饰，避免改 renderShelf 的多个早退分支
  let decorating = false;
  const shelfObserver = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => {
      if (decorating) return;
      decorating = true;
      setTimeout(() => { try { decorateShelf(); } catch (e) {} decorating = false; }, 0);
    }) : null;
  if (shelfObserver && $('book-list')) shelfObserver.observe($('book-list'), { childList: true });

  // ---------------- 新功能 7：会话恢复 ----------------
  function onExit() {
    stopTTS();
    sessionShown = false; // 允许下次回到书架再次给出「继续阅读」
    const b = book();
    if (b && config.restoreSession) {
      const p = pos();
      writeLS(LS.session, { bookId: b.id, title: b.title, ci: p.ci || 0, pi: p.pi || 0, pct: Number(p.pct) || 0, at: now() });
    }
    hideEndStop();
    const meta = $('plus-meta'); if (meta) meta.classList.add('hidden');
    const ticks = $('plus-ticks'); if (ticks) ticks.classList.add('hidden');
  }
  function maybeShowSession() {
    if (!config.restoreSession || document.body.classList.contains('reader-active')) return;
    const s = readLS(LS.session, null);
    if (!s || !s.bookId || sessionShown) return;
    sessionShown = true;
    const el = $('plus-session');
    $('plus-session-text').textContent = `继续《${String(s.title || '上次阅读').slice(0, 14)}》· ${Math.round(s.pct || 0)}%`;
    el.classList.remove('hidden');
    clearTimeout(maybeShowSession._t);
    maybeShowSession._t = setTimeout(hideSession, 12000);
  }
  function hideSession() { const el = $('plus-session'); if (el) el.classList.add('hidden'); }
  setTimeout(maybeShowSession, 900);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeShowSession(); });

  // ---------------- 新功能 8：横屏双页 ----------------
  function viewSize() {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  function twoState() {
    const v = viewSize();
    const b = book();
    return {
      enabled: config.twoPage,
      landscape: core.isLandscape(v.width, v.height),
      isPdf: !!(b && b.source === 'pdf'),
      width: v.width,
    };
  }
  function isTwoPage() { return core.twoPageActive(twoState()); }
  function pageMetrics(w, h) {
    const st = twoState();
    return core.pageMetrics({
      width: w, height: h,
      enabled: st.enabled,
      landscape: core.isLandscape(w, h),
      isPdf: st.isPdf,
    });
  }
  function layoutKey() { return isTwoPage() ? '2up' : '1up'; }
  function pageStep() { return isTwoPage() ? 2 : 1; }
  window.addEventListener('resize', () => {
    const next = isTwoPage();
    if (next !== twoPageNow) {
      twoPageNow = next;
      try { if (ctx.onLayoutModeChange) ctx.onLayoutModeChange(); } catch (e) {}
    }
  });
  twoPageNow = isTwoPage();

  // ---------------- 新功能 1：全文搜索 ----------------
  function doSearch() {
    const q = ($('plus-q') && $('plus-q').value || '').trim();
    const out = $('plus-search-out');
    if (!out) return;
    if (!q) { out.innerHTML = '<p class="plus-empty">输入关键词，检索全书章节。</p>'; return; }
    const b = book();
    if (!b) { out.innerHTML = '<p class="plus-empty">请先打开一本书。</p>'; return; }
    const t0 = now();
    const hits = core.searchBook(b, q, 80);
    lastSearchResults = hits;
    const ms = now() - t0;
    if (!hits.length) { out.innerHTML = '<p class="plus-empty">全书没有找到这个词句。</p>'; return; }
    out.innerHTML = `<p class="plus-count">共 ${hits.length} 处 · 用时 ${ms}ms · 点击跳到原文</p>` +
      hits.map((h, i) => `<button class="plus-result" data-i="${i}">
        <span class="plus-result-t">${esc(h.title)}</span>
        <span class="plus-result-s">${esc(h.snippet)}</span></button>`).join('');
  }
  function openResult(i) {
    const h = lastSearchResults[i];
    if (!h || !ctx.jumpToResult) return;
    ctx.jumpToResult(h.ci, h.quote);
    closePanel();
  }

  // ---------------- 新功能 6：章节速览 ----------------
  function renderChapters() {
    const out = $('plus-chapter-out');
    if (!out) return;
    const b = book();
    if (!b) { out.innerHTML = '<p class="plus-empty">请先打开一本书。</p>'; return; }
    chapterStats = core.chapterOverview(b);
    totalChars = chapterStats.reduce((s, c) => s + c.chars, 0);
    const cur = pos().ci || 0;
    out.innerHTML = `<p class="plus-count">全书 ${chapterStats.length} 章 · 约 ${totalChars.toLocaleString('zh-CN')} 字 · 约 ${core.formatMinutes(chapterStats.reduce((s, c) => s + c.minutes, 0))}</p>` +
      chapterStats.map((c) => `<button class="plus-chapter${c.ci === cur ? ' current' : ''}" data-ci="${c.ci}">
        <span class="plus-chapter-n">${String(c.ci + 1).padStart(2, '0')}</span>
        <span class="plus-chapter-t">${esc(c.title)}</span>
        <span class="plus-chapter-m">${c.chars.toLocaleString('zh-CN')} 字 · ${c.minutes} 分</span>
      </button>`).join('');
  }

  // ---------------- 新功能 2：TTS 朗读 ----------------
  // Android WebView 经常没有 Web Speech API：优先用原生 TextToSpeech 桥，浏览器 / PWA 用 speechSynthesis。
  function nativeTts() {
    try { const b = window.InkTools; return b && typeof b.speak === 'function' ? b : null; } catch (e) { return null; }
  }
  function webTts() { return !!(window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined'); }
  function ttsSupported() { return !!nativeTts() || webTts(); }
  function pageText() {
    const p = $('page');
    return p ? String(p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }
  // 原生桥读完一页后回调；Web Speech 也复用同一段「自动翻下一页」逻辑
  window.__inkTtsOnEnd = () => {
    if (!ttsOn) return;
    if (config.ttsAutoNext && ctx.requestTurn) {
      ctx.requestTurn('next', 'tts');
      setTimeout(() => { if (ttsOn) speakCurrent(); }, 700);
    } else stopTTS();
  };
  function speakCurrent() {
    if (!ttsSupported()) { ctx.showToast && ctx.showToast('本机不支持语音朗读'); return; }
    stopTTS();
    const text = pageText().slice(0, 6000);
    if (!text) return;
    const rate = clamp(Number(config.ttsRate) || 1, 0.6, 1.8);
    const nt = nativeTts();
    if (nt) {
      try { nt.speak(text, rate); } catch (e) { ctx.showToast && ctx.showToast('朗读启动失败'); return; }
    } else {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = rate;
      u.onend = () => window.__inkTtsOnEnd();
      u.onerror = () => stopTTS();
      try { window.speechSynthesis.speak(u); } catch (e) { stopTTS(); return; }
    }
    ttsOn = true;
    $('plus-ttsbar').classList.remove('hidden');
    $('plus-tts-state').textContent = '朗读中';
    $('plus-tts-toggle').textContent = nt ? '停止' : '暂停';
  }
  function stopTTS() {
    ttsOn = false;
    const nt = nativeTts();
    if (nt) { try { nt.stopSpeak(); } catch (e) {} }
    else { try { if (webTts()) window.speechSynthesis.cancel(); } catch (e) {} }
    const bar = $('plus-ttsbar'); if (bar) bar.classList.add('hidden');
  }
  function toggleTTS() {
    if (!ttsSupported()) return;
    if (!ttsOn) { speakCurrent(); return; }
    if (nativeTts()) {
      // TextToSpeech 没有 pause/resume：明确停止并说明「继续 = 重读本页」，不做假暂停
      stopTTS();
      ctx.showToast && ctx.showToast('已停止朗读，点「播放本页」可重新朗读');
      return;
    }
    const syn = window.speechSynthesis;
    if (syn.paused) { syn.resume(); $('plus-tts-toggle').textContent = '暂停'; }
    else { syn.pause(); $('plus-tts-toggle').textContent = '继续'; }
  }

  // ---------------- 新功能 3：摘录导出 ----------------
  function marksOfCurrent() {
    const m = (ctx.getMarks && ctx.getMarks()) || {};
    const pick = (v, id) => (Array.isArray(v) ? v : (v && id && Array.isArray(v[id]) ? v[id] : []));
    return {
      highlights: pick(m.highlights, bookId),
      favorites: pick(m.favorites, bookId),
      bookmarks: pick(m.bookmarks, bookId),
    };
  }
  function exportExcerpt(asMd) {
    const b = book() || {};
    const m = marksOfCurrent();
    const md = core.buildExcerptMarkdown(Object.assign({ title: b.title, author: b.author }, m));
    const text = asMd ? md : core.buildExcerptMarkdown(Object.assign({ title: b.title, author: b.author }, m))
      .replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').replace(/^\s*-\s*/gm, '  ');
    const name = `红杉摘录-${String(b.title || 'book').replace(/[\\/:*?"<>|]/g, '_').slice(0, 24)}.${asMd ? 'md' : 'txt'}`;
    shareOrDownload(name, text, asMd ? 'text/markdown' : 'text/plain').then((r) => {
      ctx.showToast && ctx.showToast(saveResultToast(r,
        `已导出 ${m.highlights.length + m.favorites.length + m.bookmarks.length} 条摘录`));
    });
  }

  // ---------------- 新功能 10：本地备份 ----------------
  async function exportBackup() {
    const kv = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('inkreader:')) continue;
        try { kv[k] = JSON.parse(localStorage.getItem(k)); } catch (e) { kv[k] = localStorage.getItem(k); }
      }
    } catch (e) {}
    let books = [];
    try { if (ctx.getAllBooks) books = await ctx.getAllBooks(); } catch (e) {}
    const payload = { kv, books };
    const text = core.serializeBackup(payload);
    const name = `红杉备份-${new Date().toISOString().slice(0, 10)}.json`;
    const r = await shareOrDownload(name, text, 'application/json');
    ctx.showToast && ctx.showToast(saveResultToast(r, `已备份 ${books.length} 本书与本机设置`));
  }
  function importBackup() {
    pickFile('application/json,.json', (text) => {
      let data;
      try { data = core.parseBackup(text); } catch (e) { ctx.showToast && ctx.showToast(e.message); return; }
      try {
        const kv = data.kv || {};
        Object.keys(kv).forEach((k) => {
          if (typeof k === 'string' && k.startsWith('inkreader:')) {
            try { localStorage.setItem(k, typeof kv[k] === 'string' ? kv[k] : JSON.stringify(kv[k])); } catch (e) {}
          }
        });
        const books = Array.isArray(data.books) ? data.books : [];
        if (ctx.restoreBooks) ctx.restoreBooks(books);
        ctx.showToast && ctx.showToast(`已恢复 ${books.length} 本书，建议重启应用使设置完全生效`);
        closePanel();
      } catch (e) { ctx.showToast && ctx.showToast('恢复失败：' + e.message); }
    });
  }

  // ---------------- 新功能 9：字体 / 封面自定义 ----------------
  function applyCustomFont(dataUrl) {
    if (!dataUrl || dataUrl.length > 2 * 1024 * 1024) { ctx.showToast && ctx.showToast('字体文件过大（上限 2MB）'); return; }
    try {
      const ff = new FontFace('InkCustom', `url("${dataUrl}")`);
      ff.load().then(() => {
        document.fonts.add(ff);
        writeLS(LS.font, dataUrl);
        document.body.classList.add('plus-custom-font');
        ctx.showToast && ctx.showToast('自定义字体已应用');
      }).catch(() => ctx.showToast && ctx.showToast('字体解析失败，请换 TTF/OTF/WOFF'));
    } catch (e) { ctx.showToast && ctx.showToast('本机不支持自定义字体'); }
  }
  function clearCustomFont() {
    writeLS(LS.font, null);
    document.body.classList.remove('plus-custom-font');
    ctx.showToast && ctx.showToast('已恢复默认字体');
  }
  (() => {
    const saved = readLS(LS.font, null);
    if (saved) applyCustomFont(saved);
  })();
  function importCover() {
    const b = book();
    if (!b) { ctx.showToast && ctx.showToast('请先打开一本书'); return; }
    pickFile('image/*', null, (dataUrl) => {
      if (dataUrl.length > 3 * 1024 * 1024) { ctx.showToast && ctx.showToast('封面图过大（上限 3MB）'); return; }
      if (ctx.setCover) ctx.setCover(b.id, dataUrl);
      ctx.showToast && ctx.showToast('封面已更新');
    });
  }

  // ---------------- 新功能 4：阅读目标 / 新功能 10：配额预警 ----------------
  function renderStats() {
    const stats = (ctx.getStats && ctx.getStats()) || {};
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = stats[key] || { byBook: {}, checkin: false };
    const totalMs = Object.keys(day.byBook || {}).reduce((s, k) => s + (day.byBook[k] || 0), 0);
    const goalMs = (Number(config.dailyGoalMin) || 20) * 60000;
    const pct = clamp(Math.round(totalMs / goalMs * 100), 0, 100);
    $('plus-goal-pct').textContent = pct + '%';
    $('plus-goal-ring').style.setProperty('--pct', pct + '%');
    $('plus-goal-detail').textContent = `已读 ${Math.round(totalMs / 60000)} / ${config.dailyGoalMin} 分钟${day.checkin ? ' · 今日已打卡 ✓' : ''}`;
    if (pct >= 100) {
      const done = readLS(LS.goalDone, {});
      if (!done[key]) {
        done[key] = true; writeLS(LS.goalDone, done);
        ctx.showToast && ctx.showToast(`今日阅读目标达成 ✓（${config.dailyGoalMin} 分钟）`);
      }
    }
    const remain = core.estimateRemainingMinutes({ pct: lastPct, totalChars, readChars, effectiveMs });
    $('plus-stat-grid').innerHTML = [
      ['有效阅读（本次会话）', core.formatMinutes(effectiveMs / 60000)],
      ['预计读完本书', lastPct > 0 ? core.formatMinutes(remain) : '开始阅读后估算'],
      ['今日打卡', day.checkin ? '已完成 ✓' : '未完成'],
      ['本机存储占用', '检测中…'],
    ].map(([k, v]) => `<div class="plus-stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    checkQuota();
  }
  function checkQuota() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    navigator.storage.estimate().then((e) => {
      const used = Math.round((e.usage || 0) / 1048576);
      const quota = Math.round((e.quota || 0) / 1048576);
      const ratio = e.quota ? (e.usage || 0) / e.quota : 0;
      const txt = `${used} MB / ${quota} MB`;
      const grid = $('plus-stat-grid');
      const target = grid && grid.querySelectorAll('.plus-stat b')[3];
      if (target) target.textContent = txt + (ratio > 0.8 ? ' ⚠' : '');
      if (ratio > 0.8) ctx.showToast && ctx.showToast('本机存储空间偏紧，建议清理旧离线缓存或删除不读的书');
    }).catch(() => {});
  }
  async function cleanOldCaches() {
    if (typeof caches === 'undefined') { ctx.showToast && ctx.showToast('当前环境没有离线缓存'); return; }
    try {
      const keys = await caches.keys();
      const stale = keys.filter((k) => k.startsWith('inkreader-v') && k !== ctx.swCacheName);
      await Promise.all(stale.map((k) => caches.delete(k)));
      ctx.showToast && ctx.showToast(stale.length ? `已清理 ${stale.length} 份旧缓存` : '没有需要清理的旧缓存');
    } catch (e) { ctx.showToast && ctx.showToast('清理失败：' + e.message); }
  }

  // ---------------- 新功能 5：划词查词 ----------------
  let selTimer = null;
  function onSelectionChange() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const bar = $('plus-selbar');
      const sel = window.getSelection && window.getSelection();
      if (!bar || !sel || sel.isCollapsed || !document.body.classList.contains('reader-active')) { if (bar) bar.classList.add('hidden'); return; }
      const text = String(sel.toString() || '').trim();
      if (!text || text.length > 200 || !sel.rangeCount) { bar.classList.add('hidden'); return; }
      if (sel.getRangeAt(0).startContainer && sel.getRangeAt(0).startContainer.nodeType === 1 &&
          sel.getRangeAt(0).startContainer.closest && sel.getRangeAt(0).startContainer.closest('#plus-panel')) { bar.classList.add('hidden'); return; }
      selText = text;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      bar.style.left = clamp(r.left + r.width / 2 - 90, 8, window.innerWidth - 190) + 'px';
      bar.style.top = Math.max(8, r.top - 48) + 'px';
      bar.classList.remove('hidden');
    }, 180);
  }
  document.addEventListener('selectionchange', onSelectionChange);

  // ---------------- 设置开关 ----------------
  const SWITCHES = [
    ['perBookLayout', '按书记忆排版', '每本书独立保存字号 / 行距 / 主题'],
    ['effectiveReading', '有效阅读估算', '静置时排除本次会话有效阅读与剩余时长估算；每日阅读时长统计不受影响'],
    ['adaptiveRegal', 'Regal 自适应刷新', '快翻 / 夜览 / 开启动画时减少闪屏'],
    ['chapterEndPause', '章末自动停', '自动翻页到章末 / 书末暂停并提示继续'],
    ['gazeIntent', '视线意图判定', '视线丢失 / 选字 / 面板打开时忽略回扫'],
    ['recentFirst', '最近阅读置顶', '书架把刚读过的书排在最前'],
    ['seriesGroup', '系列分组', '同系列分卷在书架相邻排列'],
    ['showTicks', '章节刻度', '进度条显示章节分界与剩余时长'],
    ['twoPage', '横屏双页', '横屏且宽度 ≥640 时两页并排'],
    ['restoreSession', '会话恢复', '回到书架时给「继续阅读」入口'],
  ];
  function renderSwitches() {
    const host = $('plus-switches');
    if (!host) return;
    host.innerHTML = SWITCHES.map(([k, label, tip]) => `
      <label class="plus-switch">
        <span><b>${esc(label)}</b><small>${esc(tip)}</small></span>
        <input type="checkbox" data-k="${k}" ${config[k] ? 'checked' : ''} />
        <i aria-hidden="true"></i>
      </label>`).join('');
  }
  renderSwitches();
  $('plus-switches').addEventListener('change', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    saveConfig(k, e.target.checked);
    if (k === 'showTicks') { buildTicks(); onProgress({ pct: lastPct }); }
    if (k === 'twoPage') { const n = isTwoPage(); if (n !== twoPageNow) { twoPageNow = n; ctx.onLayoutModeChange && ctx.onLayoutModeChange(); } }
    if (k === 'recentFirst' || k === 'seriesGroup') ctx.renderShelf && ctx.renderShelf();
    if (k === 'restoreSession' && !e.target.checked) hideSession();
  });

  // ---------------- 面板 ----------------
  function openPanel(tab) {
    const p = $('plus-panel');
    p.classList.remove('hidden');
    $('plus-pause-marker').classList.add('open');
    if (tab) switchTab(tab);
    try { if (ctx.syncPro) ctx.syncPro(); } catch (e) {}
    renderActivePane();
  }
  function closePanel() {
    $('plus-panel').classList.add('hidden');
    $('plus-pause-marker').classList.remove('open');
    $('plus-selbar').classList.add('hidden');
    try { if (ctx.syncPro) ctx.syncPro(); } catch (e) {}
  }
  function switchTab(tab) {
    document.querySelectorAll('#plus-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.plus-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
    renderActivePane(tab);
  }
  function renderActivePane(tab) {
    const t = tab || (document.querySelector('#plus-tabs button.active') || {}).dataset?.tab || 'search';
    if (t === 'chapters') renderChapters();
    if (t === 'stats') renderStats();
    if (t === 'config') renderSwitches();
    if (t === 'search' && book()) { /* 保留上次结果，不重复检索 */ }
  }
  entry.addEventListener('click', (e) => {
    e.stopPropagation();
    const p = $('plus-panel');
    if (p.classList.contains('hidden')) openPanel(); else closePanel();
  });
  $('plus-close').addEventListener('click', closePanel);
  $('plus-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) switchTab(b.dataset.tab); });

  // 搜索
  $('plus-search-go').addEventListener('click', doSearch);
  $('plus-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('plus-search-out').addEventListener('click', (e) => {
    const b = e.target.closest('.plus-result'); if (b) openResult(Number(b.dataset.i));
  });
  // 章节速览
  $('plus-chapter-out').addEventListener('click', (e) => {
    const b = e.target.closest('.plus-chapter'); if (!b) return;
    const ci = Number(b.dataset.ci);
    if (ctx.jumpToChapter) ctx.jumpToChapter(ci);
    closePanel();
  });
  // TTS
  $('plus-tts-play').addEventListener('click', speakCurrent);
  $('plus-tts-toggle').addEventListener('click', toggleTTS);
  $('plus-tts-stop').addEventListener('click', stopTTS);
  $('plus-tts-rate').value = String(config.ttsRate);
  $('plus-tts-rate-val').textContent = Number(config.ttsRate).toFixed(1) + '×';
  $('plus-tts-rate').addEventListener('input', (e) => {
    saveConfig('ttsRate', Number(e.target.value));
    $('plus-tts-rate-val').textContent = Number(config.ttsRate).toFixed(1) + '×';
  });
  $('plus-tts-next').checked = !!config.ttsAutoNext;
  $('plus-tts-next').addEventListener('change', (e) => saveConfig('ttsAutoNext', e.target.checked));
  // 导出 / 备份 / 外观
  $('plus-export-md').addEventListener('click', () => exportExcerpt(true));
  $('plus-export-txt').addEventListener('click', () => exportExcerpt(false));
  $('plus-backup-out').addEventListener('click', exportBackup);
  $('plus-backup-in').addEventListener('click', importBackup);
  $('plus-font-in').addEventListener('click', () => pickFile('.ttf,.otf,.woff,.woff2,font/*', null, applyCustomFont));
  $('plus-font-clear').addEventListener('click', clearCustomFont);
  $('plus-cover-in').addEventListener('click', importCover);
  $('plus-cache-clean').addEventListener('click', cleanOldCaches);
  $('plus-two-page').checked = !!config.twoPage;
  $('plus-two-page').addEventListener('change', (e) => {
    saveConfig('twoPage', e.target.checked);
    const n = isTwoPage();
    if (n !== twoPageNow) { twoPageNow = n; ctx.onLayoutModeChange && ctx.onLayoutModeChange(); }
  });
  // 阅读目标
  $('plus-goal-min').value = String(config.dailyGoalMin);
  $('plus-goal-val').textContent = config.dailyGoalMin + ' 分钟';
  $('plus-goal-min').addEventListener('input', (e) => {
    saveConfig('dailyGoalMin', Number(e.target.value));
    $('plus-goal-val').textContent = config.dailyGoalMin + ' 分钟';
    renderStats();
  });
  // 章末停 / 会话恢复
  $('plus-endstop-resume').addEventListener('click', () => {
    hideEndStop();
    if (ctx.resumeAuto) ctx.resumeAuto();
    else ctx.requestTurn && ctx.requestTurn('next', 'manual');
  });
  $('plus-endstop-x').addEventListener('click', hideEndStop);
  $('plus-session-go').addEventListener('click', () => {
    const s = readLS(LS.session, null);
    hideSession();
    if (s && s.bookId && ctx.openBook) ctx.openBook(s.bookId);
  });
  $('plus-session-x').addEventListener('click', () => { writeLS(LS.session, null); hideSession(); });
  // 划词查词
  $('plus-sel-lookup').addEventListener('click', () => {
    if (selText && ctx.explainText) ctx.explainText(selText);
    $('plus-selbar').classList.add('hidden');
  });
  $('plus-sel-copy').addEventListener('click', () => {
    if (selText && ctx.copyText) ctx.copyText(selText);
    $('plus-selbar').classList.add('hidden');
  });
  $('plus-sel-excerpt').addEventListener('click', () => {
    if (selText && ctx.addExcerpt) ctx.addExcerpt(selText);
    $('plus-selbar').classList.add('hidden');
  });

  // 阅读器打开/关闭时同步浮层可见性（不依赖 MutationObserver，避免与 pro 层互相触发）
  const bodyObserver = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => {
      const active = document.body.classList.contains('reader-active');
      const meta = $('plus-meta'); if (meta) meta.classList.toggle('hidden', !active || !config.showTicks);
      const ticks = $('plus-ticks'); if (ticks) ticks.classList.toggle('hidden', !active || !config.showTicks);
      if (active) hideSession(); else maybeShowSession();
      if (!active) closePanel();
    }) : null;
  if (bodyObserver) bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ---------------- 对外 API（app.js 只通过这些方法挂钩子） ----------------
  return {
    config, core,
    onOpenBook, onExit, onPageRendered, onProgress, onTurn,
    onGazeStatus, acceptGazeSignal, beforeAutoTurn,
    shouldRegal, countThisTick,
    pageMetrics, layoutKey, pageStep, isTwoPage,
    anchorPi, findPageByQuote: core.findPageByQuote,
    sortShelf, decorateShelf,
    saveBookLayout,
    openPanel, closePanel,
    state: () => ({
      config: Object.assign({}, config), bookId, totalChars, lastPct,
      effectiveMs, readChars, twoPage: twoPageNow, ttsOn, gazePhase,
      lastActivityAt, lastTurnAt,
    }),
    // 自动化回归入口
    _test: { doSearch, renderChapters, renderStats, stopTTS, core },
  };
}

// 供 importers.js / 测试按需直接引用
export { sanitizeBookHtml } from './plus-core.js';
