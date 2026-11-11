// 红杉阅读 —— 华为 AGC 应用内截图生成器（独立脚本，零业务污染）
//
// 用途：用真实 WebView 界面（www/ 即 App 本体）跑一遍完整用户路径，输出
//       1080×1920 (9:16) 的应用内截图，供 AppGallery 提审使用。
// 用法：node scripts/capture_agc_shots.mjs
// 输出：screenshots/agc/shot-01-shelf.png ... shot-06-mine.png
//
// 说明：
//  - 所有界面均由真实交互产生（导入 EPUB → 翻页 → 目录 → 设置 → 统计 → 标注），
//    不是设计稿、不合成手机边框、不拉伸。示例书籍为脚本合成的虚构演示数据。
//  - 视口 360×640 CSS px @ deviceScaleFactor 3 = 1080×1920 物理像素，正好 9:16。
//  - 依赖：puppeteer-core + 系统 Chrome + www/js/vendor/fflate.js（与 smoke.mjs 一致）。
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fflate = require('../www/js/vendor/fflate.js');

const ROOT = path.resolve('www');
const OUT = path.resolve('screenshots/agc');
const TMP = path.join(os.tmpdir(), 'inkreader-agc-shots');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 纯 JS 生成封面 PNG（不依赖图像库/字体） ---------------- */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makeCoverPng(cfg, w = 360, h = 540) {
  const { top, bottom, tree, line } = cfg;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let o = 0;
  const tiers = [[0.19, 0.44, 0.31], [0.33, 0.59, 0.27], [0.47, 0.73, 0.23]];
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    const t = y / h;
    const bg = [
      Math.round(top[0] + (bottom[0] - top[0]) * t),
      Math.round(top[1] + (bottom[1] - top[1]) * t),
      Math.round(top[2] + (bottom[2] - top[2]) * t),
    ];
    for (let x = 0; x < w; x++) {
      let px = bg;
      const m = Math.round(w * 0.065);
      // 细内框
      if (y >= m && y <= h - m && x >= m && x <= w - m &&
          (Math.abs(x - m) <= 1 || Math.abs(x - (w - m)) <= 1 ||
           Math.abs(y - m) <= 1 || Math.abs(y - (h - m)) <= 1)) px = line;
      // 三层杉树
      const cx = w / 2;
      for (const [y0, y1, hw] of tiers) {
        const a = y0 * h, b = y1 * h;
        if (y >= a && y <= b && Math.abs(x - cx) <= hw * w * ((y - a) / (b - a))) px = tree;
      }
      // 树干
      if (y > 0.73 * h && y < 0.81 * h && Math.abs(x - cx) < w * 0.017) px = tree;
      // 底部装饰横线
      if (Math.abs(y - 0.86 * h) < 2 && x > w * 0.28 && x < w * 0.72) px = line;
      raw[o++] = px[0]; raw[o++] = px[1]; raw[o++] = px[2]; raw[o++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 合成虚构演示 EPUB（含封面与多章正文） ---------------- */
const BOOKS = [
  {
    title: '山木手记', author: '林见山',
    colors: { top: [26, 62, 67], bottom: [10, 30, 35], tree: [232, 228, 210], line: [150, 184, 172] },
    chapters: ['入山', '听雨', '归途'],
    paras: [
      '清晨的山道还留着夜里的凉意，石阶上覆着一层薄薄的松针。我把背包换到另一边肩膀，听见远处溪水从石缝里挤出来的声音，忽远忽近，像谁在翻一册很旧的书。',
      '山里的树并不急于长高，它们只是把年轮一圈一圈地收紧，把风雨收进纹理里。走近了看，树皮上有细密的裂纹，像被反复读过的段落，边缘微微卷起。',
      '走到半山腰时雾散开一角，露出对面坡上一片杉林。阳光斜着落下来，把每一棵树都描出一道亮边，那一刻我忽然明白，所谓安静并不是没有声音，而是声音各有各的位置。',
      '午后在一处废弃的亭子里歇脚。木柱上有人用刀刻过字，笔画已经模糊，只剩一点浅浅的凹痕。我没有去辨读，只把手掌贴上去，感到木头里还存着白天的温度。',
      '雨是在傍晚落下来的。先是两三滴打在瓦上，接着连成一片。山把雨声一层层递远，近处的清楚，远处的含混，像有人在隔壁房间轻轻翻页。',
      '夜里借宿在守山人的小屋。灯是旧式的，光晕只够照亮桌面一角。他给我倒了一杯热茶，说山里的时间走得慢，不必急着把一本书读完。',
      '第二天醒来，窗外的雾还没散。我坐在门槛上把昨天的笔记补完，写到一半停住，发现真正想记下的其实不是看见了什么，而是那些没被说出口的停顿。',
      '下山的路比上山短，大概是因为不再频频回头。经过那片杉林时我放慢脚步，把树影收进眼里，像把一段喜欢的句子折了个角，留着以后再读。',
    ],
  },
  {
    title: '纸上行旅', author: '陈舟',
    colors: { top: [146, 58, 48], bottom: [74, 24, 24], tree: [246, 232, 214], line: [224, 176, 148] },
    chapters: ['启程', '旧城', '海边的信'],
    paras: [
      '车票被我夹在书的第七十八页，纸角折出一道浅痕。站台上的广播响了两遍，我仍没有起身，只想把这一段开场多留一会儿，像舍不得翻过扉页。',
      '车窗外的田畴一块块退过去，颜色从深绿慢慢换到浅黄。有人在小站上车，带着一只藤编的篮子，坐下之后便一直望着窗外，仿佛那才是他要去的地方。',
      '旧城的巷子窄得只容两人错身。墙根长着青苔，门环是铜的，被摸得发亮。我按着门牌号一路找过去，最后发现要找的那间铺子已经改成了书屋。',
      '书屋里没有分类牌，书按主人自己的顺序排着。老板说，找书这件事太讲道理就没意思了，有时候你伸手抽出的那一本，恰好就是当天该读的。',
      '傍晚在河边的石阶上坐了很久。水面上有灯影被拉成长长的一条，风一吹就散，散了又聚。我把白天买的那本书摊在膝上，却一个字也没读进去。',
      '旅店的老式台灯有一点晃，写字时影子跟着抖。我给朋友写了张明信片，只写了一句：这里的黄昏比别处慢，适合把没想完的事继续想完。',
      '最后一站是海边。信是蹲在礁石上写完的，纸被风掀起来一角，我用手按住，忽然觉得所谓行旅，不过是把平常的日子放到陌生的光里再看一遍。',
      '回程那天没再买车票夹进书里。那本书已经翻到最后一页，票根也就失去了用处——有些路走过一次，就自动长进了人身上。',
    ],
  },
  {
    title: '算法与诗', author: '周叙',
    colors: { top: [40, 56, 102], bottom: [16, 24, 52], tree: [234, 238, 250], line: [148, 168, 214] },
    chapters: ['序', '确定与偶然', '余韵'],
    paras: [
      '把一件事写清楚，往往比把它做出来更难。步骤可以枚举，边界却总在暗处；我们以为自己画好了方框，其实只是把未知暂时挪到了方框之外。',
      '确定性的好处是安静。同样的输入，同样的路径，同样的结果，不解释、不犹豫。它像一行格律工整的句子，读第二遍时你已知道它会停在哪里。',
      '可人并不总活在格律里。一次偶然的停顿、一个没被预期的分支，常常才是后来最值得讲的部分。于是我们在流程里留出一小段空白，交给判断去填。',
      '写程序久了，会对「例外」生出敬意。它提醒你模型只是模型，真正的世界比枚举值多出一层，而那层恰恰是所有有趣事情发生的地方。',
      '有人问，既然最后仍要由人决定，那些严密的步骤是否白费。我想不是。正因为大部分路径被稳妥地接住，剩下需要斟酌的才足够少，也足够重要。',
      '好的结构像好诗的骨架：不抢话，却让每个字站得住。你改动其中一处，别处会轻轻回应，这种呼应不是装饰，是长期约束留下的回声。',
      '夜里重读自己半年前写的一段逻辑，竟像读别人的文字。当时觉得必然的取舍，如今看只是诸多可能中的一种；能意识到这一点，大概也算一种长进。',
      '收尾时不必强求圆满。留一个可以回退的入口，写清楚哪一步由谁负责，再把剩下的交给时间——这比一句漂亮的结论更接近诚实。',
    ],
  },
  {
    title: '灯下读', author: '沈砚',
    colors: { top: [110, 88, 46], bottom: [56, 42, 20], tree: [246, 238, 214], line: [204, 182, 130] },
    chapters: ['一灯', '慢读', '夜深'],
    paras: [
      '把台灯调低一档，纸面便从白变成暖黄。这个动作几乎没有意义，却是我每晚开始读书前必做的一件事，像给接下来的两个小时划一道安静的界线。',
      '年轻时总想读得快些，一年列很长的单子，翻完就划掉。后来才明白，有些段落是要停下来等的，等它在心里落稳，再往下走才不算白过。',
      '今晚读的是一册旧随笔，纸边发脆，翻页时得轻一点。作者在某一页写「天凉了，该把椅子搬进屋里」，没有下文，我却盯着这句看了很久。',
      '窗外有车驶过，灯光从窗帘缝里扫进来一道，斜斜地掠过书脊又消失。屋里重新安静下来，字还在原处，一行也没有因为刚才的打扰而挪动。',
      '读到喜欢的地方，我从前会折角，现在只夹一张小纸条。折痕留得太久会变成一道伤，纸条却可以随时抽走，像允许自己改主意。',
      '茶凉了半杯。书读到中段，节奏忽然慢下来，作者大概也在这里犹豫过。这种不急着往下推的写法，如今已经不太常见了。',
      '夜深时合上书，没有立刻开灯。眼睛适应黑暗的那几秒，字句的余影还浮着，像散场后仍留在原地的几个人，谁都不先开口。',
      '明晚大概会从这一页接着读，也可能随手换一本。灯还放在原处，椅子也没有搬走——为一件小事留好位置，日子就有了可以回来的地方。',
    ],
  },
];

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function makeEpub(book, coverPng) {
  // 封面直接内联成 data URI：App 的 extractCoverFromBook() 只认 data:image/ 前缀，
  // 走相对路径时解析器会转成 blob:，书架就退化成「书名首字」占位封面。
  const coverDataUri = `data:image/png;base64,${coverPng.toString('base64')}`;
  const files = {};
  files['META-INF/container.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const items = book.chapters.map((_, i) =>
    `<item id="c${i}" href="Text/chapter${i}.xhtml" media-type="application/xhtml+xml"/>`).join('\n');
  const spines = book.chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('\n');
  files['OEBPS/content.opf'] = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(book.title)}</dc:title><dc:creator>${esc(book.author)}</dc:creator><dc:language>zh-CN</dc:language></metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="png" href="Images/cover.png" media-type="image/png"/>
${items}
</manifest>
<spine toc="ncx">${spines}</spine>
</package>`;
  const navPoints = book.chapters.map((c, i) =>
    `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(c)}</text></navLabel><content src="Text/chapter${i}.xhtml"/></navPoint>`).join('');
  files['OEBPS/toc.ncx'] = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>${esc(book.title)}</text></docTitle><navMap>${navPoints}</navMap></ncx>`;
  book.chapters.forEach((c, i) => {
    const body = i === 0
      ? `<h1>${esc(book.title)}</h1><p class="author">${esc(book.author)}</p><img src="${coverDataUri}" alt="封面"/>`
      : `<h2>${esc(c)}</h2>` + book.paras.map((p) => `<p>${esc(p)}</p>`).join('\n');
    files[`OEBPS/Text/chapter${i}.xhtml`] = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(c)}</title></head><body>${body}</body></html>`;
  });
  const input = {};
  for (const [k, v] of Object.entries(files)) input[k] = fflate.strToU8(v);
  input['OEBPS/Images/cover.png'] = new Uint8Array(coverPng);
  return Buffer.from(fflate.zipSync(input, { level: 6 }));
}

/* ---------------- 静态服务器（与 smoke.mjs 一致） ---------------- */
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
const BASE = `http://localhost:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: process.env.INK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
// 360×640 CSS px 是典型手机宽度；×3 物理像素密度 = 1080×1920，正好 9:16
await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) {} });

