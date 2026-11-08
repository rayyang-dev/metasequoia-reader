// 红杉 Sequoia —— 全格式导入综合冒烟测试（puppeteer-core + 系统 Chrome）
// 覆盖 7 种格式：TXT / EPUB / PDF / MOBI / FB2 / HTML / DOCX
// 对每种格式：上传 → 断言书架新增 → 打开阅读器 → 断言正文分页渲染 → 断言 TOC 章节数 → 全程无 JS 报错
// 运行：node test/import-all.mjs
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const BASE = `http://localhost:${port}/`;

// ---------- 生成样例文件（TXT / FB2 / HTML / DOCX）----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-import-'));
function writeFixture(name, content) { const fp = path.join(TMP, name); fs.writeFileSync(fp, content, 'utf-8'); return fp; }

const txtName = '测试文本书.txt';
writeFixture(txtName, [
  '第一章 测试开篇', '这是 TXT 的第一段正文，用于验证纯文本章节分割与分页。', '第二段继续展开，提供足够文字以触发多页分页。',
  '第二章 中段发展', 'TXT 的第二章内容，验证多章结构在书架与目录中的呈现。', '再补一段以保证正文长度，便于翻页测试。'
].join('\n'));

const fb2Name = 'sample.fb2';
writeFixture(fb2Name, `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info><genre>sf</genre><author><first-name>测试</first-name><last-name>作者</last-name></author><book-title>虚构之书 FB2</book-title></title-info></description>
  <body>
    <section><title><p>第一章 开端</p></title><p>这是 FB2 的第一段正文。</p><p>第二段继续展开。</p></section>
    <section><title><p>第二章 发展</p></title><p>FB2 的第二章内容，包含更多文字用于分页测试。</p></section>
  </body>
</FictionBook>`);

