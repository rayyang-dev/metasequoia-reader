// 水杉阅读 v1.1.19 —— 阅读统计仪表盘 + 目录/当前章一致性 专项回归
// 三段：① stats.js 纯函数（Node 侧直接 import，同时证明模块顶层零 DOM 副作用）
//       ② 源码级接线（SW 模块图 / 主控挂载 / 旧 DOM 已移除 / 目录同步钩子）
//       ③ 真实 App 集成（统计页图表与交互 / 空状态 / 跨章翻页后目录高亮）
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
console.log('static server:', BASE);

const results = [];
const check = (name, cond, extra) => results.push({ name, pass: !!cond, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= ① 纯函数 ================= */
const S = await import(new URL('../www/js/stats.js', import.meta.url));

const TODAY = new Date();
const K_TODAY = S.dateKeyOf(TODAY);
const K_YEST = S.dateKeyOf(S.addDays(TODAY, -1));
const K_OLD = S.dateKeyOf(S.addDays(TODAY, -9));
const MIN = 60000;
const stats = {
  [K_OLD]: { byBook: { b1: 20 * MIN }, checkin: true },
  [K_YEST]: { byBook: { b1: 35 * MIN, b2: 10 * MIN }, checkin: true },
  [K_TODAY]: { byBook: { b1: 25 * MIN }, checkin: false },
};

check('纯函数模块可在无 DOM 的 Node 环境直接 import（顶层零副作用）',
  typeof S.mountStatsDashboard === 'function' && typeof S.bookHistory === 'function');
check('period(day)：本期=今天、上一期=昨天、图表 7 天',
  S.period('day', TODAY).keys[0] === K_TODAY &&
  S.period('day', TODAY).prevKeys[0] === K_YEST &&
  S.period('day', TODAY).chartKeys.length === 7);
const pw = S.period('week', TODAY);
check('period(week)：周一起 7 天、上一期为上周 7 天',
  pw.keys.length === 7 && pw.keys[0] === S.dateKeyOf(S.mondayOf(TODAY)) && pw.prevKeys.length === 7);
const pm = S.period('month', TODAY);
check('period(month)：覆盖当月每一天且图表按天展开',
  pm.keys.length === new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0).getDate() &&
  pm.chartKeys.length === pm.keys.length);

check('summarize：本期总时长与打卡天数',
  S.summarize(stats, [K_YEST, K_TODAY]).totalMs === 70 * MIN &&
  S.summarize(stats, [K_YEST, K_TODAY]).checkinDays === 1);
check('summarize：按书筛选只计入该书',
  S.summarize(stats, [K_YEST], 'b2').totalMs === 10 * MIN &&
  S.summarize(stats, [K_YEST], 'b1').totalMs === 35 * MIN);
check('summarize：日均按周期天数而非有阅读天数计算',
  Math.round(S.summarize(stats, [K_OLD, K_YEST, K_TODAY]).avgMs / MIN) === 30);
check('summarize：bestDay 指向读得最多的那天',
  S.summarize(stats, [K_OLD, K_YEST, K_TODAY]).bestDay === K_YEST);

// 用户明确诉求：「看不出来这本书什么日期开始看，每天看了多少分钟」
const h1 = S.bookHistory(stats, 'b1');
check('bookHistory：首读日期是历史里最早有记录的一天', h1.first === K_OLD, { first: h1.first });
check('bookHistory：末次阅读日期 / 累计天数 / 总时长正确',
  h1.last === K_TODAY && h1.days === 3 && h1.totalMs === 80 * MIN);
check('bookHistory：逐日分钟可用于 sparkline 与每日明细',
  h1.perDay[K_OLD] === 20 * MIN && h1.perDay[K_YEST] === 35 * MIN && h1.perDay[K_TODAY] === 25 * MIN);
check('bookHistory：从未读过的书返回全零且不编造日期',
  S.bookHistory(stats, 'nope').first === null && S.bookHistory(stats, 'nope').totalMs === 0);
check('dayMs：单书 / 全书两种口径',
  S.dayMs(stats, K_YEST) === 45 * MIN && S.dayMs(stats, K_YEST, 'b2') === 10 * MIN &&
  S.dayMs(stats, '2999-01-01') === 0);
check('hasAnyReading：空数据不误报', !S.hasAnyReading({}) && S.hasAnyReading(stats));
check('streak：连续天数只算连续段，不会被 9 天前的记录拉长',
  S.streak(stats, TODAY) === 2, { streak: S.streak(stats, TODAY) });
check('streak：今天还没读时从昨天起算，不误判断签',
  S.streak({ [K_YEST]: { byBook: { b1: 10 * MIN } } }, TODAY) === 1);
check('deltaText：有上一期才给环比，无上一期返回 null',
  S.deltaText(25 * MIN, 45 * MIN).up === -1 &&
  S.deltaText(25 * MIN, 45 * MIN).text.includes('少 20 分钟') &&
  S.deltaText(25 * MIN, 0) === null);
const hm = S.heatmapKeys(TODAY, 12);
check('heatmapKeys：12 周 84 格，未来日期标 future、今天不标',
  hm.length === 84 && !!hm.find((x) => x.key === K_TODAY) &&
  !hm.find((x) => x.key === K_TODAY).future &&
  hm.filter((x) => x.future).every((x) => x.key > K_TODAY));
check('levelOf：0 / 15 / 30 / 60 分钟四级色阶',
  [0, 10 * MIN, 20 * MIN, 45 * MIN, 70 * MIN].map(S.levelOf).join(',') === '0,1,2,3,4');
check('fmtDuration：分钟 / 小时 / 整点',
  S.fmtDuration(25 * MIN) === '25 分钟' && S.fmtDuration(90 * MIN) === '1 小时 30 分' &&
  S.fmtDuration(120 * MIN) === '2 小时');
check('fmtChineseDate：可读中文日期', /\d{4} 年 \d{1,2} 月 \d{1,2} 日/.test(S.fmtChineseDate(K_TODAY)));
check('sparkKeys：近 14 天且末位是今天',
  S.sparkKeys(TODAY, 14).length === 14 && S.sparkKeys(TODAY, 14)[13] === K_TODAY);
check('parseKey / addDays / mondayOf 跨月不漂移',
  S.dateKeyOf(S.addDays(new Date(2026, 0, 31), 1)) === '2026-02-01' &&
  S.dateKeyOf(S.mondayOf(new Date(2026, 2, 1))) === '2026-02-23');

/* ================= ② 源码级接线 ================= */
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/stats.css'), 'utf8');
check('SW 缓存版本不低于 v12 且保留增量缓存的上一版指针',
  (() => { const m = sw.match(/const CACHE = 'inkreader-v(\d+)'/); return !!m && Number(m[1]) >= 12; })() &&
  /const PREV_CACHE = 'inkreader-v\d+'/.test(sw));
check('SW ASSETS 补齐 stats.css / stats.js（离线首启不白屏）',
  /'css\/stats\.css'/.test(sw) && /'js\/stats\.js'/.test(sw));
check('index.html 引入 stats.css 并挂载 #stats-root',
  /css\/stats\.css/.test(html) && /id="stats-root"/.test(html));
check('旧版三行 ss-* DOM 已从 HTML 移除',
  !/id="ss-total"/.test(html) && !/id="stats-booklist"/.test(html));
check('app.js 不再引用已删除的 ss-* / stats-booklist 节点',
  !/\$\('ss-total'\)/.test(app) && !/\$\('stats-booklist'\)/.test(app));
check('app.js 挂载统计仪表盘且 renderStats 只做委托',
  /createStatsLayer\(\)/.test(app) && /mountStatsDashboard\(/.test(app) &&
  /if \(statsDashboard\) statsDashboard\.render\(mode \|\| 'day'\)/.test(app));
check('app.js init 顺序：Pro → Plus → Stats → 事件绑定',
  /createProLayer\(\);\s*\n\s*createPlusLayer\(\);\s*\n\s*createStatsLayer\(\);/.test(app));
check('统计页进入时重置日/周/月高亮，避免状态谎言',
  /t\.classList\.toggle\('active', t\.dataset\.statsTab === 'day'\)/.test(app));
check('stats.css 图例五级色阶齐全（不会全灰）',
  /\.st-legend \.st-lv4/.test(css) && /\.st-legend \.st-lv0/.test(css));
check('stats.css 零动画（遵守墨水屏原则）', !/animation|transition\s*:/.test(css));

// 目录 ↔ 当前章一致性
check('目录：chapterLabel 统一编号，空标题有兜底',
  /function chapterLabel\(i\)/.test(app) && /padStart\(2, '0'\)/.test(app) && /第 \$\{i \+ 1\} 节/.test(app));
check('目录：buildToc 给每项写 data-ci 与 aria-current',
  /d\.dataset\.ci = String\(i\)/.test(app) && /setAttribute\('aria-current', 'true'\)/.test(app));
check('目录：syncTocActive 只同步状态、不重建整表',
  /function syncTocActive\(scroll\)/.test(app) && /scrollIntoView/.test(app) && /aria-current/.test(app));
check('目录：每次翻页后同步高亮（修复跨章对不上）',
  /function afterPageTurn/.test(app) && /syncTocActive\(false\)/.test(app));
check('目录：打开目录时把当前章滚进可视区',
  /if \(id === 'panel-toc'\) syncTocActive\(true\)/.test(app));
check('目录：阅读页标题与目录项用同一个 label',
  (app.match(/\$\('chapter-title'\)\.textContent = chapterLabel\(ci\)/g) || []).length >= 3);

/* ================= ③ 真实 App 集成 ================= */
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 892 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/favicon/i.test(t) || /favicon/i.test((m.location() || {}).url || '')) return;
  errors.push('CONSOLE: ' + t);
});
page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) {} });
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('inkreader:pro-guide-v1', '1');
    sessionStorage.setItem('sw-reloaded', '1');
  } catch (e) {}
});