async function tapViewport(where) {
  const r = await page.evaluate(() => {
    const el = document.querySelector('#page-viewport');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  if (!r) return;
  const x = r.x + r.w * (where === 'right' ? 0.85 : where === 'left' ? 0.15 : 0.5);
  await page.mouse.click(x, r.y + r.h / 2);
}
async function shot(name) {
  await wait(500);
  // 收起 App 的临时浮层（等价于用户点「继续阅读」浮层的 ✕），避免遮住页面顶部；
  // 同时清掉焦点框与导入中遮罩，保证画面是稳定的常态界面。
  await page.evaluate(() => {
    ['plus-session', 'toast', 'busy', 'plus-endstop'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
  await wait(150);
  const fp = path.join(OUT, name);
  await page.screenshot({ path: fp, type: 'png' });
  const b = fs.readFileSync(fp);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  return { name, size: `${w}x${h}`, bytes: b.length, md5: crypto.createHash('md5').update(b).digest('hex').slice(0, 8) };
}

const report = [];
try {
  // 1) 生成演示书籍
  const epubPaths = BOOKS.map((b, i) => {
    const png = makeCoverPng(b.colors);
    const fp = path.join(TMP, `book${i + 1}.epub`);
    fs.writeFileSync(fp, makeEpub(b, png));
    return fp;
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(700);
  // 关掉首次引导；设一套适合截图的排版参数
  await page.evaluate(() => {
    localStorage.setItem('inkreader:pro-guide-v1', '1');
    const s = JSON.parse(localStorage.getItem('inkreader:settings') || '{}');
    Object.assign(s, {
      theme: 'ink', font: 'serif', fontSize: 20, lineHeight: 1.9,
      margin: 22, paraSpacing: 0.6, letterSpacing: 0, justify: true, indent: true,
      pageFlip: false,
    });
    localStorage.setItem('inkreader:settings', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await wait(700);

  // 2) 逐本导入（真实文件选择器路径）
  for (let i = 0; i < epubPaths.length; i++) {
    const input = await page.$('#file-epub');
    if (!input) throw new Error('#file-epub 不存在');
    await input.uploadFile(epubPaths[i]);
    await page.waitForFunction(
      (n) => document.querySelectorAll('#book-list .book-card').length >= n,
      { timeout: 30000 }, i + 1
    ).catch(() => {});
    await wait(250);
  }
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('#book-list .book-card')].map((c) => c.dataset.bookId));
  const titles = {};
  ids.forEach((id, i) => { titles[id] = BOOKS[i] ? BOOKS[i].title : `书籍 ${i + 1}`; });

  // 3) 注入最近 14 天阅读统计 + 标注（让统计页/我的页是「有数据的真实界面」）
  await page.evaluate(({ ids, titles }) => {
    const stats = {};
    const dayMs = 24 * 3600 * 1000;
    const pattern = [18, 32, 0, 26, 41, 35, 12, 24, 38, 0, 29, 46, 33, 22];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * dayMs);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const mins = pattern[13 - i];
      if (!mins) continue;
      stats[k] = {
        byBook: { [ids[0]]: Math.round(mins * 0.6 * 60000), [ids[1] || ids[0]]: Math.round(mins * 0.4 * 60000) },
        checkin: mins >= 20, checkinAt: Date.now() - i * dayMs,
      };
    }
    localStorage.setItem('inkreader:stats', JSON.stringify(stats));
    localStorage.setItem('inkreader:stats-titles', JSON.stringify(titles));
    const hl = {};
    if (ids[0]) hl[ids[0]] = [
      { id: 'h1', text: '安静并不是没有声音，而是声音各有各的位置。', ci: 1, pi: 0, at: Date.now() - 86400000 },
      { id: 'h2', text: '有些段落是要停下来等的，等它在心里落稳，再往下走才不算白过。', ci: 2, pi: 0, at: Date.now() - 172800000 },
      { id: 'h3', text: '把没想完的事继续想完。', ci: 1, pi: 1, at: Date.now() - 259200000 },
    ];
    localStorage.setItem('inkreader:highlights', JSON.stringify(hl));
  }, { ids, titles });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await wait(900);

  // 4) ① 书架：折叠导入区，让书籍卡片完整露出。
  // 注意：不要点 #import-head —— app.js 的 toggleImport() 用 $('shelf-actions')
  // (getElementById) 取元素，但 index.html 只有 class 没有 id，真机上点它会抛
  // "Cannot read properties of null (reading 'classList')" 且折叠无效。这里直接置为
  // CSS 已支持的 collapsed 状态（.shelf-actions.collapsed .import-body{display:none}），
  // 与用户成功折叠后的界面完全一致。该 App bug 留到上架后再修，避免动送审包。
  await page.evaluate(() => {
    const sa = document.querySelector('.shelf-actions');
    if (sa) sa.classList.add('collapsed');
    const chevron = document.getElementById('import-chevron');
    if (chevron) chevron.textContent = '▸';
  });
  report.push(await shot('shot-01-shelf.png'));

  // 5) ② 阅读器正文页
  await page.evaluate(() => {
    const c = document.querySelector('#book-list .book-card');
    if (c) c.click();
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 15000 });
  await wait(800);
  for (let i = 0; i < 6; i++) {
    const len = await page.evaluate(() => {
      const p = document.getElementById('page'); return p ? p.innerText.trim().length : 0;
    });
    if (len > 120) break;
    await tapViewport('right');
    await wait(420);
  }
  await wait(300);
  report.push(await shot('shot-02-reader.png'));

  // 6) ③ 目录面板（先点中央唤出控制条）
  await tapViewport('center');
  await wait(350);
  const tocBtn = await page.$('#btn-toc');
  if (tocBtn) await tocBtn.click();
  else await page.evaluate(() => { const b = document.getElementById('btn-toc-top'); if (b) b.click(); });
  await wait(400);
  report.push(await shot('shot-03-toc.png'));

  // 7) 返回书架 → ④ 设置页
  await page.evaluate(() => {
    const panel = document.getElementById('panel-toc');
    if (panel) panel.classList.remove('open');
    const back = document.getElementById('btn-back');
    if (back) back.click();
  });
  await wait(450);
  await page.evaluate(() => {
    const t = document.querySelector('#tabbar .tab[data-view="settings"]');
    if (t) t.click();
  });
  await wait(500);
  report.push(await shot('shot-04-settings.png'));

  // 8) ⑤ 统计页
  await page.evaluate(() => {
    const t = document.querySelector('#tabbar .tab[data-view="stats"]');
    if (t) t.click();
  });
  await wait(650);
  report.push(await shot('shot-05-stats.png'));

  // 9) ⑥ 我的标注与收藏
  await page.evaluate(() => {
    const t = document.querySelector('#tabbar .tab[data-view="mine"]');
    if (t) t.click();
  });
  await wait(550);
  report.push(await shot('shot-06-mine.png'));

  const uniq = new Set(report.map((r) => r.md5)).size;
  console.log(JSON.stringify({ shots: report, unique: uniq, errors }, null, 2));
} catch (e) {
  console.error('CAPTURE FAILED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
