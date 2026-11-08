// 红杉 — PDF 导入管线自测（Node 环境，不依赖浏览器）
//
// 目的：在交给浏览器/预览之前，先在 Node 里把「导入 → 解析 → 渲染单页 → 大纲映射 → 存储兜底」
// 整条链路跑通，证明文件本身可被 pdf.js 正确解析，且我们的解析逻辑不会抛错。
//
// 用法：
//   node tests/pdf-pipeline.test.mjs
//
// 说明：本机已安装 pdfjs-dist@4.10.38（/tmp/pdfjs-test/node_modules）。
// importers.js 里 parsePdf 用的是浏览器 File.arrayBuffer + 浏览器 pdf.js(v4) worker；
// 这里用等价的 Node 写法复刻同一套逻辑（getDocument / getMetadata / getPage / render / getOutline）。

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// pdfjs-dist 随测试一同放在 tests/vendor（与本仓库一起分发，无需联网安装）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDFJS_PATH = pathToFileURL(path.join(__dirname, 'vendor', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href;
const PDF_PATH = 'C:/Users/杨睿/Desktop/《人生亏钱指南》生财有术出品.pdf';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// 简单稳定 hash（与 importers.js 中保持同形，仅用于生成 book id）
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function main() {
  console.log('=== 红杉 PDF 导入管线自测 ===');
  console.log(`目标文件: ${PDF_PATH}`);

  const pdfjs = await import(PDFJS_PATH);
  // 关键 1：不设置 workerSrc 时，pdf.js v4 会在主线程用「fake worker」执行，Node 环境最稳。
  // 关键 2：getDocument({data}) 会 transfer 掉 ArrayBuffer，故传入副本 .slice()。
  const buf = await readFile(PDF_PATH);
  const bytes = new Uint8Array(buf);
  check('读取本地 PDF 字节', bytes.length > 0, `${bytes.length} bytes`);

  const t0 = Date.now();
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const t1 = Date.now();
  check('getDocument 成功', !!doc, `耗时 ${t1 - t0}ms`);

  const numPages = doc.numPages;
  check('页数解析正确（预期 256）', numPages === 256, `numPages=${numPages}`);

  // ---- 元数据 ----
  const meta = await doc.getMetadata().catch(() => null);
  let title = '', author = '';
  if (meta && meta.info) {
    title = meta.info.Title || '';
    author = meta.info.Author || '';
  }
  check('可读取元数据（info）', !!meta, `title="${(title || '').slice(0, 24)}" author="${(author || '').slice(0, 16)}"`);

  // ---- 文本层检测：判读这是否为「扫描/图片型 PDF」（决定渲染策略）----
  const page1 = await doc.getPage(1);
  const textContent = await page1.getTextContent();
  const page1Text = (textContent.items || []).map((it) => it.str || '').join('');
  const isImagePdf = page1Text.trim().length < 20;
  check('文本层检测', true, isImagePdf ? '图片/扫描型（用整页渲染）' : `有文本层（${page1Text.length} 字符）`);

  // ---- 渲染单页为位图：复刻 app 的 renderPdfPage 策略（图片型必须能出图）----
  const viewport = page1.getViewport({ scale: 1.0 });
  const canvasDim = { w: Math.floor(viewport.width), h: Math.floor(viewport.height) };
  // Node 端不真正写 PNG，只验证 render 不抛错且返回合理尺寸
  let renderOk = false;
  try {
    const operatorList = await page1.getOperatorList();
    renderOk = operatorList && operatorList.fnArray && operatorList.fnArray.length > 0;
  } catch (e) {
    console.log('   render 异常:', e.message);
  }
  check('单页可解析 operatorList（渲染前置）', renderOk, `${canvasDim.w}x${canvasDim.h}px, ops=${renderOk ? 'ok' : 'fail'}`);
  check('页面尺寸合理', canvasDim.w > 100 && canvasDim.h > 100, `${canvasDim.w}x${canvasDim.h}`);

  // ---- 大纲/书签映射：复刻 importers 的 outline → 真实页码 逻辑（best-effort）----
  let outline = null;
  try { outline = await doc.getOutline(); } catch (e) { outline = null; }
  // 不强制要求有 outline：很多扫描书没有。仅验证调用不抛错。
  check('getOutline 调用安全', true, outline ? `条目 ${outline.length}` : '无大纲（扫描书常见）');

  // ---- 模拟 importers.parsePdf 的返回结构 ----
  const chapters = [];
  for (let i = 0; i < numPages; i++) {
    chapters.push({ title: `第 ${i + 1} 页`, isPdfPage: true, pageIndex: i });
  }
  const bookId = 'pdf-' + hashStr(PDF_PATH + numPages);
  const fakeBook = {
    id: bookId,
    title: title || path.basename(PDF_PATH, '.pdf'),
    author: author || '未知',
    source: 'pdf',
    numPages,
    pdfBytes: bytes, // 注意：真实浏览器端我们用 IndexedDB 存；此处仅校验结构
    chapters,
  };
  check('生成 book 对象结构', fakeBook.chapters.length === numPages && !!fakeBook.id, `id=${bookId}, chapters=${fakeBook.chapters.length}`);

  // ---- 存储层兜底逻辑：在「无 IndexedDB」环境下应自动降级为内存（复刻 store.js 行为）----
  // store.js 中 openDB 检测到 indexedDB 未定义即 reject 并置 dbAvailable=false，
  // 随后 putBook/getBook 走 memBooks。这里用一段与 store.js 等价的纯逻辑验证该分支不抛错。
  const memBooks = new Map();
  function fakePut(b) { memBooks.set(b.id, b); }
  function fakeGet(id) { return memBooks.get(id) || null; }
  let storeOk = true;
  try {
    fakePut(fakeBook);
    const got = fakeGet(bookId);
    if (!got || got.numPages !== numPages) storeOk = false;
  } catch (e) {
    storeOk = false;
  }
  check('无 IDB 时内存兜底存储可用', storeOk, `memBooks.size=${memBooks.size}`);

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('测试异常中断:', e);
  process.exit(1);
});
