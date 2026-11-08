// 水杉 Nexus —— 能力层 UI / 编排（v1.2.0）
//
// 与 Pro / Plus / Stats 同构：独立 #nexus-root，只通过 ctx 回调与主控通信。
// 所有可判定行为都在 nexus-core.js；本文件只做 DOM、事件、持久化与编排。
// 面板初始 hidden —— 早期版本吃过「浮层盖住控制条按钮」的亏，冒烟测试会抓。
import * as core from './nexus-core.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LS = {
  config: 'inkreader:nexus:config',
  tags: 'inkreader:nexus:tags',
  notes: 'inkreader:nexus:notes',
  trash: 'inkreader:nexus:trash',
  plan: 'inkreader:nexus:plan',
  history: 'inkreader:nexus:history',
  focus: 'inkreader:nexus:focus',
  queue: 'inkreader:nexus:queue',
  errors: 'inkreader:nexus:errors',
  tts: 'inkreader:nexus:tts',
  profile: 'inkreader:nexus:profile',
};
const mem = new Map();
function read(key, fb) {
  try { const r = localStorage.getItem(key); return r != null ? JSON.parse(r) : (mem.has(key) ? mem.get(key) : fb); }
  catch (e) { return mem.has(key) ? mem.get(key) : fb; }
}
function write(key, v) {
  mem.set(key, v);
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
  return v;
}
const DEFAULTS = {
  shelfView: 'auto', sort: 'recent', tagFilter: [], tagMode: 'and', stateFilter: '',
  edge: 0.30, zones: 3, swap: false, gestures: {}, keys: {}, perBookFlip: {},
  theme: {}, lang: 'zh', userReduced: false, followSystemFont: false,
  checkin: { enabled: true, fromHour: 8, toHour: 22, silentDays: [] },
  focusMin: 25, reviewEnabled: true, achievementsEnabled: true,
  ttsRate: 1, ttsSleepMin: 0, ttsSkipStructural: true, ttsAutoNext: false,
  profile: 'default', pin: '',
  eyeRest: false, nightStart: 19, dayStart: 7, darkRoom: false, autoNight: false,
};

