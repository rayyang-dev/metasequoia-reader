// 水杉 Metasequoia —— headless 冒烟测试（puppeteer-core + 系统 Chrome）
// 用途：每次改动后跑一遍，作为“打包前闸门”，验证：
//   ① app.js 正常加载、无致命报错（按钮接线正常）
//   ② 书架按钮可点中（不被遮挡）
//   ③ 导入 EPUB 后阅读器打开、封面/图片内联（无裂图）
//   ④ 控制条按钮（翻页/目录）可点中
//   ⑤ 连续翻页后按钮仍可被点中、且能翻到正文页（分页正常）
// 说明：Capacitor 原生能力（返回键/退出）在纯浏览器不存在属正常；app.js 已对 window.Capacitor 容错，不产生阻断报错。
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fflate = require('../www/js/vendor/fflate.js');

// 冒烟测试不再硬依赖某台电脑桌面上的书：找不到样本书时，用 fflate 在内存里
// 合成一本最小 EPUB（含一张图片 + 足够文字），保证在任意机器上都能跑。
function ensureSampleEpub() {
  const preferred = 'C:/Users/杨睿/Desktop/雍正帝：中国的独裁君主.epub';
  if (fs.existsSync(preferred)) return preferred;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
    'base64'
  );
  const body = Array.from({ length: 12 }, (_, i) =>
    `<p>这是冒烟测试用的第 ${i + 1} 段正文，用来验证分页引擎能够在真实屏幕尺寸下切出有内容的页面，并确保连续翻页之后控制条按钮依然可以被正常点中。</p>`
  ).join('');
  const files = {
    'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    'OEBPS/content.opf': `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>冒烟测试样本</dc:title><dc:creator>regression</dc:creator></metadata>
<manifest>
<item id="c1" href="Text/chapter1.xhtml" media-type="application/xhtml+xml"/>
<item id="png" href="Images/cover.png" media-type="image/png"/>
</manifest>
<spine><itemref idref="c1"/></spine>
</package>`,
    'OEBPS/Text/chapter1.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1>
<img src="../Images/cover.png" alt="封面" />${body}</body></html>`,
  };
  const input = {};
  for (const [k, v] of Object.entries(files)) input[k] = fflate.strToU8(v);
  input['OEBPS/Images/cover.png'] = new Uint8Array(png);
  const out = path.join(os.tmpdir(), 'inkreader-smoke-sample.epub');
  fs.writeFileSync(out, Buffer.from(fflate.zipSync(input, { level: 0 })));
  return out;
}

const ROOT = path.resolve('www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon'
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
const port = server.address().port;
const BASE = `http://localhost:${port}/`;
console.log('static server:', BASE);

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 892 }); // 手机尺寸

const errors = [];
const dialogs = [];
page.on('console', (m) => {
  if (m.type() === 'error') {
    const txt = m.text();
    const loc = m.location();
    const url = (loc && loc.url) || '';
    if (/favicon\.ico/i.test(url) || /favicon/i.test(txt)) return; // 良性噪音
    errors.push('CONSOLE: ' + txt);
  }
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));
page.on('dialog', async (d) => { dialogs.push(d.message()); try { await d.dismiss(); } catch (e) {} });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function clickableReport(sel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, exists: false };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { sel, exists: true, visible: false, w: 0, h: 0 };
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const covered = !(top === el || el.contains(top));
    return { sel, exists: true, visible: true, w: Math.round(r.width), h: Math.round(r.height), covered,
      coveredBy: covered && top ? (top.id || top.className || top.tagName) : null };
  }, sel);
}
// 点 page-viewport 中央以唤出/收起控制条；点右侧翻下一页
async function tapViewport(where) {
  await page.evaluate((where) => {
    const vp = document.querySelector('#page-viewport');
    if (!vp) return;
    const r = vp.getBoundingClientRect();
    let x = r.left + r.width / 2;
    if (where === 'right') x = r.left + r.width * 0.85;
    if (where === 'left') x = r.left + r.width * 0.15;
    vp.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: r.top + r.height / 2 }));
  }, where);
}