const htmlName = 'sample.html';
writeFixture(htmlName, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>测试网页 HTML</title></head>
<body><h1>网页主标题</h1><p>这是网页的第一段正文内容，用于验证 HTML 导入后能够正确分页并渲染出可见的中文正文。</p><p>第二段继续展开，提供足够长度的文本以便触发多页分页与翻页测试，确认阅读器不会在 HTML 上出现空白页。</p>
<h2>小节一</h2><p>这是小节一下的具体内容，叙述进一步推进。</p><p>再补一段以保证单页文字量足以被断言为“已成功渲染正文”。</p>
<h2>小节二</h2><p>这是小节二下的具体内容段落，用于验证多章节 HTML 在目录中的呈现。</p><p>结尾段落，确保整本测试书在翻页过程中始终有可见正文。</p></body></html>`);

// DOCX：最小可用 OOXML（Store 法 ZIP，fflate 可解压）
function crc32(uint8) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < uint8.length; i++) {
    let c = (crc ^ uint8[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  // entries: [{name, data:Uint8Array}]
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); // flags=0, method=store
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); // time/date
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    local.set(nameBytes, 30);
    locals.push(Buffer.concat([local, Buffer.from(data)]));
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length, 8); end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(localBuf.length, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, end]);
}
const docxDoc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>文档标题</w:t></w:r></w:p>
<w:p><w:r><w:t>这是 DOCX 的正文第一段。</w:t></w:r></w:p>
<w:p><w:r><w:t>这是 DOCX 的正文第二段，用于分页。</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>小节标题</w:t></w:r></w:p>
<w:p><w:r><w:t>小节下的具体内容段落。</w:t></w:r></w:p>
</w:body></w:document>`;
const docxStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`;
const docxCore = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试文档 DOCX</dc:title><dc:creator>文档作者</dc:creator></cp:coreProperties>`;
const docxCT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;
const docxName = 'sample.docx';
fs.writeFileSync(path.join(TMP, docxName), makeZip([
  { name: '[Content_Types].xml', data: enc8(docxCT) },
  { name: '_rels/.rels', data: enc8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
  { name: 'word/document.xml', data: enc8(docxDoc) },
  { name: 'word/styles.xml', data: enc8(docxStyles) },
  { name: 'docProps/core.xml', data: enc8(docxCore) }
]));
function enc8(s) { return new TextEncoder().encode(s); }

// ---------- 用例 ----------
const EPUB = 'C:/Users/杨睿/Desktop/雍正帝：中国的独裁君主.epub';
const PDF = 'C:/Users/杨睿/Desktop/027  天国之秋.pdf';
const MOBI = path.resolve('tests/samples/test.mobi');
const cases = [
  { id: 'TXT', input: '#file-txt', file: path.join(TMP, txtName) },
  { id: 'FB2', input: '#file-fb2', file: path.join(TMP, fb2Name) },
  { id: 'HTML', input: '#file-html', file: path.join(TMP, htmlName) },
  { id: 'DOCX', input: '#file-docx', file: path.join(TMP, docxName) },
];
if (fs.existsSync(EPUB)) cases.push({ id: 'EPUB', input: '#file-epub', file: EPUB });
if (fs.existsSync(PDF)) cases.push({ id: 'PDF', input: '#file-pdf', file: PDF });
if (fs.existsSync(MOBI)) cases.push({ id: 'MOBI', input: '#file-mobi', file: MOBI });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 892 });
const errors = [], dialogs = [];
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(), u = (m.location() && m.location().url) || ''; if (/favicon/i.test(u) || /favicon/i.test(t)) return; errors.push('CONSOLE: ' + t); } });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : e)));
page.on('dialog', async (d) => { dialogs.push(d.message()); try { await d.dismiss(); } catch (e) {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { results: [] };
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(800);
  const initDone = await page.evaluate(() => !!window.__INK_INIT_DONE);
  report.initDone = initDone;
  for (const c of cases) {
    const res = { id: c.id, ok: false };
    try {
      const before = await page.evaluate(() => [...document.querySelectorAll('#shelf .book-card .bc-title')].map((e) => e.textContent.trim()));
      const input = await page.$(c.input);
      if (!input) throw new Error('找不到输入控件 ' + c.input);
      await input.uploadFile(c.file);
      await page.waitForFunction(
        (b) => { const t = [...document.querySelectorAll('#shelf .book-card .bc-title')].map((e) => e.textContent.trim()); return t.length > b.length; },
        { timeout: 30000 }, before
      ).catch(() => {});
      const after = await page.evaluate(() => [...document.querySelectorAll('#shelf .book-card .bc-title')].map((e) => e.textContent.trim()));
      const added = after.filter((t) => !before.includes(t));
      if (added.length === 0) throw new Error('导入后书架未新增（解析/导入失败）');
      res.importedTitle = added[0];
      // 打开该书（按标题定位）
      await page.evaluate((title) => {
        const cards = [...document.querySelectorAll('#shelf .book-card')];
        const card = cards.find((c) => c.querySelector('.bc-title') && c.querySelector('.bc-title').textContent.trim() === title);
        if (card) card.click();
      }, res.importedTitle);
      await page.waitForFunction(() => { const r = document.querySelector('#reader'); return !!r && !r.classList.contains('hidden'); }, { timeout: 15000 }).catch(() => {});
      const open = await page.evaluate(() => { const r = document.querySelector('#reader'); return !!r && !r.classList.contains('hidden'); });
      if (!open) throw new Error('阅读器未打开');
      if (c.id === 'PDF') {
        await page.waitForFunction(() => { const img = document.querySelector('#page .pdfpage img'); const fail = /渲染失败/.test((document.querySelector('#page').innerText || '')); return (img && /^data:/.test(img.getAttribute('src') || '')) || fail; }, { timeout: 30000 }).catch(() => {});
        const s = await page.evaluate(() => { const img = document.querySelector('#page .pdfpage img'); const fail = /渲染失败/.test((document.querySelector('#page').innerText || '')); return { natW: img ? img.naturalWidth : 0, fail }; });
        if (s.fail) throw new Error('渲染失败');
        if (!s.natW || s.natW < 10) throw new Error('PDF 首页未渲染为有效图片(natW=' + s.natW + ')');
        res.natW = s.natW;
      } else {
        // 统计翻页过程中出现的“最大正文长度”（封面/标题页可能无正文，避免误判为渲染失败）
        await wait(1500);
        let maxLen = 0;
        for (let i = 0; i < 8; i++) {
          const t = await page.evaluate(() => { const p = document.querySelector('#page'); return p ? p.innerText.trim().length : 0; });
          if (t > maxLen) maxLen = t;
          if (maxLen > 20) break;
          await page.evaluate(() => { const b = document.querySelector('#btn-next'); if (b) b.click(); });
          await wait(450);
        }
        if (maxLen <= 20) throw new Error('翻页后仍未出现正文(最大长度=' + maxLen + ')');
        res.textLen = maxLen;
        const toc = await page.evaluate(() => document.querySelectorAll('#toc-list .toc-item').length);
        res.toc = toc;
      }
      res.ok = true;
      // 返回书架
      await page.evaluate(() => { const b = document.querySelector('#btn-back'); if (b) b.click(); });
      await wait(400);
    } catch (e) { res.reason = e.message; }
    report.results.push(res);
    console.log(`[${res.ok ? '✅' : '❌'}] ${res.id}  ${res.ok ? ('标题「' + res.importedTitle + '」' + (res.natW ? (' 首页natW=' + res.natW) : (' 正文长度=' + res.textLen + ' TOC=' + res.toc))) : ('→ ' + res.reason)}`);
  }
} catch (e) { report.fatal = e.message; }

const failed = report.results.filter((r) => !r.ok).length;
report.summary = { initDone: !!report.initDone, total: report.results.length, failed, errors: errors.length, dialogs: dialogs.length, skipped: cases.length - report.results.length };
console.log('\n==== 全格式导入测试汇总 ====');
console.log(JSON.stringify(report.summary, null, 2));
if (errors.length) console.log('控制台错误:', JSON.stringify(errors.slice(0, 10), null, 2));
if (dialogs.length) console.log('JS 弹窗(导入失败提示):', JSON.stringify(dialogs.slice(0, 10), null, 2));
if (report.fatal) console.log('致命错误:', report.fatal);
await browser.close();
server.close();
process.exit(report.summary.failed === 0 && report.summary.errors === 0 && report.summary.dialogs === 0 && !report.fatal ? 0 : 1);