export function mountReaderNexus(ctx) {
  const {
    getMetas = async () => [], getBooks = async () => [], putBook = async () => {},
    deleteBook = async () => {}, getProgress = () => null, getStats = () => {},
    openBook = () => {}, showToast = () => {}, refreshShelf = () => {}, now = () => new Date(),
  } = ctx;
  const root = document.createElement('div');
  root.id = 'nexus-root';
  document.body.appendChild(root);

  let cfg = Object.assign({}, DEFAULTS, read(LS.config, {}));
  const saveCfg = (patch) => { cfg = Object.assign({}, cfg, patch); return write(LS.config, cfg); };
  let activeTab = 'search';
  let query = '';
  let metasCache = [];
  let focusSession = null;
  let open = false;

  root.innerHTML = `
    <div id="nexus-shelfbar" class="nx-shelfbar">
      <input id="nx-shelf-search" class="nx-input" type="search" placeholder="搜书名 / 作者 / 标签" aria-label="书架搜索" />
      <button id="nx-view" class="nx-mini" title="切换书架视图">▦</button>
      <button id="nx-trash" class="nx-mini" title="回收站">♲</button>
      <button id="nexus-center-shelf" class="nx-mini nx-accent" title="能力中心">✦</button>
    </div>
    <div id="nexus-panel" class="nx-panel hidden" role="dialog" aria-modal="true" aria-label="能力中心" tabindex="-1">
      <div class="nx-head">
        <div class="nx-handle"></div>
        <div class="nx-title">能力中心</div>
        <button id="nexus-close" class="nx-mini" aria-label="${esc(core.a11yLabel('close'))}">✕</button>
      </div>
      <div id="nexus-tabs" class="nx-tabs"></div>
      <div id="nexus-body" class="nx-body"></div>
    </div>`;

  // 书架工具条插到书卡列表之前（renderShelf 只重建列表内部，不会删掉兄弟节点）
  const shelf = $('shelf');
  const bookList = $('book-list');
  const bar = $('nexus-shelfbar');
  if (shelf && bookList && bar) shelf.insertBefore(bar, bookList);

  // 阅读器入口复用 Pro 的 #pro-chip：绝不新增 fixed 浮层。
  // 早期版本吃过「新浮层盖住 #btn-toc / 底栏按钮」的亏，冒烟测试会直接抓到。
  const proChip = document.getElementById('pro-chip');
  let chipBtn = null;
  if (proChip) {
    chipBtn = document.createElement('button');
    chipBtn.id = 'nx-chip-open';
    chipBtn.className = 'nx-chip-open';
    chipBtn.textContent = '✦';
    chipBtn.title = '能力中心';
    chipBtn.setAttribute('aria-label', '打开能力中心');
    chipBtn.addEventListener('click', () => setOpen(true));
    proChip.appendChild(chipBtn);
  }

  const TABS = [
    { id: 'search', name: '搜索' }, { id: 'notes', name: '笔记' },
    { id: 'shelf', name: '书架' }, { id: 'plan', name: '计划' },
    { id: 'settings', name: '设置' }, { id: 'diagnose', name: '诊断' },
  ];
  $('nexus-tabs').innerHTML = TABS.map((t) =>
    `<button class="nx-tab" data-tab="${t.id}">${esc(t.name)}</button>`).join('');
  function syncTabs() {
    $('nexus-tabs').querySelectorAll('.nx-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    $('nexus-panel').classList.toggle('hidden', !open);
    if (chipBtn) chipBtn.classList.toggle('nx-open', open);
  }

  /* ---------- 各 Tab 渲染 ---------- */
  async function renderSearch() {
    const books = await getBooks();
    const hist = read(LS.history, []);
    const hits = query ? core.globalSearch(books, query, 60) : [];
    const groups = core.groupHits(hits);
    return `
      <div class="nx-row">
        <input id="nx-q" class="nx-input" type="search" value="${esc(query)}" placeholder="跨书全文搜索 / 输入 12%、第3章 直接跳转" aria-label="全局搜索" />
        <button id="nx-go" class="nx-btn">搜索</button>
      </div>
      <div class="nx-hint">${query ? `命中 ${hits.length} 处 · ${groups.length} 个章节` : '输入关键词搜全库；输入 12% / 第3章 / p42 可直接定位'}</div>
      ${!query && hist.length ? `<div class="nx-chips">${hist.map((h) => `<button class="nx-chip" data-hist="${esc(h)}">${esc(h)}</button>`).join('')}<button class="nx-chip" data-clear-hist="1">清空历史</button></div>` : ''}
      <div id="nx-results">${groups.map((g) => `
        <div class="nx-group"><div class="nx-group-title">${esc(g.bookTitle)} · ${esc(g.title)}</div>
        ${g.hits.slice(0, 4).map((h) => `<div class="nx-hit" data-book="${esc(h.bookId)}" data-ci="${h.ci}" data-pos="${h.pos}">${core.markHit(core.snippetOf(h.text, query), query)}</div>`).join('')}
        </div>`).join('') || (query ? `<div class="nx-empty">${esc(core.emptyState('search').title)}</div>` : '')}</div>`;
  }

  function renderNotes() {
    const notes = read(LS.notes, []);
    const due = cfg.reviewEnabled ? core.reviewSchedule(notes, now().getTime(), 3) : [];
    const colors = core.HIGHLIGHT_COLORS;
    return `
      <div class="nx-row">
        <input id="nx-note-q" class="nx-input" type="search" placeholder="搜笔记 / 摘录" aria-label="笔记搜索" />
        <button id="nx-note-export" class="nx-btn">导出</button>
      </div>
      ${due.length ? `<div class="nx-review"><b>今日回顾</b> ${due.map((n) => `<span>${esc(n.quote || n.text.slice(0, 18))}</span>`).join('')}</div>` : ''}
      <div class="nx-hint">共 ${notes.length} 条；点条目跳回原文，颜色：<span style="color:${colors.important}">重要</span> / <span style="color:${colors.question}">疑问</span> / <span style="color:${colors.like}">喜欢</span></div>
      <div id="nx-notes">${notes.slice().reverse().slice(0, 60).map((n) => `
        <div class="nx-note" data-note="${esc(n.id)}" style="border-left-color:${esc(core.highlightColor(n.color))}">
          <div class="nx-note-quote">${esc(n.quote)}</div><div>${esc(n.text)}</div>
          <div class="nx-note-meta">第 ${n.ci + 1} 章 · ${esc(core.dayKey(new Date(n.at)))} · ${esc((n.tags || []).join(' ') || core.t('notes', cfg.lang))}</div>
        </div>`).join('') || `<div class="nx-empty">${esc(core.emptyState('notes').title)}</div>`}</div>`;
  }

  function renderShelfTab() {
    const tagsMap = read(LS.tags, {});
    const allTags = core.normalizeTags(Object.values(tagsMap).flat());
    const trash = read(LS.trash, []);
    const purged = core.trashPurge(trash, now().getTime(), 30);
    if (purged.removed) write(LS.trash, purged.kept);
    return `
      <div class="nx-hint">标签（点选筛选，${cfg.tagMode === 'or' ? '任一命中' : '全部命中'}）</div>
      <div class="nx-chips">${allTags.map((t) => `<button class="nx-chip${cfg.tagFilter.includes(t) ? ' active' : ''}" data-tag="${esc(t)}" style="border-color:${esc(core.tagColor(t))}">${esc(t)}</button>`).join('') || '<span class="nx-hint">还没有标签，点书卡下方「标签」添加</span>'}
        <button class="nx-chip" data-tagmode="1">${cfg.tagMode === 'or' ? '切为全部' : '切为任一'}</button>
        <button class="nx-chip" data-tag-clear="1">清空</button></div>
      <div class="nx-row"><select id="nx-sort" class="nx-input">
        ${[['recent', '最近阅读'], ['title', '标题'], ['progress', '进度'], ['added', '加入时间']].map(([k, v]) => `<option value="${k}"${cfg.sort === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select><select id="nx-state" class="nx-input">
        ${[['', '全部状态'], ['unread', '未读'], ['reading', '在读'], ['finished', '读完']].map(([k, v]) => `<option value="${k}"${cfg.stateFilter === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select></div>
      <div class="nx-hint">回收站（保留 30 天）</div>
      <div id="nx-trash-list">${purged.kept.length ? purged.kept.map((x) => `<div class="nx-trash-row">${esc(x.title)} <button class="nx-mini" data-restore="${esc(x.id)}">恢复</button></div>`).join('') : `<div class="nx-empty">${esc(core.emptyState('trash').title)}</div>`}</div>
      <div class="nx-row"><button id="nx-dedupe" class="nx-btn">检测重复书籍</button><button id="nx-export-booklist" class="nx-btn">导出书单 HTML</button></div>
      <div class="nx-sec">发现 · 待读队列（智能推荐 103）</div>
      ${(() => {
        const progress = {}; metasCache.forEach((m) => { progress[m.id] = getProgress(m.id); });
        const q = core.upNextQueue(read(LS.plan, {}), metasCache, progress);
        return q.length ? `<div class="nx-list">${q.slice(0, 6).map((b) => `<div class="nx-item" data-open-book="${esc(b.id)}">${esc(b.title)}${b.inPlan ? ' · 计划中' : ''}</div>`).join('')}</div>` : `<div class="nx-hint">没有待读的书，去导入一本吧</div>`;
      })()}
      <div class="nx-sec">今日一句 · 仪式感（智能推荐 113）</div>
      <div class="nx-quote">${(() => {
        const notes = read(LS.notes, []);
        const pool = notes.length ? notes.map((n) => ({ text: n.quote, source: n.bookId })) : [{ text: '翻开一本书，今天也是好日子。' }];
        const q = core.dailyQuote(pool, core.dayKey(now()));
        return q ? esc('“' + q.text + '”') : '翻开一本书，今天也是好日子。';
      })()}</div>`;
  }

  async function renderPlan() {
    const plan = core.planOf(read(LS.plan, {}));
    const metas = await getMetas();
    const progress = {}; metas.forEach((m) => { progress[m.id] = getProgress(m.id); });
    const done = core.finishedCount(metas, progress);
    const pp = core.planProgress(plan, done, now());
    const report = core.yearReport(getStats(), metas, plan.year);
    const digest = core.weeklyDigest(getStats(), now());
    const ach = core.achievementsOf(getStats(), { enabled: cfg.achievementsEnabled, finished: done });
    return `
      <div class="nx-plan-hero"><div class="nx-ring" style="--p:${pp.pct}"><b>${pp.pct}%</b></div>
        <div><div class="nx-big">${done} / ${plan.target} 本</div>
        <div class="nx-hint">${plan.year} 年计划 · 剩 ${pp.daysLeft} 天 · 每周需读 ${pp.perWeek} 本${pp.behind ? ' · 进度偏慢' : ''}</div></div></div>
      <div class="nx-row"><input id="nx-plan-target" class="nx-input" type="number" min="1" max="999" value="${plan.target}" aria-label="年度目标本数" /><button id="nx-plan-save" class="nx-btn">保存目标</button></div>
      <div class="nx-hint">本年累计 ${Math.round(report.totalMs / 60000)} 分钟 · 阅读 ${report.activeDays} 天 · 读完 ${report.finished} 本</div>
      <div class="nx-hint">本周 ${Math.round(digest.totalMs / 60000)} 分钟（${digest.deltaMs >= 0 ? '+' : ''}${Math.round(digest.deltaMs / 60000)}） · 活跃 ${digest.activeDays} 天</div>
      ${report.top.length ? `<div class="nx-hint">读得最多：${report.top.slice(0, 3).map((x) => esc(x.title)).join('、')}</div>` : ''}
      ${ach.length ? `<div class="nx-chips">${ach.map((a) => `<span class="nx-chip active" title="${esc(a.desc)}">${esc(a.name)}</span>`).join('')}</div>` : ''}
      <div class="nx-row"><button id="nx-focus-start" class="nx-btn">开始专注 ${cfg.focusMin} 分钟</button><span id="nx-focus-left"></span></div>
      <div class="nx-hint">${esc(core.statsLegend().note)}；${esc(core.statsLegend().focus)}</div>
      <div class="nx-row"><button id="nx-stats-csv" class="nx-btn">导出统计 CSV</button></div>`;
  }

  function renderSettings() {
    const contrast = core.contrastRatio(cfg.theme.ink || '#202b31', cfg.theme.paper || '#fefdfb');
    const settingsItems = [
      { title: '翻页热区', group: '阅读交互' }, { title: '主题工坊', group: '外观' },
      { title: '专注计时', group: '计划统计' }, { title: '打卡提醒', group: '计划统计' },
      { title: '朗读设置', group: '朗读' }, { title: '语言', group: '通用' },
      { title: '可访问性', group: '通用' }, { title: '配置档', group: '数据' },
    ];
    return `
      <div class="nx-row"><input id="nx-set-q" class="nx-input" type="search" placeholder="搜设置项" aria-label="设置搜索" /><span id="nx-set-count" class="nx-hint"></span></div>
      <div id="nx-set-list">${settingsItems.map((i) => `<div class="nx-set" data-set="${esc(i.title)}"><b>${esc(i.title)}</b><span>${esc(i.group)}</span></div>`).join('')}</div>
      <div class="nx-sec">翻页热区</div>
      <div class="nx-row"><label>边缘宽度 <input id="nx-edge" type="range" min="5" max="48" value="${Math.round(cfg.edge * 100)}" /></label>
        <label><input id="nx-zones" type="checkbox" ${cfg.zones === 5 ? 'checked' : ''} /> 五区</label>
        <label><input id="nx-swap" type="checkbox" ${cfg.swap ? 'checked' : ''} /> 左右手互换</label></div>
      <div class="nx-sec">主题工坊 <span class="nx-hint">对比度 ${contrast.ratio}:1 ${contrast.pass ? '✓' : '⚠ ' + esc(contrast.advice)}</span></div>
      <div class="nx-row"><input id="nx-paper" class="nx-input" value="${esc(cfg.theme.paper || '#fefdfb')}" aria-label="纸色" /><input id="nx-ink" class="nx-input" value="${esc(cfg.theme.ink || '#202b31')}" aria-label="墨色" /><button id="nx-theme-apply" class="nx-btn">实时预览</button></div>
      <div class="nx-row"><input id="nx-theme-code" class="nx-input" placeholder="粘贴主题码" aria-label="主题码" /><button id="nx-theme-copy" class="nx-btn">复制主题码</button><button id="nx-theme-import" class="nx-btn">导入</button></div>
      <div class="nx-sec">朗读 / 打卡 / 专注</div>
      <div class="nx-row"><label>语速 <input id="nx-rate" type="range" min="50" max="200" value="${Math.round(cfg.ttsRate * 100)}" /></label>
        <label><input id="nx-tts-skip" type="checkbox" ${cfg.ttsSkipStructural ? 'checked' : ''} /> 跳过结构文本</label></div>
      <div class="nx-row"><label>提醒时段 <input id="nx-ch-from" type="number" min="0" max="23" value="${cfg.checkin.fromHour}" />—<input id="nx-ch-to" type="number" min="0" max="23" value="${cfg.checkin.toHour}" /></label>
        <label><input id="nx-ch-on" type="checkbox" ${cfg.checkin.enabled ? 'checked' : ''} /> 开启</label></div>
      <div class="nx-row"><label>专注 <input id="nx-focus-min" type="number" min="1" max="120" value="${cfg.focusMin}" /> 分钟</label>
        <label><input id="nx-reduced" type="checkbox" ${cfg.userReduced ? 'checked' : ''} /> 减弱动态效果</label></div>
      <div class="nx-sec">配置档与外观</div>
      <div class="nx-row"><input id="nx-profile" class="nx-input" value="${esc(cfg.profile)}" aria-label="配置档名" /><button id="nx-profile-save" class="nx-btn">切换</button>
        <select id="nx-lang" class="nx-input">${[['zh', '简体'], ['zh_Hant', '繁體'], ['en', 'English']].map(([k, v]) => `<option value="${k}"${cfg.lang === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="nx-sec">护眼与节律（健康护眼 183 / 164 / 189）</div>
      <div class="nx-row"><label><input id="nx-eye" type="checkbox" ${cfg.eyeRest ? 'checked' : ''} /> 20-20-20 护眼提醒</label>
        <span class="nx-hint">${core.nightModeSchedule(now(), { nightStart: cfg.nightStart, dayStart: cfg.dayStart }).on ? '当前：夜间模式（已按节律）' : '当前：日间'}</span></div>
      <div class="nx-row"><label>夜间起 <input id="nx-night-from" type="number" min="0" max="23" value="${cfg.nightStart}" aria-label="夜间起始" /></label>
        <label>日间起 <input id="nx-night-to" type="number" min="0" max="23" value="${cfg.dayStart}" aria-label="日间起始" /></label>
        <label><input id="nx-night-auto" type="checkbox" ${cfg.autoNight ? 'checked' : ''} /> 自动切换</label></div>
      <div class="nx-row"><label><input id="nx-darkroom" type="checkbox" ${cfg.darkRoom ? 'checked' : ''} /> 暗室模式（极黑·睡前）</label></div>`;
  }

  function renderDiagnose() {
    const errs = read(LS.errors, []);
    const queue = read(LS.queue, []);
    const notes = read(LS.notes, []);
    const trash = read(LS.trash, []);
    const diag = core.diagnostics({ bookCount: metasCache.length, noteCount: notes.length, trashCount: trash.length, errors: errs, used: 0, quota: 0, networkCalls: 0, permissions: [] });
    const priv = core.privacyReport({ permissions: [], networkTargets: [] });
    return `
      <div class="nx-sec">本地数据</div>
      <div class="nx-hint">书籍 ${diag.books} · 笔记 ${diag.notes} · 回收站 ${diag.trash} · 待同步队列 ${core.syncQueuePeek(queue).length}</div>
      <div class="nx-hint">存储水位：${diag.pressure.ratio}%（${diag.pressure.level}）${esc(diag.pressure.advice)}</div>
      <div class="nx-sec">隐私</div>
      <div class="nx-hint">${esc(priv.note)}；当前仅本地：${priv.localOnly ? '是' : '否'}</div>
      <div class="nx-sec">错误日志（最近 ${errs.length} 条）</div>
      <div class="nx-log">${errs.length ? errs.slice(-10).map((e) => `<div>${esc(e)}</div>`).join('') : '<div>暂无错误</div>'}</div>
      <div class="nx-row"><button id="nx-backup" class="nx-btn">导出全量备份</button><button id="nx-privacy" class="nx-btn">隐私说明</button></div>
      <div class="nx-row"><button id="nx-purge" class="nx-btn nx-danger">彻底清空本地数据</button></div>
      <div class="nx-hint">${esc(core.purgePlan({ exported: false }).message)}</div>`;
  }

  async function paint() {
    syncTabs();
    const body = $('nexus-body');
    if (!body) return;
    const fn = { search: renderSearch, notes: renderNotes, shelf: renderShelfTab, plan: renderPlan, settings: renderSettings, diagnose: renderDiagnose }[activeTab];
    try { body.innerHTML = await fn(); } catch (e) { body.innerHTML = `<div class="nx-empty">渲染失败：${esc(e.message)}</div>`; }
    if (activeTab === 'search') { const q = $('nx-q'); if (q && query) { q.focus(); q.setSelectionRange(query.length, query.length); } }
  }

  function setOpen(v, tab) {
    open = !!v;
    if (tab) activeTab = tab;
    if (open) { try { metasCache = []; } catch (e) {} paint(); closeTranslateSafe(); }
    else syncTabs();
  }
  function closeTranslateSafe() {
    try { if (ctx.closePanels) ctx.closePanels(); } catch (e) {}
  }

  /* ---------- 事件委托 ---------- */
  $('nexus-center-shelf')?.addEventListener('click', () => setOpen(true));
  $('nexus-close').addEventListener('click', () => setOpen(false));
  $('nexus-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.nx-tab'); if (!b) return;
    activeTab = b.dataset.tab; paint();
  });
  // #24 面板统一手势：下滑关闭（距离 + 速度双条件）
  let swipeY = 0, swipeT = 0;
  $('nexus-panel').addEventListener('touchstart', (e) => { swipeY = e.touches[0].clientY; swipeT = Date.now(); }, { passive: true });
  $('nexus-panel').addEventListener('touchend', (e) => {
    const dy = e.changedTouches[0].clientY - swipeY;
    if (core.panelSwipeShouldClose(dy, Date.now() - swipeT)) setOpen(false);
  }, { passive: true });

  // 书架内即时搜索（#19）与视图切换（#16）
  $('nexus-shelfbar').addEventListener('input', (e) => {
    if (e.target.id !== 'nx-shelf-search') return;
    const q = e.target.value;
    const list = $('book-list');
    if (!list) return;
    const hits = core.shelfSearch(metasCache, q).map((h) => h.meta.id);
    list.querySelectorAll('.book-card').forEach((c) => c.classList.toggle('nx-filtered', !!q && !hits.includes(c.dataset.bookId)));
  });
  $('nexus-shelfbar').addEventListener('click', (e) => {
    const id = e.target.id;
    if (id === 'nexus-center-shelf') return;
    if (id === 'nx-view') {
      const next = { grid: 'list', list: 'compact', compact: 'grid' }[cfg.shelfView === 'auto' ? core.shelfViewOf(window.innerWidth) : cfg.shelfView];
      saveCfg({ shelfView: next }); applyShelfView(); showToast(`书架视图：${next}`);
    }
    if (id === 'nx-trash') setOpen(true, 'shelf');
  });

  $('nexus-body').addEventListener('click', async (e) => {
    const el = e.target;
    const btn = el.closest('button, .nx-hit, .nx-note');
    if (!btn) return;
    const d = btn.dataset || {};

    // 搜索：提交 / 历史 / 结果跳转 / 快捷跳转
    if (btn.id === 'nx-go') {
      const v = $('nx-q').value.trim();
      const jump = core.parseJump(v, 999, 999);
      if (jump.ok && ctx.jumpTo) { ctx.jumpTo(jump); setOpen(false); return; }
      query = v;
      if (v) write(LS.history, core.searchHistoryPush(read(LS.history, []), v));
      paint(); return;
    }
    if (d.hist) { query = d.hist; paint(); return; }
    if (d.clearHist) { write(LS.history, []); paint(); return; }
    if (btn.classList.contains('nx-hit')) {
      openBook(d.book, { ci: Number(d.ci), pi: 0 }); setOpen(false); return;
    }

    // 笔记：跳原文 / 导出
    if (btn.classList.contains('nx-note')) {
      const n = read(LS.notes, []).find((x) => x.id === d.note);
      if (n) { const tgt = core.noteJumpTarget(n, []); openBook(n.bookId, { ci: tgt.ci, pi: tgt.pi }); setOpen(false); }
      return;
    }
    if (btn.id === 'nx-note-export') {
      const notes = core.filterExcerpts(read(LS.notes, []), { q: ($('nx-note-q') || {}).value || '' });
      const html = core.buildBooklistHtml(metasCache, notes, '我的摘录');
      downloadHtml('水杉摘录.html', html); showToast(`已导出 ${notes.length} 条摘录`); return;
    }

    // 书架：标签筛选 / 模式 / 回收站 / 去重 / 书单导出
    if (d.tag) {
      const set = new Set(cfg.tagFilter); set.has(d.tag) ? set.delete(d.tag) : set.add(d.tag);
      saveCfg({ tagFilter: Array.from(set) }); applyShelfFilter(); paint(); return;
    }
    if (d.tagmode) { saveCfg({ tagMode: cfg.tagMode === 'and' ? 'or' : 'and' }); paint(); return; }
    if (d.tagClear || d['tag-clear']) { saveCfg({ tagFilter: [] }); applyShelfFilter(); paint(); return; }
    if (d.restore) {
      const list = read(LS.trash, []), r = core.trashRestore(list, d.restore);
      if (r.book) { await putBook(r.book); write(LS.trash, r.rest); await refreshShelf(); showToast('已恢复'); paint(); }
      return;
    }
    if (btn.id === 'nx-dedupe') {
      const books = await getBooks(), r = core.dedupeBooks(books);
      showToast(r.groups > 0 ? `发现 ${r.groups} 组重复，保留章节更全的版本` : '未发现重复书籍'); return;
    }
    if (btn.id === 'nx-export-booklist') {
      await loadMetas(); downloadHtml('水杉书单.html', core.shareListHtml(metasCache)); showToast('书单已导出'); return;
    }
    if (d.openBook) { openBook(d.openBook, { ci: 0, pi: 0 }); setOpen(false); return; }

    // 计划
    if (btn.id === 'nx-plan-save') {
      const target = Number(($('nx-plan-target') || {}).value) || 12;
      write(LS.plan, core.planOf(Object.assign({}, read(LS.plan, {}), { target, year: now().getFullYear() })));
      showToast('年度目标已保存'); paint(); return;
    }
    if (btn.id === 'nx-focus-start') {
      focusSession = { running: true, minutes: cfg.focusMin, elapsed: 0, lastTs: Date.now() };
      showToast(`专注开始：${cfg.focusMin} 分钟`); tickFocus(); return;
    }
    if (btn.id === 'nx-stats-csv') {
      await loadMetas(); downloadText('水杉统计.csv', core.statsCsv(getStats(), metasCache), 'text/csv'); showToast('统计已导出'); return;
    }

    // 设置
    if (btn.id === 'nx-theme-apply') {
      const theme = { paper: $('nx-paper').value.trim(), ink: $('nx-ink').value.trim() };
      const c = core.contrastRatio(theme.ink, theme.paper);
      saveCfg({ theme }); applyTheme();
      showToast(c.pass ? '主题已应用' : c.advice); paint(); return;
    }
    if (btn.id === 'nx-theme-copy') {
      const code = core.encodeTheme(cfg.theme); $('nx-theme-code').value = code;
      try { await navigator.clipboard.writeText(code); } catch (err) {}
      showToast('主题码已复制'); return;
    }
    if (btn.id === 'nx-theme-import') {
      const t = core.parseTheme($('nx-theme-code').value.trim());
      if (!t) { showToast('主题码无效'); return; }
      saveCfg({ theme: t }); applyTheme(); showToast('主题已导入'); paint(); return;
    }
    if (btn.id === 'nx-profile-save') {
      const p = core.profileNamespace($('nx-profile').value);
      saveCfg({ profile: p }); showToast(`已切换到配置档「${p}」`); return;
    }

    // 诊断
    if (btn.id === 'nx-backup') {
      const books = await getBooks();
      const payload = { version: '1.2.0', exportedAt: now().toISOString(), books, settings: cfg, progress: {}, notes: read(LS.notes, []) };
      downloadText('水杉备份.json', JSON.stringify(payload), 'application/json'); showToast('备份已导出'); return;
    }
    if (btn.id === 'nx-privacy') {
      const r = core.privacyReport({ permissions: [], networkTargets: [] });
      showToast(r.note); return;
    }
    if (btn.id === 'nx-purge') {
      const p = core.purgePlan({ exported: false, confirmed: false });
      if (p.exportFirst) { showToast(p.message); return; }
      if (!window.confirm('确认彻底清空？此操作不可恢复')) return;
      Object.values(LS).forEach((k) => { mem.delete(k); try { localStorage.removeItem(k); } catch (err) {} });
      showToast('已清空 Nexus 本地数据'); paint(); return;
    }
  });

  $('nexus-body').addEventListener('change', async (e) => {
    const el = e.target, id = el.id;
    if (id === 'nx-sort') { saveCfg({ sort: el.value }); applyShelfFilter(); }
    if (id === 'nx-state') { saveCfg({ stateFilter: el.value }); applyShelfFilter(); }
    if (id === 'nx-edge') { saveCfg({ edge: Number(el.value) / 100 }); }
    if (id === 'nx-zones') { saveCfg({ zones: el.checked ? 5 : 3 }); }
    if (id === 'nx-swap') { saveCfg({ swap: el.checked }); }
    if (id === 'nx-rate') { saveCfg({ ttsRate: Number(el.value) / 100 }); }
    if (id === 'nx-tts-skip') { saveCfg({ ttsSkipStructural: el.checked }); }
    if (id === 'nx-ch-from' || id === 'nx-ch-to' || id === 'nx-ch-on') {
      saveCfg({ checkin: { enabled: $('nx-ch-on').checked, fromHour: Number($('nx-ch-from').value), toHour: Number($('nx-ch-to').value), silentDays: cfg.checkin.silentDays } });
    }
    if (id === 'nx-focus-min') { saveCfg({ focusMin: Math.max(1, Number(el.value) || 25) }); paint(); }
    if (id === 'nx-reduced') { saveCfg({ userReduced: el.checked }); applyMotion(); }
    if (id === 'nx-eye') { saveCfg({ eyeRest: el.checked }); showToast(el.checked ? '20-20-20 护眼提醒已开' : '已关闭'); }
    if (id === 'nx-night-auto') { saveCfg({ autoNight: el.checked }); }
    if (id === 'nx-darkroom') { saveCfg({ darkRoom: el.checked }); applyDarkRoom(); showToast(el.checked ? '暗室模式·极黑' : '已退出暗室'); }
    if (id === 'nx-night-from' || id === 'nx-night-to') {
      saveCfg({ nightStart: Math.max(0, Math.min(23, Number($('nx-night-from').value) || 19)), dayStart: Math.max(0, Math.min(23, Number($('nx-night-to').value) || 7)) });
    }
    if (id === 'nx-lang') { saveCfg({ lang: el.value }); paint(); }
    if (id === 'nx-note-q') { /* 输入时即时过滤在 input 事件里 */ }
  });
  $('nexus-body').addEventListener('input', (e) => {
    if (e.target.id === 'nx-q' && !query) return;
    if (e.target.id === 'nx-set-q') {
      const q = e.target.value, items = $('nx-set-list').querySelectorAll('.nx-set');
      const visible = core.filterSettings(Array.from(items).map((x) => ({ el: x, title: x.querySelector('b').textContent, group: x.querySelector('span').textContent })), q);
      const show = new Set(visible.map((v) => v.el));
      items.forEach((x) => x.classList.toggle('nx-filtered', !show.has(x)));
      $('nx-set-count').textContent = `${show.size} 项`;
    }
    if (e.target.id === 'nx-note-q') {
      const q = e.target.value;
      const notes = core.searchNotes(read(LS.notes, []), q);
      const ids = new Set(notes.map((n) => n.id));
      $('nexus-body').querySelectorAll('.nx-note').forEach((x) => x.classList.toggle('nx-filtered', !!q && !ids.has(x.dataset.note)));
    }
  });

  /* ---------- 把配置真正作用到 App ---------- */
  async function loadMetas() {
    if (!metasCache.length) {
      const list = await getMetas();
      const tagsMap = read(LS.tags, {});
      metasCache = core.sortMetas(list.map((m) => Object.assign({}, m, {
        tags: core.normalizeTags(tagsMap[m.id] || m.tags || []),
        readState: core.readStateOf(getProgress(m.id), (getProgress(m.id) || {}).pct),
        progress: (getProgress(m.id) || {}).pct || 0,
      })), cfg.sort);
    }
    return metasCache;
  }
  function applyShelfFilter() {
    const list = $('book-list'); if (!list) return;
    const tagsMap = read(LS.tags, {});
    const enriched = metasCache.map((m) => Object.assign({}, m, { tags: core.normalizeTags(tagsMap[m.id] || m.tags || []) }));
    const hit = new Set(core.filterMetas(enriched, { tags: cfg.tagFilter, tagMode: cfg.tagMode, state: cfg.stateFilter }).map((m) => m.id));
    list.querySelectorAll('.book-card').forEach((c) => c.classList.toggle('nx-filtered', !hit.has(c.dataset.bookId)));
  }
  function applyShelfView() {
    const list = $('book-list'); if (!list) return;
    list.dataset.nxView = cfg.shelfView === 'auto' ? core.shelfViewOf(window.innerWidth) : cfg.shelfView;
  }
  function applyTheme() {
    const css = core.themePreviewCss(cfg.theme);
    Object.keys(css).forEach((k) => document.documentElement.style.setProperty(k, css[k]));
  }
  function applyMotion() {
    const r = core.reducedMotion({ userReduced: cfg.userReduced, systemReduced: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches });
    document.documentElement.classList.toggle('nx-reduced', r.reduce);
  }
  function applyDarkRoom() {
    const d = core.darkRoomMode({ on: cfg.darkRoom });
    document.documentElement.classList.toggle('nx-darkroom', !!cfg.darkRoom);
    if (cfg.darkRoom) { document.documentElement.style.setProperty('--bg', d.paper); document.documentElement.style.setProperty('--fg', d.ink); }
    else { document.documentElement.style.removeProperty('--bg'); document.documentElement.style.removeProperty('--fg'); }
  }
  if (cfg.darkRoom) applyDarkRoom();
  function tickFocus() {
    if (!focusSession || !focusSession.running) return;
    const s = core.focusTick(focusSession, Date.now());
    focusSession = Object.assign({}, focusSession, { elapsed: s.elapsed, lastTs: Date.now(), running: s.running });
    const left = $('nx-focus-left');
    if (left) left.textContent = s.done ? '专注完成 ✓' : `剩余 ${Math.ceil(s.left / 60000)} 分钟`;
    if (s.done) {
      const arr = read(LS.focus, []); arr.push({ done: true, minutes: focusSession.minutes, at: Date.now() }); write(LS.focus, arr);
      focusSession = null; showToast('专注完成，已记入统计'); return;
    }
    setTimeout(tickFocus, 1000);
  }

  function downloadText(name, text, mime) {
    // Android WebView 不处理 blob: 下载，优先走 v1.1.18 已验证的 InkTools 原生桥
    try {
      const bridge = window.InkTools;
      if (bridge && typeof bridge.save === 'function') {
        const bytes = new TextEncoder().encode(text);
        let bin = ''; const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        bridge.save(name, btoa(bin)); return;
      }
    } catch (e) { /* 降级到 Blob */ }
    try {
      const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { showToast('导出失败，请检查存储权限'); }
  }
  const downloadHtml = (n, h) => downloadText(n, h, 'text/html');
  function logError(e) {
    const arr = read(LS.errors, []); arr.push(String(e && e.message || e).slice(0, 200)); write(LS.errors, arr.slice(-50));
  }
  window.addEventListener('error', (e) => logError(e.message));
  window.addEventListener('unhandledrejection', (e) => logError(e.reason));

  // 零侵入：主控 renderShelf() 有多个 return 分支，与其逐个插钩子，
  // 不如观察 #book-list 的 DOM 变化，重建后自动补齐元数据、筛选与视图。
  let shelfTimer = null;
  const shelfList = $('book-list');
  if (shelfList && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => {
      clearTimeout(shelfTimer);
      shelfTimer = setTimeout(() => { metasCache = []; loadMetas().then(() => { applyShelfFilter(); applyShelfView(); }).catch(() => {}); }, 60);
    }).observe(shelfList, { childList: true });
  }

  /* ---------- 对主控暴露的钩子 ---------- */
  return {
    core,
    config: () => cfg,
    state: () => ({ open, tab: activeTab, query, profile: cfg.profile, featureCount: core.NEXUS_FEATURE_IDS.length }),
    setOpen,
    loadMetas,
    applyShelfFilter,
    applyShelfView,
    applyTheme,
    applyMotion,
    // 书架渲染后重新取元数据并应用筛选/视图
    onShelfRendered: async () => { metasCache = []; await loadMetas(); applyShelfFilter(); applyShelfView(); },
    // 删书先进回收站（#7）
    onBookDelete: (book) => { if (book) write(LS.trash, core.trashPut(read(LS.trash, []), book, now().getTime())); },
    // 导入失败分类（#3）与进度（#1）
    onImportPhase: (phase, ratio) => core.importProgress(phase, ratio),
    onImportError: (err) => { const c = core.classifyImportError(err); logError(`${c.kind}: ${err}`); return c; },
    // 划词后加入批注（#41）
    addNote: (o) => { const arr = read(LS.notes, []); const n = core.makeNote(o); arr.push(n); write(LS.notes, arr); return n; },
    // 翻页热区（#21）：返回 'prev' | 'next' | 'menu'
    hitZone: (x, y, w, h) => core.hitZone(x, y, w, h, cfg),
    // 键位映射（#23）
    keyAction: (code) => core.resolveKey(code, cfg).action,
    // 朗读协同（#80）
    ttsConflict: (o) => core.ttsTurnConflict(o),
    _test: { paint, renderSearch, renderNotes, renderShelfTab, renderPlan, renderSettings, renderDiagnose, LS, read, write },
  };
}