const report = { steps: [] };
const EPUB = ensureSampleEpub();
try {
  // —— 1) 加载 ——
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(800);

  // 切到简约主题并开启翻页动画，持久化后重载。
  // 修正：真实 key 是 inkreader:settings（带冒号）；旧写法用 inkreader-settings 导致
  // 主题从未切换、pageFlip 也从未开启，「水平滑动翻页」用例实际是空跑。
  await page.evaluate(() => {
    try {
      const k = 'inkreader:settings';
      const s = JSON.parse(localStorage.getItem(k) || '{}');
      s.theme = 'simple'; s.pageFlip = true;
      localStorage.setItem(k, JSON.stringify(s));
    } catch (e) {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await wait(800);

  // —— 2) 书架按钮可点中 ——
  const shelf = await clickableReport('#import-epub');
  report.steps.push({ name: '书架 #import-epub 可点中', ...shelf, pass: shelf.exists && shelf.visible && !shelf.covered });

  // —— 3) 导入《雍正帝》EPUB ——
  const input = await page.$('#file-epub');
  if (!input) throw new Error('#file-epub 输入控件不存在');
  await input.uploadFile(EPUB);
  // 等待书架出现该书（导入完成）
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 1, { timeout: 25000 }).catch(() => {});
  // 点击该书卡打开阅读器
  await page.evaluate(() => { const c = document.querySelector('#shelf .book-card') || document.querySelector('.book-card'); if (c) c.click(); });
  await page.waitForFunction(() => { const r = document.querySelector('#reader'); return !!r && !r.classList.contains('hidden'); }, { timeout: 15000 }).catch(() => {});
  const readerOpen = await page.evaluate(() => { const r = document.querySelector('#reader'); return !!r && !r.classList.contains('hidden'); });
  const imgState = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('#page img, #page image')];
    const inlined = imgs.filter((i) => {
      const a = i.getAttribute('src') || i.getAttribute('href') || i.getAttribute('xlink:href') || '';
      return /^(data:|blob:)/i.test(a);
    }).length;
    return { total: imgs.length, inlined };
  });
  // 首次进入阅读器会弹出一次性引导（全屏），按真实用户操作关掉，
  // 否则后面「控制条按钮是否被遮挡」的检查会被引导层挡住。
  await page.evaluate(() => {
    const g = document.getElementById('pro-guide');
    const ok = document.getElementById('pro-guide-ok');
    if (g && ok && g.classList.contains('pro-on')) ok.click();
  });
  await wait(150);
  report.steps.push({
    name: '导入EPUB-阅读器打开且图片内联',
    readerOpen, ...imgState, dialogs: dialogs.length,
    pass: readerOpen && imgState.total > 0 && imgState.inlined === imgState.total && dialogs.length === 0
  });

  // —— 4) 点中央唤出控制条，检查控制条按钮可点中 ——
  await tapViewport('center');
  await wait(300);
  const btnNext = await clickableReport('#btn-next');
  const btnToc = await clickableReport('#btn-toc');
  report.steps.push({ name: '控制条 #btn-next 可点中', ...btnNext, pass: btnNext.exists && btnNext.visible && !btnNext.covered });
  report.steps.push({ name: '控制条 #btn-toc 可点中', ...btnToc, pass: btnToc.exists && btnToc.visible && !btnToc.covered });

  // —— 5) 连续翻页：翻到正文页（验证分页有文字）+ 按钮持续可点中 ——
  let foundText = false;
  for (let i = 0; i < 6; i++) {
    const t = await page.evaluate(() => { const p = document.querySelector('#page'); return p ? p.innerText.trim().length : 0; });
    if (t > 50) { foundText = true; break; }
    await tapViewport('right');
    await wait(450);
  }
  // 最后再确认按钮仍可被点中。新版状态机里「控制条显示时点中间」是收起，
  // 因此按当前状态决定是否唤出，而不是无脑再点一次中间。
  const chromeHidden = await page.evaluate(() => document.getElementById('reader').classList.contains('hide-chrome'));
  if (chromeHidden) { await tapViewport('center'); await wait(300); }
  const btnNext2 = await clickableReport('#btn-next');
  report.steps.push({ name: '翻页至正文页（分页有文字）', foundText, pass: foundText });
  report.steps.push({ name: '连续翻页后 #btn-next 可点中', ...btnNext2, pass: btnNext2.exists && btnNext2.visible && !btnNext2.covered });
} catch (e) {
  report.fatal = e.message;
}

report.errors = errors;
report.dialogs = dialogs;
const failed = report.steps.filter((s) => s.pass === false).length;
report.summary = { total: report.steps.length, failed, errors: errors.length, dialogs: dialogs.length };
console.log('\n==== 测试结果 ====');
console.log(JSON.stringify(report, null, 2));

await browser.close();
server.close();
process.exit(report.summary.failed === 0 && report.summary.errors === 0 && report.summary.dialogs === 0 && !report.fatal ? 0 : 1);
