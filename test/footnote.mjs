// 脚注回归测试（不依赖本机真实 EPUB）：在内存里合成一本 EPUB，覆盖真实书籍里踩过的坑：
//   ① 跨文件脚注 ../Text/chapter2.xhtml#m28 —— 不拦截就会让 WebView 跳到不存在的本地文件 → 白屏
//   ② m28 / w28 在不同章节重复 —— 必须按 href 的目标文件名锁定对应注释，不能全书取第一个
//   ③ 同文件 #m1 脚注、多看式图片脚注（注释文本在 <li class="duokan-footnote-item"> 里）
//   ④ 旧书兼容：删掉 chapters[].src（模拟升级前已导入的书），仍要能定位到正确注释
// 运行：npm run test:footnote
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

// ---------- 合成 EPUB ----------
const NOTE_TEXT_1 = '这是第一章的第28条注释， Operation Mongoose 备忘录。';
const NOTE_TEXT_2 = '这是第二章的第28条注释，与第一章编号相同但内容不同。';
const SAME_FILE_TEXT = '同文件脚注文本，注释就写在本章末尾。';
const IMG_NOTE_TEXT = '图片式标记的注释文本，来自多看式 li 容器。';
const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64'
); // 合法的 1x1 透明 PNG（仅用于验证 img 标记与内联，不参与断言）
const files = {
  'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  'OEBPS/content.opf': `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>脚注回归测试样本</dc:title><dc:creator>regression</dc:creator></metadata>
<manifest>
<item id="c1" href="Text/chapter1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml"/>
<item id="c3" href="Text/chapter3.xhtml" media-type="application/xhtml+xml"/>
<item id="c4" href="Text/chapter4.xhtml" media-type="application/xhtml+xml"/>
<item id="png" href="Images/note.png" media-type="image/png"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/><itemref idref="c4"/></spine>
</package>`,
  'OEBPS/Text/chapter1.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>第一章</h1>
<p>正文里有一处跨文件脚注<a id="w28" href="../Text/chapter2.xhtml#m28"><span class="note">[28]</span></a>，
还有一处同文件脚注<a id="w1" href="#m1">[1]</a>，以及一个图片式脚注<a class="duokan-footnote" href="#img-note"><img alt="注释" src="../Images/note.png"/></a>。
这一段有足够多的文字，保证分页器不会把整章压成一个空页，从而能真实还原手机上的点击路径。</p>
<p class="footnote"><a id="m1" href="#w1">[1]</a> ${SAME_FILE_TEXT}</p>
<ol class="duokan-footnote-content"><li class="duokan-footnote-item" id="img-note"><p class="footnote-text"><a class="duokan-footnote-link" href="#img-back">${IMG_NOTE_TEXT}</a></p></li></ol>
</body></html>`,
  'OEBPS/Text/chapter2.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章注释</h1>
<p class="footnote"><a id="m28" href="../Text/chapter1.xhtml#w28">[28]</a> ${NOTE_TEXT_1}</p>
</body></html>`,
  'OEBPS/Text/chapter3.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1>
<p>第二章故意复用同样的编号，用来验证不会串到第一章的注释上<a id="w28" href="../Text/chapter4.xhtml#m28"><span class="note">[28]</span></a>。
这里补充一段正文，让脚注标记稳定落在第一页，方便测试直接点击真实 DOM 元素。</p>
</body></html>`,
  'OEBPS/Text/chapter4.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章注释</h1>
<p class="footnote"><a id="m28" href="../Text/chapter3.xhtml#w28">[28]</a> ${NOTE_TEXT_2}</p>
</body></html>`,
};
const zipInput = {};
for (const [k, v] of Object.entries(files)) zipInput[k] = fflate.strToU8(v);
zipInput['OEBPS/Images/note.png'] = new Uint8Array(png1x1);
const epubBuf = Buffer.from(fflate.zipSync(zipInput, { level: 0 }));
const tmpEpub = path.join(os.tmpdir(), 'inkreader-footnote-regression.epub');
fs.writeFileSync(tmpEpub, epubBuf);

// ---------- 静态服务 ----------
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
const errors = [], navs = [], results = [];
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 412, height: 892 });
await page.evaluateOnNewDocument(() => {
  try {
    const s = JSON.parse(localStorage.getItem('inkreader:settings') || '{}');
    s.pageFlip = false;
    localStorage.setItem('inkreader:settings', JSON.stringify(s));
  } catch (e) {}
  // 测试环境禁用「SW 接管后自动刷新」，避免 reload 竞态导致 detached frame
  try { sessionStorage.setItem('sw-reloaded', '1'); } catch (e) {}
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('CONSOLE: ' + m.text());
});
page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) {} });
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });

async function gotoChapter(i) {
  await page.evaluate((idx) => {
    const items = document.querySelectorAll('#toc-list .toc-item');
    if (items[idx]) items[idx].click();
  }, i);
  await wait(300);
}
async function tapMarker(selector, expected, name) {
  const click = await page.evaluate((sel) => {
    const pg = document.querySelector('#page');
    const el = pg && pg.querySelector(sel);
    if (!el) return { found: false };
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return { found: true, prevented: ev.defaultPrevented, href: el.getAttribute('href') || '' };
  }, selector);
  await wait(180);
  const state = await page.evaluate(() => {
    const pop = document.querySelector('#footnote-pop');
    return {
      visible: !!pop && !pop.classList.contains('hidden'),
      text: (document.querySelector('#footnote-text') || {}).textContent || '',
      pageLen: (document.querySelector('#page') || { innerText: '' }).innerText.trim().length,
      hasPage: !!document.querySelector('#page'),
      url: location.href
    };
  });
  const pass = click.found && click.prevented && state.visible && state.url === BASE &&
    state.hasPage && state.pageLen > 20 && (state.text || '').includes(expected) &&
    !/本书未找到/.test(state.text || '');
  results.push({ name, expected, got: (state.text || '').slice(0, 80), click, ...state, pass });
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(600);
  const input = await page.$('#file-epub');
  await input.uploadFile(tmpEpub);
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 1, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('.book-card').click());
  await page.waitForFunction(() => {
    const r = document.querySelector('#reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 15000 });

  // —— 新导入（章节带 src，精确按文件名定位）——
  await gotoChapter(0);
  await tapMarker('a[href$="#m28"], .fn-marker[data-fn="28"]', NOTE_TEXT_1.slice(0, 10), '新导入-第一章跨文件[28]');
  await tapMarker('a[href="#m1"]', SAME_FILE_TEXT.slice(0, 8), '新导入-同文件[1]');
  await tapMarker('a.duokan-footnote[href="#img-note"]', IMG_NOTE_TEXT.slice(0, 8), '新导入-图片式标记');
  await gotoChapter(2);
  await tapMarker('a[href$="#m28"], .fn-marker[data-fn="28"]', NOTE_TEXT_2.slice(0, 10), '新导入-第二章同编号[28]（不串注）');

  // —— 旧书兼容（删掉 src，模拟升级前已导入的书）——
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('inkreader', 1);
    req.onerror = () => reject(new Error('idb open'));
    req.onsuccess = () => {
      const tx = req.result.transaction('books', 'readwrite');
      const st = tx.objectStore('books');
      const g = st.getAll();
      g.onsuccess = () => (g.result || []).forEach((b) => {
        (b.chapters || []).forEach((c) => { delete c.src; });
        st.put(b);
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(new Error('idb put'));
    };
  }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__INK_INIT_DONE === true, { timeout: 15000 });
  await wait(200);
  await page.evaluate(() => document.querySelector('.book-card').click());
  await page.waitForFunction(() => {
    const r = document.querySelector('#reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 15000 });
  await gotoChapter(0);
  await tapMarker('a[href$="#m28"], .fn-marker[data-fn="28"]', NOTE_TEXT_1.slice(0, 10), '旧书-第一章跨文件[28]');
  await gotoChapter(2);
  await tapMarker('a[href$="#m28"], .fn-marker[data-fn="28"]', NOTE_TEXT_2.slice(0, 10), '旧书-第二章同编号[28]（不串注）');
} catch (e) {
  results.push({ name: 'FATAL', pass: false, error: e.message });
}

const failed = results.filter((r) => !r.pass);
const summary = { total: results.length, failed: failed.length, errors, navigations: navs.filter((u) => u !== BASE) };
console.log(JSON.stringify({ results, summary }, null, 1));
await ctx.close();
await browser.close();
server.close();
try { fs.unlinkSync(tmpEpub); } catch (e) {}
process.exit(failed.length === 0 && errors.length === 0 && summary.navigations.length === 0 ? 0 : 1);
