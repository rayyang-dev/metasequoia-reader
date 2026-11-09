// 红杉 Sequoia — 真实页面截图（puppeteer-core 版，替代原 Playwright 脚本）
// 启动本地静态服务器托管 www → 注入种子书/统计/设置 → 逐页导航并截图到 docs/screenshots/
// 运行：node test/regen-screenshots.mjs
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = fileURLToPath(new URL('../www', import.meta.url));
const OUT = fileURLToPath(new URL('../docs/screenshots', import.meta.url));
const PORT = 5188;
const CHROME = (process.env.INK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const fp = normalize(join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const data = await readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });
console.log('静态服务器已启动: http://localhost:' + PORT);

const book1 = {
  id: 'builtin-sample-shouji', title: '示例书·手记', author: '佚名', source: 'txt',
  addedAt: Date.now() - 2000,
  chapters: [
    { title: '第一章 起', html: '<p>这是一段示例正文，用于展示阅读与翻页效果。</p><p>第二段内容继续展开。</p>' },
    { title: '第二章 承', html: '<p>翻过一页，故事仍在继续。</p>' },
  ],
  ai: { tags: ['小说', '随笔'] },
};
const book2 = {
  id: 'seed-2', title: '深入浅出推荐系统', author: '佚名', source: 'txt',
  addedAt: Date.now() - 1000,
  chapters: [
    { title: '第1章 推荐系统的前世今生', html: '<p>推荐系统是一类信息过滤系统。</p><p>它试图预测用户对物品的偏好。</p>' },
    { title: '第2章 协同过滤', html: '<p>协同过滤分为基于用户与基于物品两类。</p>' },
  ],
  ai: { tags: ['技术', '工具'] },
};

async function seedIDB(page) {
  await page.evaluate(async (books) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('inkreader', 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' }); };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('books', 'readwrite');
        const st = tx.objectStore('books');
        books.forEach((b) => st.put(b));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, [book1, book2]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function exists(page, sel) { return (await page.$(sel)) !== null; }
async function clickSel(page, sel) { const el = await page.$(sel); if (el) { await el.click(); return true; } return false; }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  args: ['--no-sandbox', '--hide-scrollbars'],
});
const BASE = 'http://localhost:' + PORT + '/';
const errors = [];

// ---------- 场景 A：空书架 ----------
console.log('\n=== 场景 A：空书架 ===');
const pA = await browser.newPage();
pA.on('pageerror', (e) => errors.push('A:' + e));
await pA.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
await pA.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(400);
console.log('  空书架空状态可见:', await exists(pA, '#shelf-empty'));
console.log('  书籍卡片数:', await pA.$$eval('.book-card', (els) => els.length).catch(() => 0));
await pA.screenshot({ path: join(OUT, '01-shelf-empty.png') });
await pA.close();

// ---------- 场景 B：带书 + 分组 + 各面板 ----------
console.log('\n=== 场景 B：书架 / 阅读 / 设置 / AI / 统计 ===');
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push('B:' + e));
await page.evaluateOnNewDocument(() => {
  const q = new URLSearchParams(location.search);
  const ls = window.localStorage;
  if (!ls.getItem('inkreader:stats')) {
    const d = new Date();
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    ls.setItem('inkreader:stats', JSON.stringify({
      [k]: { byBook: { 'builtin-sample-shouji': 35 * 60000, 'seed-2': 18 * 60000 }, checkin: true, checkinAt: Date.now() },
    }));
  }
  const settings = JSON.parse(ls.getItem('inkreader:settings') || '{}');
  settings.shelfGroupByTag = q.get('group') === '1';
  if (typeof settings.checkinGoalMin !== 'number') settings.checkinGoalMin = 10;
  ls.setItem('inkreader:settings', JSON.stringify(settings));
});

await page.goto(BASE, { waitUntil: 'networkidle0' });
await seedIDB(page);

// B1 平铺书架
await page.goto(BASE + '?group=0', { waitUntil: 'networkidle0' });
await sleep(400);
console.log('  平铺卡片数:', await page.$$eval('.book-card', (els) => els.length).catch(() => 0));
console.log('  标签筛选条:', await page.$$eval('#tag-filter .tag-chip', (e) => e.length).catch(() => 0));
await page.screenshot({ path: join(OUT, '02-shelf-flat.png') });

// B2 分组书架
await page.goto(BASE + '?group=1', { waitUntil: 'networkidle0' });
await sleep(400);
console.log('  分组头数:', await page.$$eval('.group-header', (e) => e.length).catch(() => 0));
await page.screenshot({ path: join(OUT, '03-shelf-grouped.png') });

// B3 阅读器
await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(300);
const firstCard = await page.$('.book-card');
if (firstCard) { await firstCard.click({ offset: { x: 12, y: 12 } }); }
await sleep(500);
console.log('  阅读器可见:', await exists(page, '#reader'));
const pv = await page.$('#page-viewport');
if (pv) { await pv.click({ offset: { x: 195, y: 400 } }); }
await sleep(200);
await page.screenshot({ path: join(OUT, '03-reader.png') });

// B4 AI 面板
const btnAi = await page.$('#btn-ai');
if (btnAi) { await btnAi.click(); await sleep(300); }
console.log('  AI 面板打开:', await exists(page, '#panel-ai.open'));
await page.screenshot({ path: join(OUT, '05-ai-panel.png') });
await clickSel(page, '#panel-ai .panel-close');
await sleep(150);

// 返回书架
await clickSel(page, '#btn-back');
await sleep(300);

// B5 设置页
await clickSel(page, '#tabbar .tab[data-view="settings"]');
await sleep(300);
console.log('  设置页可见:', await exists(page, '#view-settings'));
console.log('  皮肤色板数:', await page.$$eval('#theme-swatches .swatch', (e) => e.length).catch(() => 0));
const sb = await page.$('#view-settings .settings-body');
if (sb) { await page.evaluate(() => { const el = document.querySelector('#view-settings .settings-body'); if (el) el.scrollTop = 0; }); }
await sleep(120);
await page.screenshot({ path: join(OUT, '04-settings.png') });
if (sb) { await page.evaluate(() => { const el = document.querySelector('#view-settings .settings-body'); if (el) el.scrollTop = el.scrollHeight; }); }
await sleep(150);
await page.screenshot({ path: join(OUT, '04b-settings-ai.png') });

// B6 统计页（日）
await clickSel(page, '#tabbar .tab[data-view="stats"]');
await sleep(300);
console.log('  统计页可见:', await exists(page, '#view-stats'));
await page.screenshot({ path: join(OUT, '06-stats-day.png') });

// B7 统计页（周）
await clickSel(page, '.stats-tab[data-stats-tab="week"]');
await sleep(200);
await page.screenshot({ path: join(OUT, '07-stats-week.png') });

await page.close();
await browser.close();
server.close();
console.log('\nJS 运行时错误:', errors.length ? errors.join(' | ') : '无');
console.log('截图输出目录: ' + OUT);