const injectData = async (withStats) => {
  await page.evaluate(async ({ statsData }) => {
    const s = JSON.parse(localStorage.getItem('inkreader:settings') || '{}');
    s.theme = 'ink'; s.pageFlip = false;
    localStorage.setItem('inkreader:settings', JSON.stringify(s));
    localStorage.setItem('inkreader:stats-titles', JSON.stringify({ b1: '测试书·上卷', b2: '测试书·下卷' }));
    // 三章短文本书：每章 1 页，便于真实翻页跨章
    const { putBook } = await import('/js/store.js');
    await putBook({
      id: 'b1', title: '测试书·上卷', author: '回归测试', category: '其他',
      source: 'txt', addedAt: Date.now(), chaptersCount: 3,
      chapters: [
        { title: '第一章', html: '<p>第一章正文，用于验证目录高亮与当前章是否一致。</p>' },
        { title: '第二章', html: '<p>第二章正文，用于验证跨章翻页后目录自动跟随。</p>' },
        { title: '第三章', html: '<p>第三章正文，用于验证点击目录跳章后状态统一。</p>' },
      ],
    });
    localStorage.setItem('inkreader:progress', JSON.stringify({ b1: { ci: 0, pi: 0, pct: 0 } }));
    // 必须最后写：上一阶段可能仍开着阅读器，每秒的阅读计时会 addReadingTime 回写 stats，
    // 放在这里覆盖才能保证「零数据」用例真的是零数据。
    localStorage.setItem('inkreader:stats', JSON.stringify(statsData));
  }, { statsData: withStats ? stats : {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(600);
};

const openStats = async () => {
  await page.evaluate(() => {
    const t = document.querySelector('#tabbar .tab[data-view="stats"]');
    if (t) t.click();
  });
  await sleep(350);
};

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(700);
  check('App 启动无致命报错（stats.js 已进入模块图）', errors.length === 0, { errors });
  check('统计仪表盘已挂载并生成 DOM',
    await page.evaluate(() => !!document.getElementById('st-hero-val') && !!window.__INK_STATS));

  await injectData(true);
  await openStats();

  const dash = await page.evaluate(() => ({
    hero: (document.getElementById('st-hero-val') || {}).textContent || '',
    period: (document.getElementById('st-period') || {}).textContent || '',
    emptyHidden: document.getElementById('st-empty').classList.contains('hidden'),
    contentHidden: document.getElementById('st-content').classList.contains('hidden'),
    bars: document.querySelectorAll('#st-bars .st-bar').length,
    todayNum: (document.querySelector('#st-bars .st-bar.today .st-bar-num') || {}).textContent || '',
    todayLabel: (document.querySelector('#st-bars .st-bar.today') || {}).getAttribute?.('aria-label') || '',
    cells: document.querySelectorAll('#st-heat .st-cell').length,
    futureCells: document.querySelectorAll('#st-heat .st-cell.st-lvfuture').length,
    books: document.querySelectorAll('#st-books .st-book').length,
    booksText: (document.getElementById('st-books') || {}).textContent || '',
    chips: document.querySelectorAll('#st-chips .st-chip').length,
    streak: (document.getElementById('st-streak') || {}).textContent || '',
    active: (document.getElementById('st-active') || {}).textContent || '',
    delta: (document.getElementById('st-hero-delta') || {}).textContent || '',
    activeTab: (document.querySelector('.stats-tab.active') || {}).dataset?.statsTab || '',
  }));
  check('统计页主指标直接显示本期分钟数', dash.hero.includes('25 分钟'), { hero: dash.hero });
  check('统计页明确显示周期（今天）', /今天/.test(dash.period), { period: dash.period });
  check('有数据时展示内容、隐藏空状态', !dash.contentHidden && dash.emptyHidden);
  check('每日柱状图渲染最近 7 天', dash.bars === 7, { bars: dash.bars });
  check('柱状图今天这根标出「25 分钟」', dash.todayNum === '25' && /25 分钟/.test(dash.todayLabel),
    { num: dash.todayNum, label: dash.todayLabel });
  check('12 周热力图 84 格且今天不标成未来', dash.cells === 84 &&
    await page.evaluate((k) => {
      const c = document.querySelector(`#st-heat .st-cell[data-date="${k}"]`);
      return !!c && !c.classList.contains('st-lvfuture');
    }, K_TODAY), { cells: dash.cells, future: dash.futureCells });
  check('按书明细展示「开始于 + 首读日期」',
    dash.books >= 1 && /开始于/.test(dash.booksText) && dash.booksText.includes(K_OLD),
    { text: dash.booksText.slice(0, 220) });
  check('按书明细展示累计天数 / 累计时长 / 本期时长',
    /共 3 天/.test(dash.booksText) && /1 小时 20 分/.test(dash.booksText) && /25 分钟/.test(dash.booksText));
  check('按书明细带近 14 天 sparkline',
    await page.evaluate(() => document.querySelectorAll('#st-books .st-spark i').length === 14));
  check('书籍筛选 chip 覆盖历史里出现过的两本书', dash.chips === 3, { chips: dash.chips });
  check('连续阅读 / 有阅读天数 / 环比均有值',
    dash.streak.includes('2 天') && /\d+ 天/.test(dash.active) && dash.delta.length > 0,
    { streak: dash.streak, active: dash.active, delta: dash.delta });
  check('从 Tab 进入统计页时高亮回到「日」', dash.activeTab === 'day');

  // 点柱子 → 当天读了哪些书
  await page.evaluate(() => {
    const g = document.querySelector('#st-bars .st-bar.today');
    if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(150);
  check('点柱子显示当天明细（日期 + 书名 + 分钟）',
    await page.evaluate(() => {
      const t = document.getElementById('st-day-detail').textContent;
      return /年/.test(t) && /测试书·上卷/.test(t) && /25 分钟/.test(t);
    }));
  check('被选中的柱子有 picked 标记',
    await page.evaluate(() => !!document.querySelector('#st-bars .st-bar.today.picked')));

  // 按书筛选
  await page.evaluate(() => {
    const c = document.querySelector('#st-chips .st-chip[data-book="b2"]');
    if (c) c.click();
  });
  await sleep(150);
  check('按书筛选后主指标标题切到该书名',
    await page.evaluate(() => /《测试书·下卷》/.test(document.getElementById('st-hero-label').textContent)));
  check('按书筛选后本期归零（这本书今天没读）',
    await page.evaluate(() => document.getElementById('st-hero-val').textContent === '0 分钟'));
  await page.evaluate(() => {
    const c = document.querySelector('#st-chips .st-chip[data-book=""]');
    if (c) c.click();
  });

  // 周 / 月切换
  await page.evaluate(() => document.querySelector('.stats-tab[data-stats-tab="week"]').click());
  await sleep(150);
  check('切到「周」：周期文案与按钮高亮同步',
    await page.evaluate(() => /本周/.test(document.getElementById('st-period').textContent) &&
      document.querySelector('.stats-tab.active').dataset.statsTab === 'week'));
  await page.evaluate(() => document.querySelector('.stats-tab[data-stats-tab="month"]').click());
  await sleep(150);
  check('切到「月」：图表按当月天数展开',
    await page.evaluate((days) => document.querySelectorAll('#st-bars .st-bar').length === days,
      new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0).getDate()));
  check('统计仪表盘 state() 与 UI 的 mode 一致',
    await page.evaluate(() => window.__INK_STATS.state().mode === 'month'));

  // 点热力格 → 当天明细
  await page.evaluate(() => {
    const c = document.querySelector('#st-heat .st-cell:not(.st-lvfuture)[data-date]');
    if (c) c.click();
  });
  await sleep(120);
  check('点热力格可选中日期并刷新明细',
    await page.evaluate(() => !!window.__INK_STATS.state().selectedDay));

  // 点书卡 → 回到原文（统计页到阅读器的导航闭环）
  await openStats(); // 先回到「日」，保证按书卡片有本期数据
  await page.evaluate(() => {
    const c = document.querySelector('#st-books .st-book');
    if (c) c.click();
  });
  await sleep(700);
  check('点「按书看」卡片可直接跳回该书原文',
    await page.evaluate(() => {
      const r = document.getElementById('reader');
      return !!r && !r.classList.contains('hidden');
    }));

  /* ---------- 目录 ↔ 当前章一致性（用户报的问题） ---------- */
  const tocState = await page.evaluate(() => {
    const active = document.querySelector('#toc-list .toc-item.active');
    return {
      title: document.getElementById('chapter-title').textContent,
      activeText: active ? active.textContent : '',
      activeCi: active ? active.dataset.ci : '',
      items: document.querySelectorAll('#toc-list .toc-item').length,
      aria: active ? active.getAttribute('aria-current') : '',
    };
  });
  check('打开书时阅读页标题与目录高亮项文字完全一致',
    tocState.title === tocState.activeText && tocState.title === '01 · 第一章',
    tocState);
  check('目录项带 data-ci 与 aria-current',
    tocState.activeCi === '0' && tocState.aria === 'true' && tocState.items === 3);

  // 点击第 3 章
  await page.evaluate(() => {
    const items = document.querySelectorAll('#toc-list .toc-item');
    if (items[2]) items[2].click();
  });
  await sleep(450);
  const afterJump = await page.evaluate(() => {
    const active = document.querySelector('#toc-list .toc-item.active');
    return {
      title: document.getElementById('chapter-title').textContent,
      activeText: active ? active.textContent : '',
      activeCi: active ? active.dataset.ci : '',
      activeCount: document.querySelectorAll('#toc-list .toc-item.active').length,
    };
  });
  check('点击目录跳章后标题 / 高亮 / data-ci 三者一致',
    afterJump.title === '03 · 第三章' && afterJump.activeText === '03 · 第三章' &&
    afterJump.activeCi === '2' && afterJump.activeCount === 1, afterJump);

  // 回到第 1 章，用真实翻页跨章，验证 afterPageTurn 同步
  await page.evaluate(() => {
    const items = document.querySelectorAll('#toc-list .toc-item');
    if (items[0]) items[0].click();
  });
  await sleep(450);
  let turned = false;
  for (let i = 0; i < 6 && !turned; i++) {
    await page.evaluate(() => {
      const b = document.getElementById('btn-next');
      if (b) b.click();
    });
    await sleep(320);
    turned = await page.evaluate(() =>
      document.getElementById('chapter-title').textContent !== '01 · 第一章');
  }
  check('真实翻页可以跨到下一章', turned, { turned });
  if (turned) {
    const afterTurn = await page.evaluate(() => {
      const active = document.querySelector('#toc-list .toc-item.active');
      return {
        title: document.getElementById('chapter-title').textContent,
        activeText: active ? active.textContent : '',
        activeCount: document.querySelectorAll('#toc-list .toc-item.active').length,
      };
    });
    check('跨章翻页后目录高亮自动跟随（核心修复点）',
      afterTurn.title === afterTurn.activeText && afterTurn.activeCount === 1, afterTurn);
  }

  // 打开目录面板时当前章应在可视区
  await page.evaluate(() => document.getElementById('btn-toc').click());
  await sleep(200);
  check('打开目录面板时当前章位于可视区',
    await page.evaluate(() => {
      const a = document.querySelector('#toc-list .toc-item.active');
      if (!a) return false;
      const r = a.getBoundingClientRect();
      return r.top >= -2 && r.bottom <= window.innerHeight + 2;
    }));

  /* ---------- 空状态 ---------- */
  await injectData(false);
  await openStats();
  check('零阅读记录时显示空状态而不是编造数据',
    await page.evaluate(() => !document.getElementById('st-empty').classList.contains('hidden') &&
      document.getElementById('st-content').classList.contains('hidden')));
  check('空状态文案直接回答「哪天开始看 / 每天多少分钟」',
    await page.evaluate(() => {
      const t = document.getElementById('st-empty').textContent;
      return t.includes('哪天开始看') && t.includes('每天读了多少分钟');
    }));
  check('空状态提供「去书架」CTA',
    await page.evaluate(() => !!document.getElementById('st-go-shelf')));

  check('全流程无未捕获异常 / console error', errors.length === 0, { errors });
} catch (e) {
  check('测试执行未抛异常', false, { error: String(e && e.stack || e) });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.pass);
results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  ' + JSON.stringify(r.extra || {})}`));
console.log(`\nstats: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
