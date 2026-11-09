// 红杉阅读 —— 阅读统计仪表盘（v1.1.19 重做）
//
// 设计目标（对标 Apple Books / 微信读书 / Linear 的数据页）：
//   1. 回答具体问题，而不是罗列三个数字：这本书「哪天开始看」「共读了几天」
//      「每天多少分钟」「哪天读得最多」「连续读了几天」「比上一期多还是少」。
//   2. 主视觉是图，不是表：每日柱状图 + 12 周热力图，零数据时明确留白，绝不编造。
//   3. 可交互：日/周/月、按书筛选、点柱子/格子看当天明细。
//   4. 本地优先、零追踪、纯 SVG/CSS 无图表库、无动画（遵守墨水屏原则）、主题自适应。
//
// 结构：上半部分是纯函数（模块级零 DOM 副作用，可直接单测）；
//       下半部分 mountStatsDashboard(ctx) 只通过 ctx 与主控通信。
// 删除本文件 + css/stats.css + index.html 的挂载 + app.js 的 renderStats 委托即可完整回退。

/* ===================== 纯函数：日期 ===================== */
export function dateKeyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseKey(k) {
  const [y, m, d] = String(k).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
export function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 周一为一周起点
  return addDays(x, -dow);
}
function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function rangeKeys(from, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(dateKeyOf(addDays(from, i)));
  return out;
}
export function fmtDuration(ms) {
  const min = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
export function fmtShortMin(ms) {
  const min = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  return min >= 60 ? `${(min / 60).toFixed(1).replace(/\.0$/, '')}h` : `${min}m`;
}
export function fmtDate(key) { return String(key || ''); }
export function fmtMonthDay(key) {
  const d = parseKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
export function fmtChineseDate(key) {
  const d = parseKey(key);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/* ===================== 纯函数：周期 ===================== */
/** 返回本期 / 上一期 / 图表日期键。图表始终按「天」展开，这是用户最直接想看的粒度。 */
export function period(mode, ref) {
  const r = dayStart(ref || new Date());
  if (mode === 'day') {
    const keys = [dateKeyOf(r)];
    return {
      keys, prevKeys: [dateKeyOf(addDays(r, -1))],
      chartKeys: rangeKeys(addDays(r, -6), 7),
      label: `${r.getMonth() + 1} 月 ${r.getDate()} 日 · 今天`,
      chartLabel: '最近 7 天',
    };
  }
  if (mode === 'week') {
    const mon = mondayOf(r);
    return {
      keys: rangeKeys(mon, 7),
      prevKeys: rangeKeys(addDays(mon, -7), 7),
      chartKeys: rangeKeys(mon, 7),
      label: `${fmtMonthDay(dateKeyOf(mon))} – ${fmtMonthDay(dateKeyOf(addDays(mon, 6)))} · 本周`,
      chartLabel: '本周一至周日',
    };
  }
  const first = new Date(r.getFullYear(), r.getMonth(), 1);
  const count = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  const prevFirst = new Date(r.getFullYear(), r.getMonth() - 1, 1);
  const prevCount = new Date(r.getFullYear(), r.getMonth(), 0).getDate();
  return {
    keys: rangeKeys(first, count),
    prevKeys: rangeKeys(prevFirst, prevCount),
    chartKeys: rangeKeys(first, count),
    label: `${r.getFullYear()} 年 ${r.getMonth() + 1} 月`,
    chartLabel: `${r.getMonth() + 1} 月每日`,
  };
}

/* ===================== 纯函数：聚合 ===================== */
export function dayMs(stats, key, bookId) {
  const day = stats && stats[key];
  if (!day || !day.byBook) return 0;
  if (bookId) return Number(day.byBook[bookId]) || 0;
  return Object.keys(day.byBook).reduce((s, id) => s + (Number(day.byBook[id]) || 0), 0);
}
export function summarize(stats, keys, bookId) {
  const perDay = {}, byBook = {};
  let totalMs = 0, activeDays = 0, checkinDays = 0;
  (keys || []).forEach((k) => {
    const day = stats && stats[k];
    if (day && day.checkin) checkinDays++;
    let ms = 0;
    if (day && day.byBook) {
      Object.keys(day.byBook).forEach((id) => {
        const v = Number(day.byBook[id]) || 0;
        if (bookId && id !== bookId) return;
        ms += v;
        byBook[id] = (byBook[id] || 0) + v;
      });
    }
    perDay[k] = ms;
    totalMs += ms;
    if (ms > 0) activeDays++;
  });
  return {
    totalMs, activeDays, checkinDays, perDay, byBook,
    avgMs: (keys && keys.length) ? totalMs / keys.length : 0,
    bestDay: Object.keys(perDay).sort((a, b) => perDay[b] - perDay[a])[0] || null,
  };
}
/** 一本书的完整历史：首读日期、末次、累计天数、总时长、逐日分钟。零存储迁移，直接扫历史。 */
export function bookHistory(stats, bookId) {
  let first = null, last = null, totalMs = 0, days = 0;
  const perDay = {};
  Object.keys(stats || {}).sort().forEach((k) => {
    const ms = Number((((stats[k] || {}).byBook || {})[bookId])) || 0;
    if (ms > 0) {
      if (!first) first = k;
      last = k; days++; totalMs += ms; perDay[k] = ms;
    }
  });
  return { first, last, totalMs, days, perDay };
}
export function hasAnyReading(stats) {
  return Object.keys(stats || {}).some((k) => dayMs(stats, k) > 0);
}
/** 连续阅读天数：今天没读时从昨天起算，不把「今天还没开始」误判为断签。 */
export function streak(stats, ref) {
  const r = dayStart(ref || new Date());
  let d = dayMs(stats, dateKeyOf(r)) > 0 ? r : addDays(r, -1);
  let n = 0;
  while (dayMs(stats, dateKeyOf(d)) > 0 && n < 3650) { n++; d = addDays(d, -1); }
  return n;
}
/** 没有上一期数据时不编造环比，返回 null。 */
export function deltaText(curMs, prevMs) {
  const p = Math.round((Number(prevMs) || 0) / 60000);
  const c = Math.round((Number(curMs) || 0) / 60000);
  if (p <= 0) return null;
  const diff = c - p;
  if (diff === 0) return { text: '与上一期持平', up: 0 };
  return { text: `比上一期${diff > 0 ? '多' : '少'} ${Math.abs(diff)} 分钟`, up: diff > 0 ? 1 : -1 };
}
/** 12 周热力图：从 11 周前的周一起，共 84 格；未来日期标 future，不显示假数据。 */
export function heatmapKeys(ref, weeks = 12) {
  const r = dayStart(ref || new Date());
  const start = addDays(mondayOf(r), -(weeks - 1) * 7);
  const todayKey = dateKeyOf(r);
  return rangeKeys(start, weeks * 7).map((k) => ({ key: k, future: k > todayKey }));
}
export function levelOf(ms) {
  const min = (Number(ms) || 0) / 60000;
  if (min <= 0) return 0;
  if (min < 15) return 1;
  if (min < 30) return 2;
  if (min < 60) return 3;
  return 4;
}
/** 近 14 天迷你趋势，用于每本书的 sparkline。 */
export function sparkKeys(ref, n = 14) {
  const r = dayStart(ref || new Date());
  return rangeKeys(addDays(r, -(n - 1)), n);
}

/* ===================== DOM 层 ===================== */
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const svgNs = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const e = document.createElementNS(svgNs, tag);
  Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, String(attrs[k])));
  return e;
}

