// 标注 / 收藏语句 / 「我的」汇总页 的端到端回归测试（内存合成 EPUB，不依赖本机书籍）
// 运行：npm run test:marks
// 覆盖：真实文字选区 -> 标注高亮与持久化 -> 收藏 -> 刷新后还原 -> 点高亮删除/转收藏
//       -> 底部「我的」按书汇总、类型筛选、跳回原文、删除条目
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fflate = require('../www/js/vendor/fflate.js');
const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

const HL_TEXT = '水杉阅读的第一句值得标注的话';
const FAV_TEXT = '第二句普通正文';
const BOOK_TITLE = '标注收藏测试样本';
const files = {
  'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  'OEBPS/content.opf': `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${BOOK_TITLE}</dc:title><dc:creator>regression</dc:creator></metadata>
<manifest>
<item id="c1" href="Text/chapter1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
  'OEBPS/Text/chapter1.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>第一章</h1>
<p>${HL_TEXT}，后面还有一段普通正文用来占位。这一段文字足够长以便分页器正常工作，并且不会把整章压成单字页面。${FAV_TEXT}继续补充内容，让整章稳定落在第一页。</p>
</body></html>`,
  'OEBPS/Text/chapter2.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>第二章</h1>
<p>第二章里另一句普通的正文，用来验证切换章节与跳回原文时不会串页。</p>
</body></html>`,
};
const zipInput = {};
for (const [k, v] of Object.entries(files)) zipInput[k] = fflate.strToU8(v);
const tmpEpub = path.join(os.tmpdir(), 'inkreader-marks-regression.epub');
fs.writeFileSync(tmpEpub, Buffer.from(fflate.zipSync(zipInput, { level: 0 })));

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

