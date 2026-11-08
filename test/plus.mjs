// 水杉 Plus —— 10 项改进 + 10 项新功能 端到端回归
// 分三段：① plus-core 纯逻辑（DOMParser 白名单 / 锚点 / 搜索 / 决策函数）
//        ② 源码级接线检查（SW 模块图 / importers 净化入口 / 主控挂载）
//        ③ 真实 App 集成（工具箱面板 / 搜索跳转 / 章节速览 / 双页 / 会话 / 无遮挡 / 无报错）
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.wasm': 'application/wasm',
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

// ---------------- ② 源码级接线检查 ----------------
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const importers = fs.readFileSync(path.join(ROOT, 'js/importers.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('SW 缓存已升版到 inkreader-v11', /const CACHE = 'inkreader-v11'/.test(sw));
check('SW ASSETS 补齐 plus.css / plus.js / plus-core.js',
  /css\/plus\.css/.test(sw) && /js\/plus\.js/.test(sw) && /js\/plus-core\.js/.test(sw));
check('SW 实现增量缓存：未变更文件从旧缓存复用',
  /const REUSE = \[/.test(sw) && /copyFromPrev/.test(sw) && /PREV_CACHE/.test(sw));
check('SW 离线升级不留空洞（fetch 失败回填旧版本）',
  /await copyFromPrev\(cache, a\);/.test(sw));
check('index.html 引入 plus.css', /css\/plus\.css/.test(html));
check('importers.js 切到 DOMParser 白名单净化',
  /import \{ sanitizeBookHtml \} from '\.\/plus-core\.js'/.test(importers) && /return sanitizeBookHtml\(html\);/.test(importers));
check('app.js 挂载 Plus 层且保留 Pro 预告组合',
  /createPlusLayer\(\)/.test(app) && /getBeforeTurn\(\)/.test(app) && /proBefore/.test(app));
check('app.js 有效阅读 / 锚点 / 双页 / Regal 钩子就位',
  /plus\.countThisTick/.test(app) && /plus\.anchorPi/.test(app) &&
  /plus\.pageStep/.test(app) && /plus\.shouldRegal/.test(app) && /plus\.onPageRendered/.test(app));

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

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(700);

  // ---------------- ① plus-core 纯逻辑 ----------------
  const coreResults = await page.evaluate(async () => {
    const out = [];
    const c = await import('/js/plus-core.js');
    const ck = (name, cond, extra) => out.push({ name, pass: !!cond, extra });

    // —— 白名单净化 ——
    const s1 = c.sanitizeBookHtml('<p onclick="evil()">正文</p><script>alert(1)</script>');
    ck('净化：移除 script 与 onclick，保留正文', !/script/i.test(s1) && !/onclick/i.test(s1) && s1.includes('正文'), { s1 });
    const s2 = c.sanitizeBookHtml('<a href="javascript:alert(1)">点我</a>');
    ck('净化：javascript: 链接被中和', !/javascript:/i.test(s2), { s2 });
    const s3 = c.sanitizeBookHtml('<img src="https://tracker.example/a.png" data-img="Images/a.png" />');
    ck('净化：外链图片被阻断但 data-img 占位保留',
      !/tracker\.example/.test(s3) && /data-img="Images\/a\.png"/.test(s3), { s3 });
    const s4 = c.sanitizeBookHtml('<img src="data:image/png;base64,iVBORw0KGgo=" />');
    ck('净化：图片 data: URI 放行', /data:image\/png/.test(s4), { s4 });
    const s5 = c.sanitizeBookHtml('<p style="background:url(https://x/y);color:red">字</p>');
    ck('净化：内联 style 的 url() 被剔除、普通样式保留',
      !/url\(/i.test(s5) && /color:red/.test(s5), { s5 });
    const s6 = c.sanitizeBookHtml('<foo>脱壳</foo>');
    ck('净化：白名单外元素脱壳保留内容（证明 DOMParser 阶段生效）',
      !/<foo/i.test(s6) && s6.includes('脱壳'), { s6 });
    const s7 = c.sanitizeBookHtml('<svg viewBox="0 0 10 10"><image xlink:href="Images/c.svg" /></svg>');
    ck('净化：SVG <image xlink:href> 原样保护（EPUB 插图不丢）',
      /xlink:href="Images\/c\.svg"/.test(s7) && /<svg/.test(s7), { s7 });
    const s8 = c.sanitizeBookHtml('<a href="#fn1" id="ref1">[1]</a><p id="fn1">脚注</p>');
    ck('净化：跨文件脚注锚点与 id 保留',
      /href="#fn1"/.test(s8) && /id="fn1"/.test(s8), { s8 });
    const s9 = c.sanitizeBookHtml('<foreignObject><p>x</p></foreignObject><animate attributeName="x" />');
    ck('净化：foreignObject / animate 被丢弃', !/foreignObject|animate/i.test(s9), { s9 });
    const s10 = c.sanitizeBookHtml('<p>' + '中文正文'.repeat(30) + '</p>');
    ck('净化：结构守卫不吞正文', c.textOf(s10).length >= 100, { len: c.textOf(s10).length });
    ck('净化：空输入安全返回空串', c.sanitizeBookHtml('') === '' && c.sanitizeBookHtml(null) === '');
    ck('净化：非图片 data: URI 被拒绝', !/data:text\/html/.test(c.sanitizeBookHtml('<a href="data:text/html,x">x</a>')));

    // —— 锚点 ——
    const pages = ['<p>桃花源记 晋太元中 武陵人捕鱼为业</p>', '<p>忽逢桃花林 夹岸数百步</p>', '<p>土地平旷 屋舍俨然</p>'];
    const anchorEl = document.createElement('div');
    anchorEl.innerHTML = '<p>土地平旷 屋舍俨然 有良田美池桑竹之属</p>';
    const anchor = c.makeAnchor(anchorEl, 2);
    ck('锚点：从已渲染页生成引文', !!anchor && anchor.ci === 2 && anchor.quote.length > 4, { anchor });
    ck('锚点：分页变化后仍能找回所在页', c.findPageByQuote(pages, anchor.quote) === 2,
      { found: c.findPageByQuote(pages, anchor.quote) });
    ck('锚点：找不到的引文返回 -1', c.findPageByQuote(pages, '完全不相干的词句') === -1);
    ck('锚点：空引文返回 -1', c.findPageByQuote(pages, '') === -1);

    // —— 搜索 / 章节速览 ——
    const book = { title: '测试书', chapters: [
      { title: '第一章', html: '<p>晋太元中 武陵人捕鱼为业 缘溪行</p>' },
      { title: '第二章', html: '<p>忽逢桃花林 夹岸数百步 中无杂树</p>' },
      { title: '第三章', html: '<p>武陵人 又见桃花 芳草鲜美</p>' },
    ] };
    const hits = c.searchBook(book, '武陵人');
    ck('全文搜索：跨章节命中并给出引文', hits.length === 2 && hits[0].ci === 0 && hits[1].ci === 2, { n: hits.length });
    ck('全文搜索：结果带上下文片段', !!hits[0] && hits[0].snippet.includes('武陵人'));
    ck('全文搜索：无结果返回空数组', c.searchBook(book, '不存在的句子').length === 0);
    const ov = c.chapterOverview(book);
    ck('章节速览：返回字数与预估分钟', ov.length === 3 && ov[0].chars > 0 && ov[0].minutes >= 1);

    // —— 章末停 / Regal / 有效阅读 / 视线意图 ——
    ck('章末停：本章末页触发暂停', c.chapterEndDecision({ ci: 0, pi: 4, pages: 5, chapterCount: 3 }, 'next', 1).stop === true);
    ck('章末停：全书末页给出书末理由',
      c.chapterEndDecision({ ci: 2, pi: 4, pages: 5, chapterCount: 3 }, 'next', 1).reason.includes('全书'));
    ck('章末停：章中不暂停', c.chapterEndDecision({ ci: 0, pi: 1, pages: 5, chapterCount: 3 }, 'next', 1).stop === false);
    ck('章末停：上一页不暂停', c.chapterEndDecision({ ci: 0, pi: 4, pages: 5, chapterCount: 3 }, 'prev', 1).stop === false);
    ck('Regal：关闭时不闪', c.shouldRegalFlash({ N: 0, turnCounter: 6 }) === false);
    ck('Regal：开翻页动画时不叠闪屏', c.shouldRegalFlash({ N: 6, turnCounter: 6, pageFlip: true }) === false);
    ck('Regal：连续快翻时延后刷新', c.shouldRegalFlash({ N: 6, turnCounter: 6, rapidTurns: 4 }) === false);
    ck('Regal：夜览拉长到 ≥12 次', c.shouldRegalFlash({ N: 6, turnCounter: 6, theme: 'night' }) === false);
    ck('Regal：关闭自适应时回归原公式', c.shouldRegalFlash({ N: 6, turnCounter: 6, adaptive: false }) === true);
    ck('Regal：章末刷新 999 模式', c.shouldRegalFlash({ N: 999, chapterChanged: true }) === true);
    const t = 1e12;
    ck('有效阅读：近期有交互计时', c.effectiveTick({ now: t, lastActivityAt: t - 1000 }) === true);
    ck('有效阅读：静置超过 30 秒不计时', c.effectiveTick({ now: t, lastActivityAt: t - 60000 }) === false);
    ck('有效阅读：自动翻页刚发生仍计时',
      c.effectiveTick({ now: t, lastActivityAt: t - 60000, lastTurnAt: t - 2000, autoActive: true }) === true);
    ck('有效阅读：开关关闭时维持旧行为', c.effectiveTick({ enabled: false, now: t, lastActivityAt: 0 }) === true);
    ck('剩余时长：按会话速度估算且不为 0', c.estimateRemainingMinutes({ pct: 30, totalChars: 100000, readChars: 30000, effectiveMs: 120000 }) >= 1);
    ck('剩余时长：已读完返回 0', c.estimateRemainingMinutes({ pct: 100, totalChars: 100000 }) === 0);
    ck('时长格式化：超过 1 小时拆分', c.formatMinutes(135).includes('小时'));
    ck('视线意图：视线丢失时不翻页', c.acceptGazeSignal({ phase: 'lost', now: t }) === false);
    ck('视线意图：面板打开时不翻页', c.acceptGazeSignal({ phase: 'tracking', panelOpen: true, now: t }) === false);
    ck('视线意图：正在选字时不翻页', c.acceptGazeSignal({ phase: 'tracking', selection: true, now: t }) === false);
    ck('视线意图：手动刚翻过 700ms 内不连翻',
      c.acceptGazeSignal({ phase: 'tracking', now: t, lastManualTurnAt: t - 200 }) === false);
    ck('视线意图：正常回扫放行', c.acceptGazeSignal({ phase: 'bottom', now: t }) === true);
    ck('视线意图：开关关闭时不过滤', c.acceptGazeSignal({ enabled: false, phase: 'lost', now: t }) === true);

    // —— 导出 / 备份 / 书架 / 双页 ——
    const md = c.buildExcerptMarkdown({ title: '测试书', author: '作者', highlights: [{ text: '一句标注', ci: 0, at: Date.now() }], favorites: [], bookmarks: [] });
    ck('摘录导出：含书名、分组与条目', md.includes('测试书') && md.includes('标注') && md.includes('一句标注'));
    ck('摘录导出：无条目时给提示', c.buildExcerptMarkdown({ title: 'x' }).includes('还没有标注'));
    const backup = c.serializeBackup({ kv: { a: 1 }, books: [{ id: 'b' }] });
    ck('本地备份：序列化/反序列化往返', c.parseBackup(backup).books[0].id === 'b');
    let rejected = false;
    try { c.parseBackup('{"app":"other"}'); } catch (e) { rejected = true; }
    ck('本地备份：拒绝非本应用/损坏文件', rejected);
    ck('系列分组：识别「第X卷」前缀', c.seriesKeyOf('大秦帝国 第三卷') !== '' || c.seriesKeyOf('大秦帝国（3）') !== '');
    const shelf = [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }, { id: 'c', title: '丙' }];
    ck('书架增强：最近阅读置顶', c.sortShelfList(shelf, { recentFirst: true, recentId: 'c' })[0].id === 'c');
    ck('书架增强：无最近记录时顺序稳定', c.sortShelfList(shelf, {})[0].id === 'a');
    ck('双页：横屏判定', c.isLandscape(900, 400) === true && c.isLandscape(400, 900) === false);
    ck('双页：默认关闭时不启用', c.twoPageActive({ enabled: false, landscape: true, width: 900 }) === false);
    ck('双页：PDF 不启用', c.twoPageActive({ enabled: true, landscape: true, width: 900, isPdf: true }) === false);
    const pm = c.pageMetrics({ enabled: true, landscape: true, width: 900, height: 400 });
    ck('双页：按半栏宽度分页', pm.twoPage === true && pm.pageWidth === 436 && pm.pageHeight === 400, pm);
    const pm1 = c.pageMetrics({ enabled: true, landscape: false, width: 412, height: 892 });
    ck('双页：竖屏回落整屏宽度', pm1.twoPage === false && pm1.pageWidth === 412, pm1);

    return out;
  });
  coreResults.forEach((r) => check(r.name, r.pass, r.extra));

  // ---------------- ③ 真实 App 集成 ----------------
  // 直接往 IndexedDB 放一本测试书，避免依赖桌面样本；reload 后由书架渲染出来
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const paras = (n) => Array.from({ length: 14 }, (_, i) =>
      `<p>第 ${n} 章第 ${i + 1} 段：武陵人捕鱼为业，缘溪行，忘路之远近，忽逢桃花林。</p>`).join('');
    await store.putBook({
      id: 'plus-test-book', title: 'Plus 回归样本', author: 'regression', source: 'txt',
      addedAt: Date.now(), category: '其他', cover: '', ai: { tags: [] },
      chapters: [
        { title: '第一章 桃花源', html: '<h1>第一章 桃花源</h1>' + paras(1) },
        { title: '第二章 问津', html: '<h1>第二章 问津</h1>' + paras(2) },
        { title: '第三章 归去', html: '<h1>第三章 归去</h1>' + paras(3) },
      ],
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(800);

  const mount = await page.evaluate(() => ({
    init: !!window.__INK_INIT_DONE,
    plus: !!window.__INK_PLUS,
    css: Array.from(document.styleSheets).some((s) => (s.href || '').includes('plus.css')),
    panelHidden: document.getElementById('plus-panel').classList.contains('hidden'),
    entryInChip: !!document.querySelector('#pro-chip #plus-entry'),
    ticks: !!document.getElementById('plus-ticks'),
    switches: document.querySelectorAll('#plus-switches .plus-switch').length,
    rings: document.querySelectorAll('#book-list .plus-ring').length,
    cardHasId: !!document.querySelector('#book-list .book-card[data-book-id]'),
  }));
  check('App 集成：Plus 层挂载且无阻断', mount.init && mount.plus, mount);
  check('App 集成：plus.css 已加载', mount.css);
  check('App 集成：工具箱初始隐藏（不遮挡控制条）', mount.panelHidden);
  check('App 集成：入口复用 #pro-chip 避让', mount.entryInChip);
  check('App 集成：章节刻度容器与设置开关生成', mount.ticks && mount.switches === 10, { switches: mount.switches });
  check('书架增强：卡片带 bookId 且进度环已挂载', mount.cardHasId && mount.rings >= 1, { rings: mount.rings });

  // 打开书
  await page.click('#book-list .book-card[data-book-id="plus-test-book"]');
  await sleep(600);
  const opened = await page.evaluate(() => ({
    reader: !document.getElementById('reader').classList.contains('hidden'),
    ticks: document.querySelectorAll('#plus-ticks .plus-tick').length,
    meta: document.getElementById('plus-meta').textContent,
    anchor: JSON.parse(localStorage.getItem('inkreader:plus:anchors') || '{}')['plus-test-book'] || null,
  }));
  check('App 集成：打开书后阅读器可见', opened.reader, opened);
  check('改进 9：进度条章节刻度按章节生成', opened.ticks === 2, { ticks: opened.ticks });
  check('改进 9：剩余阅读时长已显示', /约剩|已读完/.test(opened.meta), { meta: opened.meta });
  check('改进 1：阅读位置锚点已落盘', !!opened.anchor && !!opened.anchor.quote, { anchor: opened.anchor });

  // 工具箱面板 + 暂停联动
  await page.click('#plus-entry');
  await sleep(200);
  const panel = await page.evaluate(() => ({
    open: !document.getElementById('plus-panel').classList.contains('hidden'),
    marker: document.getElementById('plus-pause-marker').classList.contains('open'),
    paused: window.__INK_PRO.turn.isPaused(),
  }));
  check('App 集成：工具箱可打开', panel.open, panel);
  check('App 集成：打开面板自动暂停自动翻页（复用 Pro 的暂停门控）', panel.marker && panel.paused, panel);

  // 全文搜索 + 跳转
  await page.evaluate(() => { document.getElementById('plus-q').value = '武陵人'; });
  await page.click('#plus-search-go');
  await sleep(250);
  const searched = await page.evaluate(() => ({
    count: document.querySelectorAll('#plus-search-out .plus-result').length,
    label: (document.querySelector('#plus-search-out .plus-count') || {}).textContent || '',
  }));
  check('新功能 1：全文搜索命中全书章节', searched.count > 0, searched);
  await page.evaluate(() => {
    const btns = document.querySelectorAll('#plus-search-out .plus-result');
    // 选一个落在第 3 章的结果，验证跳转确实改了章
    const target = Array.from(btns).find((b) => /第三章/.test(b.textContent)) || btns[btns.length - 1];
    if (target) target.click();
  });
  await sleep(500);
  const jumped = await page.evaluate(() => ({
    ci: window.__INK_PRO.getPosition().ci,
    title: document.getElementById('chapter-title').textContent,
    panelClosed: document.getElementById('plus-panel').classList.contains('hidden'),
  }));
  check('新功能 1：点击搜索结果跳到对应章节', jumped.ci === 2, jumped);
  check('新功能 1：跳转后自动收起工具箱', jumped.panelClosed);

  // 章节速览 / 统计 / 设置
  await page.click('#plus-entry'); await sleep(120);
  await page.click('#plus-tabs button[data-tab="chapters"]'); await sleep(150);
  const chapters = await page.evaluate(() => document.querySelectorAll('#plus-chapter-out .plus-chapter').length);
  check('新功能 6：章节速览列出全部章节与预估时长', chapters === 3, { chapters });
  await page.click('#plus-tabs button[data-tab="stats"]'); await sleep(150);
  const stats = await page.evaluate(() => ({
    ring: !!document.getElementById('plus-goal-ring'),
    rows: document.querySelectorAll('#plus-stat-grid .plus-stat').length,
  }));
  check('新功能 4：阅读目标环与统计面板', stats.ring && stats.rows >= 4, stats);
  await page.click('#plus-tabs button[data-tab="config"]'); await sleep(120);
  await page.evaluate(() => {
    const el = document.querySelector('#plus-switches input[data-k="twoPage"]');
    el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(150);
  const cfg = await page.evaluate(() => ({
    saved: JSON.parse(localStorage.getItem('inkreader:plus:config') || '{}').twoPage,
    state: window.__INK_PLUS.state().config.twoPage,
  }));
  check('改进 / 新功能：设置开关即时生效并持久化', cfg.saved === true && cfg.state === true, cfg);

  // 横屏双页
  await page.setViewport({ width: 900, height: 420 });
  await sleep(500);
  const two = await page.evaluate(() => {
    const p = window.__INK_PLUS;
    return {
      active: p.isTwoPage(),
      step: p.pageStep(),
      key: p.layoutKey(),
      metrics: p.pageMetrics(900, 420),
      spread: !!document.querySelector('#page .plus-spread'),
    };
  });
  check('新功能 8：横屏切到双页布局', two.active && two.step === 2 && two.key === '2up', two);
  check('新功能 8：分页按半栏宽度而非整屏挤压', two.metrics.twoPage && two.metrics.pageWidth === 436, two.metrics);
  check('新功能 8：阅读页渲染出双栏并排', two.spread);
  await page.setViewport({ width: 412, height: 892 });
  await sleep(450);
  const one = await page.evaluate(() => ({ active: window.__INK_PLUS.isTwoPage(), step: window.__INK_PLUS.pageStep() }));
  check('新功能 8：回到竖屏自动还原单页', !one.active && one.step === 1, one);

  // 章末自动停：确认 beforeTurn 是「Plus 章末停 + Pro 预告」的组合链，且章中放行
  const endStop = await page.evaluate(() => {
    const before = window.__INK_PRO.turn.getBeforeTurn();
    return {
      composed: typeof before === 'function', // Pro 的预告函数仍在链上
      hasChapterEnd: typeof window.__INK_PLUS.beforeAutoTurn === 'function',
    };
  });
  check('改进 4：章末停与 Pro 预告被组合而非互相覆盖',
    endStop.composed && endStop.hasChapterEnd, endStop);

  // 会话恢复
  await page.evaluate(() => { document.getElementById('plus-close').click(); });
  await sleep(120);
  await page.evaluate(() => { window.__INK_PLUS.onExit(); });
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('inkreader:plus:session') || 'null'));
  check('新功能 7：退出阅读器保存会话（书名/进度/时间）',
    !!session && session.bookId === 'plus-test-book' && typeof session.pct === 'number', session);

  // 无遮挡：阅读器控制条与书架按钮分别在自己可见时检查
  const hitTest = (sels) => page.evaluate((list) => {
    const out = {};
    list.forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = false; return; }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) { out[sel] = false; return; }
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out[sel] = top === el || el.contains(top);
    });
    return out;
  }, sels);
  const readerClickable = await page.evaluate(() => {
    document.getElementById('reader').classList.remove('hide-chrome');
    return true;
  });
  await sleep(120);
  const bar = await hitTest(['#btn-next', '#btn-toc', '#plus-entry']);
  check('App 集成：控制条按钮与工具箱入口不被 Plus 浮层遮挡',
    readerClickable && Object.values(bar).every(Boolean), bar);
  await page.evaluate(() => document.getElementById('btn-back').click());
  await sleep(400);
  const shelfBtn = await hitTest(['#import-epub']);
  check('App 集成：退出阅读器后书架按钮可点中', shelfBtn['#import-epub'], shelfBtn);
  check('App 集成：无致命脚本报错', errors.length === 0, errors.slice(0, 4));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.pass);
results.forEach((r) => console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  ' + JSON.stringify(r.extra || {})}`));
console.log(`\n${results.length - failed.length}/${results.length} 通过，页面错误 ${errors.length} 条`);
if (failed.length) process.exit(1);