// 书名只用于展示，缓存一份纯展示映射：下次进统计页首帧就能显示书名，
// 不必等 IndexedDB 回调，也不会出现「ID 片段 → 书名」的闪烁。
const TITLE_CACHE_KEY = 'inkreader:stats-titles';
function readTitleCache() {
  try {
    const v = JSON.parse(localStorage.getItem(TITLE_CACHE_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (e) { return {}; }
}
function writeTitleCache(map) {
  try { localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(map)); } catch (e) { /* 隐私模式下静默降级 */ }
}

export function mountStatsDashboard(ctx) {
  const {
    getStats, getProgress, listBooksMeta, goShelf, openBook, now = () => new Date(),
  } = ctx;

  const root = $('stats-root');
  if (!root) return { render: () => {}, state: () => ({}), _test: {} };

  root.innerHTML = `
    <div id="st-filter">
      <div class="st-period" id="st-period"></div>
      <div class="st-chips" id="st-chips"></div>
    </div>

    <div id="st-empty" class="st-empty hidden">
      <div class="st-empty-mark">◷</div>
      <h3>还没有阅读记录</h3>
      <p>打开任意一本书开始阅读，这里会记下你<strong>哪天开始看</strong>、<strong>每天读了多少分钟</strong>，以及持续了几天。</p>
      <button id="st-go-shelf" class="st-primary">去书架选一本书</button>
    </div>

    <div id="st-content">
      <section class="st-hero">
        <div class="st-hero-label" id="st-hero-label">本期阅读时长</div>
        <div class="st-hero-val" id="st-hero-val">0 分钟</div>
        <div class="st-hero-delta" id="st-hero-delta"></div>
        <div class="st-hero-grid">
          <div><b id="st-daily">0 分</b><span>日均</span></div>
          <div><b id="st-active">0 天</b><span>有阅读</span></div>
          <div><b id="st-streak">0 天</b><span>连续阅读</span></div>
          <div><b id="st-checkin">0 天</b><span>打卡</span></div>
        </div>
      </section>

      <section class="st-card">
        <div class="st-card-head">
          <h3>每日阅读分钟</h3><span id="st-chart-range"></span>
        </div>
        <div class="st-chart-scroll"><svg id="st-bars" role="img" aria-label="每日阅读分钟柱状图"></svg></div>
        <div class="st-day-detail" id="st-day-detail">点一根柱子，看当天读了哪些书</div>
      </section>

      <section class="st-card">
        <div class="st-card-head"><h3>阅读节奏</h3><span>最近 12 周</span></div>
        <div class="st-heat-scroll"><div class="st-heat" id="st-heat"></div></div>
        <div class="st-heat-foot">
          <span id="st-heat-summary"></span>
          <span class="st-legend">少 <i class="st-lv0"></i><i class="st-lv1"></i><i class="st-lv2"></i><i class="st-lv3"></i><i class="st-lv4"></i> 多</span>
        </div>
      </section>

      <section class="st-card">
        <div class="st-card-head"><h3>按书看</h3><span>首读日期 · 累计 · 本期</span></div>
        <div id="st-books"></div>
      </section>
    </div>`;

  let mode = 'day';
  let bookFilter = '';
  let selectedDay = '';
  let lastMetaMap = readTitleCache();

  function statSnapshot() { return getStats() || {}; }

  function renderChips(stats) {
    const host = $('st-chips');
    const ids = Object.keys(stats || {}).reduce((set, k) => {
      Object.keys((stats[k] || {}).byBook || {}).forEach((id) => set.add(id));
      return set;
    }, new Set());
    const list = Array.from(ids);
    const label = (id) => (lastMetaMap[id] || `书 ${String(id).slice(0, 6)}`);
    host.innerHTML = `<button class="st-chip${bookFilter ? '' : ' active'}" data-book="">全部</button>` +
      list.map((id) => `<button class="st-chip${bookFilter === id ? ' active' : ''}" data-book="${esc(id)}">${esc(label(id))}</button>`).join('');
  }

  function renderBars(stats, p, sum) {
    const svg = $('st-bars');
    svg.innerHTML = '';
    const keys = p.chartKeys;
    const barW = keys.length > 14 ? 20 : 34;
    const gap = keys.length > 14 ? 8 : 12;
    const W = Math.max(300, keys.length * (barW + gap) + 24);
    const H = 152;
    const top = 22, bottom = 26, plotH = H - top - bottom;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    const vals = keys.map((k) => dayMs(stats, k, bookFilter));
    const max = Math.max(10, ...vals.map((v) => v / 60000));
    const todayKey = dateKeyOf(now());

    // 参考线：只在有数据时画，零数据不画假刻度
    if (max > 0) {
      [0.5, 1].forEach((f) => {
        const y = top + plotH - plotH * f;
        svg.appendChild(svgEl('line', { x1: 8, x2: W - 8, y1: y, y2: y, class: 'st-grid' }));
      });
    }

    keys.forEach((k, i) => {
      const v = vals[i];
      const min = Math.round(v / 60000);
      const h = max > 0 ? Math.min(plotH, (min / max) * plotH) : 0;
      const x = 12 + i * (barW + gap);
      const y = top + plotH - h;
      const g = svgEl('g', { class: 'st-bar' + (k === todayKey ? ' today' : '') + (selectedDay === k ? ' picked' : ''), 'data-date': k });
      g.appendChild(svgEl('rect', { x, y: top, width: barW, height: plotH, rx: 3, class: 'st-track' }));
      if (h > 0) g.appendChild(svgEl('rect', { x, y, width: barW, height: h, rx: 3, class: 'st-fill' }));
      if (min > 0) {
        const t = svgEl('text', { x: x + barW / 2, y: Math.max(12, y - 5), class: 'st-bar-num', 'text-anchor': 'middle' });
        t.textContent = String(min);
        g.appendChild(t);
      }
      const lab = svgEl('text', { x: x + barW / 2, y: H - 8, class: 'st-bar-label', 'text-anchor': 'middle' });
      lab.textContent = keys.length > 14 ? String(parseKey(k).getDate()) : fmtMonthDay(k);
      g.appendChild(lab);
      const title = svgEl('title');
      title.textContent = `${fmtChineseDate(k)} · ${fmtDuration(v)}`;
      g.appendChild(title);
      g.setAttribute('aria-label', title.textContent);
      svg.appendChild(g);
    });
    $('st-chart-range').textContent = p.chartLabel;
    $('st-day-detail').textContent = sum.bestDay && sum.perDay[sum.bestDay] > 0
      ? `本期读得最多：${fmtMonthDay(sum.bestDay)} · ${fmtDuration(sum.perDay[sum.bestDay])}`
      : '点一根柱子，看当天读了哪些书';
  }

  function renderHeat(stats) {
    const host = $('st-heat');
    const cells = heatmapKeys(now(), 12);
    host.innerHTML = cells.map(({ key, future }) => {
      const ms = future ? 0 : dayMs(stats, key, bookFilter);
      const lv = future ? -1 : levelOf(ms);
      const tip = future ? '' : `${fmtChineseDate(key)} · ${fmtDuration(ms)}`;
      return `<i class="st-cell st-lv${lv < 0 ? 'future' : lv}${selectedDay === key ? ' picked' : ''}" data-date="${esc(key)}" title="${esc(tip)}" aria-label="${esc(tip || '未来日期')}"></i>`;
    }).join('');
    const active = cells.filter((c) => !c.future && dayMs(stats, c.key, bookFilter) > 0).length;
    $('st-heat-summary').textContent = `近 12 周有 ${active} 天阅读`;
  }

  function dayDetail(stats, key) {
    const box = $('st-day-detail');
    const day = stats[key];
    const rows = Object.keys((day && day.byBook) || {})
      .filter((id) => !bookFilter || id === bookFilter)
      .map((id) => ({ id, ms: Number(day.byBook[id]) || 0 }))
      .filter((r) => r.ms > 0)
      .sort((a, b) => b.ms - a.ms);
    const total = rows.reduce((s, r) => s + r.ms, 0);
    if (!rows.length) {
      box.innerHTML = `<b>${fmtChineseDate(key)}</b> · 没有阅读记录`;
      return;
    }
    box.innerHTML = `<b>${fmtChineseDate(key)}</b> · 共 ${esc(fmtDuration(total))}` +
      rows.map((r) => `<span class="st-day-book">${esc(lastMetaMap[r.id] || '未知书目')} ${esc(fmtDuration(r.ms))}</span>`).join('');
  }

  function renderBooks(stats, p, sum) {
    const host = $('st-books');
    const ids = Object.keys(sum.byBook).filter((id) => (sum.byBook[id] || 0) > 0);
    if (!ids.length) {
      host.innerHTML = '<p class="st-muted">本期还没有分书记录。切换到「周 / 月」，或从书架打开一本书开始阅读。</p>';
      return;
    }
    const sorted = ids.sort((a, b) => sum.byBook[b] - sum.byBook[a]);
    const spark = sparkKeys(now(), 14);
    host.innerHTML = sorted.map((id) => {
      const hist = bookHistory(stats, id);
      const prog = getProgress ? getProgress(id) : null;
      const pct = prog && typeof prog.pct === 'number' && isFinite(prog.pct) ? Math.round(prog.pct) : null;
      const curMs = sum.byBook[id] || 0;
      const share = sum.totalMs ? Math.round(curMs / sum.totalMs * 100) : 0;
      const firstText = hist.first
        ? `<span class="st-first">开始于 <b>${esc(hist.first)}</b></span>`
        : '<span class="st-first st-muted">暂无阅读记录</span>';
      const sparkVals = spark.map((k) => (hist.perDay[k] || 0) / 60000);
      const sparkMax = Math.max(10, ...sparkVals);
      const bars = sparkVals.map((v) => `<i style="height:${v > 0 ? Math.max(12, Math.round(v / sparkMax * 100)) : 4}%"></i>`).join('');
      return `<div class="st-book" data-book="${esc(id)}">
        <div class="st-book-top">
          <div class="st-book-name">${esc(lastMetaMap[id] || '未知书目')}</div>
          <div class="st-book-pct">${pct == null ? '—' : pct + '%'}</div>
        </div>
        <div class="st-book-meta">${firstText}<span>共 ${hist.days} 天</span><span>最近 ${hist.last ? esc(hist.last) : '—'}</span></div>
        <div class="st-book-nums">
          <span>累计 <b>${esc(fmtDuration(hist.totalMs))}</b></span>
          <span>本期 <b>${esc(fmtDuration(curMs))}</b></span>
          <span>占比 ${share}%</span>
        </div>
        <div class="st-share"><i style="width:${share}%"></i></div>
        <div class="st-spark" title="近 14 天每日阅读">${bars}</div>
      </div>`;
    }).join('');
  }

  function paint() {
    const stats = statSnapshot();
    const p = period(mode, now());
    const sum = summarize(stats, p.keys, bookFilter);
    const prev = summarize(stats, p.prevKeys, bookFilter);

    $('st-period').textContent = p.label;
    renderChips(stats);
    $('st-empty').classList.toggle('hidden', hasAnyReading(stats));
    $('st-content').classList.toggle('hidden', !hasAnyReading(stats));
    if (!hasAnyReading(stats)) return;

    $('st-hero-label').textContent = bookFilter
      ? `《${lastMetaMap[bookFilter] || '这本书'}》本期阅读时长`
      : '本期阅读时长';
    $('st-hero-val').textContent = fmtDuration(sum.totalMs);
    const d = deltaText(sum.totalMs, prev.totalMs);
    const delta = $('st-hero-delta');
    delta.textContent = d ? d.text : '本期记录已开始累积';
    delta.className = 'st-hero-delta' + (d && d.up > 0 ? ' up' : d && d.up < 0 ? ' down' : '');
    $('st-daily').textContent = fmtShortMin(sum.avgMs);
    $('st-active').textContent = `${sum.activeDays} 天`;
    $('st-streak').textContent = `${streak(stats, now())} 天`;
    $('st-checkin').textContent = `${sum.checkinDays} 天`;

    renderBars(stats, p, sum);
    renderHeat(stats);
    if (selectedDay) dayDetail(stats, selectedDay);
    renderBooks(stats, p, sum);
  }

  async function render(nextMode) {
    if (nextMode) mode = nextMode;
    // 先同步出图：统计页绝不能因为 IndexedDB 回调慢而白屏或只显示一个空壳。
    paint();
    try {
      const metas = await listBooksMeta();
      const map = {};
      (metas || []).forEach((m) => { map[m.id] = m.title; });
      lastMetaMap = Object.assign({}, lastMetaMap, map);
      writeTitleCache(lastMetaMap);
      paint(); // 书名就绪后补齐，柱状图/热力图不必重算两次以上
    } catch (e) { /* 书名取不到时保留缓存，图表数据仍然完整 */ }
  }

  // 交互：书籍筛选 / 柱子 / 热力格 / 点书跳原文 / 空状态 CTA
  $('st-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.st-chip'); if (!b) return;
    bookFilter = b.dataset.book || '';
    selectedDay = '';
    paint();
  });
  $('st-bars').addEventListener('click', (e) => {
    const g = e.target.closest('.st-bar'); if (!g) return;
    selectedDay = g.dataset.date;
    paint();
  });
  $('st-heat').addEventListener('click', (e) => {
    const c = e.target.closest('.st-cell'); if (!c || c.classList.contains('st-lvfuture')) return;
    selectedDay = c.dataset.date;
    paint();
  });
  $('st-books').addEventListener('click', (e) => {
    const card = e.target.closest('.st-book'); if (!card || !openBook) return;
    openBook(card.dataset.book);
  });
  $('st-go-shelf').addEventListener('click', () => { if (goShelf) goShelf(); });

  return {
    render,
    state: () => ({ mode, bookFilter, selectedDay }),
    _test: { paint, period, summarize, bookHistory, heatmapKeys, streak, levelOf, deltaText },
  };
}