const browser = await puppeteer.launch({
  executablePath: (process.env.INK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [], dialogs = [], results = [];
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 412, height: 892 });
await page.evaluateOnNewDocument(() => {
  try {
    const s = JSON.parse(localStorage.getItem('inkreader:settings') || '{}');
    s.pageFlip = false;
    localStorage.setItem('inkreader:settings', JSON.stringify(s));
  } catch (e) {}
  // 测试环境禁用「SW 接管后自动刷新」，否则会与打开阅读器的时机撞车
  try { sessionStorage.setItem('sw-reloaded', '1'); } catch (e) {}
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('CONSOLE: ' + m.text());
});
page.on('dialog', async (d) => { dialogs.push(d.message()); try { await d.dismiss(); } catch (e) {} });

function step(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
}

async function selectText(text) {
  const ok = await page.evaluate((t) => {
    const root = document.querySelector('#page');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.nodeValue.indexOf(t);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + t.length);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, text);
  await wait(140);
  return ok;
}
async function clickSel(id) {
  await page.evaluate((i) => document.querySelector(i).click(), id);
  await wait(160);
}
async function storage() {
  return page.evaluate(() => ({
    hl: JSON.parse(localStorage.getItem('inkreader:highlights') || '{}'),
    fv: JSON.parse(localStorage.getItem('inkreader:favorites') || '{}'),
  }));
}
async function marks() {
  return page.evaluate(() => Array.from(document.querySelectorAll('#page mark.ink-hl')).map((m) => m.textContent));
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__INK_INIT_DONE === true, { timeout: 15000 });
  const input = await page.$('#file-epub');
  await input.uploadFile(tmpEpub);
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 1, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('.book-card').click());
  await page.waitForFunction(() => {
    const r = document.querySelector('#reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 15000 });

  // —— 1) 选中工具条出现且可标注 ——
  const sel1 = await selectText(HL_TEXT);
  const barState = await page.evaluate(() => ({
    visible: !document.querySelector('#sel-bar').classList.contains('hidden'),
    label: document.querySelector('#sel-highlight').textContent,
    hasFav: !!document.querySelector('#sel-favorite'),
  }));
  step('选中文字后工具条显示标注/收藏', sel1 && barState.visible && barState.hasFav && barState.label === '标注', barState);

  await clickSel('#sel-highlight');
  const m1 = await marks();
  const s1 = await storage();
  const hlCount = Object.values(s1.hl).reduce((a, b) => a + b.length, 0);
  step('标注写入正文高亮并持久化', m1.length === 1 && m1[0] === HL_TEXT && hlCount === 1,
    { marks: m1, hlCount });

  // —— 2) 收藏语句（不产生高亮） ——
  const sel2 = await selectText(FAV_TEXT);
  await clickSel('#sel-favorite');
  const s2 = await storage();
  const favTexts = Object.values(s2.fv).flat().map((x) => x.text);
  const m2 = await marks();
  step('收藏语句入库且不改正文', sel2 && favTexts.length === 1 && favTexts[0] === FAV_TEXT && m2.length === 1,
    { favTexts, marks: m2.length });

  // —— 3) 刷新重进后高亮自动还原 ——
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__INK_INIT_DONE === true, { timeout: 15000 });
  await wait(200);
  await page.evaluate(() => document.querySelector('.book-card').click());
  await page.waitForFunction(() => {
    const r = document.querySelector('#reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 15000 });
  const m3 = await marks();
  step('刷新重进后标注自动还原', m3.length === 1 && m3[0] === HL_TEXT, { marks: m3 });

  // —— 4) 点高亮 -> 弹层（收藏这句 / 删除标注） ——
  await page.evaluate(() => document.querySelector('#page mark.ink-hl').dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true })));
  await wait(150);
  const popState = await page.evaluate(() => ({
    visible: !document.querySelector('#hl-pop').classList.contains('hidden'),
    text: document.querySelector('#hl-text').textContent,
  }));
  step('点击高亮弹出标注操作层', popState.visible && popState.text === HL_TEXT, popState);
  await clickSel('#hl-fav');
  const s4 = await storage();
  step('弹层里可把标注句转为收藏',
    Object.values(s4.fv).flat().some((x) => x.text === HL_TEXT),
    { favorites: Object.values(s4.fv).flat().map((x) => x.text) });

  await page.evaluate(() => document.querySelector('#page mark.ink-hl').dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true })));
  await wait(150);
  await clickSel('#hl-del');
  const m5 = await marks();
  const s5 = await storage();
  step('弹层里删除标注后高亮消失',
    m5.length === 0 && Object.values(s5.hl).reduce((a, b) => a + b.length, 0) === 0,
    { marks: m5 });

  // —— 5) 「我的」页按书汇总 / 筛选 / 删除 / 跳回原文 ——
  await page.evaluate(() => document.querySelector('#tabbar .tab[data-view="mine"]').click());
  await wait(400);
  const mine = await page.evaluate(() => ({
    viewVisible: !document.querySelector('#view-mine').classList.contains('hidden'),
    books: document.querySelectorAll('.mine-book').length,
    title: (document.querySelector('.mine-book-title') || {}).textContent || '',
    items: Array.from(document.querySelectorAll('.mine-item')).map((x) => ({
      type: x.className.includes('mine-fav') ? 'favorite' : 'highlight',
      text: (x.querySelector('.mine-text') || {}).textContent || '',
    })),
    summary: (document.querySelector('#mine-summary') || {}).textContent || '',
  }));
  step('我的页面按书汇总两类记录',
    mine.viewVisible && mine.books === 1 && mine.title === BOOK_TITLE && mine.items.length === 2 &&
    mine.items.every((i) => i.type === 'favorite'),
    mine);

  await page.evaluate(() => document.querySelector('[data-mine-tab="highlight"]').click());
  await wait(250);
  const emptyAfterFilter = await page.evaluate(() => ({
    items: document.querySelectorAll('.mine-item').length,
    empty: !!document.querySelector('#mine-list .empty-tip'),
  }));
  step('筛选「标注」时正确显示空态', emptyAfterFilter.items === 0 && emptyAfterFilter.empty, emptyAfterFilter);

  await page.evaluate(() => document.querySelector('[data-mine-tab="all"]').click());
  await wait(250);
  await page.evaluate(() => document.querySelector('.mine-item [data-act="jump"]').click());
  await wait(500);
  const jumped = await page.evaluate(() => ({
    reader: !document.querySelector('#reader').classList.contains('hidden'),
    mineHidden: document.querySelector('#view-mine').classList.contains('hidden'),
    progress: (document.querySelector('#progress') || {}).textContent || '',
  }));
  step('「跳到原文」可打开阅读器并收起我的页面',
    jumped.reader && jumped.mineHidden && /第1\//.test(jumped.progress), jumped);

  await page.evaluate(() => document.querySelector('#tabbar .tab[data-view="mine"]').click());
  await wait(350);
  await page.evaluate(() => document.querySelector('.mine-item [data-act="del"]').click());
  await wait(250);
  const afterDel = await page.evaluate(() => document.querySelectorAll('.mine-item').length);
  const s6 = await storage();
  step('删除条目后列表与存储同步',
    afterDel === 1 && Object.values(s6.fv).flat().length === 1,
    { items: afterDel, favorites: Object.values(s6.fv).flat().length });
} catch (e) {
  step('FATAL', false, e.message);
}

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({
  results,
  summary: { total: results.length, failed: failed.length, errors, dialogs }
}, null, 1));
await ctx.close();
await browser.close();
server.close();
try { fs.unlinkSync(tmpEpub); } catch (e) {}
process.exit(failed.length === 0 && errors.length === 0 && dialogs.length === 0 ? 0 : 1);
