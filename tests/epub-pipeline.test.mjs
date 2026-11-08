// 红杉 — EPUB 导入管线自测（Node 环境，跑真实 parseEpub 逻辑）
//
// 目的：在交给浏览器之前，先在 Node 里「构造一个合法 EPUB → 走真实 parseEpub → 校验章节/TOC」。
// 直接用 fflate 拼一个 EPUB3(NAV) 与一个 EPUB2(NCX) 的 zip 包，喂给 importers.js 的 parseEpub，
// 以验证解析逻辑（container→OPF→manifest/spine→章节→TOC 映射）无逻辑 bug。
//
// 用法：node tests/epub-pipeline.test.mjs

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// fflate 是 UMD，可直接 require
const fflate = require(path.resolve('www/js/vendor/fflate.js'));
// 浏览器全局垫片：parseEpub 用 window.fflate，Node 里补上
globalThis.window = globalThis.window || {};
globalThis.window.fflate = fflate;
// Node 22 自带 btoa/atob；若缺失则补
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const importers = await import(pathToFileURL(path.resolve('www/js/importers.js')).href);

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const enc = new TextEncoder();
function strBytes(s) { return enc.encode(s); }

// 简易 EPUB 组装器（zipSync）
function buildEpub(entries) {
  const obj = {};
  for (const k in entries) obj[k] = strBytes(entries[k]);
  return fflate.zipSync(obj, { level: 0 });
}

function makeFile(name, bytes) {
  return {
    name,
    async arrayBuffer() {
      // 返回独立的 ArrayBuffer 副本（模拟 File）
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return ab;
    },
  };
}

// ---------- EPUB3（NAV 目录）----------
function epub3() {
  const container =
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  const opf =
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试书 EPUB3</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="chap3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`;
  const nav =
`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
<nav epub:type="toc">
  <ol>
    <li><a href="chap1.xhtml">第一章 开始</a></li>
    <li><a href="chap2.xhtml">第二章 发展</a></li>
    <li><a href="chap3.xhtml">第三章 结局</a></li>
  </ol>
</nav>
</body></html>`;
  const chap = (n, t, body) =>
`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head>
<body><h1>${t}</h1>${body}</body></html>`;
  const p = (s) => `<p>${s}</p>`;
  return buildEpub({
    'mimetype': 'application/epub+zip',
    'META-INF/container.xml': container,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': nav,
    'OEBPS/chap1.xhtml': chap(1, '第一章 开始', p('第一段内容，用于测试解析。') + p('第二段内容。')),
    'OEBPS/chap2.xhtml': chap(2, '第二章 发展', p('中段剧情推进。')),
    'OEBPS/chap3.xhtml': chap(3, '第三章 结局', p('收尾。')),
  });
}

// ---------- EPUB2（NCX 目录）----------
function epub2() {
  const container =
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf =
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试书 EPUB2</dc:title>
    <dc:creator>测试作者2</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
  const ncx =
`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="bookid"/></head>
  <docTitle><text>测试书 EPUB2</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>第一节</text></navLabel><content src="chap1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>第二节</text></navLabel><content src="chap2.xhtml"/></navPoint>
  </navMap>
</ncx>`;
  const chap = (t, body) =>
`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head>
<body><h1>${t}</h1>${body}</body></html>`;
  return buildEpub({
    'mimetype': 'application/epub+zip',
    'META-INF/container.xml': container,
    'OEBPS/content.opf': opf,
    'OEBPS/toc.ncx': ncx,
    'OEBPS/chap1.xhtml': chap('第一节', '<p>第一段。</p>'),
    'OEBPS/chap2.xhtml': chap('第二节', '<p>第二段。</p>'),
  });
}

async function testOne(label, bytes, expectTitleFromToc) {
  console.log(`\n--- ${label} ---`);
  const book = await importers.parseEpub(makeFile('test.epub', bytes));
  check('解析成功且 source=epub', book && book.source === 'epub', `title="${book.title}" author="${book.author}"`);
  check('章节数正确', book.chapters.length === (label.includes('EPUB3') ? 3 : 2), `chapters=${book.chapters.length}`);
  check('章节 html 非空', book.chapters.every((c) => c.html && c.html.length > 0));
  check('首章含段落文本', /第一段内容/.test(book.chapters[0].html) || /第一段/.test(book.chapters[0].html), book.chapters[0].html.slice(0, 24));
  if (expectTitleFromToc) {
    // 修复后 TOC 标题应正确映射
    check('TOC 标题已映射到章节（非回退）', book.chapters[0].title && !/^第 \d+ 节$/.test(book.chapters[0].title), `首章标题="${book.chapters[0].title}"`);
  } else {
    console.log(`  ℹ️ 标题: ${book.chapters.map((c) => c.title).join(' / ')}`);
  }
  return book;
}

async function main() {
  console.log('=== 红杉 EPUB 导入管线自测 ===');
  await testOne('EPUB3（NAV 目录）', epub3(), true);
  await testOne('EPUB2（NCX 目录）', epub2(), true);
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error('测试异常中断:', e); process.exit(1); });
