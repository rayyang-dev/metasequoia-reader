// 书架页截图（改前/改后对照用）：起静态服务托管 www，用手机视口渲染空书架 + 带书书架
// 用法: node scripts/shot_shelf.mjs <tag>   → screenshots/shelf_<tag>_empty.png / _books.png
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = fileURLToPath(new URL('../www', import.meta.url));
const OUT = fileURLToPath(new URL('../screenshots', import.meta.url));
const TAG = process.argv[2] || 'x';
const PORT = 5199;
const CHROME = process.env.INK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json',
  '.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const fp = normalize(join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const data = await readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });

const books = [
  { id:'shot-1', title:'示例书·手记', author:'佚名', source:'txt', addedAt:Date.now()-2000,
    ai:{tags:['随笔']}, chapters:[{title:'第一章 起',html:'<p>这是一段示例正文，用于展示阅读与翻页效果。</p>'}] },
  { id:'shot-2', title:'深入浅出推荐系统', author:'佚名', source:'txt', addedAt:Date.now()-1000,
    ai:{tags:['技术']}, chapters:[{title:'第1章 前世今生',html:'<p>推荐系统是一类信息过滤系统。</p>'}] },
];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  defaultViewport:{ width:390, height:844, deviceScaleFactor:2, hasTouch:true, isMobile:true },
  args:['--no-sandbox','--hide-scrollbars'],
});
const BASE = 'http://localhost:' + PORT + '/';
const errors = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 空书架
{
  const p = await browser.newPage();
  p.on('pageerror', e => errors.push('empty:' + e));
  await p.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await p.goto(BASE, { waitUntil:'networkidle0' });
  await sleep(350);
  await p.screenshot({ path: join(OUT, `shelf_${TAG}_empty.png`) });
  const box = await p.$eval('.shelf-head', el => { const r = el.getBoundingClientRect(); return {w:r.width,h:r.height,top:r.top}; }).catch(()=>null);
  console.log('empty shelf-head rect:', JSON.stringify(box));
  console.log('brand-mark present:', (await p.$('.brand-mark')) !== null);
  await p.close();
}

// 带书书架
{
  const p = await browser.newPage();
  p.on('pageerror', e => errors.push('books:' + e));
  await p.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await p.goto(BASE, { waitUntil:'networkidle0' });
  await p.evaluate(async (bs) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('inkreader', 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('books')) db.createObjectStore('books',{keyPath:'id'}); };
      req.onsuccess = () => { const tx = req.result.transaction('books','readwrite'); bs.forEach(b=>tx.objectStore('books').put(b)); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); };
      req.onerror = () => reject(req.error);
    });
  }, books);
  await p.goto(BASE, { waitUntil:'networkidle0' });
  await sleep(400);
  await p.screenshot({ path: join(OUT, `shelf_${TAG}_books.png`) });
  await p.close();
}

await browser.close();
server.close();
console.log('JS errors:', errors.length ? errors.join(' | ') : 'none');
console.log('outputs:', `screenshots/shelf_${TAG}_empty.png`, `screenshots/shelf_${TAG}_books.png`);
